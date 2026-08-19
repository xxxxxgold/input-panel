use std::collections::HashMap;
#[cfg(test)]
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tokio::sync::Semaphore;
use tokio::time::sleep;
use uuid::Uuid;

use crate::application::{
    account_service, data_center_service,
    runtime_coordination_service::{AccountDueWorkLease, BackgroundSyncDueWork},
    subscription_quota_alert_dispatcher,
    subscription_snapshot_service::{
        self, SubscriptionProcessingCapabilities, SubscriptionSnapshotOrigin,
    },
    upstream_service::UpstreamRequestPolicy,
    AppContext,
};
use crate::contracts::{SchedulerConfigPayload, UsageRow};
use crate::infrastructure::datetime::{format_storage_timestamp, now_storage_timestamp};
use crate::infrastructure::runtime_coordination::CoordinationDecision;
use crate::infrastructure::sqlite::repositories;

const SCHEDULER_ENABLED_KEY: &str = "scheduler_enabled";
const SCHEDULER_INTERVAL_KEY: &str = "scheduler_interval_seconds";
const SCHEDULER_SUBSCRIPTION_INTERVAL_KEY: &str = "scheduler_subscription_interval_seconds";
const DEFAULT_SCHEDULER_INTERVAL: u64 = 6;
const MIN_SCHEDULER_INTERVAL: u64 = 4;
const MAX_SCHEDULER_INTERVAL: u64 = 10;
const DEFAULT_SUBSCRIPTION_INTERVAL: u64 = 30;
const MIN_SUBSCRIPTION_INTERVAL: u64 = 15;
const MAX_SUBSCRIPTION_INTERVAL: u64 = 300;
const FIRST_FRESH_USAGE_DELAY_MILLIS: u64 = 250;
const HISTORY_MAINTENANCE_INTERVAL_SECONDS: u64 = 60;
const MAX_CONCURRENT_ACCOUNT_SYNCS: usize = 2;
const SCHEDULER_LOOP_POLL_INTERVAL_MILLIS: u64 = 100;
const COORDINATION_RETRY_DELAY_MILLIS: u64 = 1_000;
const DATABASE_MAINTENANCE_INTERVAL_SECONDS: i64 = 300;
const USAGE_NOTIFICATION_OUTBOX_RETENTION_DAYS: i64 = 7;
const QUOTA_ALERT_COMPLETED_EVENT_RETENTION_DAYS: i64 = 30;
static LAST_DATABASE_MAINTENANCE_EPOCH: AtomicI64 = AtomicI64::new(0);
static DATABASE_MAINTENANCE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct SchedulerDueSnapshot {
    account_work: BackgroundSyncDueWork,
    database_maintenance: bool,
}

/// 各资源使用独立 deadline，任一任务耗时都不会推迟其它资源的下一轮。
#[derive(Debug, Clone, Copy)]
struct SchedulerDueClocks {
    next_fresh_usage: Instant,
    next_subscriptions: Instant,
    next_history_maintenance: Option<Instant>,
    next_database_maintenance: Instant,
}

impl SchedulerDueClocks {
    fn new(now: Instant) -> Self {
        Self {
            next_fresh_usage: now + Duration::from_millis(FIRST_FRESH_USAGE_DELAY_MILLIS),
            next_subscriptions: now + Duration::from_secs(DEFAULT_SUBSCRIPTION_INTERVAL),
            next_history_maintenance: None,
            next_database_maintenance: now,
        }
    }

    fn collect_due(
        &mut self,
        now: Instant,
        scheduler_enabled: bool,
        fresh_interval_seconds: u64,
        subscription_interval_seconds: u64,
    ) -> SchedulerDueSnapshot {
        let mut snapshot = SchedulerDueSnapshot::default();
        if now >= self.next_fresh_usage {
            snapshot.account_work.fresh_usage = scheduler_enabled;
            self.next_fresh_usage = now + Duration::from_secs(fresh_interval_seconds);
        }
        if now >= self.next_subscriptions {
            snapshot.account_work.subscriptions = scheduler_enabled;
            self.next_subscriptions = now + Duration::from_secs(subscription_interval_seconds);
        }
        if self
            .next_history_maintenance
            .is_some_and(|deadline| now >= deadline)
        {
            snapshot.account_work.history_maintenance = scheduler_enabled;
            self.next_history_maintenance =
                Some(now + Duration::from_secs(HISTORY_MAINTENANCE_INTERVAL_SECONDS));
        }
        if now >= self.next_database_maintenance {
            snapshot.database_maintenance = true;
            self.next_database_maintenance =
                now + Duration::from_secs(DATABASE_MAINTENANCE_INTERVAL_SECONDS as u64);
        }
        snapshot
    }

    fn mark_first_fresh_settled(&mut self, now: Instant) {
        if self.next_history_maintenance.is_none() {
            self.next_history_maintenance =
                Some(now + Duration::from_secs(HISTORY_MAINTENANCE_INTERVAL_SECONDS));
        }
    }
}

