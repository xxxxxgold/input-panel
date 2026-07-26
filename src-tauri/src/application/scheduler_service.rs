use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;
use tokio::sync::Semaphore;
use tokio::time::sleep;
use uuid::Uuid;

use crate::application::{data_center_service, AppContext};
use crate::contracts::UsageRow;
use crate::infrastructure::datetime::now_storage_timestamp;
use crate::infrastructure::sqlite::repositories;

const SCHEDULER_ENABLED_KEY: &str = "scheduler_enabled";
const SCHEDULER_INTERVAL_KEY: &str = "scheduler_interval_seconds";
const DEFAULT_SCHEDULER_INTERVAL: u64 = 15;
const MIN_SCHEDULER_INTERVAL: u64 = 15;
const SCHEDULER_STARTUP_DELAY_SECONDS: u64 = 15;
const STARTUP_RECENT_FOUR_DAY_USAGE_READ_DELAY_SECONDS: u64 = 5;
const MAX_CONCURRENT_ACCOUNT_SYNCS: usize = 2;
const MAX_SYNC_DURATION_SECONDS: u64 = 300; // 5分钟超时保护

#[derive(Clone)]
pub struct DataSyncScheduler {
    running: Arc<AtomicBool>,
}

impl DataSyncScheduler {
    pub fn start(ctx: AppContext, app: AppHandle) -> Self {
        let running = Arc::new(AtomicBool::new(true));
        let running_for_task = Arc::clone(&running);
        let ctx_for_task = ctx.clone();
        let app_for_task = app.clone();

        tauri::async_runtime::spawn(async move {
            let mut last_interval = resolve_interval(&ctx_for_task);
            let in_progress = Arc::new(AtomicBool::new(false));
            let mut next_delay = SCHEDULER_STARTUP_DELAY_SECONDS;

            loop {
                sleep(Duration::from_secs(next_delay)).await;
                if !running_for_task.load(Ordering::Relaxed) {
                    break;
                }
                if database_restart_stops_scheduler(&ctx_for_task) {
                    break;
                }
                let current_interval = resolve_interval(&ctx_for_task);
                if current_interval != last_interval {
                    log::info!("[scheduler] 间隔从 {} 秒调整为 {} 秒", last_interval, current_interval);
                    last_interval = current_interval;
                }
                if in_progress.load(Ordering::Relaxed) {
                    log::warn!("[scheduler] 上一次同步仍在进行中，跳过本次 tick");
                    next_delay = current_interval;
                    continue;
                }
                let in_progress_for_tick = Arc::clone(&in_progress);
                tick_with_guard(&ctx_for_task, &app_for_task, in_progress_for_tick).await;
                next_delay = current_interval + scheduler_tick_jitter_seconds();
            }
        });

        let ctx_for_startup_usage_read = ctx;
        let running_for_startup_usage_read = Arc::clone(&running);
        tauri::async_runtime::spawn(async move {
            sleep(Duration::from_secs(
                STARTUP_RECENT_FOUR_DAY_USAGE_READ_DELAY_SECONDS,
            ))
            .await;
            if !running_for_startup_usage_read.load(Ordering::Relaxed) {
                return;
            }
            if database_restart_stops_scheduler(&ctx_for_startup_usage_read) {
                return;
            }
            data_center_service::sync_startup_recent_four_day_usage_reads(
                &ctx_for_startup_usage_read,
            )
            .await;
        });

        Self { running }
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }
}

fn database_restart_stops_scheduler(ctx: &AppContext) -> bool {
    match ctx.db.restart_required() {
        Ok(restart_required) => restart_required,
        Err(error) => {
            log::error!("[scheduler] 无法读取数据库迁移状态，停止后续调度: {error}");
            true
        }
    }
}

async fn tick_with_guard(ctx: &AppContext, app: &AppHandle, in_progress: Arc<AtomicBool>) {
    in_progress.store(true, Ordering::Relaxed);
    let ctx_for_tick = ctx.clone();
    let app_for_tick = app.clone();
    let result = await_scheduler_tick_without_cancelling(
        async move {
            tick(&ctx_for_tick, &app_for_tick).await;
        },
        Duration::from_secs(MAX_SYNC_DURATION_SECONDS),
    )
    .await;
    in_progress.store(false, Ordering::Relaxed);

    match result {
        Ok(true) => log::warn!(
            "[scheduler] 单次同步超过 {} 秒后才完成；期间持续保留调度锁",
            MAX_SYNC_DURATION_SECONDS
        ),
        Ok(false) => {}
        Err(error) => log::warn!("[scheduler] 调度任务异常结束: {error}"),
    }
}

