use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::time::interval;

use crate::application::{data_center_service, AppContext};
use crate::contracts::{DataSyncScope, DataSyncTrigger, SyncAccountDataInput};
use crate::infrastructure::sqlite::repositories;

const SCHEDULER_ENABLED_KEY: &str = "scheduler_enabled";
const SCHEDULER_INTERVAL_KEY: &str = "scheduler_interval_seconds";
const DEFAULT_SCHEDULER_INTERVAL: u64 = 9;
const MAX_SYNC_DURATION_SECONDS: u64 = 300; // 5分钟超时保护

#[derive(Clone)]
pub struct DataSyncScheduler {
    running: Arc<AtomicBool>,
}

impl DataSyncScheduler {
    pub fn start(ctx: AppContext) -> Self {
        let running = Arc::new(AtomicBool::new(true));
        let running_for_task = Arc::clone(&running);
        let ctx_for_task = ctx.clone();

        tauri::async_runtime::spawn(async move {
            // 动态间隔：每次 tick 重新读取配置，支持运行时修改
            let mut ticker = interval(Duration::from_secs(resolve_interval(&ctx_for_task)));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut last_interval = resolve_interval(&ctx_for_task);
            // 重入保护：防止单次同步耗时超过间隔时，并发执行多批同步
            let in_progress = Arc::new(AtomicBool::new(false));

            loop {
                ticker.tick().await;
                if !running_for_task.load(Ordering::Relaxed) {
                    break;
                }
                // 动态重新读取间隔，支持用户修改后立即生效
                let current_interval = resolve_interval(&ctx_for_task);
                if current_interval != last_interval {
                    log::info!("[scheduler] 间隔从 {} 秒调整为 {} 秒", last_interval, current_interval);
                    ticker = interval(Duration::from_secs(current_interval));
                    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    last_interval = current_interval;
                }
                // 如果上一次 tick 还没完成，跳过本次
                if in_progress.load(Ordering::Relaxed) {
                    log::warn!("[scheduler] 上一次同步仍在进行中，跳过本次 tick");
                    continue;
                }
                let in_progress_for_tick = Arc::clone(&in_progress);
                tick_with_guard(&ctx_for_task, in_progress_for_tick).await;
            }
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

async fn tick_with_guard(ctx: &AppContext, in_progress: Arc<AtomicBool>) {
    in_progress.store(true, Ordering::Relaxed);
    let result = tokio::time::timeout(
        Duration::from_secs(MAX_SYNC_DURATION_SECONDS),
        tick(ctx)
    ).await;
    in_progress.store(false, Ordering::Relaxed);

    if let Err(_) = result {
        log::error!("[scheduler] 单次同步超时（超过 {} 秒），强制释放锁", MAX_SYNC_DURATION_SECONDS);
    }
}

async fn tick(ctx: &AppContext) {
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
    log::info!("[scheduler] 开始调度同步，共 {} 个账号，全部并行", total);

    let mut set = tokio::task::JoinSet::new();
    for (idx, account_id) in account_ids.into_iter().enumerate() {
        let ctx = ctx.clone();
        set.spawn(async move {
            let start = std::time::Instant::now();
            let result = data_center_service::sync_account_data(
                &ctx,
                &account_id,
                SyncAccountDataInput {
                    scope: DataSyncScope::Full,
                    trigger_source: DataSyncTrigger::Auto,
                },
            ).await;
            match result {
                Ok(_) => {
                    log::info!(
                        "[scheduler] [{}/{}] 账号 {} 同步完成，耗时 {:?}",
                        idx + 1, total, account_id, start.elapsed()
                    );
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

fn resolve_interval(ctx: &AppContext) -> u64 {
    repositories::get_setting(&ctx.db, SCHEDULER_INTERVAL_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_SCHEDULER_INTERVAL)
        .max(1)
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
    let normalized = seconds.max(1);
    repositories::set_setting(&ctx.db, SCHEDULER_INTERVAL_KEY, &normalized.to_string())
}