#[derive(Debug, Default)]
struct PendingAccountWork {
    queued: BackgroundSyncDueWork,
    active: BackgroundSyncDueWork,
    in_flight: bool,
    retry_at: Option<Instant>,
}

#[derive(Debug)]
struct AccountWorkCompletion {
    requeue: BackgroundSyncDueWork,
    retry_after: Option<Duration>,
    fresh_settled: bool,
}

#[derive(Debug)]
struct AccountWorkerExit {
    account_id: String,
    result: Result<AccountWorkCompletion, tokio::task::JoinError>,
}

fn merge_due_work(target: &mut BackgroundSyncDueWork, source: BackgroundSyncDueWork) {
    target.fresh_usage |= source.fresh_usage;
    target.subscriptions |= source.subscriptions;
    target.history_maintenance |= source.history_maintenance;
}

fn remaining_due_work(
    requested: BackgroundSyncDueWork,
    acquired: BackgroundSyncDueWork,
) -> BackgroundSyncDueWork {
    BackgroundSyncDueWork {
        fresh_usage: requested.fresh_usage && !acquired.fresh_usage,
        subscriptions: requested.subscriptions && !acquired.subscriptions,
        history_maintenance: requested.history_maintenance && !acquired.history_maintenance,
    }
}

#[derive(Clone)]
pub struct DataSyncScheduler {
    running: Arc<AtomicBool>,
}

impl DataSyncScheduler {
    pub fn start(ctx: AppContext, app: AppHandle) -> Self {
        Self::start_with_notification_app(ctx, Some(app))
    }

    /// 启动浏览器调试后端调度器，不投递依赖 Tauri 窗口的原生通知。
    pub fn start_headless(ctx: AppContext) -> Self {
        Self::start_with_notification_app(ctx, None)
    }