async fn await_scheduler_tick_without_cancelling<F>(
    future: F,
    timeout: Duration,
) -> Result<bool, tokio::task::JoinError>
where
    F: Future<Output = ()> + Send + 'static,
{
    let mut task = tokio::spawn(future);
    match tokio::time::timeout(timeout, &mut task).await {
        Ok(result) => result.map(|_| false),
        Err(_) => {
            log::error!(
                "[scheduler] 单次同步超过 {} 秒，保留既有任务直到其自行收束",
                timeout.as_secs()
            );
            task.await.map(|_| true)
        }
    }
}

async fn tick(ctx: &AppContext, app: &AppHandle) {
    let enabled = repositories::get_setting(&ctx.db, SCHEDULER_ENABLED_KEY)
        .ok()
        .flatten()
        .map(|v| v == "1")
        .unwrap_or(true);

    if !enabled {
        log::info!("[scheduler] 调度器已禁用，跳过本次 tick");
        return;
    }

    let account_ids = match repositories::list_account_ids(&ctx.db) {
        Ok(ids) => ids,
        Err(e) => {
            log::warn!("[scheduler] 读取账号列表失败: {}", e);
            return;
        }
    };

    let total = account_ids.len();
    if total == 0 {
        log::info!("[scheduler] 没有账号，跳过本次 tick");
        return;
    }
    log::info!(
        "[scheduler] 开始调度同步，共 {} 个账号，并发上限 {}",
        total,
        MAX_CONCURRENT_ACCOUNT_SYNCS
    );

    let mut set = tokio::task::JoinSet::new();
    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT_ACCOUNT_SYNCS));
    for (idx, account_id) in account_ids.into_iter().enumerate() {
        let ctx = ctx.clone();
        let app = app.clone();
        let semaphore = Arc::clone(&semaphore);
        set.spawn(async move {
            let Ok(_permit) = semaphore.acquire_owned().await else {
                log::warn!("[scheduler] 账号同步并发控制器已关闭");
                return;
            };
            let start = std::time::Instant::now();
            let result = data_center_service::sync_scheduled_account_data(&ctx, &account_id).await;
            match result {
                Ok(Some(sync_result)) => {
                    if should_enqueue_usage_update_notifications(
                        sync_result.notification_owner,
                        sync_result.usage_notification_eligible,
                        &sync_result.changed_usage_rows,
                    ) {
                        if let Err(error) = enqueue_usage_update_notifications(
                            &app,
                            &account_id,
                            &sync_result.changed_usage_rows,
                        ) {
                            log::warn!("[scheduler] 账号 {} 用量通知投递失败: {}", account_id, error);
                        }
                    }
                    log::info!(
                        "[scheduler] [{}/{}] 账号 {} 同步完成，耗时 {:?}",
                        idx + 1, total, account_id, start.elapsed()
                    );
                }
                Ok(None) => {
                    log::info!("[scheduler] 账号 {} 正在进行用量同步，本轮延后", account_id);
                }
                Err(e) => {
                    log::warn!(
                        "[scheduler] [{}/{}] 账号 {} 同步失败: {}",
                        idx + 1, total, account_id, e
                    );
                }
            }
        });
    }

    while let Some(result) = set.join_next().await {
        if let Err(e) = result {
            log::warn!("[scheduler] 子任务 panic: {}", e);
        }
    }

    log::info!("[scheduler] 本轮调度完成");
}

pub(crate) fn enqueue_usage_update_notifications(
    app: &AppHandle,
    account_id: &str,
    rows: &[UsageRow],
) -> Result<(), String> {
    for notification in build_usage_update_notifications(account_id, rows)? {
        crate::enqueue_floating_notification(app, notification)?;
    }
    Ok(())
}

pub(crate) fn build_usage_update_notifications(
    account_id: &str,
    rows: &[UsageRow],
) -> Result<Vec<crate::FloatingNotificationPayload>, String> {
    rows.iter()
        .map(|row| build_usage_update_notification(account_id, row))
        .collect()
}

pub(crate) fn should_enqueue_usage_update_notifications(
    notification_owner: bool,
    usage_notification_eligible: bool,
    rows: &[UsageRow],
) -> bool {
    notification_owner && usage_notification_eligible && !rows.is_empty()
}

pub(crate) fn build_usage_update_notification(
    account_id: &str,
    row: &UsageRow,
) -> Result<crate::FloatingNotificationPayload, String> {
    let api_key_label = row
        .api_key_name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| row.api_key_id.map(|id| format!("API Key #{id}")))
        .unwrap_or_else(|| "未命名 API Key".into());

    Ok(crate::FloatingNotificationPayload {
        id: Uuid::new_v4().to_string(),
        dedupe_key: format!("usage-sync:{account_id}:{}", row.id),
        channel: crate::FloatingNotificationChannel::Usage,
        title: "用量已更新".into(),
        level: "success".into(),
        source: "usage-sync".into(),
        created_at: now_storage_timestamp(),
        content: format!("{api_key_label} / {} / ${:.6}", row.model, row.actual_cost),
        account: Some(crate::FloatingNotificationReference {
            id: Some(account_id.to_string()),
            label: account_id.to_string(),
        }),
        site: None,
        model: Some(crate::FloatingNotificationReference {
            id: None,
            label: row.model.clone(),
        }),
        usage: Some(crate::FloatingUsageNotificationDetails {
            api_key_label,
            model: row.model.clone(),
            reasoning_effort: row.reasoning_effort.clone(),
            input_tokens: row.input_tokens,
            output_tokens: row.output_tokens,
            cache_creation_tokens: row.cache_creation_tokens.unwrap_or_default(),
            cache_read_tokens: row.cache_read_tokens.unwrap_or_default(),
            actual_cost: row.actual_cost,
            total_cost: row.total_cost,
            first_token_ms: row.first_token_ms,
        }),
    })
}

/// 0-2 秒 tick 抖动：避免与前端自动刷新等其它周期任务长期同相位共振。
fn scheduler_tick_jitter_seconds() -> u64 {
    u64::from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.subsec_nanos())
            .unwrap_or(0),
    ) % 3
}

fn resolve_interval(ctx: &AppContext) -> u64 {
    repositories::get_setting(&ctx.db, SCHEDULER_INTERVAL_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_SCHEDULER_INTERVAL)
        .max(MIN_SCHEDULER_INTERVAL)
}

pub fn is_scheduler_enabled(ctx: &AppContext) -> bool {
    repositories::get_setting(&ctx.db, SCHEDULER_ENABLED_KEY)
        .ok()
        .flatten()
        .map(|v| v == "1")
        .unwrap_or(true)
}

pub fn get_scheduler_interval(ctx: &AppContext) -> u64 {
    resolve_interval(ctx)
}

pub fn set_scheduler_enabled(ctx: &AppContext, enabled: bool) -> anyhow::Result<()> {
    repositories::set_setting(&ctx.db, SCHEDULER_ENABLED_KEY, if enabled { "1" } else { "0" })
}

pub fn set_scheduler_interval(ctx: &AppContext, seconds: u64) -> anyhow::Result<()> {
    let normalized = seconds.max(MIN_SCHEDULER_INTERVAL);
    repositories::set_setting(&ctx.db, SCHEDULER_INTERVAL_KEY, &normalized.to_string())
}