    fn start_with_notification_app(ctx: AppContext, app: Option<AppHandle>) -> Self {
        let running = Arc::new(AtomicBool::new(true));
        let running_for_task = Arc::clone(&running);
        tauri::async_runtime::spawn(async move {
            run_scheduler_loop(ctx, app, running_for_task).await;
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

#[cfg(test)]
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

async fn run_scheduler_loop(ctx: AppContext, app: Option<AppHandle>, running: Arc<AtomicBool>) {
    let mut clocks = SchedulerDueClocks::new(Instant::now());
    let mut pending = HashMap::<String, PendingAccountWork>::new();
    let mut workers = tokio::task::JoinSet::<AccountWorkerExit>::new();
    let account_slots = Arc::new(Semaphore::new(MAX_CONCURRENT_ACCOUNT_SYNCS));
    let mut last_fresh_interval = resolve_interval(&ctx);
    let mut last_subscription_interval = resolve_subscription_interval(&ctx);

    loop {
        while let Some(result) = workers.try_join_next() {
            handle_account_worker_result(result, &mut pending, &mut clocks);
        }
        if !running.load(Ordering::Relaxed) || database_restart_stops_scheduler(&ctx) {
            break;
        }

        let fresh_interval = resolve_interval(&ctx);
        let subscription_interval = resolve_subscription_interval(&ctx);
        if fresh_interval != last_fresh_interval {
            log::info!(
                "[scheduler] Fresh Usage 间隔从 {} 秒调整为 {} 秒",
                last_fresh_interval,
                fresh_interval
            );
            last_fresh_interval = fresh_interval;
        }
        if subscription_interval != last_subscription_interval {
            log::info!(
                "[scheduler] Subscriptions 间隔从 {} 秒调整为 {} 秒",
                last_subscription_interval,
                subscription_interval
            );
            last_subscription_interval = subscription_interval;
        }

        let now = Instant::now();
        let due = clocks.collect_due(
            now,
            is_scheduler_enabled(&ctx),
            fresh_interval,
            subscription_interval,
        );
        if due.database_maintenance {
            let maintenance_ctx = ctx.clone();
            tauri::async_runtime::spawn(async move {
                run_database_maintenance(&maintenance_ctx).await;
            });
        }
        if !due.account_work.is_empty() {
            enqueue_due_account_work(&ctx, &mut pending, due.account_work);
        }
        spawn_ready_account_workers(
            &ctx,
            app.clone(),
            &account_slots,
            &mut pending,
            &mut workers,
            now,
        );
        sleep(Duration::from_millis(SCHEDULER_LOOP_POLL_INTERVAL_MILLIS)).await;
    }

    // stop 只停止继续 admit，新启动的上游请求必须自行收束并释放跨进程租约。
    while let Some(result) = workers.join_next().await {
        handle_account_worker_result(result, &mut pending, &mut clocks);
    }
}

fn enqueue_due_account_work(
    ctx: &AppContext,
    pending: &mut HashMap<String, PendingAccountWork>,
    due_work: BackgroundSyncDueWork,
) {
    let account_ids = match repositories::list_account_ids(&ctx.db) {
        Ok(account_ids) => account_ids,
        Err(error) => {
            log::warn!("[scheduler] 读取账号列表失败，本轮 due work 保持未执行: {error}");
            return;
        }
    };
    for account_id in account_ids {
        let entry = pending.entry(account_id).or_default();
        merge_due_work(&mut entry.queued, due_work);
        entry.retry_at = None;
    }
}

fn spawn_ready_account_workers(
    ctx: &AppContext,
    app: Option<AppHandle>,
    account_slots: &Arc<Semaphore>,
    pending: &mut HashMap<String, PendingAccountWork>,
    workers: &mut tokio::task::JoinSet<AccountWorkerExit>,
    now: Instant,
) {
    let ready_accounts = pending
        .iter()
        .filter(|(_, work)| {
            !work.in_flight
                && !work.queued.is_empty()
                && work.retry_at.map_or(true, |retry_at| now >= retry_at)
        })
        .map(|(account_id, _)| account_id.clone())
        .collect::<Vec<_>>();

    for account_id in ready_accounts {
        let Some(work) = pending.get_mut(&account_id) else {
            continue;
        };
        let requested = std::mem::take(&mut work.queued);
        work.active = requested;
        work.in_flight = true;
        work.retry_at = None;

        let worker_ctx = ctx.clone();
        let worker_app = app.clone();
        let worker_slots = Arc::clone(account_slots);
        workers.spawn(async move {
            let exit_account_id = account_id.clone();
            let task = tokio::spawn(async move {
                let Ok(_local_slot) = worker_slots.acquire_owned().await else {
                    log::warn!("[scheduler] 本地账号并发控制器已关闭");
                    return AccountWorkCompletion {
                        requeue: requested,
                        retry_after: Some(Duration::from_millis(COORDINATION_RETRY_DELAY_MILLIS)),
                        fresh_settled: false,
                    };
                };
                run_account_due_work(&worker_ctx, worker_app, &account_id, requested).await
            });
            AccountWorkerExit {
                account_id: exit_account_id,
                result: task.await,
            }
        });
    }
}

fn handle_account_worker_result(
    result: Result<AccountWorkerExit, tokio::task::JoinError>,
    pending: &mut HashMap<String, PendingAccountWork>,
    clocks: &mut SchedulerDueClocks,
) {
    let exit = match result {
        Ok(exit) => exit,
        Err(error) => {
            log::warn!("[scheduler] 账号 worker 容器异常结束: {error}");
            return;
        }
    };
    let mut remove_entry = false;
    if let Some(work) = pending.get_mut(&exit.account_id) {
        let active = std::mem::take(&mut work.active);
        work.in_flight = false;
        match exit.result {
            Ok(completion) => {
                merge_due_work(&mut work.queued, completion.requeue);
                work.retry_at = completion.retry_after.map(|delay| Instant::now() + delay);
                if completion.fresh_settled {
                    clocks.mark_first_fresh_settled(Instant::now());
                }
            }
            Err(error) => {
                log::warn!(
                    "[scheduler] 账号 {} worker panic，已重排未完成工作: {}",
                    exit.account_id,
                    error
                );
                merge_due_work(&mut work.queued, active);
                work.retry_at =
                    Some(Instant::now() + Duration::from_millis(COORDINATION_RETRY_DELAY_MILLIS));
            }
        }
        remove_entry = !work.in_flight && work.queued.is_empty();
    }
    if remove_entry {
        pending.remove(&exit.account_id);
    }
}

async fn run_account_due_work(
    ctx: &AppContext,
    app: Option<AppHandle>,
    account_id: &str,
    requested: BackgroundSyncDueWork,
) -> AccountWorkCompletion {
    let (account, site) = match account_service::load_account_site(ctx, account_id) {
        Ok(value) => value,
        Err(error) => {
            log::warn!("[scheduler] 账号 {account_id} 本地身份读取失败: {error}");
            return AccountWorkCompletion {
                requeue: requested,
                retry_after: Some(Duration::from_millis(COORDINATION_RETRY_DELAY_MILLIS)),
                fresh_settled: false,
            };
        }
    };
    let decision = match ctx
        .runtime_coordination
        .try_acquire_due_work_lease(&site.base_url, &account.email, requested)
        .await
    {
        Ok(decision) => decision,
        Err(error) => {
            log::warn!("[scheduler] 账号 {account_id} 共享协调失败，已阻止上游请求: {error}");
            return AccountWorkCompletion {
                requeue: requested,
                retry_after: Some(Duration::from_millis(COORDINATION_RETRY_DELAY_MILLIS)),
                fresh_settled: false,
            };
        }
    };
    let AccountDueWorkLease { lease, due_work } = match decision {
        CoordinationDecision::Acquired(grant) => grant,
        CoordinationDecision::Waiting { wait_ms } => {
            return AccountWorkCompletion {
                requeue: requested,
                retry_after: Some(Duration::from_millis(wait_ms.max(25))),
                fresh_settled: false,
            };
        }
    };

    let mut completion =
        run_acquired_account_work(ctx, app, account_id, requested, due_work, &lease).await;
    if let Err(error) = lease.release().await {
        log::warn!("[scheduler] 账号 {account_id} 租约显式释放失败: {error}");
    }
    if !completion.requeue.is_empty() && completion.retry_after.is_none() {
        completion.retry_after = Some(Duration::from_millis(COORDINATION_RETRY_DELAY_MILLIS));
    }
    completion
}

async fn run_acquired_account_work(
    ctx: &AppContext,
    app: Option<AppHandle>,
    account_id: &str,
    requested: BackgroundSyncDueWork,
    acquired: BackgroundSyncDueWork,
    lease: &crate::application::runtime_coordination_service::AccountLeaseGuard,
) -> AccountWorkCompletion {
    let started_at = Instant::now();
    let mut requeue = remaining_due_work(requested, acquired);
    let mut retry_after = None;
    let mut fresh_settled = false;

    if acquired.fresh_usage {
        match data_center_service::sync_scheduled_account_data(ctx, account_id).await {
            Ok(Some(sync_result)) => {
                fresh_settled = true;
                if let Some(app) = app.as_ref().filter(|_| {
                    should_enqueue_usage_update_notifications(
                        sync_result.notification_owner,
                        sync_result.usage_notification_eligible,
                        &sync_result.changed_usage_rows,
                    )
                }) {
                    if let Err(error) = enqueue_usage_update_notifications(
                        app,
                        account_id,
                        &sync_result.changed_usage_rows,
                    ) {
                        log::warn!("[scheduler] 账号 {account_id} 用量通知投递失败: {error}");
                    }
                }
                log::info!(
                    "[scheduler] 账号 {account_id} Fresh Usage 完成，耗时 {:?}",
                    started_at.elapsed()
                );
            }
            Ok(None) => {
                requeue.fresh_usage = true;
                retry_after = Some(Duration::from_millis(SCHEDULER_LOOP_POLL_INTERVAL_MILLIS));
                log::info!("[scheduler] 账号 {account_id} 正在进行用量同步，Fresh Usage 已延后");
            }
            Err(error) => {
                fresh_settled = true;
                log::warn!("[scheduler] 账号 {account_id} Fresh Usage 同步失败: {error}");
            }
        }
    }

    if acquired.subscriptions {
        let capabilities = if app.is_some() {
            SubscriptionProcessingCapabilities::desktop(true)
        } else {
            SubscriptionProcessingCapabilities::headless(true)
        };
        let subscription_result = match repositories::load_session(&ctx.db, account_id) {
            Ok(None) => Ok(None),
            Ok(Some(_)) => subscription_snapshot_service::refresh_and_process(
                ctx,
                account_id,
                true,
                UpstreamRequestPolicy::RecoverableSyncOrWrite,
                SubscriptionSnapshotOrigin::Scheduler,
                capabilities,
            )
            .await
            .map(Some),
            Err(error) => Err(error),
        };
        match subscription_result {
            Ok(Some(outcome)) => log::info!(
                "[scheduler] 账号 {} Subscriptions 完成，订阅 {} 条，额度事件 {} 条，候补评估 {} 条",
                account_id,
                outcome.subscriptions.len(),
                outcome.processing.quota_alert_event_ids.len(),
                outcome.processing.switch_evaluation_count,
            ),
            Ok(None) => {
                log::debug!("[scheduler] 账号 {account_id} 没有有效会话，跳过 Subscriptions")
            }
            Err(error) => log::warn!(
                "[scheduler] 账号 {account_id} Subscriptions 失败，保留既有提醒与候补状态: {error}"
            ),
        }
        if let Some(app) = app.as_ref() {
            if let Err(error) =
                subscription_quota_alert_dispatcher::flush_due(app, Some(account_id)).await
            {
                log::warn!(
                    "[scheduler] 账号 {account_id} 额度提醒通道 flush 失败，将在后续 Subscriptions 周期重试: {error}"
                );
            }
        }
    }

    if acquired.history_maintenance {
        if acquired.fresh_usage || acquired.subscriptions {
            requeue.history_maintenance = true;
        } else {
            match data_center_service::sync_scheduled_history_maintenance(ctx, account_id, lease)
                .await
            {
                Ok(Some(data_center_service::HistoryMaintenanceOutcome::Completed {
                    merged_count,
                })) => log::info!(
                    "[scheduler] 账号 {account_id} History maintenance 完成，合并 {merged_count} 条"
                ),
                Ok(Some(data_center_service::HistoryMaintenanceOutcome::Yielded {
                    merged_count,
                })) => {
                    requeue.history_maintenance = true;
                    log::debug!(
                        "[scheduler] 账号 {account_id} History maintenance 已安全让行，本 quantum 合并 {merged_count} 条"
                    );
                }
                Ok(None) => {
                    requeue.history_maintenance = true;
                    retry_after = Some(Duration::from_millis(SCHEDULER_LOOP_POLL_INTERVAL_MILLIS));
                }
                Err(error) => log::warn!(
                    "[scheduler] 账号 {account_id} History maintenance 失败，已保留 checkpoint: {error}"
                ),
            }
        }
    }

    AccountWorkCompletion {
        requeue,
        retry_after,
        fresh_settled,
    }
}

async fn run_database_maintenance(ctx: &AppContext) {
    let now_epoch = chrono::Utc::now().timestamp();
    let last_epoch = LAST_DATABASE_MAINTENANCE_EPOCH.load(Ordering::Relaxed);
    if now_epoch - last_epoch < DATABASE_MAINTENANCE_INTERVAL_SECONDS {
        return;
    }
    if DATABASE_MAINTENANCE_IN_PROGRESS.swap(true, Ordering::AcqRel) {
        return;
    }
    let db = ctx.db.clone();
    let cutoff = format_storage_timestamp(
        chrono::Utc::now() - chrono::Duration::days(USAGE_NOTIFICATION_OUTBOX_RETENTION_DAYS),
    );
    let quota_cutoff = format_storage_timestamp(
        chrono::Utc::now() - chrono::Duration::days(QUOTA_ALERT_COMPLETED_EVENT_RETENTION_DAYS),
    );
    let result = tokio::task::spawn_blocking(move || {
        let pruned = repositories::prune_usage_notifications_before(&db, &cutoff)?;
        let quota_pruned = repositories::prune_completed_subscription_quota_alert_events_before(
            &db,
            &quota_cutoff,
        )?;
        let checkpoint_completed = db.checkpoint_wal_truncate()?;
        Ok::<_, anyhow::Error>((pruned, quota_pruned, checkpoint_completed))
    })
    .await;
    DATABASE_MAINTENANCE_IN_PROGRESS.store(false, Ordering::Release);

    match result {
        Ok(Ok((pruned, quota_pruned, true))) => {
            LAST_DATABASE_MAINTENANCE_EPOCH.store(now_epoch, Ordering::Release);
            if pruned > 0 {
                log::info!("[scheduler] 清理了 {} 条过期用量通知", pruned);
            }
            if quota_pruned > 0 {
                log::info!("[scheduler] 清理了 {} 条已完成额度提醒事件", quota_pruned);
            }
        }
        Ok(Ok((_, _, false))) => {
            log::debug!("[scheduler] WAL checkpoint 因活跃读事务延后，将在下个 tick 重试");
        }
        Ok(Err(error)) => log::warn!(
            "[scheduler] 数据库空闲维护失败，将在下个 tick 重试: {}",
            error
        ),
        Err(error) => log::warn!("[scheduler] 数据库空闲维护任务中断: {}", error),
    }
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
            service_tier: row.service_tier.clone(),
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

fn normalize_fresh_interval(seconds: u64) -> u64 {
    seconds.clamp(MIN_SCHEDULER_INTERVAL, MAX_SCHEDULER_INTERVAL)
}

fn normalize_subscription_interval(seconds: u64) -> u64 {
    seconds.clamp(MIN_SUBSCRIPTION_INTERVAL, MAX_SUBSCRIPTION_INTERVAL)
}

fn resolve_interval(ctx: &AppContext) -> u64 {
    normalize_fresh_interval(
        repositories::get_setting(&ctx.db, SCHEDULER_INTERVAL_KEY)
            .ok()
            .flatten()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(DEFAULT_SCHEDULER_INTERVAL),
    )
}

fn resolve_subscription_interval(ctx: &AppContext) -> u64 {
    normalize_subscription_interval(
        repositories::get_setting(&ctx.db, SCHEDULER_SUBSCRIPTION_INTERVAL_KEY)
            .ok()
            .flatten()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(DEFAULT_SUBSCRIPTION_INTERVAL),
    )
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

pub fn get_scheduler_subscription_interval(ctx: &AppContext) -> u64 {
    resolve_subscription_interval(ctx)
}

pub fn get_scheduler_config(ctx: &AppContext) -> SchedulerConfigPayload {
    SchedulerConfigPayload {
        enabled: is_scheduler_enabled(ctx),
        interval_seconds: get_scheduler_interval(ctx),
        subscription_interval_seconds: get_scheduler_subscription_interval(ctx),
    }
}

pub fn set_scheduler_enabled(ctx: &AppContext, enabled: bool) -> anyhow::Result<()> {
    repositories::set_setting(
        &ctx.db,
        SCHEDULER_ENABLED_KEY,
        if enabled { "1" } else { "0" },
    )
}

pub fn set_scheduler_interval(ctx: &AppContext, seconds: u64) -> anyhow::Result<()> {
    let normalized = normalize_fresh_interval(seconds);
    repositories::set_setting(&ctx.db, SCHEDULER_INTERVAL_KEY, &normalized.to_string())
}

pub fn set_scheduler_subscription_interval(ctx: &AppContext, seconds: u64) -> anyhow::Result<()> {
    let normalized = normalize_subscription_interval(seconds);
    repositories::set_setting(
        &ctx.db,
        SCHEDULER_SUBSCRIPTION_INTERVAL_KEY,
        &normalized.to_string(),
    )
}

pub fn update_scheduler_config(
    ctx: &AppContext,
    payload: SchedulerConfigPayload,
) -> anyhow::Result<SchedulerConfigPayload> {
    let interval_seconds = normalize_fresh_interval(payload.interval_seconds);
    let subscription_interval_seconds =
        normalize_subscription_interval(payload.subscription_interval_seconds);
    repositories::set_settings(
        &ctx.db,
        &[
            (
                SCHEDULER_ENABLED_KEY,
                if payload.enabled {
                    "1".to_string()
                } else {
                    "0".to_string()
                },
            ),
            (SCHEDULER_INTERVAL_KEY, interval_seconds.to_string()),
            (
                SCHEDULER_SUBSCRIPTION_INTERVAL_KEY,
                subscription_interval_seconds.to_string(),
            ),
        ],
    )?;
    Ok(SchedulerConfigPayload {
        enabled: payload.enabled,
        interval_seconds,
        subscription_interval_seconds,
    })
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
        build_usage_update_notifications, get_scheduler_config, get_scheduler_interval,
        get_scheduler_subscription_interval, is_scheduler_enabled, run_database_maintenance,
        should_enqueue_usage_update_notifications, update_scheduler_config, DataSyncScheduler,
        SchedulerDueClocks, DATABASE_MAINTENANCE_IN_PROGRESS, DEFAULT_SCHEDULER_INTERVAL,
        DEFAULT_SUBSCRIPTION_INTERVAL, FIRST_FRESH_USAGE_DELAY_MILLIS,
        HISTORY_MAINTENANCE_INTERVAL_SECONDS, LAST_DATABASE_MAINTENANCE_EPOCH,
        MAX_SCHEDULER_INTERVAL, MAX_SUBSCRIPTION_INTERVAL, MIN_SCHEDULER_INTERVAL,
        MIN_SUBSCRIPTION_INTERVAL,
    };
    use crate::{
        application::{resource_coordinator::ResourceCoordinator, AppContext},
        contracts::{SchedulerConfigPayload, UsageRow},
        infrastructure::{
            files::AppPaths,
            sqlite::{repositories, Database},
        },
    };

    static MAINTENANCE_TEST_GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
            runtime_coordination: crate::application::runtime_coordination_service::RuntimeCoordinationService::from_paths_for_test(&paths)
                .expect("initialize test runtime coordination"),
            paths,
            db,
            sync_tasks: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            live_resources: ResourceCoordinator::default(),
            native_notifications_enabled: false,
        }
    }

    fn seed_outbox_account(ctx: &AppContext) {
        let conn = ctx.db.connect().expect("open sqlite");
        conn.execute(
            "INSERT INTO sites (id, name, base_url, created_at, updated_at)
             VALUES ('scheduler-site', 'site', 'https://example.test',
                     '2026-07-19 00:00:00', '2026-07-19 00:00:00')",
            [],
        )
        .expect("seed scheduler site");
        conn.execute(
            "INSERT INTO accounts (
                id, site_id, label, email, balance_warning, last_login_at, created_at, updated_at
             ) VALUES (
                'scheduler-account', 'scheduler-site', 'account', 'account@example.test', 0, NULL,
                '2026-07-19 00:00:00', '2026-07-19 00:00:00'
             )",
            [],
        )
        .expect("seed scheduler account");
    }

    fn usage_row() -> UsageRow {
        UsageRow {
            id: "usage-1".into(),
            upstream_user_id: None,
            api_key_id: Some(8),
            upstream_account_id: None,
            request_id: None,
            created_at: "2026-07-15T13:00:00+08:00".into(),
            model: "gpt-5".into(),
            reasoning_effort: Some("high".into()),
            endpoint: None,
            upstream_endpoint: None,
            group_id: None,
            subscription_id: None,
            actual_cost: 0.012345,
            total_cost: 0.013,
            input_tokens: 120,
            output_tokens: 80,
            input_cost: None,
            output_cost: None,
            cache_creation_tokens: Some(20),
            cache_read_tokens: Some(30),
            cache_creation_5m_tokens: None,
            cache_creation_1h_tokens: None,
            cache_creation_cost: None,
            cache_read_cost: None,
            total_tokens: 250,
            first_token_ms: Some(456),
            duration_ms: None,
            billing_mode: None,
            request_type: None,
            stream: None,
            openai_ws_mode: None,
            billing_type: None,
            service_tier: Some("priority".into()),
            long_context_billing_applied: None,
            image_count: None,
            image_input_tokens: None,
            image_size: None,
            image_input_size: None,
            image_output_size: None,
            image_output_tokens: None,
            image_input_cost: None,
            image_output_cost: None,
            image_size_source: None,
            image_size_breakdown: None,
            media_type: None,
            rate_multiplier: None,
            user_agent: None,
            ip_address: None,
            cache_ttl_overridden: None,
            api_key_name: Some("prod-key".into()),
            platform: None,
            subscription_name: None,
            group_name: None,
            subscription_type: None,
        }
    }

    #[test]
    fn builds_a_floating_notification_for_each_changed_usage_row() {
        let notification = build_usage_update_notification("account-1", &usage_row())
            .expect("usage row must produce a notification");

        assert_eq!(notification.title, "用量已更新");
        assert_eq!(
            notification.account.expect("account context").label,
            "account-1"
        );
        assert_eq!(notification.dedupe_key, "usage-sync:account-1:usage-1");
        assert_eq!(
            notification.channel,
            crate::FloatingNotificationChannel::Usage
        );
        let usage = notification.usage.expect("usage details");
        assert_eq!(usage.api_key_label, "prod-key");
        assert_eq!(usage.service_tier.as_deref(), Some("priority"));
        assert_eq!(usage.cache_creation_tokens, 20);
        assert_eq!(usage.first_token_ms, Some(456));
    }

    #[test]
    fn only_the_single_flight_owner_may_enqueue_changed_usage_notifications() {
        let rows = vec![usage_row()];

        assert!(should_enqueue_usage_update_notifications(true, true, &rows));
        assert!(!should_enqueue_usage_update_notifications(
            false, true, &rows
        ));
        assert!(!should_enqueue_usage_update_notifications(
            true, false, &rows
        ));
        assert!(!should_enqueue_usage_update_notifications(true, true, &[]));
    }

    #[test]
    fn scheduler_config_uses_the_default_interval_when_not_configured() {
        let ctx = build_test_context();

        assert_eq!(get_scheduler_interval(&ctx), DEFAULT_SCHEDULER_INTERVAL);
    }

    #[test]
    fn scheduler_config_persists_all_normalized_fields_together() {
        let ctx = build_test_context();

        let config = update_scheduler_config(
            &ctx,
            SchedulerConfigPayload {
                enabled: false,
                interval_seconds: 1,
                subscription_interval_seconds: u64::MAX,
            },
        )
        .expect("update scheduler configuration");

        assert!(!config.enabled);
        assert_eq!(config.interval_seconds, MIN_SCHEDULER_INTERVAL);
        assert_eq!(
            config.subscription_interval_seconds,
            MAX_SUBSCRIPTION_INTERVAL
        );
        assert_eq!(get_scheduler_config(&ctx), config);
        assert!(!is_scheduler_enabled(&ctx));
        assert_eq!(get_scheduler_interval(&ctx), MIN_SCHEDULER_INTERVAL);
        assert_eq!(
            get_scheduler_subscription_interval(&ctx),
            MAX_SUBSCRIPTION_INTERVAL
        );
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
        assert_eq!(
            repositories::get_setting(&ctx.db, "scheduler_subscription_interval_seconds")
                .expect("read scheduler subscription interval")
                .as_deref(),
            Some(MAX_SUBSCRIPTION_INTERVAL.to_string().as_str())
        );
    }

    #[test]
    fn scheduler_config_clamps_fresh_and_subscription_intervals() {
        let ctx = build_test_context();

        assert_eq!(
            get_scheduler_subscription_interval(&ctx),
            DEFAULT_SUBSCRIPTION_INTERVAL
        );
        for (value, expected) in [
            (1, MIN_SCHEDULER_INTERVAL),
            (MIN_SCHEDULER_INTERVAL, MIN_SCHEDULER_INTERVAL),
            (MAX_SCHEDULER_INTERVAL + 1, MAX_SCHEDULER_INTERVAL),
            (u64::MAX, MAX_SCHEDULER_INTERVAL),
        ] {
            repositories::set_setting(&ctx.db, super::SCHEDULER_INTERVAL_KEY, &value.to_string())
                .expect("write fresh interval");
            assert_eq!(get_scheduler_interval(&ctx), expected);
        }
        for (value, expected) in [
            (MIN_SUBSCRIPTION_INTERVAL - 1, MIN_SUBSCRIPTION_INTERVAL),
            (MIN_SUBSCRIPTION_INTERVAL, MIN_SUBSCRIPTION_INTERVAL),
            (MAX_SUBSCRIPTION_INTERVAL + 1, MAX_SUBSCRIPTION_INTERVAL),
            (u64::MAX, MAX_SUBSCRIPTION_INTERVAL),
        ] {
            repositories::set_setting(
                &ctx.db,
                super::SCHEDULER_SUBSCRIPTION_INTERVAL_KEY,
                &value.to_string(),
            )
            .expect("write subscription interval");
            assert_eq!(get_scheduler_subscription_interval(&ctx), expected);
        }
    }

    #[test]
    fn due_clocks_schedule_first_fresh_within_one_second() {
        let now = std::time::Instant::now();
        let clocks = SchedulerDueClocks::new(now);

        assert!(clocks.next_fresh_usage <= now + Duration::from_secs(1));
        assert_eq!(
            clocks.next_fresh_usage,
            now + Duration::from_millis(FIRST_FRESH_USAGE_DELAY_MILLIS)
        );
        assert_eq!(
            clocks.next_subscriptions,
            now + Duration::from_secs(DEFAULT_SUBSCRIPTION_INTERVAL)
        );
        assert_eq!(clocks.next_history_maintenance, None);
        assert_eq!(clocks.next_database_maintenance, now);
    }

    #[test]
    fn due_clocks_advance_resources_independently_and_gate_history() {
        let now = std::time::Instant::now();
        let mut clocks = SchedulerDueClocks::new(now);
        let subscriptions_before = clocks.next_subscriptions;

        let first = clocks.collect_due(
            now + Duration::from_millis(FIRST_FRESH_USAGE_DELAY_MILLIS),
            true,
            DEFAULT_SCHEDULER_INTERVAL,
            DEFAULT_SUBSCRIPTION_INTERVAL,
        );
        assert!(first.account_work.fresh_usage);
        assert!(!first.account_work.subscriptions);
        assert!(!first.account_work.history_maintenance);
        assert_eq!(clocks.next_subscriptions, subscriptions_before);

        let settled_at = now + Duration::from_secs(2);
        clocks.mark_first_fresh_settled(settled_at);
        assert_eq!(
            clocks.next_history_maintenance,
            Some(settled_at + Duration::from_secs(HISTORY_MAINTENANCE_INTERVAL_SECONDS))
        );

        clocks.next_fresh_usage = subscriptions_before + Duration::from_secs(1);
        let fresh_before = clocks.next_fresh_usage;
        let subscriptions = clocks.collect_due(
            subscriptions_before,
            true,
            DEFAULT_SCHEDULER_INTERVAL,
            DEFAULT_SUBSCRIPTION_INTERVAL,
        );
        assert!(subscriptions.account_work.subscriptions);
        assert_eq!(clocks.next_fresh_usage, fresh_before);
    }

    #[test]
    fn disabled_due_clocks_do_not_admit_upstream_work() {
        let now = std::time::Instant::now();
        let mut clocks = SchedulerDueClocks::new(now);
        clocks.mark_first_fresh_settled(now);

        let snapshot = clocks.collect_due(
            now + Duration::from_secs(HISTORY_MAINTENANCE_INTERVAL_SECONDS),
            false,
            DEFAULT_SCHEDULER_INTERVAL,
            DEFAULT_SUBSCRIPTION_INTERVAL,
        );

        assert!(snapshot.account_work.is_empty());
        assert!(snapshot.database_maintenance);
    }

    #[tokio::test]
    async fn headless_scheduler_starts_and_stops_without_a_tauri_app_handle() {
        let _guard = MAINTENANCE_TEST_GUARD.lock().await;
        LAST_DATABASE_MAINTENANCE_EPOCH.store(0, Ordering::Release);
        DATABASE_MAINTENANCE_IN_PROGRESS.store(false, Ordering::Release);

        let scheduler = DataSyncScheduler::start_headless(build_test_context());

        assert!(scheduler.is_running());
        for _ in 0..100 {
            if LAST_DATABASE_MAINTENANCE_EPOCH.load(Ordering::Acquire) > 0
                && !DATABASE_MAINTENANCE_IN_PROGRESS.load(Ordering::Acquire)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        scheduler.stop();
        assert!(!scheduler.is_running());
        assert!(LAST_DATABASE_MAINTENANCE_EPOCH.load(Ordering::Acquire) > 0);
        LAST_DATABASE_MAINTENANCE_EPOCH.store(0, Ordering::Release);
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
        assert!(waiter.await.expect("waiter task").expect("tick task"));
        assert!(completed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn database_maintenance_prunes_expired_outbox_records() {
        let _guard = MAINTENANCE_TEST_GUARD.lock().await;
        LAST_DATABASE_MAINTENANCE_EPOCH.store(0, Ordering::Release);
        DATABASE_MAINTENANCE_IN_PROGRESS.store(false, Ordering::Release);

        let ctx = build_test_context();
        seed_outbox_account(&ctx);
        let expired_at = crate::infrastructure::datetime::format_storage_timestamp(
            chrono::Utc::now() - chrono::Duration::days(8),
        );
        let current_at = crate::infrastructure::datetime::now_storage_timestamp();
        assert!(repositories::enqueue_usage_notification(
            &ctx.db,
            "scheduler-account",
            "expired-notification",
            "usage-sync:scheduler-account:expired",
            "{\"id\":\"expired-notification\"}",
            &expired_at,
        )
        .expect("enqueue expired notification"));
        assert!(repositories::enqueue_usage_notification(
            &ctx.db,
            "scheduler-account",
            "current-notification",
            "usage-sync:scheduler-account:current",
            "{\"id\":\"current-notification\"}",
            &current_at,
        )
        .expect("enqueue current notification"));

        run_database_maintenance(&ctx).await;

        assert_eq!(
            repositories::list_usage_notifications(&ctx.db)
                .expect("load retained notifications")
                .iter()
                .map(|record| record.id.as_str())
                .collect::<Vec<_>>(),
            ["current-notification"]
        );
        assert!(LAST_DATABASE_MAINTENANCE_EPOCH.load(Ordering::Acquire) > 0);
        LAST_DATABASE_MAINTENANCE_EPOCH.store(0, Ordering::Release);
    }
}