pub fn update_scheduler_config(
    ctx: &AppContext,
    enabled: bool,
    seconds: u64,
) -> anyhow::Result<(bool, u64)> {
    let interval_seconds = seconds.max(MIN_SCHEDULER_INTERVAL);
    repositories::set_settings(
        &ctx.db,
        &[
            (
                SCHEDULER_ENABLED_KEY,
                if enabled { "1".to_string() } else { "0".to_string() },
            ),
            (SCHEDULER_INTERVAL_KEY, interval_seconds.to_string()),
        ],
    )?;
    Ok((enabled, interval_seconds))
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::Duration,
    };

    use super::{
        await_scheduler_tick_without_cancelling, build_usage_update_notification,
        build_usage_update_notifications,
        get_scheduler_interval, is_scheduler_enabled, should_enqueue_usage_update_notifications,
        update_scheduler_config, MIN_SCHEDULER_INTERVAL,
    };
    use crate::{
        application::{resource_coordinator::ResourceCoordinator, AppContext},
        contracts::UsageRow,
        infrastructure::{
            files::AppPaths,
            sqlite::{repositories, Database},
        },
    };

    fn build_test_context() -> AppContext {
        let root = std::env::temp_dir().join(format!(
            "input-panel-scheduler-config-tests-{}",
            uuid::Uuid::new_v4()
        ));
        let paths = AppPaths::from_root(root);
        paths.ensure().expect("ensure test app paths");
        let db = Database::new(paths.db_path.clone());
        let _ = db.connect().expect("initialize test sqlite");
        AppContext {
            paths,
            db,
            sync_tasks: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            live_resources: ResourceCoordinator::default(),
        }
    }

    fn usage_row() -> UsageRow {
        UsageRow {
            id: "usage-1".into(),
            upstream_user_id: None, api_key_id: Some(8), upstream_account_id: None, request_id: None,
            created_at: "2026-07-15T13:00:00+08:00".into(), model: "gpt-5".into(), reasoning_effort: Some("high".into()),
            endpoint: None, upstream_endpoint: None, group_id: None, subscription_id: None, actual_cost: 0.012345,
            total_cost: 0.013, input_tokens: 120, output_tokens: 80, input_cost: None, output_cost: None,
            cache_creation_tokens: Some(20), cache_read_tokens: Some(30), cache_creation_5m_tokens: None,
            cache_creation_1h_tokens: None, cache_creation_cost: None, cache_read_cost: None, total_tokens: 250,
            first_token_ms: Some(456), duration_ms: None, billing_mode: None, request_type: None, stream: None,
            openai_ws_mode: None, billing_type: None, image_count: None, image_size: None, image_input_size: None,
            image_output_size: None, image_output_tokens: None, image_output_cost: None, image_size_source: None,
            image_size_breakdown: None, media_type: None, rate_multiplier: None, user_agent: None, ip_address: None,
            cache_ttl_overridden: None, api_key_name: Some("prod-key".into()),
            platform: None, subscription_name: None, group_name: None, subscription_type: None,
        }
    }

    #[test]
    fn builds_a_floating_notification_for_each_changed_usage_row() {
        let notification = build_usage_update_notification("account-1", &usage_row())
            .expect("usage row must produce a notification");

        assert_eq!(notification.title, "用量已更新");
        assert_eq!(notification.account.expect("account context").label, "account-1");
        assert_eq!(notification.dedupe_key, "usage-sync:account-1:usage-1");
        assert_eq!(notification.channel, crate::FloatingNotificationChannel::Usage);
        let usage = notification.usage.expect("usage details");
        assert_eq!(usage.api_key_label, "prod-key");
        assert_eq!(usage.cache_creation_tokens, 20);
        assert_eq!(usage.first_token_ms, Some(456));
    }

    #[test]
    fn only_the_single_flight_owner_may_enqueue_changed_usage_notifications() {
        let rows = vec![usage_row()];

        assert!(should_enqueue_usage_update_notifications(true, true, &rows));
        assert!(!should_enqueue_usage_update_notifications(false, true, &rows));
        assert!(!should_enqueue_usage_update_notifications(true, false, &rows));
        assert!(!should_enqueue_usage_update_notifications(true, true, &[]));
    }

    #[test]
    fn scheduler_config_persists_the_normalized_pair_together() {
        let ctx = build_test_context();

        let (enabled, interval_seconds) = update_scheduler_config(&ctx, false, 1)
            .expect("update scheduler configuration");

        assert!(!enabled);
        assert_eq!(interval_seconds, MIN_SCHEDULER_INTERVAL);
        assert!(!is_scheduler_enabled(&ctx));
        assert_eq!(get_scheduler_interval(&ctx), MIN_SCHEDULER_INTERVAL);
        assert_eq!(
            repositories::get_setting(&ctx.db, "scheduler_enabled")
                .expect("read scheduler enabled")
                .as_deref(),
            Some("0")
        );
        assert_eq!(
            repositories::get_setting(&ctx.db, "scheduler_interval_seconds")
                .expect("read scheduler interval")
                .as_deref(),
            Some(MIN_SCHEDULER_INTERVAL.to_string().as_str())
        );
    }

    #[test]
    fn preserves_all_five_changed_rows_in_arrival_order_with_stable_usage_dedupe_keys() {
        let rows = (1..=5)
            .map(|index| {
                let mut row = usage_row();
                row.id = format!("usage-{index}");
                row
            })
            .collect::<Vec<_>>();

        let notifications = build_usage_update_notifications("account-1", &rows)
            .expect("changed rows must build notifications");

        assert_eq!(notifications.len(), 5);
        assert_eq!(
            notifications
                .iter()
                .map(|item| item.dedupe_key.as_str())
                .collect::<Vec<_>>(),
            [
                "usage-sync:account-1:usage-1",
                "usage-sync:account-1:usage-2",
                "usage-sync:account-1:usage-3",
                "usage-sync:account-1:usage-4",
                "usage-sync:account-1:usage-5",
            ]
        );
        assert!(notifications
            .iter()
            .all(|item| item.channel == crate::FloatingNotificationChannel::Usage));
    }

    #[tokio::test]
    async fn scheduler_timeout_keeps_existing_tick_running_until_it_finishes() {
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let (release_sender, release_receiver) = tokio::sync::oneshot::channel();
        let completed = Arc::new(AtomicBool::new(false));
        let completed_for_tick = Arc::clone(&completed);

        let waiter = tokio::spawn(async move {
            await_scheduler_tick_without_cancelling(
                async move {
                    let _ = started_sender.send(());
                    let _ = release_receiver.await;
                    completed_for_tick.store(true, Ordering::SeqCst);
                },
                Duration::from_millis(1),
            )
            .await
        });

        started_receiver.await.expect("tick started");
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            !waiter.is_finished(),
            "timeout must keep waiting for the original tick instead of cancelling it"
        );
        assert!(!completed.load(Ordering::SeqCst));

        release_sender.send(()).expect("release tick");
        assert!(waiter
            .await
            .expect("waiter task")
            .expect("tick task"));
        assert!(completed.load(Ordering::SeqCst));
    }
}
