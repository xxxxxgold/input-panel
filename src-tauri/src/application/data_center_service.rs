use anyhow::{Context, Result};
use chrono::{Days, NaiveDate, Utc};
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration as StdDuration, Instant as StdInstant};
use tokio::sync::{Mutex, Notify, OwnedMutexGuard, OwnedSemaphorePermit};
use tokio::task::JoinSet;
use uuid::Uuid;

use crate::contracts::{
    AccountSyncProgress, AccountSyncProgressDetail, AccountSyncProgressPhase,
    AccountSyncProgressStage, AccountSyncProgressStageId, AccountSyncProgressStageState,
    AccountSyncProgressUnit, AccountSyncState, AccountSyncStatusPayload, AccountSyncStatusRecord,
    DataSyncScope, DataSyncTrigger, GroupRecord, ManagedKeyRecord, PlatformQuotaPayload,
    RefreshAccountTaskResponse, RefreshTriggerSource, SubscriptionRecord,
    SubscriptionSummaryPayload, SyncAccountDataInput, SyncFailureCategory, SyncFailurePayload,
    SyncFailureResponse, TaskRunRecord, TaskRunStatus, UsageRow, UserProfileRecord,
};
use crate::infrastructure::datetime::{
    now_storage_timestamp, shanghai_today, storage_timestamp_date,
};
use crate::infrastructure::sqlite::repositories;
use crate::infrastructure::sub2api::client::{UpstreamFailure, UpstreamFailureCategory};
use crate::infrastructure::sub2api::normalizers::{
    normalize_group_record, normalize_items, normalize_managed_key_record,
    normalize_platform_quotas, normalize_profile, normalize_subscription_summary,
    normalize_usage_row,
};

use super::{
    account_service, auth_service,
    resource_coordinator::{LiveResourceKind, MAX_USAGE_PAGE_SLOTS},
    runtime_coordination_service::AccountLeaseGuard,
    site_failover_service::{self, SiteFailoverReadClient},
    subscription_snapshot_service::{
        self, SubscriptionProcessingCapabilities, SubscriptionSnapshotOrigin,
    },
    upstream_service::{self, UpstreamRequestPolicy},
    AppContext,
};

const DATA_CENTER_USAGE_REPAIR_DONE_KEY: &str = "data_center_usage_repair_done_v1";
const USAGE_PAGE_SIZE: i64 = 1_000;
const AUTO_LATEST_USAGE_PAGE_SIZE: i64 = 100;
const MAX_AUTO_LATEST_USAGE_PAGES: i64 = 50;
const MAX_EARLIEST_USAGE_PROBE_ATTEMPTS: usize = 3;
const MAX_USAGE_WINDOW_ATTEMPTS: usize = 3;
const USAGE_WINDOW_CHANGED_ERROR: &str = "用量日期窗口在读取期间发生变化，请重试。";
const EARLIEST_USAGE_PROBE_METADATA_CHANGED_ERROR: &str = "上游用量最早日期探针分页元数据不一致。";
const HISTORY_MAINTENANCE_QUANTUM_SECONDS: u64 = 4;

/// 仅标识最早日期探针因活跃数据持续增长而耗尽有限重试次数。
#[derive(Debug)]
struct EarliestUsageProbeGrowthExhausted;

impl std::fmt::Display for EarliestUsageProbeGrowthExhausted {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(EARLIEST_USAGE_PROBE_METADATA_CHANGED_ERROR)
    }
}

impl std::error::Error for EarliestUsageProbeGrowthExhausted {}

#[derive(Debug, Clone)]
pub struct SyncAccountDataResult {
    pub item_count: i64,
    pub status: AccountSyncStatusPayload,
    pub run: TaskRunRecord,
    pub changed_usage_rows: Vec<UsageRow>,
    pub(crate) notification_owner: bool,
    pub(crate) usage_notification_eligible: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct SyncExecutionResult {
    status: AccountSyncStatusPayload,
    changed_usage_rows: Vec<UsageRow>,
    usage_notification_eligible: bool,
}

#[derive(Debug, Clone)]
struct UsageSyncResult {
    item_count: i64,
    changed_rows: Vec<UsageRow>,
}

#[derive(Clone)]
struct UsagePageAnchor {
    created_at: String,
    id: String,
}

struct UsagePageEnvelope {
    page: i64,
    page_size: i64,
    total: i64,
    pages: i64,
    items: Vec<UsageRow>,
    first_anchor: Option<UsagePageAnchor>,
    last_anchor: Option<UsagePageAnchor>,
}

struct FetchedUsagePage {
    envelope: UsagePageEnvelope,
    _page_slot: OwnedSemaphorePermit,
}

struct UsageWindowResult {
    merged_count: i64,
    changed_rows: Vec<UsageRow>,
}

enum UsageWindowOutcome {
    Completed(UsageWindowResult),
    Yielded { merged_count: i64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryMaintenanceOutcome {
    Completed { merged_count: i64 },
    Yielded { merged_count: i64 },
}

struct HistoryQuantum<'a> {
    started_at: StdInstant,
    max_duration: StdDuration,
    lease: &'a AccountLeaseGuard,
}

impl<'a> HistoryQuantum<'a> {
    fn new(lease: &'a AccountLeaseGuard) -> Self {
        Self {
            started_at: StdInstant::now(),
            max_duration: StdDuration::from_secs(HISTORY_MAINTENANCE_QUANTUM_SECONDS),
            lease,
        }
    }

    #[cfg(test)]
    fn with_max_duration(lease: &'a AccountLeaseGuard, max_duration: StdDuration) -> Self {
        Self {
            started_at: StdInstant::now(),
            max_duration,
            lease,
        }
    }

    async fn should_yield(&self) -> bool {
        if self.started_at.elapsed() >= self.max_duration {
            return true;
        }
        match self.lease.should_yield_to_peer().await {
            Ok(should_yield) => should_yield,
            Err(error) => {
                log::warn!(
                    "[usage-history] 无法读取 peer demand，当前 history quantum 主动让行: {error}"
                );
                true
            }
        }
    }
}

async fn history_quantum_should_yield(quantum: Option<&HistoryQuantum<'_>>) -> bool {
    match quantum {
        Some(quantum) => quantum.should_yield().await,
        None => false,
    }
}

fn completed_usage_window(outcome: UsageWindowOutcome) -> Result<UsageWindowResult> {
    match outcome {
        UsageWindowOutcome::Completed(result) => Ok(result),
        UsageWindowOutcome::Yielded { .. } => {
            Err(anyhow::anyhow!("非 cooperative 用量读取意外进入让行状态。"))
        }
    }
}

/// 记录一次 usage 操作中已成功写入 SQLite 的事实，供最终入口统一决定缓存失效。
#[derive(Clone, Default)]
struct UsageWriteTracker {
    persisted_changes: Arc<AtomicBool>,
}

impl UsageWriteTracker {
    fn record_merge(&self, merged_count: i64) {
        if merged_count > 0 {
            self.persisted_changes.store(true, Ordering::Release);
        }
    }

    fn has_persisted_changes(&self) -> bool {
        self.persisted_changes.load(Ordering::Acquire)
    }
}

#[derive(Clone)]
struct SyncProgressReporter {
    task_handle: Arc<super::context::SyncTaskHandle>,
}

impl SyncProgressReporter {
    fn new(task_handle: Arc<super::context::SyncTaskHandle>) -> Self {
        Self { task_handle }
    }

    async fn set_stage_state(
        &self,
        id: AccountSyncProgressStageId,
        stage_state: AccountSyncProgressStageState,
    ) {
        let mut task_state = self.task_handle.state.lock().await;
        let Some(progress) = task_state.progress.as_mut() else {
            return;
        };
        if let Some(stage) = progress.stages.iter_mut().find(|stage| stage.id == id) {
            stage.state = stage_state;
        }
    }

    async fn set_usage_detail(&self, detail: AccountSyncProgressDetail) {
        let mut task_state = self.task_handle.state.lock().await;
        let Some(progress) = task_state.progress.as_mut() else {
            return;
        };
        if let Some(stage) = progress
            .stages
            .iter_mut()
            .find(|stage| stage.id == AccountSyncProgressStageId::Usage)
        {
            stage.state = AccountSyncProgressStageState::Running;
            stage.detail = Some(detail);
        }
    }

    async fn cancel_unfinished_stages(&self) {
        let mut task_state = self.task_handle.state.lock().await;
        let Some(progress) = task_state.progress.as_mut() else {
            return;
        };
        for stage in &mut progress.stages {
            if matches!(
                stage.state,
                AccountSyncProgressStageState::Pending | AccountSyncProgressStageState::Running
            ) {
                stage.state = AccountSyncProgressStageState::Cancelled;
            }
        }
    }
}

fn progress_stage(
    id: AccountSyncProgressStageId,
    state: AccountSyncProgressStageState,
) -> AccountSyncProgressStage {
    AccountSyncProgressStage {
        id,
        state,
        detail: None,
    }
}

fn initial_sync_progress(scope: &DataSyncScope) -> AccountSyncProgress {
    let running = AccountSyncProgressStageState::Running;
    let stages = match scope {
        DataSyncScope::Core => vec![progress_stage(AccountSyncProgressStageId::Core, running)],
        DataSyncScope::Subscriptions => vec![progress_stage(
            AccountSyncProgressStageId::Subscriptions,
            running,
        )],
        DataSyncScope::Keys => vec![progress_stage(AccountSyncProgressStageId::Keys, running)],
        DataSyncScope::Usage => vec![progress_stage(AccountSyncProgressStageId::Usage, running)],
        DataSyncScope::Full => vec![
            progress_stage(AccountSyncProgressStageId::Core, running),
            progress_stage(AccountSyncProgressStageId::Keys, running),
            progress_stage(AccountSyncProgressStageId::Usage, running),
            progress_stage(
                AccountSyncProgressStageId::SubscriptionRules,
                AccountSyncProgressStageState::Pending,
            ),
        ],
    };
    AccountSyncProgress { stages }
}

fn usage_progress_detail(
    phase: AccountSyncProgressPhase,
    processed: Option<i64>,
    total: Option<i64>,
    unit: Option<AccountSyncProgressUnit>,
    current_date: Option<String>,
    attempt: Option<i64>,
) -> AccountSyncProgressDetail {
    AccountSyncProgressDetail {
        phase: Some(phase),
        processed,
        total,
        unit,
        current_date,
        attempt,
        wait: None,
    }
}

fn sync_failure_category(category: UpstreamFailureCategory) -> SyncFailureCategory {
    match category {
        UpstreamFailureCategory::Unauthorized => SyncFailureCategory::Unauthorized,
        UpstreamFailureCategory::RateLimited => SyncFailureCategory::RateLimited,
        UpstreamFailureCategory::Http => SyncFailureCategory::Http,
        UpstreamFailureCategory::Timeout => SyncFailureCategory::Timeout,
        UpstreamFailureCategory::Transport => SyncFailureCategory::Transport,
        UpstreamFailureCategory::Decode => SyncFailureCategory::Decode,
        UpstreamFailureCategory::Business => SyncFailureCategory::Business,
    }
}

fn sync_failure_message(failure: &UpstreamFailure, retry_exhausted: bool) -> String {
    match failure.category {
        UpstreamFailureCategory::Unauthorized => "账号认证已失效，请重新登录。".to_string(),
        UpstreamFailureCategory::RateLimited if retry_exhausted => {
            "上游持续限流，本轮重试已用尽，将在后续自动同步中继续恢复。".to_string()
        }
        UpstreamFailureCategory::RateLimited => "上游请求受限，请稍后重试。".to_string(),
        UpstreamFailureCategory::Timeout => "上游服务响应超时，请稍后重试。".to_string(),
        UpstreamFailureCategory::Transport => "请求上游服务失败，请检查网络后重试。".to_string(),
        UpstreamFailureCategory::Decode => "上游响应解析失败。".to_string(),
        UpstreamFailureCategory::Http => "上游请求失败，请稍后重试。".to_string(),
        UpstreamFailureCategory::Business => "上游接口返回业务错误。".to_string(),
    }
}

fn sync_failure_payload_from_upstream(failure: &UpstreamFailure) -> SyncFailurePayload {
    let retry_exhausted = failure.is_switchable_address_failure();
    SyncFailurePayload {
        category: sync_failure_category(failure.category),
        message: sync_failure_message(failure, retry_exhausted),
        code: None,
        http_status: failure.http_status,
        retry_at: None,
        retry_after_ms: failure.retry_after_ms,
        retry_exhausted,
    }
}

fn sync_failure_payload_from_failover(error: &anyhow::Error) -> Option<SyncFailurePayload> {
    let (_, payload) = site_failover_service::transport_error_payload(error)?;
    let category = if payload.code == "all_site_addresses_rate_limited" {
        SyncFailureCategory::RateLimited
    } else {
        SyncFailureCategory::Transport
    };
    Some(SyncFailurePayload {
        category,
        message: payload.error,
        code: Some(payload.code),
        http_status: payload.http_status,
        retry_at: payload.retry_at,
        retry_after_ms: payload.retry_after_ms,
        retry_exhausted: true,
    })
}

fn sync_task_failure(error: anyhow::Error) -> super::context::SyncTaskFailure {
    let payload = sync_failure_payload_from_failover(&error)
        .or_else(|| {
            error
                .downcast_ref::<UpstreamFailure>()
                .map(sync_failure_payload_from_upstream)
        })
        .unwrap_or_else(|| SyncFailurePayload {
            category: SyncFailureCategory::Internal,
            message: "账号数据同步失败，请稍后重试。".to_string(),
            code: None,
            http_status: None,
            retry_at: None,
            retry_after_ms: None,
            retry_exhausted: false,
        });
    super::context::SyncTaskFailure { payload }
}

pub(crate) fn sync_failure_response_from_error(error: &anyhow::Error) -> SyncFailureResponse {
    let failure = sync_failure_payload_from_failover(error)
        .or_else(|| {
            error
                .downcast_ref::<super::context::SyncTaskFailure>()
                .map(|failure| failure.payload.clone())
        })
        .or_else(|| {
            error
                .downcast_ref::<UpstreamFailure>()
                .map(sync_failure_payload_from_upstream)
        })
        .unwrap_or_else(|| SyncFailurePayload {
            category: SyncFailureCategory::Internal,
            message: "账号数据同步失败，请稍后重试。".to_string(),
            code: None,
            http_status: None,
            retry_at: None,
            retry_after_ms: None,
            retry_exhausted: false,
        });
    SyncFailureResponse {
        error: failure.message.clone(),
        failure,
    }
}

async fn run_progress_stage<T, F>(
    reporter: &SyncProgressReporter,
    stage: AccountSyncProgressStageId,
    future: F,
) -> Result<T>
where
    F: Future<Output = Result<T>>,
{
    reporter
        .set_stage_state(stage, AccountSyncProgressStageState::Running)
        .await;
    let result = future.await;
    reporter
        .set_stage_state(
            stage,
            if result.is_ok() {
                AccountSyncProgressStageState::Succeeded
            } else {
                AccountSyncProgressStageState::Failed
            },
        )
        .await;
    result
}

#[derive(Clone, Copy)]
enum UsageHistoryCheckpointPolicy {
    Track,
    Preserve,
}

/// 日期窗口读取的一致性策略。
#[derive(Clone, Copy)]
enum UsageWindowConsistency {
    Strict,
    OpenSnapshot,
}

impl UsageWindowConsistency {
    /// 仅将上海时区的今天和昨天视为仍可追加记录的开放日期。
    fn for_date(date: NaiveDate) -> Self {
        let today = shanghai_today();
        if date <= today && is_recent_usage_date(date, today) {
            Self::OpenSnapshot
        } else {
            Self::Strict
        }
    }

    /// 严格窗口要求元数据不变，开放快照只接受单调增长。
    fn metadata_matches(
        self,
        page: &UsagePageEnvelope,
        expected_total: i64,
        expected_pages: i64,
        expected_page_size: i64,
    ) -> bool {
        match self {
            Self::Strict => usage_page_metadata_matches(
                page,
                expected_total,
                expected_pages,
                expected_page_size,
            ),
            Self::OpenSnapshot => {
                page.total >= expected_total
                    && page.pages >= expected_pages
                    && page.page_size == expected_page_size
            }
        }
    }
}

#[derive(Clone, Copy)]
enum UsagePageOrder {
    Asc,
    Desc,
}

impl UsagePageOrder {
    fn query_value(self) -> &'static str {
        match self {
            Self::Asc => "asc",
            Self::Desc => "desc",
        }
    }

    fn is_ordered(self, previous: &UsagePageAnchor, current: &UsagePageAnchor) -> bool {
        let previous_key = (previous.created_at.as_str(), previous.id.as_str());
        let current_key = (current.created_at.as_str(), current.id.as_str());
        match self {
            Self::Asc => previous_key <= current_key,
            Self::Desc => previous_key >= current_key,
        }
    }
}

#[derive(Clone, Copy)]
enum LatestUsageStopReason {
    CachedTail,
    NaturalEnd,
    PageBudget,
}

impl LatestUsageStopReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::CachedTail => "cached_tail",
            Self::NaturalEnd => "natural_end",
            Self::PageBudget => "page_budget",
        }
    }
}

pub async fn sync_account_data(
    ctx: &AppContext,
    account_id: &str,
    input: SyncAccountDataInput,
) -> Result<SyncAccountDataResult> {
    ctx.db.ensure_requests_available()?;
    sync_account_data_with_usage_gate(ctx, account_id, input, None).await
}

/// 创建尚未执行的同步任务句柄，供首次启动和同 scope 终态替换共用。
fn create_sync_task_handle(
    account_id: &str,
    input: &SyncAccountDataInput,
) -> Arc<super::context::SyncTaskHandle> {
    let run = TaskRunRecord {
        id: Uuid::new_v4().to_string(),
        account_id: account_id.to_string(),
        scope: input.scope.clone(),
        primary_trigger_source: input.trigger_source.clone(),
        status: TaskRunStatus::Running,
        join_count: 0,
        started_at: Utc::now().to_rfc3339(),
        finished_at: None,
        error_message: None,
    };
    Arc::new(super::context::SyncTaskHandle {
        state: Mutex::new(super::context::SyncTaskState {
            run,
            progress: Some(initial_sync_progress(&input.scope)),
            completed: false,
            result: None,
        }),
        notify: Notify::new(),
    })
}

async fn sync_account_data_with_usage_gate(
    ctx: &AppContext,
    account_id: &str,
    input: SyncAccountDataInput,
    usage_gate: Option<OwnedMutexGuard<()>>,
) -> Result<SyncAccountDataResult> {
    let task_key = format!("{}:{}", account_id, sync_scope_key(&input.scope));
    let (task_handle, is_primary) = loop {
        let existing = {
            let tasks = ctx.sync_tasks.lock().await;
            tasks.get(&task_key).cloned()
        };
        if let Some(existing) = existing {
            let mut state = existing.state.lock().await;
            if !state.completed {
                state.run.join_count += 1;
                drop(state);
                break (existing, false);
            }
            drop(state);

            let replacement = create_sync_task_handle(account_id, &input);
            let mut tasks = ctx.sync_tasks.lock().await;
            if tasks
                .get(&task_key)
                .is_some_and(|current| Arc::ptr_eq(current, &existing))
            {
                // 保持 Usage 终态到下一 run 的替换连续可观察，不能留下无 runId 的缓存窗口。
                tasks.insert(task_key.clone(), Arc::clone(&replacement));
                break (replacement, true);
            }
            continue;
        }

        let handle = create_sync_task_handle(account_id, &input);
        let mut tasks = ctx.sync_tasks.lock().await;
        if tasks.contains_key(&task_key) {
            continue;
        }
        tasks.insert(task_key.clone(), Arc::clone(&handle));
        break (handle, true);
    };

    if !is_primary {
        // 自动调度已经预先拿到 usage gate；加入既有 run 时必须先释放，避免与主任务互等。
        drop(usage_gate);
        return wait_for_sync_task(task_handle, false).await;
    }

    let ctx_for_spawn = ctx.clone();
    let account_id_for_spawn = account_id.to_string();
    let input_for_spawn = input.clone();
    let task_key_for_spawn = task_key.clone();
    let task_handle_for_spawn = Arc::clone(&task_handle);
    let progress_reporter = SyncProgressReporter::new(Arc::clone(&task_handle));
    // Usage 是任务中心独立展示的外层任务，需和 Full 一样保留最近终态。
    let retain_terminal_state = matches!(input.scope, DataSyncScope::Full | DataSyncScope::Usage);
    tokio::spawn(async move {
        let sync_future = run_sync_account_data(
            &ctx_for_spawn,
            &account_id_for_spawn,
            input_for_spawn,
            usage_gate,
            progress_reporter,
        );
        let result = sync_future.await.map_err(sync_task_failure);
        {
            let mut state = task_handle_for_spawn.state.lock().await;
            state.run.status = if result.is_ok() {
                TaskRunStatus::Succeeded
            } else {
                TaskRunStatus::Failed
            };
            state.run.finished_at = Some(Utc::now().to_rfc3339());
            state.run.error_message = result
                .as_ref()
                .err()
                .map(|failure| failure.payload.message.clone());
            state.completed = true;
            state.result = Some(result);
        }
        task_handle_for_spawn.notify.notify_waiters();
        if !retain_terminal_state {
            let mut tasks = ctx_for_spawn.sync_tasks.lock().await;
            if tasks
                .get(&task_key_for_spawn)
                .is_some_and(|current| Arc::ptr_eq(current, &task_handle_for_spawn))
            {
                tasks.remove(&task_key_for_spawn);
            }
        }
    });

    wait_for_sync_task(task_handle, true).await
}

pub fn schedule_bootstrap_sync(ctx: &AppContext, account_id: String) {
    let ctx = ctx.clone();
    tokio::spawn(async move {
        if let Err(error) = sync_account_data(
            &ctx,
            &account_id,
            SyncAccountDataInput {
                scope: DataSyncScope::Full,
                trigger_source: DataSyncTrigger::Bootstrap,
            },
        )
        .await
        {
            log::warn!("[auth] 账号 {} 登录后初始化同步失败: {}", account_id, error);
        }
    });
}

pub async fn has_running_full_sync(ctx: &AppContext, account_id: &str) -> bool {
    let task_handle = {
        let tasks = ctx.sync_tasks.lock().await;
        tasks.get(&format!("{}:full", account_id)).cloned()
    };
    match task_handle {
        Some(task_handle) => !task_handle.state.lock().await.completed,
        None => false,
    }
}

async fn wait_for_sync_task(
    task_handle: Arc<super::context::SyncTaskHandle>,
    notification_owner: bool,
) -> Result<SyncAccountDataResult> {
    loop {
        let maybe_done = {
            let state = task_handle.state.lock().await;
            if state.completed {
                Some((state.result.clone(), state.run.clone()))
            } else {
                None
            }
        };
        if let Some((result, _run)) = maybe_done {
            let execution = result
                .ok_or_else(|| anyhow::anyhow!("同步任务状态异常: 已完成但没有结果。"))?
                .map_err(anyhow::Error::new)?;
            let item_count = execution
                .status
                .statuses
                .iter()
                .map(|item| item.item_count)
                .sum();
            return Ok(SyncAccountDataResult {
                item_count,
                run: _run,
                status: execution.status,
                changed_usage_rows: execution.changed_usage_rows,
                notification_owner,
                usage_notification_eligible: execution.usage_notification_eligible,
            });
        }
        task_handle.notify.notified().await;
    }
}

/// 将大型同步状态机固定在堆上，避免 Full 分支在 Windows 默认线程栈内联展开。
fn run_sync_account_data<'a>(
    ctx: &'a AppContext,
    account_id: &'a str,
    input: SyncAccountDataInput,
    usage_gate: Option<OwnedMutexGuard<()>>,
    reporter: SyncProgressReporter,
) -> Pin<Box<dyn Future<Output = Result<SyncExecutionResult>> + Send + 'a>> {
    Box::pin(run_sync_account_data_inner(
        ctx, account_id, input, usage_gate, reporter,
    ))
}

async fn run_sync_account_data_inner(
    ctx: &AppContext,
    account_id: &str,
    input: SyncAccountDataInput,
    usage_gate: Option<OwnedMutexGuard<()>>,
    reporter: SyncProgressReporter,
) -> Result<SyncExecutionResult> {
    let mut statuses = Vec::new();
    let mut changed_usage_rows = Vec::new();
    let completed_scope = input.scope.clone();
    match input.scope {
        DataSyncScope::Core => {
            let trigger_source = input.trigger_source.clone();
            let core = run_progress_stage(
                &reporter,
                AccountSyncProgressStageId::Core,
                sync_core_scope_outcome(ctx, account_id, trigger_source),
            )
            .await?;
            statuses.push(success_status(
                account_id,
                DataSyncScope::Core,
                core.item_count,
            ));
            process_core_sync_outcome(
                ctx,
                account_id,
                &core,
                SubscriptionSnapshotOrigin::CoreSync,
                true,
            )
            .await;
        }
        DataSyncScope::Subscriptions => {
            let subscriptions = run_progress_stage(
                &reporter,
                AccountSyncProgressStageId::Subscriptions,
                sync_subscriptions_scope_outcome(ctx, account_id),
            )
            .await?;
            statuses.push(success_status(
                account_id,
                DataSyncScope::Subscriptions,
                subscriptions.item_count,
            ));
            process_core_sync_outcome(
                ctx,
                account_id,
                &subscriptions,
                SubscriptionSnapshotOrigin::CoreSync,
                true,
            )
            .await;
        }
        DataSyncScope::Keys => {
            let item_count = run_progress_stage(
                &reporter,
                AccountSyncProgressStageId::Keys,
                sync_keys_scope(ctx, account_id, input.trigger_source),
            )
            .await?;
            statuses.push(success_status(account_id, DataSyncScope::Keys, item_count));
        }
        DataSyncScope::Usage => {
            let usage_writes = UsageWriteTracker::default();
            let usage_sync = async {
                let _usage_gate = match usage_gate {
                    Some(gate) => gate,
                    None => {
                        ctx.live_resources
                            .acquire_usage_account_gate(account_id)
                            .await
                    }
                };
                sync_usage_scope_with_changes_under_usage_gate(
                    ctx,
                    account_id,
                    input.trigger_source.clone(),
                    None,
                    None,
                    Some(&reporter),
                    &usage_writes,
                )
                .await
            };
            let usage_result =
                run_progress_stage(&reporter, AccountSyncProgressStageId::Usage, usage_sync).await;
            invalidate_dashboard_stats_if_usage_changed(ctx, account_id, &usage_writes).await;
            let usage = match usage_result {
                Ok(usage) => usage,
                Err(error) => {
                    mark_rate_limited_usage_history_degraded(ctx, account_id, &error);
                    return Err(error);
                }
            };
            statuses.push(success_status(
                account_id,
                DataSyncScope::Usage,
                usage.item_count,
            ));
            changed_usage_rows = usage.changed_rows;
        }
        DataSyncScope::Full => {
            let usage_writes = UsageWriteTracker::default();
            let usage_writes_for_sync = usage_writes.clone();
            let usage_sync = async {
                let _usage_gate = match usage_gate {
                    Some(gate) => gate,
                    None => {
                        ctx.live_resources
                            .acquire_usage_account_gate(account_id)
                            .await
                    }
                };
                sync_initial_usage_history_if_needed_under_usage_gate(
                    ctx,
                    account_id,
                    Some(&reporter),
                    None,
                    &usage_writes_for_sync,
                )
                .await?;
                let result = sync_usage_scope_with_changes_under_usage_gate(
                    ctx,
                    account_id,
                    input.trigger_source.clone(),
                    None,
                    None,
                    Some(&reporter),
                    &usage_writes_for_sync,
                )
                .await;
                if let Err(error) = result.as_ref() {
                    mark_rate_limited_usage_history_degraded(ctx, account_id, error);
                }
                result
            };
            let joined = tokio::try_join!(
                run_progress_stage(
                    &reporter,
                    AccountSyncProgressStageId::Core,
                    sync_core_scope_outcome(ctx, account_id, input.trigger_source.clone()),
                ),
                run_progress_stage(
                    &reporter,
                    AccountSyncProgressStageId::Keys,
                    sync_keys_scope(ctx, account_id, input.trigger_source.clone()),
                ),
                run_progress_stage(&reporter, AccountSyncProgressStageId::Usage, usage_sync,)
            );
            let (core, keys_count, usage) = match joined {
                Ok(result) => result,
                Err(error) => {
                    invalidate_dashboard_stats_if_usage_changed(ctx, account_id, &usage_writes)
                        .await;
                    reporter.cancel_unfinished_stages().await;
                    return Err(error);
                }
            };
            statuses.push(success_status(
                account_id,
                DataSyncScope::Core,
                core.item_count,
            ));
            statuses.push(success_status(account_id, DataSyncScope::Keys, keys_count));
            statuses.push(success_status(
                account_id,
                DataSyncScope::Usage,
                usage.item_count,
            ));
            changed_usage_rows = usage.changed_rows;
            invalidate_dashboard_stats_if_usage_changed(ctx, account_id, &usage_writes).await;
            let _ = run_progress_stage(
                &reporter,
                AccountSyncProgressStageId::SubscriptionRules,
                async {
                    let report = process_core_sync_outcome(
                        ctx,
                        account_id,
                        &core,
                        SubscriptionSnapshotOrigin::FullSync,
                        true,
                    )
                    .await;
                    Ok::<_, anyhow::Error>(report.switch_evaluation_count as i64)
                },
            )
            .await?;
        }
    }

    let completed_usage_scope = matches!(
        completed_scope.clone(),
        DataSyncScope::Usage | DataSyncScope::Full
    );
    let usage_notification_eligible = if completed_usage_scope {
        ctx.live_resources
            .complete_usage_sync_and_should_notify(account_id)
            .await
    } else {
        false
    };

    Ok(SyncExecutionResult {
        status: AccountSyncStatusPayload {
            account_id: account_id.to_string(),
            statuses,
        },
        changed_usage_rows,
        usage_notification_eligible,
    })
}

fn mark_rate_limited_usage_history_degraded(
    ctx: &AppContext,
    account_id: &str,
    error: &anyhow::Error,
) {
    if !upstream_service::is_rate_limited_error(error) {
        return;
    }
    if let Err(state_error) = repositories::mark_usage_history_issue(
        &ctx.db,
        account_id,
        repositories::UsageHistoryState::Degraded,
        &sync_failure_message(
            error
                .downcast_ref::<UpstreamFailure>()
                .expect("rate-limited errors retain UpstreamFailure"),
            true,
        ),
        &usage_sync_timestamp(),
    ) {
        log::warn!("[usage-history] 无法记录限流降级状态: {state_error}");
    }
}

/// DashboardStats 依赖 usage 缓存，只在本次操作实际写入 SQLite 后丢弃实时快照。
async fn invalidate_dashboard_stats_if_usage_changed(
    ctx: &AppContext,
    account_id: &str,
    usage_writes: &UsageWriteTracker,
) {
    if usage_writes.has_persisted_changes() {
        ctx.live_resources
            .invalidate(account_id, LiveResourceKind::DashboardStats)
            .await;
    }
}

pub async fn sync_all_accounts(
    ctx: &AppContext,
    input: SyncAccountDataInput,
) -> Result<Vec<(String, SyncAccountDataResult)>> {
    let account_ids = repositories::list_account_ids(&ctx.db)?;
    let mut result = Vec::new();
    for account_id in account_ids {
        let synced = sync_account_data(
            ctx,
            &account_id,
            SyncAccountDataInput {
                scope: input.scope.clone(),
                trigger_source: input.trigger_source.clone(),
            },
        )
        .await?;
        result.push((account_id, synced));
    }
    Ok(result)
}

pub async fn refresh_account(
    ctx: &AppContext,
    account_id: &str,
    trigger_source: RefreshTriggerSource,
) -> Result<RefreshAccountTaskResponse> {
    let sync_trigger_source = match trigger_source {
        RefreshTriggerSource::Manual => DataSyncTrigger::Manual,
        RefreshTriggerSource::StaleAuto => DataSyncTrigger::StaleAuto,
    };
    let sync_result = sync_account_data(
        ctx,
        account_id,
        SyncAccountDataInput {
            scope: DataSyncScope::Full,
            trigger_source: sync_trigger_source,
        },
    )
    .await?;
    let (account, _) = account_service::load_account_site(ctx, account_id)?;
    let runtime = account_service::load_live_runtime(ctx, account).await?;
    Ok(RefreshAccountTaskResponse {
        account: runtime,
        run: sync_result.run,
        status: sync_result.status,
        changed_usage_rows: sync_result.changed_usage_rows,
        notification_owner: sync_result.notification_owner,
        usage_notification_eligible: sync_result.usage_notification_eligible,
    })
}

pub async fn refresh_all_accounts(
    ctx: &AppContext,
) -> Result<Vec<(String, SyncAccountDataResult)>> {
    sync_all_accounts(
        ctx,
        SyncAccountDataInput {
            scope: DataSyncScope::Full,
            trigger_source: DataSyncTrigger::Manual,
        },
    )
    .await
}

pub async fn sync_scheduled_account_data(
    ctx: &AppContext,
    account_id: &str,
) -> Result<Option<SyncAccountDataResult>> {
    ctx.db.ensure_requests_available()?;
    let Some(usage_gate) = ctx
        .live_resources
        .try_acquire_usage_account_gate(account_id)
        .await
    else {
        return Ok(None);
    };
    let sync_result = sync_account_data_with_usage_gate(
        ctx,
        account_id,
        SyncAccountDataInput {
            scope: DataSyncScope::Usage,
            trigger_source: DataSyncTrigger::Auto,
        },
        Some(usage_gate),
    )
    .await?;

    Ok(Some(sync_result))
}

fn sync_scope_key(scope: &DataSyncScope) -> &'static str {
    match scope {
        DataSyncScope::Core => "core",
        DataSyncScope::Subscriptions => "subscriptions",
        DataSyncScope::Keys => "keys",
        DataSyncScope::Usage => "usage",
        DataSyncScope::Full => "full",
    }
}

pub async fn get_account_sync_status(
    ctx: &AppContext,
    account_id: &str,
) -> Result<AccountSyncStatusPayload> {
    let (full_sync, usage_sync, subscriptions_sync) = {
        let tasks = ctx.sync_tasks.lock().await;
        (
            tasks.get(&format!("{}:full", account_id)).cloned(),
            tasks.get(&format!("{}:usage", account_id)).cloned(),
            tasks.get(&format!("{}:subscriptions", account_id)).cloned(),
        )
    };
    let (item_count, last_success_at) =
        repositories::read_usage_cache_sync_snapshot(&ctx.db, account_id)?;
    let full_state = clone_sync_task_state(full_sync).await;
    let usage_state = clone_sync_task_state(usage_sync).await;
    let subscriptions_state = clone_sync_task_state(subscriptions_sync).await;

    if full_state.as_ref().is_some_and(|state| !state.completed) {
        let state = full_state
            .as_ref()
            .expect("running Full state checked above");
        return Ok(AccountSyncStatusPayload {
            account_id: account_id.to_string(),
            statuses: vec![sync_task_status_record(
                account_id,
                state,
                0,
                last_success_at.as_deref(),
            )],
        });
    }

    let mut task_statuses = Vec::new();
    if let Some(state) = full_state.as_ref() {
        task_statuses.push(sync_task_status_record(
            account_id,
            state,
            item_count,
            last_success_at.as_deref(),
        ));
    }
    if let Some(state) = usage_state.as_ref() {
        task_statuses.push(sync_task_status_record(
            account_id,
            state,
            usage_task_item_count(state),
            last_success_at.as_deref(),
        ));
    }
    if let Some(state) = subscriptions_state.as_ref() {
        task_statuses.push(sync_task_status_record(account_id, state, 0, None));
    }
    if !task_statuses.is_empty() {
        return Ok(AccountSyncStatusPayload {
            account_id: account_id.to_string(),
            statuses: task_statuses,
        });
    }

    if let Some(history_state) = repositories::load_usage_history_state(&ctx.db, account_id)? {
        let last_error = match history_state.state {
            repositories::UsageHistoryState::Pending => {
                Some("历史用量同步尚未完成，等待恢复。".to_string())
            }
            repositories::UsageHistoryState::Backfilling => {
                Some("历史用量同步中断，等待从检查点恢复。".to_string())
            }
            repositories::UsageHistoryState::NeedsAudit
                if is_clean_completed_usage_history_checkpoint(&history_state) =>
            {
                None
            }
            repositories::UsageHistoryState::NeedsAudit => Some(
                history_state
                    .last_error
                    .unwrap_or_else(|| "历史用量同步需要检查。".to_string()),
            ),
            repositories::UsageHistoryState::Degraded => Some(
                history_state
                    .last_error
                    .unwrap_or_else(|| "历史用量同步暂时不可用，请稍后重试。".to_string()),
            ),
            repositories::UsageHistoryState::Converged => None,
        };
        if let Some(last_error) = last_error {
            return Ok(AccountSyncStatusPayload {
                account_id: account_id.to_string(),
                statuses: vec![AccountSyncStatusRecord {
                    account_id: account_id.to_string(),
                    scope: DataSyncScope::Full,
                    state: AccountSyncState::Failed,
                    last_attempt_at: Some(history_state.updated_at),
                    last_success_at: None,
                    last_error: Some(last_error),
                    item_count,
                    run_id: None,
                    finished_at: None,
                    failure: None,
                    recovered_at: None,
                    progress: None,
                }],
            });
        }
    }
    let usage_status = if item_count <= 0 {
        AccountSyncStatusRecord {
            account_id: account_id.to_string(),
            scope: DataSyncScope::Usage,
            state: AccountSyncState::Idle,
            last_attempt_at: None,
            last_success_at: None,
            last_error: None,
            item_count: 0,
            run_id: None,
            finished_at: None,
            failure: None,
            recovered_at: None,
            progress: None,
        }
    } else {
        AccountSyncStatusRecord {
            account_id: account_id.to_string(),
            scope: DataSyncScope::Usage,
            state: AccountSyncState::Succeeded,
            last_attempt_at: last_success_at.clone(),
            last_success_at,
            last_error: None,
            item_count,
            run_id: None,
            finished_at: None,
            failure: None,
            recovered_at: None,
            progress: None,
        }
    };
    Ok(AccountSyncStatusPayload {
        account_id: account_id.to_string(),
        statuses: vec![usage_status],
    })
}

async fn clone_sync_task_state(
    handle: Option<Arc<super::context::SyncTaskHandle>>,
) -> Option<super::context::SyncTaskState> {
    let handle = handle?;
    let state = handle.state.lock().await.clone();
    Some(state)
}

/// Usage 终态展示本次执行实际合并量，不能把账号缓存总量误作本轮处理量。
fn usage_task_item_count(state: &super::context::SyncTaskState) -> i64 {
    state
        .result
        .as_ref()
        .and_then(|result| result.as_ref().ok())
        .and_then(|execution| {
            execution
                .status
                .statuses
                .iter()
                .find(|status| status.scope == DataSyncScope::Usage)
        })
        .map_or(0, |status| status.item_count)
}

fn sync_task_status_record(
    account_id: &str,
    state: &super::context::SyncTaskState,
    item_count: i64,
    cache_last_success_at: Option<&str>,
) -> AccountSyncStatusRecord {
    let failure = state
        .result
        .as_ref()
        .and_then(|result| result.as_ref().err())
        .map(|failure| failure.payload.clone());
    let recovered_at = if state.run.scope == DataSyncScope::Full
        && matches!(state.run.status, TaskRunStatus::Failed)
    {
        recovery_timestamp_after_failure(cache_last_success_at, state.run.finished_at.as_deref())
    } else {
        None
    };
    let last_error = failure
        .as_ref()
        .map(|failure| failure.message.clone())
        .or_else(|| {
            state
                .run
                .error_message
                .as_deref()
                .map(repositories::sanitize_usage_history_error)
        });
    let (sync_state, last_success_at, last_error, status_item_count) = match state.run.status {
        TaskRunStatus::Running => (AccountSyncState::Running, None, None, 0),
        TaskRunStatus::Succeeded => (
            AccountSyncState::Succeeded,
            state
                .run
                .finished_at
                .clone()
                .or_else(|| cache_last_success_at.map(str::to_string)),
            None,
            item_count,
        ),
        TaskRunStatus::Failed => (
            AccountSyncState::Failed,
            None,
            Some(last_error.unwrap_or_else(|| "账号数据同步失败。".to_string())),
            item_count,
        ),
    };
    AccountSyncStatusRecord {
        account_id: account_id.to_string(),
        scope: state.run.scope.clone(),
        state: sync_state,
        last_attempt_at: Some(state.run.started_at.clone()),
        last_success_at,
        last_error,
        item_count: status_item_count,
        run_id: Some(state.run.id.clone()),
        finished_at: state.run.finished_at.clone(),
        failure,
        recovered_at,
        progress: state.progress.clone(),
    }
}

fn recovery_timestamp_after_failure(
    cache_updated_at: Option<&str>,
    failed_finished_at: Option<&str>,
) -> Option<String> {
    let cache_updated_at = cache_updated_at?;
    let failed_finished_at = failed_finished_at?;
    let cache_time = chrono::DateTime::parse_from_rfc3339(cache_updated_at).ok()?;
    let failure_time = chrono::DateTime::parse_from_rfc3339(failed_finished_at).ok()?;
    (cache_time > failure_time).then(|| cache_updated_at.to_string())
}

/// 识别已完成闭合历史和当日启动扫描、但按 Preserve 策略保留的干净检查点。
fn is_clean_completed_usage_history_checkpoint(
    history_state: &repositories::AccountUsageHistoryStateRecord,
) -> bool {
    if history_state.state != repositories::UsageHistoryState::NeedsAudit
        || history_state.active_date.is_some()
        || history_state.heartbeat_at.is_some()
        || history_state
            .last_error
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        || !history_state
            .recent_reconciled_at
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
    {
        return false;
    }

    let today = shanghai_today();
    let today_text = today.to_string();
    if history_state
        .last_startup_recent_four_day_read_date
        .as_deref()
        != Some(today_text.as_str())
    {
        return false;
    }

    let Some(closed_history_end) = today.checked_sub_days(Days::new(2)) else {
        return false;
    };
    history_state
        .completed_through_date
        .as_deref()
        .and_then(|value| parse_usage_date(value, "历史用量完成日期").ok())
        .is_some_and(|completed_through| completed_through >= closed_history_end)
}

fn success_status(
    account_id: &str,
    scope: DataSyncScope,
    item_count: i64,
) -> AccountSyncStatusRecord {
    let now = usage_sync_timestamp();
    AccountSyncStatusRecord {
        account_id: account_id.to_string(),
        scope,
        state: AccountSyncState::Succeeded,
        last_attempt_at: Some(now.clone()),
        last_success_at: Some(now),
        last_error: None,
        item_count,
        run_id: None,
        finished_at: None,
        failure: None,
        recovered_at: None,
        progress: None,
    }
}

pub fn repair_usage_cache_from_legacy(ctx: &AppContext) -> Result<()> {
    if repositories::get_setting(&ctx.db, DATA_CENTER_USAGE_REPAIR_DONE_KEY)?.as_deref()
        == Some("1")
    {
        return Ok(());
    }

    let accounts = repositories::list_accounts(&ctx.db)?;
    let now = usage_sync_timestamp();

    for account in &accounts {
        if !repositories::list_usage_row_cache(&ctx.db, &account.id, None, None, None)?.is_empty() {
            continue;
        }
        let rows = repositories::load_legacy_usage_rows(&ctx.db, &account.id)?;
        if rows.is_empty() {
            continue;
        }
        let _ = repositories::merge_usage_row_cache(&ctx.db, &account.id, &rows, &now)?;
    }

    repositories::set_setting(&ctx.db, DATA_CENTER_USAGE_REPAIR_DONE_KEY, "1")?;
    Ok(())
}

#[derive(Debug)]
struct CoreSyncOutcome {
    item_count: i64,
    subscriptions: Option<Vec<SubscriptionRecord>>,
    subscription_read_error: Option<String>,
}

pub async fn sync_core_scope(
    ctx: &AppContext,
    account_id: &str,
    trigger_source: DataSyncTrigger,
) -> Result<i64> {
    let post_switch = trigger_source == DataSyncTrigger::PostWrite;
    let outcome = sync_core_scope_outcome(ctx, account_id, trigger_source).await?;
    process_core_sync_outcome(
        ctx,
        account_id,
        &outcome,
        if post_switch {
            SubscriptionSnapshotOrigin::PostSwitch
        } else {
            SubscriptionSnapshotOrigin::CoreSync
        },
        !post_switch,
    )
    .await;
    Ok(outcome.item_count)
}

async fn sync_core_scope_outcome(
    ctx: &AppContext,
    account_id: &str,
    trigger_source: DataSyncTrigger,
) -> Result<CoreSyncOutcome> {
    let (account, site) = account_service::load_account_site(ctx, account_id)?;
    let _ = site;
    let (profile, quotas, subscriptions) = tokio::join!(
        ctx.live_resources
            .get_or_fetch(&account.id, LiveResourceKind::Profile, true, || async {
                fetch_profile(
                    ctx,
                    &account.id,
                    UpstreamRequestPolicy::RecoverableSyncOrWrite,
                )
                .await
            },),
        ctx.live_resources.get_or_fetch(
            &account.id,
            LiveResourceKind::PlatformQuotas,
            true,
            || async {
                fetch_platform_quotas(
                    ctx,
                    &account.id,
                    UpstreamRequestPolicy::RecoverableSyncOrWrite,
                )
                .await
            },
        ),
        sync_subscriptions_scope_outcome(ctx, account_id),
    );
    let _profile = profile?;
    let quotas = quotas?;
    let subscriptions = subscriptions?;
    let _ = trigger_source;
    let item_count = 1 + quotas.platform_quotas.len() as i64 + subscriptions.item_count;
    Ok(CoreSyncOutcome {
        item_count,
        subscriptions: subscriptions.subscriptions,
        subscription_read_error: subscriptions.subscription_read_error,
    })
}

/// 订阅域同步只读取订阅及摘要，并保留摘要不可用时的列表推导语义。
async fn sync_subscriptions_scope_outcome(
    ctx: &AppContext,
    account_id: &str,
) -> Result<CoreSyncOutcome> {
    let (account, site) = account_service::load_account_site(ctx, account_id)?;
    let _ = site;
    let (subscriptions, summary) = tokio::join!(
        ctx.live_resources.get_or_fetch(
            &account.id,
            LiveResourceKind::Subscriptions,
            true,
            || async {
                fetch_subscriptions(
                    ctx,
                    &account.id,
                    UpstreamRequestPolicy::RecoverableSyncOrWrite,
                )
                .await
            },
        ),
        ctx.live_resources.get_or_fetch(
            &account.id,
            LiveResourceKind::SubscriptionSummary,
            true,
            || async {
                fetch_subscription_summary(
                    ctx,
                    &account.id,
                    UpstreamRequestPolicy::RecoverableSyncOrWrite,
                )
                .await
            },
        ),
    );
    let subscriptions = subscriptions?;
    let summary = match summary {
        Ok(summary) => summary,
        Err(_) => {
            let fallback_subscriptions = subscriptions.clone();
            ctx.live_resources
                .get_or_fetch(
                    &account.id,
                    LiveResourceKind::SubscriptionSummary,
                    false,
                    move || async move {
                        Ok::<_, anyhow::Error>(derive_subscription_summary(&fallback_subscriptions))
                    },
                )
                .await?
        }
    };
    let item_count = subscriptions.len() as i64 + summary.subscriptions.len() as i64;
    Ok(CoreSyncOutcome {
        item_count,
        subscriptions: Some(subscriptions),
        subscription_read_error: None,
    })
}

async fn process_core_sync_outcome(
    ctx: &AppContext,
    account_id: &str,
    outcome: &CoreSyncOutcome,
    origin: SubscriptionSnapshotOrigin,
    evaluate_switch_rules: bool,
) -> subscription_snapshot_service::SubscriptionSnapshotProcessingReport {
    let Some(subscriptions) = outcome.subscriptions.as_deref() else {
        if let Some(error) = outcome.subscription_read_error.as_deref() {
            log::warn!(
                "[subscription-snapshot] account={} subscriptions read failed; state unchanged: {}",
                account_id,
                error
            );
        }
        return Default::default();
    };
    let capabilities = if ctx.native_notifications_enabled {
        SubscriptionProcessingCapabilities::desktop(evaluate_switch_rules)
    } else {
        SubscriptionProcessingCapabilities::headless(evaluate_switch_rules)
    };
    subscription_snapshot_service::process_successful_snapshot(
        ctx,
        account_id,
        subscriptions,
        false,
        UpstreamRequestPolicy::RecoverableSyncOrWrite,
        origin,
        capabilities,
    )
    .await
}

pub async fn sync_keys_scope(
    ctx: &AppContext,
    account_id: &str,
    trigger_source: DataSyncTrigger,
) -> Result<i64> {
    let (account, site) = account_service::load_account_site(ctx, account_id)?;
    let _ = site;
    let (groups, keys) = tokio::join!(
        ctx.live_resources
            .get_or_fetch(&account.id, LiveResourceKind::Groups, true, || async {
                fetch_groups(
                    ctx,
                    &account.id,
                    UpstreamRequestPolicy::RecoverableSyncOrWrite,
                )
                .await
            },),
        ctx.live_resources
            .get_or_fetch(&account.id, LiveResourceKind::Keys, true, || async {
                fetch_keys(
                    ctx,
                    &account.id,
                    UpstreamRequestPolicy::RecoverableSyncOrWrite,
                )
                .await
            },),
    );
    let groups = groups?;
    let keys = keys?;
    let _ = trigger_source;
    Ok((groups.len() + keys.len()) as i64)
}

pub async fn sync_usage_scope(
    ctx: &AppContext,
    account_id: &str,
    trigger_source: DataSyncTrigger,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<i64> {
    let _usage_gate = ctx
        .live_resources
        .acquire_usage_account_gate(account_id)
        .await;
    let usage_writes = UsageWriteTracker::default();
    let usage_result = sync_usage_scope_with_changes_under_usage_gate(
        ctx,
        account_id,
        trigger_source,
        start_date,
        end_date,
        None,
        &usage_writes,
    )
    .await;
    invalidate_dashboard_stats_if_usage_changed(ctx, account_id, &usage_writes).await;
    let usage = usage_result?;
    Ok(usage.item_count)
}

pub async fn sync_initial_usage_history_if_needed(
    ctx: &AppContext,
    account_id: &str,
) -> Result<i64> {
    let _usage_gate = ctx
        .live_resources
        .acquire_usage_account_gate(account_id)
        .await;
    let usage_writes = UsageWriteTracker::default();
    let result = sync_initial_usage_history_if_needed_under_usage_gate(
        ctx,
        account_id,
        None,
        None,
        &usage_writes,
    )
    .await;
    invalidate_dashboard_stats_if_usage_changed(ctx, account_id, &usage_writes).await;
    match result? {
        HistoryMaintenanceOutcome::Completed { merged_count } => Ok(merged_count),
        HistoryMaintenanceOutcome::Yielded { .. } => {
            Err(anyhow::anyhow!("非 cooperative 历史同步意外进入让行状态。"))
        }
    }
}

/// 在 account lease 内执行一个可让行的 history quantum；本地 Usage gate 忙时不持租约等待。
pub async fn sync_scheduled_history_maintenance(
    ctx: &AppContext,
    account_id: &str,
    lease: &AccountLeaseGuard,
) -> Result<Option<HistoryMaintenanceOutcome>> {
    let Some(_usage_gate) = ctx
        .live_resources
        .try_acquire_usage_account_gate(account_id)
        .await
    else {
        return Ok(None);
    };
    let usage_writes = UsageWriteTracker::default();
    let quantum = HistoryQuantum::new(lease);
    let result = sync_startup_recent_four_day_usage_reads_under_usage_gate(
        ctx,
        account_id,
        shanghai_today(),
        Some(&quantum),
        &usage_writes,
    )
    .await;
    invalidate_dashboard_stats_if_usage_changed(ctx, account_id, &usage_writes).await;
    result.map(Some)
}

pub async fn sync_startup_recent_four_day_usage_reads(ctx: &AppContext) {
    sync_startup_recent_four_day_usage_reads_for_today(ctx, shanghai_today()).await;
}

async fn sync_startup_recent_four_day_usage_reads_for_today(ctx: &AppContext, today: NaiveDate) {
    let account_ids = match repositories::list_account_ids(&ctx.db) {
        Ok(account_ids) => account_ids,
        Err(error) => {
            log::warn!("[usage-history] 无法读取启动四日扫描账号列表: {error}");
            return;
        }
    };

    for account_id in account_ids {
        let usage_gate = ctx
            .live_resources
            .acquire_usage_account_gate(&account_id)
            .await;
        let usage_writes = UsageWriteTracker::default();
        let result = sync_startup_recent_four_day_usage_reads_under_usage_gate(
            ctx,
            &account_id,
            today,
            None,
            &usage_writes,
        )
        .await;
        invalidate_dashboard_stats_if_usage_changed(ctx, &account_id, &usage_writes).await;
        if result.is_err() {
            log::warn!("[usage-history] 启动四日扫描失败，已保留恢复边界");
        }
        drop(usage_gate);
    }
}

async fn sync_startup_recent_four_day_usage_reads_under_usage_gate(
    ctx: &AppContext,
    account_id: &str,
    today: NaiveDate,
    quantum: Option<&HistoryQuantum<'_>>,
    usage_writes: &UsageWriteTracker,
) -> Result<HistoryMaintenanceOutcome> {
    let today_text = today.to_string();
    if !repositories::should_run_startup_recent_four_day_usage_read(
        &ctx.db,
        account_id,
        &today_text,
    )? {
        return Ok(HistoryMaintenanceOutcome::Completed { merged_count: 0 });
    }

    // 启动近期扫描也必须等待关闭历史日期完成，今天始终留到最后读取。
    let initial_history = sync_initial_usage_history_if_needed_under_usage_gate(
        ctx,
        account_id,
        None,
        quantum,
        usage_writes,
    )
    .await?;
    let mut merged_count = match initial_history {
        HistoryMaintenanceOutcome::Completed { merged_count } => merged_count,
        HistoryMaintenanceOutcome::Yielded { merged_count } => {
            return Ok(HistoryMaintenanceOutcome::Yielded { merged_count });
        }
    };

    let start = today
        .checked_sub_days(Days::new(3))
        .ok_or_else(|| anyhow::anyhow!("无法计算启动四日用量读取起始日期。"))?;
    let mut reader = upstream_service::prepare_usage_read_client(ctx, account_id).await?;
    let mut date = start;
    loop {
        let window = sync_usage_date_window(
            ctx,
            account_id,
            &mut reader,
            date,
            UsageHistoryCheckpointPolicy::Preserve,
            None,
            AccountSyncProgressPhase::RecentWindow,
            quantum,
            usage_writes,
        )
        .await?;
        match window {
            UsageWindowOutcome::Completed(window) => merged_count += window.merged_count,
            UsageWindowOutcome::Yielded {
                merged_count: window_merged_count,
            } => {
                merged_count += window_merged_count;
                return Ok(HistoryMaintenanceOutcome::Yielded { merged_count });
            }
        }
        if date == today {
            break;
        }
        if history_quantum_should_yield(quantum).await {
            return Ok(HistoryMaintenanceOutcome::Yielded { merged_count });
        }
        date = date
            .succ_opt()
            .ok_or_else(|| anyhow::anyhow!("启动四日用量读取日期超出可处理范围。"))?;
    }

    let now = usage_sync_timestamp();
    repositories::mark_startup_recent_four_day_usage_read_completed(
        &ctx.db,
        account_id,
        &today_text,
        &now,
    )?;
    Ok(HistoryMaintenanceOutcome::Completed { merged_count })
}

async fn sync_initial_usage_history_if_needed_under_usage_gate(
    ctx: &AppContext,
    account_id: &str,
    reporter: Option<&SyncProgressReporter>,
    quantum: Option<&HistoryQuantum<'_>>,
    usage_writes: &UsageWriteTracker,
) -> Result<HistoryMaintenanceOutcome> {
    let now = usage_sync_timestamp();
    let state = repositories::ensure_usage_history_state(&ctx.db, account_id, &now)?;
    if let Some(reporter) = reporter {
        reporter
            .set_usage_detail(usage_progress_detail(
                AccountSyncProgressPhase::HistoryDiscovery,
                None,
                None,
                None,
                None,
                None,
            ))
            .await;
    }
    if history_quantum_should_yield(quantum).await {
        return Ok(HistoryMaintenanceOutcome::Yielded { merged_count: 0 });
    }
    let mut reader = match upstream_service::prepare_usage_read_client(ctx, account_id).await {
        Ok(reader) => reader,
        Err(error) => {
            repositories::mark_usage_history_issue(
                &ctx.db,
                account_id,
                usage_history_issue_state(&error),
                &error.to_string(),
                &usage_sync_timestamp(),
            )?;
            return Err(error);
        }
    };
    let earliest_result = match fetch_earliest_usage_date(ctx, &reader, reporter).await {
        Err(error) if auth_service::is_auth_expired_error(&error) => {
            match upstream_service::recover_usage_read_client(ctx, account_id).await {
                Ok(recovered) => {
                    reader = recovered;
                    fetch_earliest_usage_date(ctx, &reader, reporter).await
                }
                Err(recovery_error) => Err(recovery_error),
            }
        }
        result => result,
    };
    let earliest = match earliest_result {
        Ok(earliest) => earliest,
        Err(error)
            if is_earliest_usage_probe_growth_exhausted(&error)
                && state.earliest_date.as_deref().is_some() =>
        {
            let earliest = parse_usage_state_date(state.earliest_date.as_deref(), "最早历史日期")?
                .expect("earliest_date presence checked before checkpoint fallback");
            log::warn!(
                "[usage-history] 最早日期探针快照持续变化，使用已验证检查点继续恢复: accountId={account_id} earliestDate={earliest}"
            );
            Some(earliest)
        }
        Err(error) => {
            repositories::mark_usage_history_issue(
                &ctx.db,
                account_id,
                usage_history_issue_state(&error),
                &error.to_string(),
                &usage_sync_timestamp(),
            )?;
            return Err(error);
        }
    };
    let Some(earliest_date) = earliest else {
        return Ok(HistoryMaintenanceOutcome::Completed { merged_count: 0 });
    };
    let closed_history_end = shanghai_today()
        .checked_sub_days(Days::new(2))
        .ok_or_else(|| anyhow::anyhow!("无法计算已关闭的用量历史日期。"))?;
    if earliest_date > closed_history_end {
        return Ok(HistoryMaintenanceOutcome::Completed { merged_count: 0 });
    }

    if history_quantum_should_yield(quantum).await {
        return Ok(HistoryMaintenanceOutcome::Yielded { merged_count: 0 });
    }

    let mut date = usage_history_resume_date(&state, earliest_date)?;
    let mut merged_count = 0_i64;
    let total_days = (closed_history_end - earliest_date).num_days() + 1;
    let mut completed_days = (date - earliest_date).num_days().clamp(0, total_days);
    while date <= closed_history_end {
        if let Some(reporter) = reporter {
            reporter
                .set_usage_detail(usage_progress_detail(
                    AccountSyncProgressPhase::HistoryWindow,
                    Some(completed_days),
                    Some(total_days),
                    Some(AccountSyncProgressUnit::Days),
                    Some(date.to_string()),
                    None,
                ))
                .await;
        }
        let window = sync_usage_date_window(
            ctx,
            account_id,
            &mut reader,
            date,
            UsageHistoryCheckpointPolicy::Track,
            reporter,
            AccountSyncProgressPhase::HistoryWindow,
            quantum,
            usage_writes,
        )
        .await?;
        match window {
            UsageWindowOutcome::Completed(window) => merged_count += window.merged_count,
            UsageWindowOutcome::Yielded {
                merged_count: window_merged_count,
            } => {
                merged_count += window_merged_count;
                return Ok(HistoryMaintenanceOutcome::Yielded { merged_count });
            }
        }
        let updated_at = usage_sync_timestamp();
        repositories::advance_usage_history_completed_through_date(
            &ctx.db,
            account_id,
            Some(&earliest_date.to_string()),
            &date.to_string(),
            Some(&earliest_date.to_string()),
            &updated_at,
        )?;
        completed_days = (completed_days + 1).min(total_days);
        if let Some(reporter) = reporter {
            reporter
                .set_usage_detail(usage_progress_detail(
                    AccountSyncProgressPhase::HistoryWindow,
                    Some(completed_days),
                    Some(total_days),
                    Some(AccountSyncProgressUnit::Days),
                    Some(date.to_string()),
                    None,
                ))
                .await;
        }
        if date < closed_history_end && history_quantum_should_yield(quantum).await {
            return Ok(HistoryMaintenanceOutcome::Yielded { merged_count });
        }
        date = date
            .succ_opt()
            .ok_or_else(|| anyhow::anyhow!("用量历史日期超出可处理范围。"))?;
    }

    Ok(HistoryMaintenanceOutcome::Completed { merged_count })
}

async fn sync_usage_scope_with_changes_under_usage_gate(
    ctx: &AppContext,
    account_id: &str,
    trigger_source: DataSyncTrigger,
    start_date: Option<String>,
    end_date: Option<String>,
    reporter: Option<&SyncProgressReporter>,
    usage_writes: &UsageWriteTracker,
) -> Result<UsageSyncResult> {
    if trigger_source == DataSyncTrigger::Auto && start_date.is_none() && end_date.is_none() {
        if let Some(reporter) = reporter {
            reporter
                .set_usage_detail(usage_progress_detail(
                    AccountSyncProgressPhase::LatestIncremental,
                    Some(0),
                    None,
                    Some(AccountSyncProgressUnit::Pages),
                    None,
                    Some(1),
                ))
                .await;
        }
        let latest =
            sync_latest_usage_incremental_under_usage_gate(ctx, account_id, reporter, usage_writes)
                .await?;
        return Ok(UsageSyncResult {
            item_count: latest.merged_count,
            changed_rows: latest.changed_rows,
        });
    }

    let (dates, is_recent_reconciliation) = usage_dates_for_sync(start_date, end_date)?;
    let mut reader = upstream_service::prepare_usage_read_client(ctx, account_id).await?;
    let mut merged_count = 0_i64;
    let mut changed_rows = Vec::new();
    let today = shanghai_today();
    let total_days = dates.len() as i64;

    for (index, date) in dates.into_iter().enumerate() {
        if let Some(reporter) = reporter {
            reporter
                .set_usage_detail(usage_progress_detail(
                    AccountSyncProgressPhase::RecentWindow,
                    Some(index as i64),
                    Some(total_days),
                    Some(AccountSyncProgressUnit::Days),
                    Some(date.to_string()),
                    None,
                ))
                .await;
        }
        let window = sync_usage_date_window(
            ctx,
            account_id,
            &mut reader,
            date,
            UsageHistoryCheckpointPolicy::Track,
            reporter,
            AccountSyncProgressPhase::RecentWindow,
            None,
            usage_writes,
        )
        .await
        .and_then(completed_usage_window)?;
        merged_count += window.merged_count;
        if is_recent_usage_date(date, today) {
            changed_rows.extend(window.changed_rows);
        }
        if let Some(reporter) = reporter {
            reporter
                .set_usage_detail(usage_progress_detail(
                    AccountSyncProgressPhase::RecentWindow,
                    Some((index as i64 + 1).min(total_days)),
                    Some(total_days),
                    Some(AccountSyncProgressUnit::Days),
                    Some(date.to_string()),
                    None,
                ))
                .await;
        }
    }
    if is_recent_reconciliation {
        let now = usage_sync_timestamp();
        repositories::record_usage_history_recent_reconciliation(&ctx.db, account_id, &now, &now)?;
    }
    let _ = trigger_source;
    Ok(UsageSyncResult {
        item_count: merged_count,
        changed_rows,
    })
}

async fn sync_latest_usage_incremental_under_usage_gate(
    ctx: &AppContext,
    account_id: &str,
    reporter: Option<&SyncProgressReporter>,
    usage_writes: &UsageWriteTracker,
) -> Result<UsageWindowResult> {
    let mut reader = upstream_service::prepare_usage_read_client(ctx, account_id).await?;
    let mut recovered_auth = false;
    let mut progress_attempt = 1_i64;

    loop {
        match sync_latest_usage_incremental_attempt(
            ctx,
            account_id,
            &reader,
            reporter,
            progress_attempt,
            usage_writes,
        )
        .await
        {
            Ok(result) => return Ok(result),
            Err(error) if auth_service::is_auth_expired_error(&error) && !recovered_auth => {
                reader = upstream_service::recover_usage_read_client(ctx, account_id).await?;
                recovered_auth = true;
                progress_attempt += 1;
            }
            Err(error) => return Err(error),
        }
    }
}

async fn sync_latest_usage_incremental_attempt(
    ctx: &AppContext,
    account_id: &str,
    reader: &SiteFailoverReadClient,
    reporter: Option<&SyncProgressReporter>,
    progress_attempt: i64,
    usage_writes: &UsageWriteTracker,
) -> Result<UsageWindowResult> {
    let updated_at = usage_sync_timestamp();
    let mut fetched_rows = 0_i64;
    let mut pages_fetched = 0_i64;
    let mut pending_rows = Vec::new();
    let stop_reason = loop {
        let requested_page = pages_fetched + 1;
        let FetchedUsagePage {
            envelope: page,
            _page_slot: page_slot,
        } = fetch_usage_page_with_retry(
            ctx,
            reader,
            None,
            requested_page,
            AUTO_LATEST_USAGE_PAGE_SIZE,
            UsagePageOrder::Desc,
            reporter,
        )
        .await?;
        let cache_presence =
            repositories::usage_row_cache_presence(&ctx.db, account_id, &page.items)?;
        let cached_tail = has_contiguous_cached_tail(&cache_presence);
        let row_count = page.items.len() as i64;
        let natural_end = row_count < AUTO_LATEST_USAGE_PAGE_SIZE || page.page >= page.pages;
        // Defer the write so a page overlap cannot become a false cache boundary in this run.
        pending_rows.extend(page.items);
        drop(page_slot);
        fetched_rows += row_count;
        pages_fetched += 1;
        if let Some(reporter) = reporter {
            reporter
                .set_usage_detail(usage_progress_detail(
                    AccountSyncProgressPhase::LatestIncremental,
                    Some(pages_fetched),
                    None,
                    Some(AccountSyncProgressUnit::Pages),
                    None,
                    Some(progress_attempt),
                ))
                .await;
        }

        if cached_tail {
            break LatestUsageStopReason::CachedTail;
        }
        if natural_end {
            break LatestUsageStopReason::NaturalEnd;
        }
        if pages_fetched >= MAX_AUTO_LATEST_USAGE_PAGES {
            break LatestUsageStopReason::PageBudget;
        }
    };

    let merged_count = merge_usage_page(
        ctx,
        account_id,
        pending_rows,
        updated_at.clone(),
        usage_writes,
    )
    .await?;

    log::info!(
        "[usage-sync] latest incremental pages={} rows={} stop_reason={}",
        pages_fetched,
        fetched_rows,
        stop_reason.as_str()
    );
    let changed_rows = if merged_count > 0 {
        repositories::list_usage_rows_updated_at(&ctx.db, account_id, &updated_at)?
    } else {
        Vec::new()
    };
    Ok(UsageWindowResult {
        merged_count,
        changed_rows,
    })
}

fn has_contiguous_cached_tail(cache_presence: &[bool]) -> bool {
    let Some(first_cached) = cache_presence.iter().position(|present| *present) else {
        return false;
    };
    cache_presence[first_cached..]
        .iter()
        .all(|present| *present)
}

pub(crate) async fn fetch_profile(
    ctx: &AppContext,
    account_id: &str,
    policy: UpstreamRequestPolicy,
) -> Result<UserProfileRecord> {
    let raw = upstream_service::account_upstream_request(
        ctx,
        account_id,
        "/api/v1/user/profile",
        "GET",
        None,
        policy,
    )
    .await?;
    Ok(normalize_profile(&raw))
}

pub(crate) async fn fetch_platform_quotas(
    ctx: &AppContext,
    account_id: &str,
    policy: UpstreamRequestPolicy,
) -> Result<PlatformQuotaPayload> {
    let raw = match upstream_service::account_upstream_request(
        ctx,
        account_id,
        "/api/v1/user/platform-quotas",
        "GET",
        None,
        policy,
    )
    .await
    {
        Ok(raw) => raw,
        Err(error) if upstream_service::is_account_auth_recovery_error(&error) => {
            return Err(error)
        }
        Err(_) => serde_json::json!({ "platform_quotas": [] }),
    };
    Ok(normalize_platform_quotas(&raw))
}

pub(crate) async fn fetch_subscription_summary(
    ctx: &AppContext,
    account_id: &str,
    policy: UpstreamRequestPolicy,
) -> Result<SubscriptionSummaryPayload> {
    let raw = upstream_service::account_upstream_request(
        ctx,
        account_id,
        "/api/v1/subscriptions/summary",
        "GET",
        None,
        policy,
    )
    .await?;
    Ok(normalize_subscription_summary(&raw))
}

pub(crate) async fn fetch_groups(
    ctx: &AppContext,
    account_id: &str,
    policy: UpstreamRequestPolicy,
) -> Result<Vec<GroupRecord>> {
    match fetch_groups_strict(ctx, account_id, policy).await {
        Ok(groups) => Ok(groups),
        Err(error) if auth_service::is_auth_expired_error(&error) => Err(error),
        Err(_) => Ok(Vec::new()),
    }
}

/// 状态机和写前校验必须以真实分组为准，不能把上游故障降级为空数据。
pub(crate) async fn fetch_groups_strict(
    ctx: &AppContext,
    account_id: &str,
    policy: UpstreamRequestPolicy,
) -> Result<Vec<GroupRecord>> {
    let raw = upstream_service::account_upstream_request(
        ctx,
        account_id,
        "/api/v1/groups/available",
        "GET",
        None,
        policy,
    )
    .await?;
    Ok(normalize_items(&raw)
        .iter()
        .map(normalize_group_record)
        .collect())
}

pub(crate) async fn fetch_keys(
    ctx: &AppContext,
    account_id: &str,
    policy: UpstreamRequestPolicy,
) -> Result<Vec<ManagedKeyRecord>> {
    let mut page = 1_i64;
    let mut rows = Vec::new();
    loop {
        let raw = upstream_service::account_upstream_request(
            ctx,
            account_id,
            &format!("/api/v1/keys?page={page}&page_size=100&sort_by=created_at&sort_order=desc"),
            "GET",
            None,
            policy,
        )
        .await?;
        let next = normalize_items(&raw)
            .iter()
            .map(normalize_managed_key_record)
            .collect::<Vec<_>>();
        if next.is_empty() {
            break;
        }
        rows.extend(next);
        let total_pages = raw
            .get("pages")
            .and_then(|value| value.as_i64())
            .or_else(|| {
                raw.get("pagination")
                    .and_then(|value| value.get("pages"))
                    .and_then(|value| value.as_i64())
            })
            .unwrap_or(page);
        if page >= total_pages {
            break;
        }
        page += 1;
    }
    Ok(rows)
}

fn usage_dates_for_sync(
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<(Vec<NaiveDate>, bool)> {
    let today = shanghai_today();
    if start_date.is_none() && end_date.is_none() {
        let yesterday = today
            .checked_sub_days(Days::new(1))
            .ok_or_else(|| anyhow::anyhow!("无法计算昨日日期。"))?;
        return Ok((vec![yesterday, today], true));
    }

    let end = match end_date {
        Some(value) => parse_usage_date(&value, "结束日期")?,
        None => today,
    };
    let start = match start_date {
        Some(value) => parse_usage_date(&value, "开始日期")?,
        None => end,
    };
    if start > end {
        return Err(anyhow::anyhow!("用量开始日期不能晚于结束日期。"));
    }

    let mut dates = Vec::new();
    let mut date = start;
    loop {
        dates.push(date);
        if date == end {
            break;
        }
        date = date
            .succ_opt()
            .ok_or_else(|| anyhow::anyhow!("用量日期范围超出可处理范围。"))?;
    }
    Ok((dates, false))
}

async fn sync_usage_date_window(
    ctx: &AppContext,
    account_id: &str,
    reader: &mut SiteFailoverReadClient,
    date: NaiveDate,
    checkpoint_policy: UsageHistoryCheckpointPolicy,
    reporter: Option<&SyncProgressReporter>,
    progress_phase: AccountSyncProgressPhase,
    quantum: Option<&HistoryQuantum<'_>>,
    usage_writes: &UsageWriteTracker,
) -> Result<UsageWindowOutcome> {
    let mut window_attempt = 0_usize;
    let mut recovered_auth = false;
    let mut progress_attempt = 1_i64;

    loop {
        let now = usage_sync_timestamp();
        if matches!(checkpoint_policy, UsageHistoryCheckpointPolicy::Track) {
            repositories::mark_usage_history_active(
                &ctx.db,
                account_id,
                &date.to_string(),
                &now,
                &now,
            )?;
        }

        if let Some(reporter) = reporter {
            reporter
                .set_usage_detail(usage_progress_detail(
                    progress_phase,
                    None,
                    None,
                    Some(AccountSyncProgressUnit::Records),
                    Some(date.to_string()),
                    Some(progress_attempt),
                ))
                .await;
        }

        match sync_usage_date_window_attempt(
            ctx,
            account_id,
            reader,
            date,
            reporter,
            progress_phase,
            progress_attempt,
            quantum,
            usage_writes,
        )
        .await
        {
            Ok(result) => return Ok(result),
            Err(error) if auth_service::is_auth_expired_error(&error) && !recovered_auth => {
                match upstream_service::recover_usage_read_client(ctx, account_id).await {
                    Ok(recovered) => {
                        *reader = recovered;
                        recovered_auth = true;
                        progress_attempt += 1;
                    }
                    Err(recovery_error) => {
                        repositories::mark_usage_history_issue(
                            &ctx.db,
                            account_id,
                            usage_history_issue_state(&recovery_error),
                            &recovery_error.to_string(),
                            &usage_sync_timestamp(),
                        )?;
                        return Err(recovery_error);
                    }
                }
            }
            Err(error)
                if is_usage_window_changed(&error)
                    && window_attempt + 1 < MAX_USAGE_WINDOW_ATTEMPTS =>
            {
                window_attempt += 1;
                progress_attempt += 1;
            }
            Err(error) => {
                repositories::mark_usage_history_issue(
                    &ctx.db,
                    account_id,
                    usage_history_issue_state(&error),
                    &error.to_string(),
                    &usage_sync_timestamp(),
                )?;
                return Err(error);
            }
        }
    }
}

async fn sync_usage_date_window_attempt(
    ctx: &AppContext,
    account_id: &str,
    reader: &SiteFailoverReadClient,
    date: NaiveDate,
    reporter: Option<&SyncProgressReporter>,
    progress_phase: AccountSyncProgressPhase,
    progress_attempt: i64,
    quantum: Option<&HistoryQuantum<'_>>,
    usage_writes: &UsageWriteTracker,
) -> Result<UsageWindowOutcome> {
    let consistency = UsageWindowConsistency::for_date(date);
    let FetchedUsagePage {
        envelope: first_page,
        _page_slot: first_page_slot,
    } = fetch_usage_page_with_retry(
        ctx,
        reader,
        Some(date),
        1,
        USAGE_PAGE_SIZE,
        UsagePageOrder::Asc,
        reporter,
    )
    .await?;
    let expected_total = first_page.total;
    let expected_pages = first_page.pages;
    let expected_page_size = first_page.page_size;
    let first_anchor = first_page.first_anchor.clone();
    let first_page_row_count = first_page.items.len() as i64;
    let mut last_anchor = if expected_pages == 1 {
        first_page.last_anchor.clone()
    } else {
        None
    };
    let updated_at = usage_sync_timestamp();
    if let Some(reporter) = reporter {
        reporter
            .set_usage_detail(usage_progress_detail(
                progress_phase,
                Some(0),
                Some(expected_total),
                Some(AccountSyncProgressUnit::Records),
                Some(date.to_string()),
                Some(progress_attempt),
            ))
            .await;
    }
    let mut merged_count = merge_usage_page(
        ctx,
        account_id,
        first_page.items,
        updated_at.clone(),
        usage_writes,
    )
    .await?;
    drop(first_page_slot);
    let mut processed_count = first_page_row_count.min(expected_total.max(0));
    if let Some(reporter) = reporter {
        reporter
            .set_usage_detail(usage_progress_detail(
                progress_phase,
                Some(processed_count),
                Some(expected_total),
                Some(AccountSyncProgressUnit::Records),
                Some(date.to_string()),
                Some(progress_attempt),
            ))
            .await;
    }
    if history_quantum_should_yield(quantum).await {
        return Ok(UsageWindowOutcome::Yielded { merged_count });
    }

    let mut readers = JoinSet::new();
    let mut next_page = 2_i64;
    while next_page <= expected_pages && readers.len() < MAX_USAGE_PAGE_SLOTS {
        spawn_usage_page_reader(&mut readers, ctx, reader, date, next_page, reporter);
        next_page += 1;
    }

    while let Some(result) = readers.join_next().await {
        let FetchedUsagePage {
            envelope: mut page,
            _page_slot: page_slot,
        } = match result {
            Ok(Ok(page)) => page,
            Ok(Err(error)) => {
                drain_usage_page_readers(&mut readers).await;
                return Err(error);
            }
            Err(error) => {
                drain_usage_page_readers(&mut readers).await;
                return Err(anyhow::anyhow!("用量页面读取任务中断: {error}"));
            }
        };
        if !consistency.metadata_matches(&page, expected_total, expected_pages, expected_page_size)
        {
            drop(page_slot);
            drain_usage_page_readers(&mut readers).await;
            return Err(usage_window_changed_error());
        }
        if page.page == expected_pages {
            let snapshot_row_count = usage_snapshot_last_page_row_count(
                expected_total,
                expected_pages,
                expected_page_size,
            );
            last_anchor = usage_snapshot_boundary_anchor(
                &page,
                expected_total,
                expected_pages,
                expected_page_size,
            );
            if snapshot_row_count > 0 && last_anchor.is_none() {
                drop(page_slot);
                drain_usage_page_readers(&mut readers).await;
                return Err(usage_window_changed_error());
            }
            page.items.truncate(snapshot_row_count);
        }
        let page_row_count = page.items.len() as i64;
        let merged = merge_usage_page(
            ctx,
            account_id,
            page.items,
            updated_at.clone(),
            usage_writes,
        )
        .await;
        drop(page_slot);
        match merged {
            Ok(count) => {
                merged_count += count;
                processed_count = (processed_count + page_row_count).min(expected_total.max(0));
                if let Some(reporter) = reporter {
                    reporter
                        .set_usage_detail(usage_progress_detail(
                            progress_phase,
                            Some(processed_count),
                            Some(expected_total),
                            Some(AccountSyncProgressUnit::Records),
                            Some(date.to_string()),
                            Some(progress_attempt),
                        ))
                        .await;
                }
            }
            Err(error) => {
                drain_usage_page_readers(&mut readers).await;
                return Err(error);
            }
        }

        if history_quantum_should_yield(quantum).await {
            drain_usage_page_readers(&mut readers).await;
            return Ok(UsageWindowOutcome::Yielded { merged_count });
        }

        if next_page <= expected_pages {
            spawn_usage_page_reader(&mut readers, ctx, reader, date, next_page, reporter);
            next_page += 1;
        }
    }

    if history_quantum_should_yield(quantum).await {
        return Ok(UsageWindowOutcome::Yielded { merged_count });
    }

    let postflight_first = fetch_usage_page_with_retry(
        ctx,
        reader,
        Some(date),
        1,
        USAGE_PAGE_SIZE,
        UsagePageOrder::Asc,
        reporter,
    )
    .await?;
    let postflight_last_anchor = usage_snapshot_boundary_anchor(
        &postflight_first.envelope,
        expected_total,
        expected_pages,
        expected_page_size,
    );
    let postflight_matches = consistency.metadata_matches(
        &postflight_first.envelope,
        expected_total,
        expected_pages,
        expected_page_size,
    ) && (expected_total == 0
        || anchors_match(
            postflight_first.envelope.first_anchor.as_ref(),
            first_anchor.as_ref(),
        ))
        && (expected_pages > 1
            || anchors_match(postflight_last_anchor.as_ref(), last_anchor.as_ref()));
    drop(postflight_first);
    if !postflight_matches {
        return Err(usage_window_changed_error());
    }

    if expected_pages > 1 {
        if history_quantum_should_yield(quantum).await {
            return Ok(UsageWindowOutcome::Yielded { merged_count });
        }
        let postflight_last = fetch_usage_page_with_retry(
            ctx,
            reader,
            Some(date),
            expected_pages,
            USAGE_PAGE_SIZE,
            UsagePageOrder::Asc,
            reporter,
        )
        .await?;
        let postflight_last_anchor = usage_snapshot_boundary_anchor(
            &postflight_last.envelope,
            expected_total,
            expected_pages,
            expected_page_size,
        );
        let postflight_matches =
            consistency.metadata_matches(
                &postflight_last.envelope,
                expected_total,
                expected_pages,
                expected_page_size,
            ) && anchors_match(postflight_last_anchor.as_ref(), last_anchor.as_ref());
        drop(postflight_last);
        if !postflight_matches {
            return Err(usage_window_changed_error());
        }
    }

    let changed_rows = if merged_count > 0 {
        repositories::list_usage_rows_updated_at(&ctx.db, account_id, &updated_at)?
    } else {
        Vec::new()
    };
    Ok(UsageWindowOutcome::Completed(UsageWindowResult {
        merged_count,
        changed_rows,
    }))
}

fn spawn_usage_page_reader(
    readers: &mut JoinSet<Result<FetchedUsagePage>>,
    ctx: &AppContext,
    reader: &SiteFailoverReadClient,
    date: NaiveDate,
    page: i64,
    reporter: Option<&SyncProgressReporter>,
) {
    let ctx = ctx.clone();
    let reader = reader.clone();
    let reporter = reporter.cloned();
    readers.spawn(async move {
        fetch_usage_page_with_retry(
            &ctx,
            &reader,
            Some(date),
            page,
            USAGE_PAGE_SIZE,
            UsagePageOrder::Asc,
            reporter.as_ref(),
        )
        .await
    });
}

async fn drain_usage_page_readers(readers: &mut JoinSet<Result<FetchedUsagePage>>) {
    // 保留 page permit 直到已发出的 HTTP future 收束，避免远端仍在处理时本地过早释放槽位。
    while readers.join_next().await.is_some() {}
}

async fn merge_usage_page(
    ctx: &AppContext,
    account_id: &str,
    rows: Vec<UsageRow>,
    updated_at: String,
    usage_writes: &UsageWriteTracker,
) -> Result<i64> {
    if rows.is_empty() {
        return Ok(0);
    }
    let _writer_slot = ctx.live_resources.acquire_usage_writer_slot().await?;
    let db = ctx.db.clone();
    let account_id = account_id.to_string();
    let merged_count = tokio::task::spawn_blocking(move || {
        repositories::merge_usage_row_cache(&db, &account_id, &rows, &updated_at)
    })
    .await
    .map_err(|error| anyhow::anyhow!("用量页面写入任务中断: {error}"))??;
    usage_writes.record_merge(merged_count);
    Ok(merged_count)
}

async fn fetch_earliest_usage_date(
    ctx: &AppContext,
    reader: &SiteFailoverReadClient,
    reporter: Option<&SyncProgressReporter>,
) -> Result<Option<NaiveDate>> {
    for attempt in 1..=MAX_EARLIEST_USAGE_PROBE_ATTEMPTS {
        let asc_page =
            fetch_usage_page_with_retry(ctx, reader, None, 1, 1, UsagePageOrder::Asc, reporter)
                .await?;
        if asc_page.envelope.total == 0 {
            return Ok(None);
        }
        let total = asc_page.envelope.total;
        let pages = asc_page.envelope.pages;
        let asc_date = asc_page
            .envelope
            .items
            .first()
            .map(|row| usage_row_date(&row.created_at))
            .transpose()?
            .ok_or_else(|| anyhow::anyhow!("上游用量最早日期探针缺少记录。"))?;
        drop(asc_page);

        let desc_page = fetch_usage_page_with_retry(
            ctx,
            reader,
            None,
            pages,
            1,
            UsagePageOrder::Desc,
            reporter,
        )
        .await?;
        if usage_page_metadata_matches(&desc_page.envelope, total, pages, 1) {
            let desc_date = desc_page
                .envelope
                .items
                .first()
                .map(|row| usage_row_date(&row.created_at))
                .transpose()?
                .ok_or_else(|| anyhow::anyhow!("上游用量最早日期探针缺少尾页记录。"))?;
            return Ok(Some(asc_date.min(desc_date)));
        }

        let is_monotonic_growth = desc_page.envelope.page_size == 1
            && desc_page.envelope.total >= total
            && desc_page.envelope.pages >= pages
            && (desc_page.envelope.total > total || desc_page.envelope.pages > pages);
        if !is_monotonic_growth {
            return Err(anyhow::anyhow!(EARLIEST_USAGE_PROBE_METADATA_CHANGED_ERROR));
        }
        if attempt == MAX_EARLIEST_USAGE_PROBE_ATTEMPTS {
            log::warn!(
                "[usage-history] 最早日期探针分页元数据持续增长且达到重试上限: attempt={attempt} expectedTotal={total} actualTotal={} expectedPages={pages} actualPages={}",
                desc_page.envelope.total,
                desc_page.envelope.pages,
            );
            return Err(anyhow::Error::new(EarliestUsageProbeGrowthExhausted));
        }
        log::warn!(
            "[usage-history] 最早日期探针分页元数据增长，重新读取探针对: attempt={attempt} expectedTotal={total} actualTotal={} expectedPages={pages} actualPages={}",
            desc_page.envelope.total,
            desc_page.envelope.pages,
        );
    }

    Err(anyhow::anyhow!(EARLIEST_USAGE_PROBE_METADATA_CHANGED_ERROR))
}

async fn fetch_usage_page_with_retry(
    _ctx: &AppContext,
    reader: &SiteFailoverReadClient,
    date: Option<NaiveDate>,
    page: i64,
    page_size: i64,
    order: UsagePageOrder,
    _reporter: Option<&SyncProgressReporter>,
) -> Result<FetchedUsagePage> {
    let path = usage_page_path(date, page, page_size, order);
    let response = reader.get_usage_api(&path).await?;
    let envelope = parse_usage_page(&response.value, date, page, page_size, order)?;
    Ok(FetchedUsagePage {
        envelope,
        _page_slot: response.page_slot,
    })
}

fn usage_page_path(
    date: Option<NaiveDate>,
    page: i64,
    page_size: i64,
    order: UsagePageOrder,
) -> String {
    let date_filter = date
        .map(|date| format!("&start_date={date}&end_date={date}"))
        .unwrap_or_default();
    format!(
        "/api/v1/usage?page={page}&page_size={page_size}{date_filter}&sort_by=created_at&sort_order={}&timezone=Asia%2FShanghai",
        order.query_value()
    )
}

fn parse_usage_page(
    raw: &Value,
    expected_date: Option<NaiveDate>,
    expected_page: i64,
    expected_page_size: i64,
    order: UsagePageOrder,
) -> Result<UsagePageEnvelope> {
    let page = required_usage_pagination_value(raw, "page")?;
    let page_size = required_usage_pagination_value(raw, "page_size")?;
    let total = required_usage_pagination_value(raw, "total")?;
    let pages = required_usage_pagination_value(raw, "pages")?;
    if page != expected_page || page_size != expected_page_size || total < 0 || pages < 0 {
        return Err(anyhow::anyhow!("上游用量分页元数据与请求不一致。"));
    }

    let items = raw
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("上游用量分页缺少 items。"))?;
    let expected_pages = if total == 0 {
        0
    } else {
        (total + page_size - 1) / page_size
    };
    if (total == 0 && pages != 0 && pages != 1) || (total > 0 && pages != expected_pages) {
        return Err(anyhow::anyhow!("上游用量分页页数与总量不一致。"));
    }
    if total > 0 && page > pages {
        return Err(anyhow::anyhow!("上游用量分页返回了越界页面。"));
    }
    let expected_items = if total == 0 {
        0
    } else {
        (total - (page - 1) * page_size).clamp(0, page_size)
    };
    if items.len() as i64 != expected_items {
        return Err(anyhow::anyhow!("上游用量分页记录数与元数据不一致。"));
    }

    let mut normalized = Vec::with_capacity(items.len());
    let mut previous_anchor: Option<UsagePageAnchor> = None;
    let mut first_anchor = None;
    let mut last_anchor = None;
    for item in items {
        let normalized_item = normalize_usage_row(item);
        let id = normalized_item.id.trim().to_string();
        if id.is_empty() {
            return Err(anyhow::anyhow!("上游用量记录缺少稳定 id。"));
        }
        let created_at = normalized_item.created_at.trim().to_string();
        if created_at.is_empty() {
            return Err(anyhow::anyhow!("上游用量记录缺少 created_at。"));
        }
        if let Some(expected_date) = expected_date {
            if usage_row_date(&created_at)? != expected_date {
                return Err(anyhow::anyhow!("上游用量记录落在请求日期窗口之外。"));
            }
        }
        let anchor = UsagePageAnchor { created_at, id };
        if let Some(previous) = &previous_anchor {
            if !order.is_ordered(previous, &anchor) {
                return Err(anyhow::anyhow!("上游用量记录未按请求排序返回。"));
            }
        }
        if first_anchor.is_none() {
            first_anchor = Some(UsagePageAnchor {
                created_at: anchor.created_at.clone(),
                id: anchor.id.clone(),
            });
        }
        last_anchor = Some(UsagePageAnchor {
            created_at: anchor.created_at.clone(),
            id: anchor.id.clone(),
        });
        previous_anchor = Some(anchor);
        normalized.push(normalized_item);
    }

    Ok(UsagePageEnvelope {
        page,
        page_size,
        total,
        pages,
        items: normalized,
        first_anchor,
        last_anchor,
    })
}

fn required_usage_pagination_value(raw: &Value, key: &str) -> Result<i64> {
    raw.get(key)
        .or_else(|| {
            raw.get("pagination")
                .and_then(|pagination| pagination.get(key))
        })
        .and_then(value_as_i64)
        .ok_or_else(|| anyhow::anyhow!("上游用量分页缺少 {key}。"))
}

fn value_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| value.as_str().and_then(|value| value.parse::<i64>().ok()))
}

fn usage_page_metadata_matches(
    page: &UsagePageEnvelope,
    expected_total: i64,
    expected_pages: i64,
    expected_page_size: i64,
) -> bool {
    page.total == expected_total
        && page.pages == expected_pages
        && page.page_size == expected_page_size
}

/// 计算首次快照最后一页应纳入本轮的记录数。
fn usage_snapshot_last_page_row_count(
    expected_total: i64,
    expected_pages: i64,
    expected_page_size: i64,
) -> usize {
    if expected_total <= 0 || expected_pages <= 0 {
        return 0;
    }
    (expected_total - (expected_pages - 1) * expected_page_size).clamp(0, expected_page_size)
        as usize
}

/// 从原始最后一页提取首次快照的截止锚点，忽略其后新增的记录。
fn usage_snapshot_boundary_anchor(
    page: &UsagePageEnvelope,
    expected_total: i64,
    expected_pages: i64,
    expected_page_size: i64,
) -> Option<UsagePageAnchor> {
    if page.page != expected_pages {
        return None;
    }
    let row_count =
        usage_snapshot_last_page_row_count(expected_total, expected_pages, expected_page_size);
    let row = page.items.get(row_count.checked_sub(1)?)?;
    Some(UsagePageAnchor {
        created_at: row.created_at.clone(),
        id: row.id.clone(),
    })
}

fn anchors_match(left: Option<&UsagePageAnchor>, right: Option<&UsagePageAnchor>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => left.created_at == right.created_at && left.id == right.id,
        (None, None) => true,
        _ => false,
    }
}

fn usage_history_issue_state(error: &anyhow::Error) -> repositories::UsageHistoryState {
    let rate_limited = error
        .downcast_ref::<crate::infrastructure::sub2api::client::UpstreamFailure>()
        .is_some_and(|failure| {
            failure.category
                == crate::infrastructure::sub2api::client::UpstreamFailureCategory::RateLimited
        });
    if rate_limited {
        repositories::UsageHistoryState::Degraded
    } else {
        repositories::UsageHistoryState::NeedsAudit
    }
}

fn usage_window_changed_error() -> anyhow::Error {
    anyhow::anyhow!(USAGE_WINDOW_CHANGED_ERROR)
}

fn is_usage_window_changed(error: &anyhow::Error) -> bool {
    error.to_string().contains(USAGE_WINDOW_CHANGED_ERROR)
}

fn is_earliest_usage_probe_growth_exhausted(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<EarliestUsageProbeGrowthExhausted>()
            .is_some()
    })
}

fn usage_history_resume_date(
    state: &repositories::AccountUsageHistoryStateRecord,
    observed_earliest_date: NaiveDate,
) -> Result<NaiveDate> {
    let stored_earliest_date =
        parse_usage_state_date(state.earliest_date.as_deref(), "最早历史日期")?;
    if stored_earliest_date.is_none()
        || stored_earliest_date.is_some_and(|date| observed_earliest_date < date)
    {
        return Ok(observed_earliest_date);
    }
    if let Some(active_date) = parse_usage_state_date(state.active_date.as_deref(), "活动日期")?
    {
        return Ok(active_date.max(observed_earliest_date));
    }
    if let Some(completed_through_date) =
        parse_usage_state_date(state.completed_through_date.as_deref(), "历史完成日期")?
    {
        return Ok(completed_through_date
            .succ_opt()
            .unwrap_or(observed_earliest_date)
            .max(observed_earliest_date));
    }
    Ok(observed_earliest_date)
}

fn parse_usage_state_date(value: Option<&str>, label: &str) -> Result<Option<NaiveDate>> {
    value
        .map(|value| parse_usage_date(value, label))
        .transpose()
}

fn parse_usage_date(value: &str, label: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| anyhow::anyhow!("{label}格式无效。"))
}

fn usage_row_date(value: &str) -> Result<NaiveDate> {
    storage_timestamp_date(value).context("上游用量记录 created_at 格式无效。")
}

fn is_recent_usage_date(date: NaiveDate, today: NaiveDate) -> bool {
    today
        .checked_sub_days(Days::new(1))
        .is_some_and(|yesterday| date >= yesterday)
}

fn usage_sync_timestamp() -> String {
    now_storage_timestamp()
}

pub(crate) async fn fetch_subscriptions(
    ctx: &AppContext,
    account_id: &str,
    policy: UpstreamRequestPolicy,
) -> Result<Vec<SubscriptionRecord>> {
    let raw = match upstream_service::account_upstream_request(
        ctx,
        account_id,
        "/api/v1/subscriptions",
        "GET",
        None,
        policy,
    )
    .await
    {
        Ok(raw) => raw,
        Err(error) if is_missing_upstream_path_error(&error) => {
            upstream_service::account_upstream_request(
                ctx,
                account_id,
                "/api/v1/subscriptions/active",
                "GET",
                None,
                policy,
            )
            .await?
        }
        Err(error) => return Err(error),
    };
    let mut subscriptions = normalize_items(&raw)
        .into_iter()
        .map(|item| {
            let group_id = item.get("group_id").and_then(|value| value.as_i64());
            let name = item
                .get("group")
                .and_then(|value| value.get("name"))
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
                .or_else(|| {
                    item.get("name")
                        .and_then(|value| value.as_str())
                        .map(ToString::to_string)
                })
                .unwrap_or_else(|| "Subscription".into());
            let group_name = item
                .get("group")
                .and_then(|value| value.get("name"))
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
                .or_else(|| {
                    item.get("group_name")
                        .and_then(|value| value.as_str())
                        .map(ToString::to_string)
                });
            let platform = item
                .get("group")
                .and_then(|value| value.get("platform"))
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
                .or_else(|| {
                    item.get("platform")
                        .and_then(|value| value.as_str())
                        .map(ToString::to_string)
                });
            let upstream_subscription_id = item
                .get("id")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let identity = crate::domain::subscription_identity::derive_subscription_identity(
                group_id,
                upstream_subscription_id,
                platform.as_deref(),
                group_name.as_deref(),
                &name,
            );
            SubscriptionRecord {
                id: stable_subscription_record_id(&item),
                subscription_key: identity.subscription_key,
                identity_kind: identity.identity_kind,
                identity_ambiguous: false,
                upstream_subscription_id: identity.upstream_subscription_id,
                fallback_identity: identity.fallback_identity,
                group_id,
                name,
                status: item
                    .get("status")
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string)
                    .unwrap_or_else(|| "unknown".into()),
                group_name,
                platform,
                expires_at: item
                    .get("expires_at")
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string),
                daily: quota_window(&item, "daily"),
                weekly: quota_window(&item, "weekly"),
                monthly: quota_window(&item, "monthly"),
            }
        })
        .collect::<Vec<_>>();
    crate::domain::subscription_identity::mark_ambiguous_subscription_identities(
        &mut subscriptions,
    );
    Ok(subscriptions)
}

fn is_missing_upstream_path_error(error: &anyhow::Error) -> bool {
    error.to_string().contains("未找到可用的接口路径")
}

fn stable_subscription_record_id(item: &serde_json::Value) -> String {
    if let Some(id) = item
        .get("id")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return id.to_string();
    }
    if let Some(group_id) = item.get("group_id").and_then(|value| value.as_i64()) {
        return format!("subscription-group-{group_id}");
    }
    let group_name = item
        .get("group")
        .and_then(|value| value.get("name"))
        .and_then(|value| value.as_str())
        .or_else(|| item.get("group_name").and_then(|value| value.as_str()))
        .or_else(|| item.get("name").and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("subscription");
    format!(
        "subscription-name-{}",
        group_name
            .to_lowercase()
            .replace(|ch: char| !ch.is_ascii_alphanumeric(), "-")
    )
}

fn quota_window(
    item: &serde_json::Value,
    key: &str,
) -> Option<crate::contracts::SubscriptionQuotaWindow> {
    let node = item.get(key)?;
    let current = node.get("current")?.as_f64()?;
    let limit = node.get("limit")?.as_f64()?;
    Some(crate::contracts::SubscriptionQuotaWindow {
        current,
        limit,
        window_start: node
            .get("window_start")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
    })
}

pub(crate) fn derive_subscription_summary(
    subscriptions: &[SubscriptionRecord],
) -> SubscriptionSummaryPayload {
    let rows = subscriptions
        .iter()
        .map(|item| crate::contracts::SubscriptionSummaryRecord {
            id: item
                .id
                .strip_prefix("summary-")
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0),
            group_id: item.group_id.unwrap_or(0),
            group_name: item.group_name.clone().unwrap_or_else(|| item.name.clone()),
            status: item.status.clone(),
            daily_used_usd: item
                .daily
                .as_ref()
                .map(|value| value.current)
                .unwrap_or(0.0),
            daily_limit_usd: item.daily.as_ref().map(|value| value.limit).unwrap_or(0.0),
            weekly_used_usd: item
                .weekly
                .as_ref()
                .map(|value| value.current)
                .unwrap_or(0.0),
            monthly_used_usd: item
                .monthly
                .as_ref()
                .map(|value| value.current)
                .unwrap_or(0.0),
            expires_at: item.expires_at.clone(),
        })
        .collect::<Vec<_>>();
    SubscriptionSummaryPayload {
        active_count: rows.iter().filter(|item| item.status == "active").count() as i64,
        total_used_usd: rows.iter().map(|item| item.daily_used_usd).sum(),
        subscriptions: rows,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    use std::time::Duration;

    use axum::{
        extract::Query,
        http::{header::AUTHORIZATION, HeaderMap, StatusCode},
        response::IntoResponse,
        routing::{get, post},
        Json, Router,
    };
    use chrono::{Days, NaiveDate};
    use serde_json::json;
    use tokio::sync::{Mutex, Notify};

    use super::{
        fetch_earliest_usage_date, fetch_platform_quotas, get_account_sync_status,
        initial_sync_progress, parse_usage_page, refresh_account, repair_usage_cache_from_legacy,
        sync_account_data, sync_failure_response_from_error, sync_initial_usage_history_if_needed,
        sync_startup_recent_four_day_usage_reads_for_today, sync_usage_scope,
        usage_history_issue_state, usage_progress_detail, SyncProgressReporter, UsagePageOrder,
    };
    use crate::application::scheduler_service::{
        build_usage_update_notification, should_enqueue_usage_update_notifications,
    };
    use crate::application::site_failover_service::{SiteFailoverError, SiteFailoverErrorCode};
    use crate::application::upstream_service::{self, UpstreamRequestPolicy};
    use crate::application::{
        account_service, context::SyncTaskHandle, keys_service, profile_service, usage_service,
        AppContext,
    };
    use crate::contracts::{
        AccountRecord, AccountSyncProgressPhase, AccountSyncProgressStageId,
        AccountSyncProgressStageState, AccountSyncProgressUnit, AccountSyncState,
        AccountSyncStatusRecord, DataSyncScope, DataSyncTrigger, RefreshTriggerSource, SiteRecord,
        StoredSession, SyncAccountDataInput, SyncFailureCategory, TaskRunStatus, UsageRow,
    };
    use crate::infrastructure::datetime::shanghai_today;
    use crate::infrastructure::files::AppPaths;
    use crate::infrastructure::sqlite::{repositories, Database, DatabaseMigrationPhase};
    use crate::infrastructure::sub2api::client::{UpstreamFailure, UpstreamFailureCategory};
    use crate::infrastructure::sub2api::normalizers::normalize_usage_row;
    use crate::test_support::TestAxumServer;
    use crate::FloatingNotificationMailbox;

    #[test]
    fn history_issue_classifies_rate_limit_as_degraded_and_protocol_as_needs_audit() {
        let rate_limited = anyhow::Error::new(UpstreamFailure {
            category: UpstreamFailureCategory::RateLimited,
            http_status: Some(429),
            message: "上游请求受限。".into(),
            retry_after_ms: Some(1_000),
            endpoint_family: "usage_page".into(),
        });

        assert_eq!(
            usage_history_issue_state(&rate_limited),
            repositories::UsageHistoryState::Degraded
        );
        assert_eq!(
            usage_history_issue_state(&super::usage_window_changed_error()),
            repositories::UsageHistoryState::NeedsAudit
        );
    }

    #[test]
    fn sync_failures_preserve_every_failover_transport_field() {
        let retry_at_ms = 1_700_000_000_000;
        let cases = [
            (
                SiteFailoverErrorCode::AllAddressesCooling,
                "all_site_addresses_cooling",
                SyncFailureCategory::Transport,
                Some(503),
                Some(retry_at_ms),
                Some(1_250),
            ),
            (
                SiteFailoverErrorCode::AllAddressesRateLimited,
                "all_site_addresses_rate_limited",
                SyncFailureCategory::RateLimited,
                Some(429),
                Some(retry_at_ms),
                Some(5_000),
            ),
            (
                SiteFailoverErrorCode::NoReachableAddress,
                "no_reachable_site_address",
                SyncFailureCategory::Transport,
                Some(502),
                None,
                None,
            ),
            (
                SiteFailoverErrorCode::UnsafeWriteNotReplayed,
                "unsafe_write_not_replayed",
                SyncFailureCategory::Transport,
                Some(502),
                None,
                None,
            ),
        ];

        for (
            code,
            expected_code,
            expected_category,
            expected_http_status,
            retry_at_ms,
            retry_after_ms,
        ) in cases
        {
            let error = anyhow::Error::new(SiteFailoverError::for_test(
                code,
                retry_at_ms,
                retry_after_ms,
            ));
            let response = sync_failure_response_from_error(&error);

            assert_eq!(response.failure.category, expected_category);
            assert_eq!(response.failure.code.as_deref(), Some(expected_code));
            assert_eq!(response.failure.http_status, expected_http_status);
            assert_eq!(response.failure.retry_after_ms, retry_after_ms);
            assert_eq!(
                response.failure.retry_at.as_deref(),
                retry_at_ms.map(|_| "2023-11-14T22:13:20.000Z")
            );
            assert!(response.failure.retry_exhausted);
            assert_eq!(response.error, response.failure.message);
        }
    }

    #[test]
    fn unsafe_write_sync_failure_preserves_original_http_status() {
        let upstream = UpstreamFailure {
            category: UpstreamFailureCategory::Http,
            http_status: Some(503),
            message: "上游服务不可用。".into(),
            retry_after_ms: None,
            endpoint_family: "profile".into(),
        };
        let error = anyhow::Error::new(SiteFailoverError::unsafe_write(Some(upstream)));

        let response = sync_failure_response_from_error(&error);
        assert_eq!(response.failure.category, SyncFailureCategory::Transport);
        assert_eq!(
            response.failure.code.as_deref(),
            Some("unsafe_write_not_replayed")
        );
        assert_eq!(response.failure.http_status, Some(503));
        assert!(response.failure.retry_exhausted);
    }

    #[test]
    fn parse_usage_page_accepts_request_id_as_stable_anchor() {
        let raw = json!({
            "items": [{
                "request_id": "request-only-1",
                "created_at": "2026-07-21T00:00:00+08:00",
                "model": "gpt-5.4",
                "input_tokens": 10,
                "output_tokens": 5,
                "total_tokens": 15
            }],
            "page": 1,
            "page_size": 1,
            "total": 1,
            "pages": 1
        });

        let page = parse_usage_page(&raw, None, 1, 1, UsagePageOrder::Desc)
            .expect("request_id must be accepted as the stable usage id");

        assert_eq!(page.items[0].id, "request-only-1");
        assert_eq!(
            page.first_anchor.as_ref().map(|anchor| anchor.id.as_str()),
            Some("request-only-1")
        );
    }

    #[tokio::test]
    async fn read_only_optional_fetch_keeps_auth_recovery_failure_visible() {
        let app = Router::new()
            .route(
                "/api/v1/user/platform-quotas",
                get(|| async { StatusCode::UNAUTHORIZED }),
            )
            .route(
                "/api/v1/user/profile",
                get(|| async { StatusCode::UNAUTHORIZED }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve upstream mock");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-read-only-error",
            "site-read-only-error",
            "只读鉴权账号",
        );

        let error = fetch_platform_quotas(
            &ctx,
            "account-read-only-error",
            UpstreamRequestPolicy::ReadOnly,
        )
        .await
        .expect_err("auth recovery failure must not degrade to an empty optional payload");

        server.abort();

        assert_eq!(
            error.to_string(),
            "账号 只读鉴权账号 尚未保存可恢复凭据，请重新登录。"
        );
    }

    #[tokio::test]
    async fn same_account_same_scope_joins_single_flight_run() {
        let group_hits = Arc::new(AtomicUsize::new(0));
        let key_hits = Arc::new(AtomicUsize::new(0));

        let app = {
            let group_hits = Arc::clone(&group_hits);
            let key_hits = Arc::clone(&key_hits);
            Router::new()
                .route(
                    "/api/v1/groups/available",
                    get(move || {
                        let group_hits = Arc::clone(&group_hits);
                        async move {
                            group_hits.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(120)).await;
                            Json(json!({
                                "items": [
                                    {
                                        "id": 1,
                                        "name": "默认分组",
                                        "platform": "openai",
                                        "rate_multiplier": 1.0
                                    }
                                ]
                            }))
                        }
                    }),
                )
                .route(
                    "/api/v1/keys",
                    get(move || {
                        let key_hits = Arc::clone(&key_hits);
                        async move {
                            key_hits.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(120)).await;
                            Json(json!({
                                "items": [
                                    {
                                        "id": "key-1",
                                        "group_id": 1,
                                        "name": "主 Key",
                                        "status": "active",
                                        "platform": "openai"
                                    }
                                ]
                            }))
                        }
                    }),
                )
        };

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-1",
            "site-1",
            "主账号",
        );

        let input = SyncAccountDataInput {
            scope: DataSyncScope::Keys,
            trigger_source: DataSyncTrigger::Manual,
        };

        let (first, second) = tokio::join!(
            sync_account_data(&ctx, "account-1", input.clone()),
            sync_account_data(&ctx, "account-1", input)
        );

        let first = first.expect("first sync result");
        let second = second.expect("second sync result");
        assert_eq!(first.status.account_id, "account-1");
        assert_eq!(second.status.account_id, "account-1");
        assert_eq!(group_hits.load(Ordering::SeqCst), 1);
        assert_eq!(key_hits.load(Ordering::SeqCst), 1);
        assert_eq!(first.run.id, second.run.id);
        assert_eq!(first.run.join_count, 1);
        assert_eq!(first.run.status, TaskRunStatus::Succeeded);
        assert_ne!(first.notification_owner, second.notification_owner);
    }

    #[tokio::test]
    async fn same_account_same_usage_scope_returns_changed_rows_to_every_joiner_once() {
        let usage_hits = Arc::new(AtomicUsize::new(0));
        let today = super::shanghai_today().to_string();
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let usage_hits = Arc::clone(&usage_hits);
                let today = today.clone();
                move |Query(query): Query<HashMap<String, String>>| {
                    let usage_hits = Arc::clone(&usage_hits);
                    let today = today.clone();
                    async move {
                        usage_hits.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(120)).await;
                        let page = query
                            .get("page")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1);
                        let page_size = query
                            .get("page_size")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1_000);
                        let items = if query.get("start_date").is_some_and(|date| date == &today) {
                            vec![json!({
                                "id": "usage-single-flight-1",
                                "created_at": format!("{today}T08:00:00+08:00"),
                                "model": "gpt-5.4",
                                "actual_cost": 0.6,
                                "total_cost": 0.6,
                                "input_tokens": 50,
                                "output_tokens": 20,
                                "total_tokens": 70
                            })]
                        } else {
                            Vec::new()
                        };
                        let total = items.len() as i64;
                        Json(json!({
                            "items": items,
                            "page": page,
                            "page_size": page_size,
                            "total": total,
                            "pages": 1
                        }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-usage-single-flight",
            "site-usage-single-flight",
            "用量单飞账号",
        );
        let input = SyncAccountDataInput {
            scope: DataSyncScope::Usage,
            trigger_source: DataSyncTrigger::Manual,
        };

        let (first, second) = tokio::join!(
            sync_account_data(&ctx, "account-usage-single-flight", input.clone()),
            sync_account_data(&ctx, "account-usage-single-flight", input.clone())
        );
        let first = first.expect("first usage sync result");
        let second = second.expect("second usage sync result");

        assert_eq!(usage_hits.load(Ordering::SeqCst), 4);
        assert_eq!(first.run.id, second.run.id);
        assert_eq!(first.run.join_count, 1);
        let first_status = get_account_sync_status(&ctx, "account-usage-single-flight")
            .await
            .expect("retained usage terminal status");
        assert_eq!(first_status.statuses.len(), 1);
        assert_eq!(first_status.statuses[0].scope, DataSyncScope::Usage);
        assert_eq!(first_status.statuses[0].state, AccountSyncState::Succeeded);
        assert_eq!(
            first_status.statuses[0].run_id.as_deref(),
            Some(first.run.id.as_str())
        );
        assert_eq!(first_status.statuses[0].item_count, 1);
        assert_eq!(first.changed_usage_rows.len(), 1);
        assert_eq!(second.changed_usage_rows.len(), 1);
        assert_eq!(first.changed_usage_rows[0].id, "usage-single-flight-1");
        assert_eq!(second.changed_usage_rows[0].id, "usage-single-flight-1");
        assert_ne!(first.notification_owner, second.notification_owner);
        assert_eq!(
            [first.notification_owner, second.notification_owner]
                .into_iter()
                .filter(|owner| *owner)
                .count(),
            1
        );
        assert!(!first.usage_notification_eligible);
        assert_eq!(
            first.usage_notification_eligible,
            second.usage_notification_eligible
        );

        let second_round = sync_account_data(&ctx, "account-usage-single-flight", input)
            .await
            .expect("second usage sync result");
        assert!(second_round.usage_notification_eligible);
        assert_ne!(second_round.run.id, first.run.id);
        let second_status = get_account_sync_status(&ctx, "account-usage-single-flight")
            .await
            .expect("latest usage terminal status");
        assert_eq!(second_status.statuses.len(), 1);
        assert_eq!(
            second_status.statuses[0].run_id.as_deref(),
            Some(second_round.run.id.as_str())
        );
        assert_eq!(second_status.statuses[0].item_count, 0);

        let owner = [&first, &second]
            .into_iter()
            .find(|result| result.notification_owner)
            .expect("one joiner must own the notification side effect");
        let joiner = [&first, &second]
            .into_iter()
            .find(|result| !result.notification_owner)
            .expect("one joiner must not own the notification side effect");
        let mut mailbox = FloatingNotificationMailbox::default();
        let mut owner_gated_enqueue_attempts = 0;

        for result in [owner, joiner] {
            if !should_enqueue_usage_update_notifications(
                result.notification_owner,
                true,
                &result.changed_usage_rows,
            ) {
                continue;
            }
            for row in &result.changed_usage_rows {
                owner_gated_enqueue_attempts += 1;
                mailbox.enqueue(
                    build_usage_update_notification("account-usage-single-flight", row)
                        .expect("changed usage row must build a notification"),
                );
            }
        }

        let owner_snapshot = mailbox.snapshot();
        assert_eq!(owner_gated_enqueue_attempts, 1);
        assert_eq!(owner_snapshot.items.len(), 1);
        assert_eq!(
            owner_snapshot.items[0].dedupe_key,
            "usage-sync:account-usage-single-flight:usage-single-flight-1"
        );

        let duplicate_from_joiner = build_usage_update_notification(
            "account-usage-single-flight",
            &joiner.changed_usage_rows[0],
        )
        .expect("joiner row must produce the same stable dedupe key");
        let deduplicated_snapshot = mailbox.enqueue(duplicate_from_joiner);
        assert_eq!(deduplicated_snapshot.items.len(), 1);
        assert_eq!(deduplicated_snapshot.revision, owner_snapshot.revision);
    }

    #[tokio::test]
    async fn completed_sync_task_without_result_returns_error_instead_of_panicking() {
        let run = crate::contracts::TaskRunRecord {
            id: "run-missing-result".into(),
            account_id: "account-missing".into(),
            scope: DataSyncScope::Keys,
            primary_trigger_source: DataSyncTrigger::Manual,
            status: TaskRunStatus::Succeeded,
            join_count: 0,
            started_at: "2026-06-28T00:00:00Z".into(),
            finished_at: Some("2026-06-28T00:00:01Z".into()),
            error_message: None,
        };
        let handle = Arc::new(SyncTaskHandle {
            state: Mutex::new(super::super::context::SyncTaskState {
                run,
                progress: None,
                completed: true,
                result: None,
            }),
            notify: tokio::sync::Notify::new(),
        });

        let error = super::wait_for_sync_task(handle, false)
            .await
            .expect_err("missing sync result should surface as error");

        assert!(error
            .to_string()
            .contains("同步任务状态异常: 已完成但没有结果"));
    }

    #[test]
    fn account_sync_status_accepts_payloads_without_progress() {
        let status: AccountSyncStatusRecord = serde_json::from_value(json!({
            "accountId": "account-legacy",
            "scope": "full",
            "state": "running",
            "lastAttemptAt": "2026-07-26T00:00:00Z",
            "lastSuccessAt": null,
            "lastError": null,
            "itemCount": 0
        }))
        .expect("legacy status payload must remain compatible");

        assert!(status.progress.is_none());
    }

    #[tokio::test]
    async fn progress_reporter_preserves_failure_and_cancels_unfinished_stages() {
        let run = crate::contracts::TaskRunRecord {
            id: "run-progress-cancel".into(),
            account_id: "account-progress".into(),
            scope: DataSyncScope::Full,
            primary_trigger_source: DataSyncTrigger::Manual,
            status: TaskRunStatus::Running,
            join_count: 0,
            started_at: "2026-07-26T00:00:00Z".into(),
            finished_at: None,
            error_message: None,
        };
        let handle = Arc::new(SyncTaskHandle {
            state: Mutex::new(super::super::context::SyncTaskState {
                run,
                progress: Some(initial_sync_progress(&DataSyncScope::Full)),
                completed: false,
                result: None,
            }),
            notify: tokio::sync::Notify::new(),
        });
        let reporter = SyncProgressReporter::new(Arc::clone(&handle));

        reporter
            .set_stage_state(
                AccountSyncProgressStageId::Core,
                AccountSyncProgressStageState::Succeeded,
            )
            .await;
        reporter
            .set_stage_state(
                AccountSyncProgressStageId::Keys,
                AccountSyncProgressStageState::Failed,
            )
            .await;
        reporter.cancel_unfinished_stages().await;

        let state = handle.state.lock().await;
        let progress = state
            .progress
            .as_ref()
            .expect("progress remains observable");
        let stage_state = |id| {
            progress
                .stages
                .iter()
                .find(|stage| stage.id == id)
                .map(|stage| stage.state)
                .expect("stage exists")
        };
        assert_eq!(
            stage_state(AccountSyncProgressStageId::Core),
            AccountSyncProgressStageState::Succeeded
        );
        assert_eq!(
            stage_state(AccountSyncProgressStageId::Keys),
            AccountSyncProgressStageState::Failed
        );
        assert_eq!(
            stage_state(AccountSyncProgressStageId::Usage),
            AccountSyncProgressStageState::Cancelled
        );
        assert_eq!(
            stage_state(AccountSyncProgressStageId::SubscriptionRules),
            AccountSyncProgressStageState::Cancelled
        );
    }

    #[tokio::test]
    async fn progress_reporter_replaces_usage_attempt_snapshot() {
        let run = crate::contracts::TaskRunRecord {
            id: "run-progress-attempt".into(),
            account_id: "account-progress".into(),
            scope: DataSyncScope::Usage,
            primary_trigger_source: DataSyncTrigger::Manual,
            status: TaskRunStatus::Running,
            join_count: 0,
            started_at: "2026-07-26T00:00:00Z".into(),
            finished_at: None,
            error_message: None,
        };
        let handle = Arc::new(SyncTaskHandle {
            state: Mutex::new(super::super::context::SyncTaskState {
                run,
                progress: Some(initial_sync_progress(&DataSyncScope::Usage)),
                completed: false,
                result: None,
            }),
            notify: tokio::sync::Notify::new(),
        });
        let reporter = SyncProgressReporter::new(Arc::clone(&handle));

        reporter
            .set_usage_detail(usage_progress_detail(
                AccountSyncProgressPhase::RecentWindow,
                Some(800),
                Some(1000),
                Some(AccountSyncProgressUnit::Records),
                Some("2026-07-26".into()),
                Some(1),
            ))
            .await;
        reporter
            .set_usage_detail(usage_progress_detail(
                AccountSyncProgressPhase::RecentWindow,
                Some(0),
                Some(1200),
                Some(AccountSyncProgressUnit::Records),
                Some("2026-07-26".into()),
                Some(2),
            ))
            .await;

        let state = handle.state.lock().await;
        let detail = state
            .progress
            .as_ref()
            .and_then(|progress| progress.stages.first())
            .and_then(|stage| stage.detail.as_ref())
            .expect("latest usage detail exists");
        assert_eq!(detail.processed, Some(0));
        assert_eq!(detail.total, Some(1200));
        assert_eq!(detail.attempt, Some(2));
    }

    #[tokio::test]
    async fn subscriptions_scope_fetches_only_subscription_resources_and_reuses_snapshots() {
        let subscriptions_hits = Arc::new(AtomicUsize::new(0));
        let summary_hits = Arc::new(AtomicUsize::new(0));
        let profile_hits = Arc::new(AtomicUsize::new(0));
        let quota_hits = Arc::new(AtomicUsize::new(0));
        let group_hits = Arc::new(AtomicUsize::new(0));
        let key_hits = Arc::new(AtomicUsize::new(0));
        let usage_hits = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route(
                "/api/v1/subscriptions",
                get({
                    let subscriptions_hits = Arc::clone(&subscriptions_hits);
                    move || {
                        let subscriptions_hits = Arc::clone(&subscriptions_hits);
                        async move {
                            subscriptions_hits.fetch_add(1, Ordering::SeqCst);
                            Json(json!({
                                "items": [{
                                    "id": "subscription-only-1",
                                    "group_id": 42,
                                    "group_name": "订阅同步",
                                    "name": "订阅同步",
                                    "status": "active",
                                    "platform": "openai",
                                    "daily": {
                                        "current": 98.0,
                                        "limit": 100.0,
                                        "window_start": "2026-08-05"
                                    }
                                }]
                            }))
                        }
                    }
                }),
            )
            .route(
                "/api/v1/subscriptions/summary",
                get({
                    let summary_hits = Arc::clone(&summary_hits);
                    move || {
                        let summary_hits = Arc::clone(&summary_hits);
                        async move {
                            summary_hits.fetch_add(1, Ordering::SeqCst);
                            (
                                StatusCode::INTERNAL_SERVER_ERROR,
                                Json(json!({ "message": "summary unavailable" })),
                            )
                                .into_response()
                        }
                    }
                }),
            )
            .route(
                "/api/v1/user/profile",
                get({
                    let profile_hits = Arc::clone(&profile_hits);
                    move || {
                        let profile_hits = Arc::clone(&profile_hits);
                        async move {
                            profile_hits.fetch_add(1, Ordering::SeqCst);
                            Json(json!({ "email": "demo@example.com", "balance": 1.0 }))
                        }
                    }
                }),
            )
            .route(
                "/api/v1/user/platform-quotas",
                get({
                    let quota_hits = Arc::clone(&quota_hits);
                    move || {
                        let quota_hits = Arc::clone(&quota_hits);
                        async move {
                            quota_hits.fetch_add(1, Ordering::SeqCst);
                            Json(json!({ "platform_quotas": [] }))
                        }
                    }
                }),
            )
            .route(
                "/api/v1/groups/available",
                get({
                    let group_hits = Arc::clone(&group_hits);
                    move || {
                        let group_hits = Arc::clone(&group_hits);
                        async move {
                            group_hits.fetch_add(1, Ordering::SeqCst);
                            Json(json!({ "items": [] }))
                        }
                    }
                }),
            )
            .route(
                "/api/v1/keys",
                get({
                    let key_hits = Arc::clone(&key_hits);
                    move || {
                        let key_hits = Arc::clone(&key_hits);
                        async move {
                            key_hits.fetch_add(1, Ordering::SeqCst);
                            Json(json!({ "items": [] }))
                        }
                    }
                }),
            )
            .route(
                "/api/v1/usage",
                get({
                    let usage_hits = Arc::clone(&usage_hits);
                    move |Query(query): Query<HashMap<String, String>>| {
                        let usage_hits = Arc::clone(&usage_hits);
                        async move {
                            usage_hits.fetch_add(1, Ordering::SeqCst);
                            let page = query
                                .get("page")
                                .and_then(|value| value.parse::<i64>().ok())
                                .unwrap_or(1);
                            let page_size = query
                                .get("page_size")
                                .and_then(|value| value.parse::<i64>().ok())
                                .unwrap_or(1_000);
                            Json(json!({
                                "items": [],
                                "page": page,
                                "page_size": page_size,
                                "total": 0,
                                "pages": 1
                            }))
                        }
                    }
                }),
            );
        let server = TestAxumServer::start(|_| app).await;

        let mut ctx = build_test_context();
        ctx.native_notifications_enabled = true;
        seed_account(
            &ctx,
            server.base_url(),
            "account-subscriptions-scope",
            "site-subscriptions-scope",
            "订阅范围账号",
        );

        let result = sync_account_data(
            &ctx,
            "account-subscriptions-scope",
            SyncAccountDataInput {
                scope: DataSyncScope::Subscriptions,
                trigger_source: DataSyncTrigger::Manual,
            },
        )
        .await
        .expect("subscriptions scope sync");

        assert_eq!(result.status.statuses.len(), 1);
        assert_eq!(
            result.status.statuses[0].scope,
            DataSyncScope::Subscriptions
        );
        assert_eq!(result.status.statuses[0].state, AccountSyncState::Succeeded);
        assert_eq!(
            profile_service::get_subscriptions(&ctx, "account-subscriptions-scope", false)
                .await
                .expect("reuse subscriptions snapshot")
                .len(),
            1
        );
        let summary =
            profile_service::get_subscription_summary(&ctx, "account-subscriptions-scope")
                .await
                .expect("reuse derived summary snapshot");
        assert_eq!(summary.active_count, 1);
        assert_eq!(summary.total_used_usd, 98.0);
        assert_eq!(summary.subscriptions.len(), 1);
        assert_eq!(summary.subscriptions[0].group_id, 42);
        assert_eq!(summary.subscriptions[0].daily_used_usd, 98.0);
        assert_eq!(summary.subscriptions[0].daily_limit_usd, 100.0);

        let subject = repositories::find_subscription_quota_alert_subject_by_key(
            &ctx.db,
            "account-subscriptions-scope",
            "group:42",
        )
        .expect("read quota alert subject")
        .expect("quota alert subject");
        let states =
            repositories::list_subscription_quota_alert_window_states(&ctx.db, &subject.subject_id)
                .expect("read quota alert window states");
        assert_eq!(states.len(), 1);
        assert_eq!(
            states[0].window_kind,
            crate::contracts::SubscriptionQuotaAlertWindowKind::Daily
        );
        assert_eq!(
            states[0].state,
            repositories::SubscriptionQuotaAlertWindowState::Triggered
        );
        assert_eq!(states[0].trigger_sequence, 1);
        assert_eq!(states[0].last_current, Some(98.0));
        assert_eq!(states[0].last_limit, Some(100.0));
        let event_id = states[0]
            .last_event_id
            .as_deref()
            .expect("quota alert event id");
        let event = repositories::find_subscription_quota_alert_event(&ctx.db, event_id)
            .expect("read quota alert event")
            .expect("quota alert event");
        let event_payload = serde_json::from_str::<
            crate::contracts::SubscriptionQuotaAlertEventPayload,
        >(&event.payload_json)
        .expect("parse quota alert event");
        assert_eq!(event_payload.subscription_key, "group:42");
        assert_eq!(event_payload.threshold_value, 98.0);
        assert_eq!(event_payload.triggered_windows.len(), 1);
        assert_eq!(
            event_payload.triggered_windows[0].kind,
            crate::contracts::SubscriptionQuotaAlertWindowKind::Daily
        );
        assert_eq!(subscriptions_hits.load(Ordering::SeqCst), 1);
        assert_eq!(summary_hits.load(Ordering::SeqCst), 1);
        assert_eq!(profile_hits.load(Ordering::SeqCst), 0);
        assert_eq!(quota_hits.load(Ordering::SeqCst), 0);
        assert_eq!(group_hits.load(Ordering::SeqCst), 0);
        assert_eq!(key_hits.load(Ordering::SeqCst), 0);
        assert_eq!(usage_hits.load(Ordering::SeqCst), 0);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn subscriptions_scope_surfaces_subscription_fetch_failures() {
        let subscriptions_hits = Arc::new(AtomicUsize::new(0));
        let summary_hits = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route(
                "/api/v1/subscriptions",
                get({
                    let subscriptions_hits = Arc::clone(&subscriptions_hits);
                    move || {
                        let subscriptions_hits = Arc::clone(&subscriptions_hits);
                        async move {
                            subscriptions_hits.fetch_add(1, Ordering::SeqCst);
                            (
                                StatusCode::INTERNAL_SERVER_ERROR,
                                Json(json!({ "message": "subscriptions unavailable" })),
                            )
                                .into_response()
                        }
                    }
                }),
            )
            .route(
                "/api/v1/subscriptions/summary",
                get({
                    let summary_hits = Arc::clone(&summary_hits);
                    move || {
                        let summary_hits = Arc::clone(&summary_hits);
                        async move {
                            summary_hits.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                            (
                                StatusCode::INTERNAL_SERVER_ERROR,
                                Json(json!({ "message": "summary unavailable" })),
                            )
                                .into_response()
                        }
                    }
                }),
            );
        let server = TestAxumServer::start(|_| app).await;

        let ctx = build_test_context();
        seed_account(
            &ctx,
            server.base_url(),
            "account-subscriptions-failure",
            "site-subscriptions-failure",
            "订阅失败账号",
        );

        let result = sync_account_data(
            &ctx,
            "account-subscriptions-failure",
            SyncAccountDataInput {
                scope: DataSyncScope::Subscriptions,
                trigger_source: DataSyncTrigger::Manual,
            },
        )
        .await;

        assert!(result.is_err());
        assert_eq!(subscriptions_hits.load(Ordering::SeqCst), 1);
        assert_eq!(summary_hits.load(Ordering::SeqCst), 1);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn running_subscriptions_task_is_exposed_with_subscription_progress() {
        let ctx = build_test_context();
        let run = crate::contracts::TaskRunRecord {
            id: "run-subscriptions-status".into(),
            account_id: "account-subscriptions-status".into(),
            scope: DataSyncScope::Subscriptions,
            primary_trigger_source: DataSyncTrigger::Manual,
            status: TaskRunStatus::Running,
            join_count: 0,
            started_at: "2026-08-05T00:00:00Z".into(),
            finished_at: None,
            error_message: None,
        };
        let handle = Arc::new(SyncTaskHandle {
            state: Mutex::new(super::super::context::SyncTaskState {
                run,
                progress: Some(initial_sync_progress(&DataSyncScope::Subscriptions)),
                completed: false,
                result: None,
            }),
            notify: tokio::sync::Notify::new(),
        });
        ctx.sync_tasks
            .lock()
            .await
            .insert("account-subscriptions-status:subscriptions".into(), handle);

        let status = get_account_sync_status(&ctx, "account-subscriptions-status")
            .await
            .expect("running subscriptions status");

        assert_eq!(status.statuses.len(), 1);
        let record = &status.statuses[0];
        assert_eq!(record.scope, DataSyncScope::Subscriptions);
        assert_eq!(record.state, AccountSyncState::Running);
        assert_eq!(record.item_count, 0);
        assert!(record.last_success_at.is_none());
        assert!(record.last_error.is_none());
        let progress = record.progress.as_ref().expect("subscriptions progress");
        assert_eq!(progress.stages.len(), 1);
        assert_eq!(
            progress.stages[0].id,
            AccountSyncProgressStageId::Subscriptions
        );
        assert_eq!(
            progress.stages[0].state,
            AccountSyncProgressStageState::Running
        );
    }

    #[tokio::test]
    async fn full_sync_marks_core_keys_and_usage_statuses() {
        let profile_hits = Arc::new(AtomicUsize::new(0));
        let quota_hits = Arc::new(AtomicUsize::new(0));
        let subscription_hits = Arc::new(AtomicUsize::new(0));
        let summary_hits = Arc::new(AtomicUsize::new(0));
        let group_hits = Arc::new(AtomicUsize::new(0));
        let key_hits = Arc::new(AtomicUsize::new(0));
        let dashboard_hits = Arc::new(AtomicUsize::new(0));
        let usage_day = super::shanghai_today().to_string();
        let history_day = super::shanghai_today()
            .checked_sub_days(Days::new(2))
            .expect("closed history day")
            .to_string();
        let app = Router::new()
            .route(
                "/api/v1/user/profile",
                get({
                    let profile_hits = Arc::clone(&profile_hits);
                    move || {
                        let profile_hits = Arc::clone(&profile_hits);
                        async move {
                            profile_hits.fetch_add(1, Ordering::SeqCst);
                            Json(json!({
                                "email": "demo@example.com",
                                "balance": 12.5
                            }))
                        }
                    }
                }),
            )
            .route(
                "/api/v1/user/platform-quotas",
                get({
                    let quota_hits = Arc::clone(&quota_hits);
                    move || {
                        let quota_hits = Arc::clone(&quota_hits);
                        async move {
                            quota_hits.fetch_add(1, Ordering::SeqCst);
                            Json(json!({ "platform_quotas": [] }))
                        }
                    }
                }),
            )
            .route(
                "/api/v1/subscriptions",
                get({
                    let subscription_hits = Arc::clone(&subscription_hits);
                    move || {
                        let subscription_hits = Arc::clone(&subscription_hits);
                        async move {
                            subscription_hits.fetch_add(1, Ordering::SeqCst);
                            Json(json!({
                                "items": [
                                    {
                                        "id": "sub-1",
                                        "name": "月度订阅",
                                        "status": "active",
                                        "platform": "openai"
                                    }
                                ]
                            }))
                        }
                    }
                }),
            )
            .route(
                "/api/v1/subscriptions/summary",
                get({
                    let summary_hits = Arc::clone(&summary_hits);
                    move || {
                        let summary_hits = Arc::clone(&summary_hits);
                        async move {
                            summary_hits.fetch_add(1, Ordering::SeqCst);
                            Json(json!({
                                "active_count": 1,
                                "total_used_usd": 3.2,
                                "subscriptions": []
                            }))
                        }
                    }
                }),
            )
            .route(
                "/api/v1/groups/available",
                get({
                    let group_hits = Arc::clone(&group_hits);
                    move || {
                        let group_hits = Arc::clone(&group_hits);
                        async move {
                            group_hits.fetch_add(1, Ordering::SeqCst);
                            Json(json!({
                                "items": [
                                    {
                                        "id": 1,
                                        "name": "默认分组",
                                        "platform": "openai",
                                        "rate_multiplier": 1.0
                                    }
                                ]
                            }))
                        }
                    }
                }),
            )
            .route(
                "/api/v1/keys",
                get({
                    let key_hits = Arc::clone(&key_hits);
                    move || {
                        let key_hits = Arc::clone(&key_hits);
                        async move {
                            key_hits.fetch_add(1, Ordering::SeqCst);
                            Json(json!({
                                "items": [
                                    {
                                        "id": "key-1",
                                        "group_id": 1,
                                        "name": "主 Key",
                                        "status": "active",
                                        "platform": "openai"
                                    }
                                ]
                            }))
                        }
                    }
                }),
            )
            .route(
                "/api/v1/usage",
                get({
                    let usage_day = usage_day.clone();
                    let history_day = history_day.clone();
                    move |Query(query): Query<HashMap<String, String>>| {
                        let usage_day = usage_day.clone();
                        let history_day = history_day.clone();
                        async move {
                            let page = query
                                .get("page")
                                .and_then(|value| value.parse::<i64>().ok())
                                .unwrap_or(1);
                            let page_size = query
                                .get("page_size")
                                .and_then(|value| value.parse::<i64>().ok())
                                .unwrap_or(1_000);
                            let history_day_requested = query
                                .get("start_date")
                                .map(|date| date == &history_day)
                                .unwrap_or(true);
                            let current_day_requested = query
                                .get("start_date")
                                .is_some_and(|date| date == &usage_day);
                            Json(json!({
                                "items": if history_day_requested { json!([{
                                    "id": "usage-full-history",
                                    "created_at": format!("{history_day}T08:00:00+08:00"),
                                    "model": "gpt-5.4",
                                    "actual_cost": 0.4,
                                    "total_cost": 0.4,
                                    "input_tokens": 8,
                                    "output_tokens": 4,
                                    "total_tokens": 12
                                }]) } else if current_day_requested { json!([{
                                    "id": "usage-full-dashboard-stats",
                                    "created_at": format!("{usage_day}T08:00:00+08:00"),
                                    "model": "gpt-5.4",
                                    "actual_cost": 0.5,
                                    "total_cost": 0.5,
                                    "input_tokens": 10,
                                    "output_tokens": 5,
                                    "total_tokens": 15
                                }]) } else { json!([]) },
                                "page": page,
                                "page_size": page_size,
                                "total": if history_day_requested || current_day_requested { 1 } else { 0 },
                                "pages": 1
                            }))
                        }
                    }
                }),
            )
            .route(
                "/api/v1/usage/dashboard/stats",
                get({
                    let dashboard_hits = Arc::clone(&dashboard_hits);
                    move || {
                        let dashboard_hits = Arc::clone(&dashboard_hits);
                        async move {
                            dashboard_hits.fetch_add(1, Ordering::SeqCst);
                            Json(json!({ "today_requests": 1, "total_requests": 1 }))
                        }
                    }
                }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-2",
            "site-2",
            "副账号",
        );
        usage_service::get_overview_dashboard_stats(&ctx, "account-2", false)
            .await
            .expect("warm dashboard stats cache");
        assert_eq!(dashboard_hits.load(Ordering::SeqCst), 1);

        let result = sync_account_data(
            &ctx,
            "account-2",
            SyncAccountDataInput {
                scope: DataSyncScope::Full,
                trigger_source: DataSyncTrigger::Manual,
            },
        )
        .await
        .expect("full sync");

        assert_eq!(result.status.statuses.len(), 3);
        for scope in [
            DataSyncScope::Core,
            DataSyncScope::Keys,
            DataSyncScope::Usage,
        ] {
            let record = result
                .status
                .statuses
                .iter()
                .find(|item| item.scope == scope)
                .expect("transient scope status exists");
            assert_eq!(record.state, AccountSyncState::Succeeded);
            assert!(record.last_success_at.is_some());
        }
        let usage_rows = repositories::list_usage_row_cache(&ctx.db, "account-2", None, None, None)
            .expect("load full usage cache");
        assert_eq!(usage_rows.len(), 2);
        assert!(usage_rows
            .iter()
            .any(|record| record.row.id == "usage-full-history"));
        assert!(usage_rows
            .iter()
            .any(|record| record.row.id == "usage-full-dashboard-stats"));
        usage_service::get_overview_dashboard_stats(&ctx, "account-2", false)
            .await
            .expect("dashboard stats invalidated after full usage write");
        assert_eq!(dashboard_hits.load(Ordering::SeqCst), 2);

        let status = get_account_sync_status(&ctx, "account-2")
            .await
            .expect("sync status");
        assert_eq!(status.statuses.len(), 1);
        assert_eq!(status.statuses[0].scope, DataSyncScope::Full);
        assert_eq!(status.statuses[0].state, AccountSyncState::Succeeded);
        assert_eq!(status.statuses[0].item_count, 2);
        assert!(status.statuses[0].last_success_at.is_some());
        let progress = status.statuses[0]
            .progress
            .as_ref()
            .expect("terminal full progress remains observable");
        assert_eq!(progress.stages.len(), 4);
        assert!(progress
            .stages
            .iter()
            .all(|stage| stage.state == AccountSyncProgressStageState::Succeeded));

        let account = repositories::find_account(&ctx.db, "account-2")
            .expect("load account")
            .expect("account exists");
        let runtime = account_service::load_live_runtime(&ctx, account)
            .await
            .expect("load coordinated runtime");
        assert_eq!(
            runtime.cache_view.expect("runtime cache view").keys.len(),
            1
        );
        assert_eq!(
            keys_service::get_available_groups(&ctx, "account-2")
                .await
                .expect("load coordinated groups")
                .len(),
            1
        );
        assert!(profile_service::get_platform_quotas(&ctx, "account-2")
            .await
            .expect("load coordinated quotas")
            .platform_quotas
            .is_empty());
        assert_eq!(
            profile_service::get_subscription_summary(&ctx, "account-2")
                .await
                .expect("load coordinated subscription summary")
                .active_count,
            1
        );
        for hits in [
            &profile_hits,
            &quota_hits,
            &subscription_hits,
            &summary_hits,
            &group_hits,
            &key_hits,
        ] {
            assert_eq!(hits.load(Ordering::SeqCst), 1);
        }

        let second = sync_account_data(
            &ctx,
            "account-2",
            SyncAccountDataInput {
                scope: DataSyncScope::Full,
                trigger_source: DataSyncTrigger::Manual,
            },
        )
        .await
        .expect("second full sync");
        assert_ne!(second.run.id, result.run.id);
        for hits in [
            &profile_hits,
            &quota_hits,
            &subscription_hits,
            &summary_hits,
            &group_hits,
            &key_hits,
        ] {
            assert_eq!(hits.load(Ordering::SeqCst), 2);
        }
        usage_service::get_overview_dashboard_stats(&ctx, "account-2", false)
            .await
            .expect("unchanged full usage keeps dashboard stats cache");
        assert_eq!(dashboard_hits.load(Ordering::SeqCst), 2);
        let terminal = {
            let tasks = ctx.sync_tasks.lock().await;
            tasks
                .get("account-2:full")
                .cloned()
                .expect("latest full task remains observable")
        };
        let terminal_state = terminal.state.lock().await;
        assert!(terminal_state.completed);
        assert_eq!(terminal_state.run.id, second.run.id);
    }

    #[tokio::test]
    async fn full_sync_failure_is_retained_and_reported_as_failed() {
        let ctx = build_test_context();

        let error = sync_account_data(
            &ctx,
            "missing-account",
            SyncAccountDataInput {
                scope: DataSyncScope::Full,
                trigger_source: DataSyncTrigger::Manual,
            },
        )
        .await
        .expect_err("missing account full sync must fail");
        assert_eq!(error.to_string(), "账号数据同步失败，请稍后重试。");
        let failure = sync_failure_response_from_error(&error);
        assert_eq!(failure.failure.category, SyncFailureCategory::Internal);
        assert!(!failure.failure.retry_exhausted);

        let status = get_account_sync_status(&ctx, "missing-account")
            .await
            .expect("failed terminal status");
        assert_eq!(status.statuses.len(), 1);
        assert_eq!(status.statuses[0].scope, DataSyncScope::Full);
        assert_eq!(status.statuses[0].state, AccountSyncState::Failed);
        assert!(status.statuses[0].last_success_at.is_none());
        assert!(status.statuses[0].last_error.is_some());
        let progress = status.statuses[0]
            .progress
            .as_ref()
            .expect("failed progress remains observable");
        let stage_state = |id| {
            progress
                .stages
                .iter()
                .find(|stage| stage.id == id)
                .map(|stage| stage.state)
                .expect("stage exists")
        };
        assert_eq!(
            stage_state(AccountSyncProgressStageId::Core),
            AccountSyncProgressStageState::Failed
        );
        assert_eq!(
            stage_state(AccountSyncProgressStageId::Keys),
            AccountSyncProgressStageState::Cancelled
        );
        assert_eq!(
            stage_state(AccountSyncProgressStageId::Usage),
            AccountSyncProgressStageState::Cancelled
        );
        assert_eq!(
            stage_state(AccountSyncProgressStageId::SubscriptionRules),
            AccountSyncProgressStageState::Cancelled
        );

        let terminal = {
            let tasks = ctx.sync_tasks.lock().await;
            tasks
                .get("missing-account:full")
                .cloned()
                .expect("failed full task remains observable")
        };
        let terminal_state = terminal.state.lock().await;
        assert!(terminal_state.completed);
        assert_eq!(terminal_state.run.status, TaskRunStatus::Failed);
        assert!(terminal_state.run.finished_at.is_some());
    }

    #[tokio::test]
    async fn usage_sync_failure_is_retained_and_reported_as_failed() {
        let ctx = build_test_context();

        let error = sync_account_data(
            &ctx,
            "missing-usage-account",
            SyncAccountDataInput {
                scope: DataSyncScope::Usage,
                trigger_source: DataSyncTrigger::Manual,
            },
        )
        .await
        .expect_err("missing account usage sync must fail");
        assert_eq!(error.to_string(), "账号数据同步失败，请稍后重试。");

        let status = get_account_sync_status(&ctx, "missing-usage-account")
            .await
            .expect("failed usage terminal status");
        assert_eq!(status.statuses.len(), 1);
        assert_eq!(status.statuses[0].scope, DataSyncScope::Usage);
        assert_eq!(status.statuses[0].state, AccountSyncState::Failed);
        assert_eq!(status.statuses[0].item_count, 0);
        assert!(status.statuses[0].run_id.is_some());
        assert!(status.statuses[0].finished_at.is_some());
        assert!(status.statuses[0].last_error.is_some());

        let terminal = {
            let tasks = ctx.sync_tasks.lock().await;
            tasks
                .get("missing-usage-account:usage")
                .cloned()
                .expect("failed usage task remains observable")
        };
        let terminal_state = terminal.state.lock().await;
        assert!(terminal_state.completed);
        assert_eq!(terminal_state.run.status, TaskRunStatus::Failed);
    }

    #[tokio::test]
    async fn usage_sync_failure_is_retained_and_reported_as_failed() {
        let ctx = build_test_context();

        let error = sync_account_data(
            &ctx,
            "missing-usage-account",
            SyncAccountDataInput {
                scope: DataSyncScope::Usage,
                trigger_source: DataSyncTrigger::Manual,
            },
        )
        .await
        .expect_err("missing account usage sync must fail");
        assert_eq!(error.to_string(), "账号数据同步失败，请稍后重试。");

        let status = get_account_sync_status(&ctx, "missing-usage-account")
            .await
            .expect("failed usage terminal status");
        assert_eq!(status.statuses.len(), 1);
        assert_eq!(status.statuses[0].scope, DataSyncScope::Usage);
        assert_eq!(status.statuses[0].state, AccountSyncState::Failed);
        assert_eq!(status.statuses[0].item_count, 0);
        assert!(status.statuses[0].run_id.is_some());
        assert!(status.statuses[0].finished_at.is_some());
        assert!(status.statuses[0].last_error.is_some());

        let terminal = {
            let tasks = ctx.sync_tasks.lock().await;
            tasks
                .get("missing-usage-account:usage")
                .cloned()
                .expect("failed usage task remains observable")
        };
        let terminal_state = terminal.state.lock().await;
        assert!(terminal_state.completed);
        assert_eq!(terminal_state.run.status, TaskRunStatus::Failed);
    }

    #[tokio::test]
    async fn earliest_usage_probe_uses_desc_tail_when_upstream_ignores_asc() {
        let requests = Arc::new(Mutex::new(Vec::<(String, i64)>::new()));
        let earliest_date = super::shanghai_today()
            .checked_sub_days(Days::new(7))
            .expect("earliest date");
        let latest_date = super::shanghai_today();
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let requests = Arc::clone(&requests);
                move |Query(query): Query<HashMap<String, String>>| {
                    let requests = Arc::clone(&requests);
                    let earliest_date = earliest_date;
                    let latest_date = latest_date;
                    async move {
                        let sort_order = query.get("sort_order").cloned().unwrap_or_default();
                        let page = query
                            .get("page")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1);
                        requests.lock().await.push((sort_order, page));
                        let created_at = if page == 1 {
                            latest_date
                        } else {
                            earliest_date
                        };
                        Json(json!({
                            "items": [{
                                "id": format!("probe-{page}"),
                                "created_at": format!("{created_at}T08:00:00+08:00"),
                                "model": "gpt-5.4",
                                "actual_cost": 0.5,
                                "total_cost": 0.5,
                                "input_tokens": 10,
                                "output_tokens": 5,
                                "total_tokens": 15
                            }],
                            "page": page,
                            "page_size": 1,
                            "total": 2,
                            "pages": 2
                        }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-ignored-asc",
            "site-ignored-asc",
            "排序兼容账号",
        );
        let reader = upstream_service::prepare_usage_read_client(&ctx, "account-ignored-asc")
            .await
            .expect("prepare usage reader");

        let detected = fetch_earliest_usage_date(&ctx, &reader, None)
            .await
            .expect("read earliest usage date");
        assert_eq!(detected, Some(earliest_date));
        assert_eq!(
            *requests.lock().await,
            vec![("asc".to_string(), 1), ("desc".to_string(), 2)]
        );
    }

    #[tokio::test]
    async fn earliest_usage_probe_retries_a_monotonic_snapshot_growth() {
        let requests = Arc::new(Mutex::new(Vec::<(String, i64)>::new()));
        let earliest_date = super::shanghai_today()
            .checked_sub_days(Days::new(9))
            .expect("earliest date");
        let latest_date = super::shanghai_today();
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let requests = Arc::clone(&requests);
                move |Query(query): Query<HashMap<String, String>>| {
                    let requests = Arc::clone(&requests);
                    let earliest_date = earliest_date;
                    let latest_date = latest_date;
                    async move {
                        let sort_order = query.get("sort_order").cloned().unwrap_or_default();
                        let page = query
                            .get("page")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1);
                        let request_index = {
                            let mut requests = requests.lock().await;
                            requests.push((sort_order, page));
                            requests.len()
                        };
                        let (total, pages) = if request_index == 2 { (3, 3) } else { (2, 2) };
                        let created_at = if page == 1 {
                            latest_date
                        } else {
                            earliest_date
                        };
                        Json(json!({
                            "items": [{
                                "id": format!("probe-growth-{request_index}"),
                                "created_at": format!("{created_at}T08:00:00+08:00"),
                                "model": "gpt-5.4",
                                "actual_cost": 0.5,
                                "total_cost": 0.5,
                                "input_tokens": 10,
                                "output_tokens": 5,
                                "total_tokens": 15
                            }],
                            "page": page,
                            "page_size": 1,
                            "total": total,
                            "pages": pages
                        }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-probe-growth",
            "site-probe-growth",
            "探针增长账号",
        );
        let reader = upstream_service::prepare_usage_read_client(&ctx, "account-probe-growth")
            .await
            .expect("prepare usage reader");

        let detected = fetch_earliest_usage_date(&ctx, &reader, None)
            .await
            .expect("stable retry detects earliest date");
        assert_eq!(detected, Some(earliest_date));
        assert_eq!(
            *requests.lock().await,
            vec![
                ("asc".to_string(), 1),
                ("desc".to_string(), 2),
                ("asc".to_string(), 1),
                ("desc".to_string(), 2)
            ]
        );
        server.abort();
    }

    #[tokio::test]
    async fn earliest_usage_probe_exhaustion_keeps_new_account_in_needs_audit() {
        let request_count = Arc::new(AtomicUsize::new(0));
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let request_count = Arc::clone(&request_count);
                move |Query(query): Query<HashMap<String, String>>| {
                    let request_count = Arc::clone(&request_count);
                    async move {
                        let page = query
                            .get("page")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1);
                        let request_index = request_count.fetch_add(1, Ordering::SeqCst) + 1;
                        let total =
                            i64::try_from(request_index + 1).expect("request count fits i64");
                        Json(json!({
                            "items": [{
                                "id": format!("probe-exhaustion-{request_index}"),
                                "created_at": "2026-01-01T08:00:00+08:00",
                                "model": "gpt-5.4",
                                "actual_cost": 0.5,
                                "total_cost": 0.5,
                                "input_tokens": 10,
                                "output_tokens": 5,
                                "total_tokens": 15
                            }],
                            "page": page,
                            "page_size": 1,
                            "total": total,
                            "pages": total
                        }))
                    }
                }
            }),
        );
        let server = TestAxumServer::start(|_| app).await;
        let ctx = build_test_context();
        seed_account(
            &ctx,
            server.base_url(),
            "account-probe-exhaustion",
            "site-probe-exhaustion",
            "探针耗尽账号",
        );

        let error = sync_initial_usage_history_if_needed(&ctx, "account-probe-exhaustion")
            .await
            .expect_err("unstable new account probe must require audit");
        assert_eq!(
            error.to_string(),
            super::EARLIEST_USAGE_PROBE_METADATA_CHANGED_ERROR
        );
        assert!(super::is_earliest_usage_probe_growth_exhausted(&error));
        assert!(super::is_earliest_usage_probe_growth_exhausted(&error));
        let history = repositories::load_usage_history_state(&ctx.db, "account-probe-exhaustion")
            .expect("load history state")
            .expect("history state exists");
        assert_eq!(history.state, repositories::UsageHistoryState::NeedsAudit);
        assert!(history.earliest_date.is_none());
        assert!(history.completed_through_date.is_none());
        assert_eq!(request_count.load(Ordering::SeqCst), 6);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn earliest_usage_probe_exhaustion_reuses_verified_earliest_checkpoint() {
        let request_count = Arc::new(AtomicUsize::new(0));
        let closed_history_end = super::shanghai_today()
            .checked_sub_days(Days::new(2))
            .expect("closed history end");
        let earliest_date = closed_history_end
            .pred_opt()
            .expect("history end has a preceding date");
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let request_count = Arc::clone(&request_count);
                move |Query(query): Query<HashMap<String, String>>| {
                    let request_count = Arc::clone(&request_count);
                    async move {
                        let page = query
                            .get("page")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1);
                        let page_size = query
                            .get("page_size")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1_000);
                        if query.get("start_date").is_none() && page_size == 1 {
                            let request_index = request_count.fetch_add(1, Ordering::SeqCst) + 1;
                            let total =
                                i64::try_from(request_index + 1).expect("request count fits i64");
                            return Json(json!({
                                "items": [{
                                    "id": format!("probe-fallback-{request_index}"),
                                    "created_at": format!("{earliest_date}T08:00:00+08:00"),
                                    "model": "gpt-5.4",
                                    "actual_cost": 0.5,
                                    "total_cost": 0.5,
                                    "input_tokens": 10,
                                    "output_tokens": 5,
                                    "total_tokens": 15
                                }],
                                "page": page,
                                "page_size": 1,
                                "total": total,
                                "pages": total
                            }));
                        }
                        Json(json!({
                            "items": [],
                            "page": page,
                            "page_size": page_size,
                            "total": 0,
                            "pages": 0
                        }))
                    }
                }
            }),
        );
        let server = TestAxumServer::start(|_| app).await;
        let ctx = build_test_context();
        seed_account(
            &ctx,
            server.base_url(),
            "account-probe-checkpoint",
            "site-probe-checkpoint",
            "探针检查点账号",
        );
        repositories::advance_usage_history_completed_through_date(
            &ctx.db,
            "account-probe-checkpoint",
            Some(&earliest_date.to_string()),
            &earliest_date.to_string(),
            Some(&earliest_date.to_string()),
            "2026-08-14T00:00:00+08:00",
        )
        .expect("seed verified earliest checkpoint");

        let merged = sync_initial_usage_history_if_needed(&ctx, "account-probe-checkpoint")
            .await
            .expect("verified earliest checkpoint can recover after probe exhaustion");
        assert_eq!(merged, 0);
        let history = repositories::load_usage_history_state(&ctx.db, "account-probe-checkpoint")
            .expect("load history state")
            .expect("history state exists");
        assert_eq!(
            history.earliest_date.as_deref(),
            Some(earliest_date.to_string().as_str())
        );
        assert_eq!(
            history.completed_through_date.as_deref(),
            Some(closed_history_end.to_string().as_str())
        );
        assert_eq!(request_count.load(Ordering::SeqCst), 6);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn earliest_usage_probe_metadata_regression_keeps_verified_checkpoint_in_needs_audit() {
        let request_count = Arc::new(AtomicUsize::new(0));
        let closed_history_end = super::shanghai_today()
            .checked_sub_days(Days::new(2))
            .expect("closed history end");
        let earliest_date = closed_history_end
            .pred_opt()
            .expect("history end has a preceding date");
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let request_count = Arc::clone(&request_count);
                move |Query(query): Query<HashMap<String, String>>| {
                    let request_count = Arc::clone(&request_count);
                    async move {
                        let page = query
                            .get("page")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1);
                        let request_index = request_count.fetch_add(1, Ordering::SeqCst) + 1;
                        let (total, pages, include_item) = if request_index == 1 {
                            (1, 1, true)
                        } else {
                            (0, 1, false)
                        };
                        let items = include_item.then(|| {
                            json!({
                                "id": format!("probe-regression-{request_index}"),
                                "created_at": format!("{earliest_date}T08:00:00+08:00"),
                                "model": "gpt-5.4",
                                "actual_cost": 0.5,
                                "total_cost": 0.5,
                                "input_tokens": 10,
                                "output_tokens": 5,
                                "total_tokens": 15
                            })
                        });
                        Json(json!({
                            "items": items.into_iter().collect::<Vec<_>>(),
                            "page": page,
                            "page_size": 1,
                            "total": total,
                            "pages": pages
                        }))
                    }
                }
            }),
        );
        let server = TestAxumServer::start(|_| app).await;
        let ctx = build_test_context();
        seed_account(
            &ctx,
            server.base_url(),
            "account-probe-regression",
            "site-probe-regression",
            "探针元数据倒退账号",
        );
        repositories::advance_usage_history_completed_through_date(
            &ctx.db,
            "account-probe-regression",
            Some(&earliest_date.to_string()),
            &earliest_date.to_string(),
            Some(&earliest_date.to_string()),
            "2026-08-14T00:00:00+08:00",
        )
        .expect("seed verified earliest checkpoint");

        let error = sync_initial_usage_history_if_needed(&ctx, "account-probe-regression")
            .await
            .expect_err("metadata regression must not use the verified checkpoint fallback");
        assert_eq!(
            error.to_string(),
            super::EARLIEST_USAGE_PROBE_METADATA_CHANGED_ERROR
        );
        assert!(!super::is_earliest_usage_probe_growth_exhausted(&error));
        assert!(!super::is_earliest_usage_probe_growth_exhausted(&error));
        let history = repositories::load_usage_history_state(&ctx.db, "account-probe-regression")
            .expect("load history state")
            .expect("history state exists");
        assert_eq!(history.state, repositories::UsageHistoryState::NeedsAudit);
        assert_eq!(
            history.earliest_date.as_deref(),
            Some(earliest_date.to_string().as_str())
        );
        assert_eq!(
            history.completed_through_date.as_deref(),
            Some(earliest_date.to_string().as_str())
        );
        assert_eq!(request_count.load(Ordering::SeqCst), 2);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn earliest_usage_probe_exhaustion_reuses_verified_earliest_checkpoint() {
        let request_count = Arc::new(AtomicUsize::new(0));
        let closed_history_end = super::shanghai_today()
            .checked_sub_days(Days::new(2))
            .expect("closed history end");
        let earliest_date = closed_history_end
            .pred_opt()
            .expect("history end has a preceding date");
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let request_count = Arc::clone(&request_count);
                move |Query(query): Query<HashMap<String, String>>| {
                    let request_count = Arc::clone(&request_count);
                    async move {
                        let page = query
                            .get("page")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1);
                        let page_size = query
                            .get("page_size")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1_000);
                        if query.get("start_date").is_none() && page_size == 1 {
                            let request_index = request_count.fetch_add(1, Ordering::SeqCst) + 1;
                            let total = i64::try_from(request_index + 1)
                                .expect("request count fits i64");
                            return Json(json!({
                                "items": [{
                                    "id": format!("probe-fallback-{request_index}"),
                                    "created_at": format!("{earliest_date}T08:00:00+08:00"),
                                    "model": "gpt-5.4",
                                    "actual_cost": 0.5,
                                    "total_cost": 0.5,
                                    "input_tokens": 10,
                                    "output_tokens": 5,
                                    "total_tokens": 15
                                }],
                                "page": page,
                                "page_size": 1,
                                "total": total,
                                "pages": total
                            }));
                        }
                        Json(json!({
                            "items": [],
                            "page": page,
                            "page_size": page_size,
                            "total": 0,
                            "pages": 0
                        }))
                    }
                }
            }),
        );
        let server = TestAxumServer::start(|_| app).await;
        let ctx = build_test_context();
        seed_account(
            &ctx,
            server.base_url(),
            "account-probe-checkpoint",
            "site-probe-checkpoint",
            "探针检查点账号",
        );
        repositories::advance_usage_history_completed_through_date(
            &ctx.db,
            "account-probe-checkpoint",
            Some(&earliest_date.to_string()),
            &earliest_date.to_string(),
            Some(&earliest_date.to_string()),
            "2026-08-14T00:00:00+08:00",
        )
        .expect("seed verified earliest checkpoint");

        let merged = sync_initial_usage_history_if_needed(&ctx, "account-probe-checkpoint")
            .await
            .expect("verified earliest checkpoint can recover after probe exhaustion");
        assert_eq!(merged, 0);
        let history = repositories::load_usage_history_state(&ctx.db, "account-probe-checkpoint")
            .expect("load history state")
            .expect("history state exists");
        assert_eq!(
            history.earliest_date.as_deref(),
            Some(earliest_date.to_string().as_str())
        );
        assert_eq!(
            history.completed_through_date.as_deref(),
            Some(closed_history_end.to_string().as_str())
        );
        assert_eq!(request_count.load(Ordering::SeqCst), 6);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn earliest_usage_probe_metadata_regression_keeps_verified_checkpoint_in_needs_audit() {
        let request_count = Arc::new(AtomicUsize::new(0));
        let closed_history_end = super::shanghai_today()
            .checked_sub_days(Days::new(2))
            .expect("closed history end");
        let earliest_date = closed_history_end
            .pred_opt()
            .expect("history end has a preceding date");
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let request_count = Arc::clone(&request_count);
                move |Query(query): Query<HashMap<String, String>>| {
                    let request_count = Arc::clone(&request_count);
                    async move {
                        let page = query
                            .get("page")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1);
                        let request_index = request_count.fetch_add(1, Ordering::SeqCst) + 1;
                        let (total, pages, include_item) = if request_index == 1 {
                            (1, 1, true)
                        } else {
                            (0, 1, false)
                        };
                        let items = include_item.then(|| {
                            json!({
                                "id": format!("probe-regression-{request_index}"),
                                "created_at": format!("{earliest_date}T08:00:00+08:00"),
                                "model": "gpt-5.4",
                                "actual_cost": 0.5,
                                "total_cost": 0.5,
                                "input_tokens": 10,
                                "output_tokens": 5,
                                "total_tokens": 15
                            })
                        });
                        Json(json!({
                            "items": items.into_iter().collect::<Vec<_>>(),
                            "page": page,
                            "page_size": 1,
                            "total": total,
                            "pages": pages
                        }))
                    }
                }
            }),
        );
        let server = TestAxumServer::start(|_| app).await;
        let ctx = build_test_context();
        seed_account(
            &ctx,
            server.base_url(),
            "account-probe-regression",
            "site-probe-regression",
            "探针元数据倒退账号",
        );
        repositories::advance_usage_history_completed_through_date(
            &ctx.db,
            "account-probe-regression",
            Some(&earliest_date.to_string()),
            &earliest_date.to_string(),
            Some(&earliest_date.to_string()),
            "2026-08-14T00:00:00+08:00",
        )
        .expect("seed verified earliest checkpoint");

        let error = sync_initial_usage_history_if_needed(&ctx, "account-probe-regression")
            .await
            .expect_err("metadata regression must not use the verified checkpoint fallback");
        assert_eq!(
            error.to_string(),
            super::EARLIEST_USAGE_PROBE_METADATA_CHANGED_ERROR
        );
        let history = repositories::load_usage_history_state(&ctx.db, "account-probe-regression")
            .expect("load history state")
            .expect("history state exists");
        assert_eq!(history.state, repositories::UsageHistoryState::NeedsAudit);
        assert_eq!(
            history.earliest_date.as_deref(),
            Some(earliest_date.to_string().as_str())
        );
        assert_eq!(
            history.completed_through_date.as_deref(),
            Some(earliest_date.to_string().as_str())
        );
        assert_eq!(request_count.load(Ordering::SeqCst), 2);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn initial_usage_probe_recovers_401_without_marking_history_needs_audit() {
        let usage_hits = Arc::new(AtomicUsize::new(0));
        let profile_hits = Arc::new(AtomicUsize::new(0));
        let refresh_hits = Arc::new(AtomicUsize::new(0));
        let usage_date = super::shanghai_today().to_string();
        let app = Router::new()
            .route(
                "/api/v1/usage",
                get({
                    let usage_hits = Arc::clone(&usage_hits);
                    let usage_date = usage_date.clone();
                    move |headers: HeaderMap| {
                        let usage_hits = Arc::clone(&usage_hits);
                        let usage_date = usage_date.clone();
                        async move {
                            usage_hits.fetch_add(1, Ordering::SeqCst);
                            if headers
                                .get(AUTHORIZATION)
                                .and_then(|value| value.to_str().ok())
                                != Some("Bearer access-new")
                            {
                                return (
                                    StatusCode::UNAUTHORIZED,
                                    Json(json!({ "message": "unauthorized" })),
                                )
                                    .into_response();
                            }
                            (
                                StatusCode::OK,
                                Json(json!({
                                    "items": [{
                                        "id": "usage-after-refresh",
                                        "created_at": format!("{usage_date}T08:00:00+08:00"),
                                        "model": "gpt-5.4",
                                        "actual_cost": 0.5,
                                        "total_cost": 0.5,
                                        "input_tokens": 10,
                                        "output_tokens": 5,
                                        "total_tokens": 15
                                    }],
                                    "page": 1,
                                    "page_size": 1,
                                    "total": 1,
                                    "pages": 1
                                })),
                            )
                                .into_response()
                        }
                    }
                }),
            )
            .route(
                "/api/v1/user/profile",
                get({
                    let profile_hits = Arc::clone(&profile_hits);
                    move |headers: HeaderMap| {
                        let profile_hits = Arc::clone(&profile_hits);
                        async move {
                            profile_hits.fetch_add(1, Ordering::SeqCst);
                            if headers
                                .get(AUTHORIZATION)
                                .and_then(|value| value.to_str().ok())
                                == Some("Bearer access-new")
                            {
                                return (
                                    StatusCode::OK,
                                    Json(json!({ "email": "demo@example.com", "balance": 8.0 })),
                                )
                                    .into_response();
                            }
                            (
                                StatusCode::UNAUTHORIZED,
                                Json(json!({ "message": "unauthorized" })),
                            )
                                .into_response()
                        }
                    }
                }),
            )
            .route(
                "/api/v1/auth/refresh",
                post({
                    let refresh_hits = Arc::clone(&refresh_hits);
                    move || {
                        let refresh_hits = Arc::clone(&refresh_hits);
                        async move {
                            refresh_hits.fetch_add(1, Ordering::SeqCst);
                            Json(json!({
                                "code": 0,
                                "data": {
                                    "access_token": "access-new",
                                    "refresh_token": "refresh-new"
                                }
                            }))
                        }
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-probe-401",
            "site-probe-401",
            "探针认证恢复账号",
        );
        repositories::save_session(
            &ctx.db,
            "account-probe-401",
            &StoredSession {
                saved_at: "2026-07-29T00:00:00Z".into(),
                access_token: Some("access-old".into()),
                refresh_token: Some("refresh-old".into()),
                token_type: Some("bearer".into()),
                cookie_jar_json: None,
            },
        )
        .expect("save expired session");

        let merged = sync_initial_usage_history_if_needed(&ctx, "account-probe-401")
            .await
            .expect("401 probe must recover");
        assert_eq!(merged, 0);

        let history = repositories::load_usage_history_state(&ctx.db, "account-probe-401")
            .expect("load history state")
            .expect("history state exists");
        assert_ne!(history.state, repositories::UsageHistoryState::NeedsAudit);
        assert!(history.last_error.is_none());

        let session = repositories::load_session(&ctx.db, "account-probe-401")
            .expect("load recovered session")
            .expect("recovered session exists");
        assert_eq!(session.access_token.as_deref(), Some("access-new"));
        assert_eq!(session.refresh_token.as_deref(), Some("refresh-new"));
        assert_eq!(usage_hits.load(Ordering::SeqCst), 3);
        assert_eq!(profile_hits.load(Ordering::SeqCst), 2);
        assert_eq!(refresh_hits.load(Ordering::SeqCst), 1);
        server.abort();
    }

    #[tokio::test]
    async fn initial_usage_probe_failure_marks_history_needs_audit_and_sync_failed() {
        let app = Router::new().route("/api/v1/usage", get(|| async { StatusCode::BAD_REQUEST }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-probe-failure",
            "site-probe-failure",
            "探针失败账号",
        );

        sync_initial_usage_history_if_needed(&ctx, "account-probe-failure")
            .await
            .expect_err("failed earliest probe must fail history sync");

        let history = repositories::load_usage_history_state(&ctx.db, "account-probe-failure")
            .expect("load history state")
            .expect("history state exists");
        assert_eq!(history.state, repositories::UsageHistoryState::NeedsAudit);
        assert!(history.last_error.is_some());
        assert!(history.completed_through_date.is_none());
        assert!(history.active_date.is_none());

        let status = get_account_sync_status(&ctx, "account-probe-failure")
            .await
            .expect("history failure status");
        assert_eq!(status.statuses.len(), 1);
        assert_eq!(status.statuses[0].scope, DataSyncScope::Full);
        assert_eq!(status.statuses[0].state, AccountSyncState::Failed);
        assert!(status.statuses[0].last_error.is_some());
    }

    #[tokio::test]
    async fn same_account_different_scopes_do_not_share_run() {
        let group_hits = Arc::new(AtomicUsize::new(0));
        let key_hits = Arc::new(AtomicUsize::new(0));
        let usage_hits = Arc::new(AtomicUsize::new(0));

        let app = {
            let group_hits = Arc::clone(&group_hits);
            let key_hits = Arc::clone(&key_hits);
            let usage_hits = Arc::clone(&usage_hits);
            Router::new()
                .route(
                    "/api/v1/groups/available",
                    get(move || {
                        let group_hits = Arc::clone(&group_hits);
                        async move {
                            group_hits.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(80)).await;
                            Json(json!({
                                "items": [
                                    {
                                        "id": 1,
                                        "name": "默认分组",
                                        "platform": "openai",
                                        "rate_multiplier": 1.0
                                    }
                                ]
                            }))
                        }
                    }),
                )
                .route(
                    "/api/v1/keys",
                    get(move || {
                        let key_hits = Arc::clone(&key_hits);
                        async move {
                            key_hits.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(80)).await;
                            Json(json!({
                                "items": [
                                    {
                                        "id": "key-1",
                                        "group_id": 1,
                                        "name": "主 Key",
                                        "status": "active",
                                        "platform": "openai"
                                    }
                                ]
                            }))
                        }
                    }),
                )
                .route(
                    "/api/v1/usage",
                    get(move |Query(query): Query<HashMap<String, String>>| {
                        let usage_hits = Arc::clone(&usage_hits);
                        async move {
                            usage_hits.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(80)).await;
                            let page = query
                                .get("page")
                                .and_then(|value| value.parse::<i64>().ok())
                                .unwrap_or(1);
                            let page_size = query
                                .get("page_size")
                                .and_then(|value| value.parse::<i64>().ok())
                                .unwrap_or(1_000);
                            Json(json!({
                                "items": [],
                                "page": page,
                                "page_size": page_size,
                                "total": 0,
                                "pages": 1
                            }))
                        }
                    }),
                )
        };

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-3",
            "site-3",
            "第三账号",
        );

        let (keys_result, usage_result) = tokio::join!(
            sync_account_data(
                &ctx,
                "account-3",
                SyncAccountDataInput {
                    scope: DataSyncScope::Keys,
                    trigger_source: DataSyncTrigger::Manual,
                },
            ),
            sync_account_data(
                &ctx,
                "account-3",
                SyncAccountDataInput {
                    scope: DataSyncScope::Usage,
                    trigger_source: DataSyncTrigger::Manual,
                },
            )
        );

        let keys_result = keys_result.expect("keys sync result");
        let usage_result = usage_result.expect("usage sync result");

        assert_eq!(group_hits.load(Ordering::SeqCst), 1);
        assert_eq!(key_hits.load(Ordering::SeqCst), 1);
        assert_eq!(usage_hits.load(Ordering::SeqCst), 4);
        assert_ne!(keys_result.run.id, usage_result.run.id);
        assert_eq!(keys_result.run.scope, DataSyncScope::Keys);
        assert_eq!(usage_result.run.scope, DataSyncScope::Usage);
    }

    #[tokio::test]
    async fn full_and_usage_scopes_share_one_usage_mutation_gate() {
        let active_usage_requests = Arc::new(AtomicUsize::new(0));
        let peak_usage_requests = Arc::new(AtomicUsize::new(0));
        let app = {
            let active_usage_requests = Arc::clone(&active_usage_requests);
            let peak_usage_requests = Arc::clone(&peak_usage_requests);
            Router::new()
                .route(
                    "/api/v1/user/profile",
                    get(|| async { Json(json!({ "email": "demo@example.com", "balance": 5.0 })) }),
                )
                .route(
                    "/api/v1/user/platform-quotas",
                    get(|| async { Json(json!({ "platform_quotas": [] })) }),
                )
                .route(
                    "/api/v1/subscriptions",
                    get(|| async { Json(json!({ "items": [] })) }),
                )
                .route(
                    "/api/v1/subscriptions/summary",
                    get(|| async { Json(json!({ "active_count": 0, "total_used_usd": 0.0, "subscriptions": [] })) }),
                )
                .route(
                    "/api/v1/groups/available",
                    get(|| async { Json(json!({ "items": [] })) }),
                )
                .route(
                    "/api/v1/keys",
                    get(|| async { Json(json!({ "items": [] })) }),
                )
                .route(
                    "/api/v1/usage",
                    get(move |Query(query): Query<HashMap<String, String>>| {
                        let active_usage_requests = Arc::clone(&active_usage_requests);
                        let peak_usage_requests = Arc::clone(&peak_usage_requests);
                        async move {
                            let current = active_usage_requests.fetch_add(1, Ordering::SeqCst) + 1;
                            loop {
                                let observed = peak_usage_requests.load(Ordering::SeqCst);
                                if current <= observed
                                    || peak_usage_requests
                                        .compare_exchange(
                                            observed,
                                            current,
                                            Ordering::SeqCst,
                                            Ordering::SeqCst,
                                        )
                                        .is_ok()
                                {
                                    break;
                                }
                            }
                            tokio::time::sleep(Duration::from_millis(30)).await;
                            active_usage_requests.fetch_sub(1, Ordering::SeqCst);
                            let page = query
                                .get("page")
                                .and_then(|value| value.parse::<i64>().ok())
                                .unwrap_or(1);
                            let page_size = query
                                .get("page_size")
                                .and_then(|value| value.parse::<i64>().ok())
                                .unwrap_or(1_000);
                            Json(json!({
                                "items": [],
                                "page": page,
                                "page_size": page_size,
                                "total": 0,
                                "pages": 1
                            }))
                        }
                    }),
                )
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve upstream mock");
        });
        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-full-usage-gate",
            "site-full-usage-gate",
            "Full 与 Usage 竞态账号",
        );

        let (full, usage) = tokio::join!(
            sync_account_data(
                &ctx,
                "account-full-usage-gate",
                SyncAccountDataInput {
                    scope: DataSyncScope::Full,
                    trigger_source: DataSyncTrigger::Manual,
                },
            ),
            sync_account_data(
                &ctx,
                "account-full-usage-gate",
                SyncAccountDataInput {
                    scope: DataSyncScope::Usage,
                    trigger_source: DataSyncTrigger::Manual,
                },
            ),
        );

        full.expect("full sync");
        usage.expect("usage sync");
        assert_eq!(peak_usage_requests.load(Ordering::SeqCst), 1);
        server.abort();
    }

    #[tokio::test]
    async fn post_write_records_trigger_source_on_task_run() {
        let app = Router::new()
            .route(
                "/api/v1/groups/available",
                get(|| async {
                    Json(json!({
                        "items": [
                            {
                                "id": 1,
                                "name": "默认分组",
                                "platform": "openai",
                                "rate_multiplier": 1.0
                            }
                        ]
                    }))
                }),
            )
            .route(
                "/api/v1/keys",
                get(|| async {
                    Json(json!({
                        "items": [
                            {
                                "id": "key-1",
                                "group_id": 1,
                                "name": "主 Key",
                                "status": "active",
                                "platform": "openai"
                            }
                        ]
                    }))
                }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-4",
            "site-4",
            "第四账号",
        );

        let result = sync_account_data(
            &ctx,
            "account-4",
            SyncAccountDataInput {
                scope: DataSyncScope::Keys,
                trigger_source: DataSyncTrigger::PostWrite,
            },
        )
        .await
        .expect("post write sync");

        assert_eq!(
            result.run.primary_trigger_source,
            DataSyncTrigger::PostWrite
        );
        assert_eq!(result.run.scope, DataSyncScope::Keys);
    }

    #[tokio::test]
    async fn custom_range_usage_sync_keeps_rows_outside_default_window() {
        let old_day = (shanghai_today() - Days::new(50)).to_string();
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let old_day = old_day.clone();
                move |Query(query): Query<HashMap<String, String>>| {
                    let old_day = old_day.clone();
                    async move {
                        let page = query
                            .get("page")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1);
                        let page_size = query
                            .get("page_size")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1_000);
                        Json(json!({
                            "items": [
                                {
                                    "id": "usage-old-1",
                                    "created_at": format!("{old_day}T08:00:00+08:00"),
                                    "model": "gpt-5.4",
                                    "actual_cost": 2.4,
                                    "total_cost": 2.4,
                                    "input_tokens": 120,
                                    "output_tokens": 80,
                                    "total_tokens": 200
                                }
                            ],
                            "page": page,
                            "page_size": page_size,
                            "total": 1,
                            "pages": 1
                        }))
                    }
                }
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-4b",
            "site-4b",
            "历史账号",
        );

        sync_usage_scope(
            &ctx,
            "account-4b",
            DataSyncTrigger::Manual,
            Some(old_day.clone()),
            Some(old_day.clone()),
        )
        .await
        .expect("custom range usage sync");

        let usage_rows =
            repositories::list_usage_row_cache(&ctx.db, "account-4b", None, None, None)
                .expect("read usage cache");
        assert_eq!(usage_rows.len(), 1);
        assert_eq!(usage_rows[0].row.id, "usage-old-1");
        assert!(usage_rows[0].occurred_at.starts_with(&old_day));
    }

    #[tokio::test]
    async fn dashboard_stats_cache_only_invalidates_after_actual_usage_writes() {
        let dashboard_hits = Arc::new(AtomicUsize::new(0));
        let usage_version = Arc::new(AtomicUsize::new(0));
        let day = super::shanghai_today()
            .checked_sub_days(Days::new(1))
            .expect("yesterday")
            .to_string();
        let app = Router::new()
            .route(
                "/api/v1/usage",
                get({
                    let usage_version = Arc::clone(&usage_version);
                    let day = day.clone();
                    move |Query(query): Query<HashMap<String, String>>| {
                        let usage_version = Arc::clone(&usage_version);
                        let day = day.clone();
                        async move {
                            let page = query
                                .get("page")
                                .and_then(|value| value.parse::<i64>().ok())
                                .unwrap_or(1);
                            let page_size = query
                                .get("page_size")
                                .and_then(|value| value.parse::<i64>().ok())
                                .unwrap_or(1_000);
                            let requested_day = query.get("start_date");
                            let has_usage_row = requested_day == Some(&day);
                            let actual_cost = if usage_version.load(Ordering::SeqCst) == 0 {
                                0.5
                            } else {
                                0.8
                            };
                            Json(json!({
                                "items": if has_usage_row { json!([{
                                    "id": "usage-dashboard-cache",
                                    "created_at": format!("{day}T08:00:00+08:00"),
                                    "model": "gpt-5.4",
                                    "actual_cost": actual_cost,
                                    "total_cost": actual_cost,
                                    "input_tokens": 10,
                                    "output_tokens": 5,
                                    "total_tokens": 15
                                }]) } else { json!([]) },
                                "page": page,
                                "page_size": page_size,
                                "total": if has_usage_row { 1 } else { 0 },
                                "pages": 1
                            }))
                        }
                    }
                }),
            )
            .route(
                "/api/v1/usage/dashboard/stats",
                get({
                    let dashboard_hits = Arc::clone(&dashboard_hits);
                    move || {
                        let dashboard_hits = Arc::clone(&dashboard_hits);
                        async move {
                            dashboard_hits.fetch_add(1, Ordering::SeqCst);
                            Json(json!({ "today_requests": 1, "total_requests": 1 }))
                        }
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve dashboard cache mock");
        });
        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-dashboard-cache",
            "site-dashboard-cache",
            "仪表盘缓存账号",
        );

        usage_service::get_overview_dashboard_stats(&ctx, "account-dashboard-cache", false)
            .await
            .expect("warm dashboard stats cache");
        assert_eq!(dashboard_hits.load(Ordering::SeqCst), 1);

        let first = sync_account_data(
            &ctx,
            "account-dashboard-cache",
            SyncAccountDataInput {
                scope: DataSyncScope::Usage,
                trigger_source: DataSyncTrigger::Manual,
            },
        )
        .await
        .expect("first usage task writes cache");
        assert_eq!(first.status.statuses[0].item_count, 1);
        usage_service::get_overview_dashboard_stats(&ctx, "account-dashboard-cache", false)
            .await
            .expect("dashboard stats invalidated after usage write");
        assert_eq!(dashboard_hits.load(Ordering::SeqCst), 2);

        let second = sync_account_data(
            &ctx,
            "account-dashboard-cache",
            SyncAccountDataInput {
                scope: DataSyncScope::Usage,
                trigger_source: DataSyncTrigger::Manual,
            },
        )
        .await
        .expect("same usage task succeeds");
        assert_eq!(second.status.statuses[0].item_count, 0);
        usage_service::get_overview_dashboard_stats(&ctx, "account-dashboard-cache", false)
            .await
            .expect("unchanged usage keeps dashboard stats cache");
        assert_eq!(dashboard_hits.load(Ordering::SeqCst), 2);

        usage_version.store(1, Ordering::SeqCst);
        let third = sync_account_data(
            &ctx,
            "account-dashboard-cache",
            SyncAccountDataInput {
                scope: DataSyncScope::Usage,
                trigger_source: DataSyncTrigger::Manual,
            },
        )
        .await
        .expect("changed usage task writes cache");
        assert_eq!(third.status.statuses[0].item_count, 1);
        usage_service::get_overview_dashboard_stats(&ctx, "account-dashboard-cache", false)
            .await
            .expect("dashboard stats invalidated after usage update");
        assert_eq!(dashboard_hits.load(Ordering::SeqCst), 3);
        server.abort();
    }

    #[tokio::test]
    async fn usage_page_size_fallback_marks_window_needs_audit_without_completion() {
        let day = super::shanghai_today().to_string();
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let day = day.clone();
                move |Query(query): Query<HashMap<String, String>>| {
                    let day = day.clone();
                    async move {
                        let page = query
                            .get("page")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1);
                        Json(json!({
                            "items": [{
                                "id": "usage-page-size-fallback",
                                "created_at": format!("{day}T08:00:00+08:00"),
                                "model": "gpt-5.4",
                                "actual_cost": 0.5,
                                "total_cost": 0.5,
                                "input_tokens": 10,
                                "output_tokens": 5,
                                "total_tokens": 15
                            }],
                            "page": page,
                            "page_size": 20,
                            "total": 1,
                            "pages": 1
                        }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve upstream mock");
        });
        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-page-size-fallback",
            "site-page-size-fallback",
            "分页回退账号",
        );

        let error = sync_usage_scope(
            &ctx,
            "account-page-size-fallback",
            DataSyncTrigger::Manual,
            Some(day.clone()),
            Some(day),
        )
        .await
        .expect_err("page size fallback must fail the date window");

        assert!(error.to_string().contains("分页元数据"));
        let state = repositories::load_usage_history_state(&ctx.db, "account-page-size-fallback")
            .expect("load history state")
            .expect("history state exists");
        assert_eq!(state.state, repositories::UsageHistoryState::NeedsAudit);
        assert!(state.completed_through_date.is_none());
        assert!(repositories::list_usage_row_cache(
            &ctx.db,
            "account-page-size-fallback",
            None,
            None,
            None,
        )
        .expect("read usage cache")
        .is_empty());
        server.abort();
    }

    #[tokio::test]
    async fn changing_window_postflight_marks_needs_audit_without_completion() {
        let calls = Arc::new(AtomicUsize::new(0));
        let dashboard_hits = Arc::new(AtomicUsize::new(0));
        let day = super::shanghai_today()
            .checked_sub_days(Days::new(2))
            .expect("closed history day")
            .to_string();
        let app = Router::new()
            .route(
                "/api/v1/usage",
                get({
                    let calls = Arc::clone(&calls);
                    let day = day.clone();
                    move |Query(query): Query<HashMap<String, String>>| {
                        let calls = Arc::clone(&calls);
                        let day = day.clone();
                        async move {
                            let call = calls.fetch_add(1, Ordering::SeqCst);
                            let page = query
                                .get("page")
                                .and_then(|value| value.parse::<i64>().ok())
                                .unwrap_or(1);
                            let page_size = query
                                .get("page_size")
                                .and_then(|value| value.parse::<i64>().ok())
                                .unwrap_or(1_000);
                            let rows = if call % 2 == 0 {
                                vec![json!({
                                    "id": "usage-window-1",
                                    "created_at": format!("{day}T08:00:00+08:00"),
                                    "model": "gpt-5.4",
                                    "actual_cost": 0.5,
                                    "total_cost": 0.5,
                                    "input_tokens": 10,
                                    "output_tokens": 5,
                                    "total_tokens": 15
                                })]
                            } else {
                                vec![
                                    json!({
                                        "id": "usage-window-1",
                                        "created_at": format!("{day}T08:00:00+08:00"),
                                        "model": "gpt-5.4",
                                        "actual_cost": 0.5,
                                        "total_cost": 0.5,
                                        "input_tokens": 10,
                                        "output_tokens": 5,
                                        "total_tokens": 15
                                    }),
                                    json!({
                                        "id": "usage-window-2",
                                        "created_at": format!("{day}T09:00:00+08:00"),
                                        "model": "gpt-5.4",
                                        "actual_cost": 0.6,
                                        "total_cost": 0.6,
                                        "input_tokens": 12,
                                        "output_tokens": 6,
                                        "total_tokens": 18
                                    }),
                                ]
                            };
                            Json(json!({
                                "items": rows,
                                "page": page,
                                "page_size": page_size,
                                "total": if call % 2 == 0 { 1 } else { 2 },
                                "pages": 1
                            }))
                        }
                    }
                }),
            )
            .route(
                "/api/v1/usage/dashboard/stats",
                get({
                    let dashboard_hits = Arc::clone(&dashboard_hits);
                    move || {
                        let dashboard_hits = Arc::clone(&dashboard_hits);
                        async move {
                            dashboard_hits.fetch_add(1, Ordering::SeqCst);
                            Json(json!({ "today_requests": 1, "total_requests": 1 }))
                        }
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve upstream mock");
        });
        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-window-change",
            "site-window-change",
            "窗口变化账号",
        );
        usage_service::get_overview_dashboard_stats(&ctx, "account-window-change", false)
            .await
            .expect("warm dashboard stats cache");
        assert_eq!(dashboard_hits.load(Ordering::SeqCst), 1);

        let error = sync_usage_scope(
            &ctx,
            "account-window-change",
            DataSyncTrigger::Manual,
            Some(day.clone()),
            Some(day),
        )
        .await
        .expect_err("repeated postflight changes must fail the date window");

        assert!(error.to_string().contains("窗口在读取期间发生变化"));
        assert_eq!(calls.load(Ordering::SeqCst), 6);
        usage_service::get_overview_dashboard_stats(&ctx, "account-window-change", false)
            .await
            .expect("failed usage sync still invalidates dashboard stats after a write");
        assert_eq!(dashboard_hits.load(Ordering::SeqCst), 2);
        let state = repositories::load_usage_history_state(&ctx.db, "account-window-change")
            .expect("load history state")
            .expect("history state exists");
        assert_eq!(state.state, repositories::UsageHistoryState::NeedsAudit);
        assert!(state.completed_through_date.is_none());
        server.abort();
    }

    #[tokio::test]
    async fn open_single_page_window_uses_snapshot_and_catches_up_without_duplicates() {
        let calls = Arc::new(AtomicUsize::new(0));
        let day = super::shanghai_today().to_string();
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let calls = Arc::clone(&calls);
                let day = day.clone();
                move |Query(query): Query<HashMap<String, String>>| {
                    let calls = Arc::clone(&calls);
                    let day = day.clone();
                    async move {
                        let call = calls.fetch_add(1, Ordering::SeqCst);
                        let page = query
                            .get("page")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1);
                        let page_size = query
                            .get("page_size")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1_000);
                        let total = if call == 0 { 1 } else { 2 };
                        let pages = (total + page_size - 1) / page_size;
                        let offset = (page - 1) * page_size;
                        let count = (total - offset).clamp(0, page_size);
                        let items = (0..count)
                            .map(|index| {
                                let row_index = offset + index;
                                json!({
                                    "id": format!("usage-open-single-{row_index}"),
                                    "created_at": format!(
                                        "{day}T{:02}:00:00+08:00",
                                        8 + row_index
                                    ),
                                    "model": "gpt-5.4",
                                    "actual_cost": 0.5,
                                    "total_cost": 0.5,
                                    "input_tokens": 10,
                                    "output_tokens": 5,
                                    "total_tokens": 15
                                })
                            })
                            .collect::<Vec<_>>();
                        Json(json!({
                            "items": items,
                            "page": page,
                            "page_size": page_size,
                            "total": total,
                            "pages": pages
                        }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve upstream mock");
        });
        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-open-single",
            "site-open-single",
            "开放单页账号",
        );

        sync_usage_scope(
            &ctx,
            "account-open-single",
            DataSyncTrigger::Manual,
            Some(day.clone()),
            Some(day.clone()),
        )
        .await
        .expect("first snapshot sync");
        let first_rows =
            repositories::list_usage_row_cache(&ctx.db, "account-open-single", None, None, None)
                .expect("read first snapshot");
        assert_eq!(first_rows.len(), 1);
        assert_eq!(first_rows[0].row.id, "usage-open-single-0");

        for _ in 0..2 {
            sync_usage_scope(
                &ctx,
                "account-open-single",
                DataSyncTrigger::Manual,
                Some(day.clone()),
                Some(day.clone()),
            )
            .await
            .expect("catch-up snapshot sync");
        }
        let final_rows =
            repositories::list_usage_row_cache(&ctx.db, "account-open-single", None, None, None)
                .expect("read final snapshot");
        assert_eq!(final_rows.len(), 2);
        assert!(final_rows
            .iter()
            .any(|row| row.row.id == "usage-open-single-1"));
        assert_eq!(calls.load(Ordering::SeqCst), 6);
        server.abort();
    }

    #[tokio::test]
    async fn open_multi_page_window_truncates_the_original_last_page() {
        const SNAPSHOT_TOTAL: i64 = 1_999;
        const GROWN_TOTAL: i64 = 2_001;

        let calls = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(Mutex::new(Vec::<HashMap<String, String>>::new()));
        let day = super::shanghai_today().to_string();
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let calls = Arc::clone(&calls);
                let requests = Arc::clone(&requests);
                let day = day.clone();
                move |Query(query): Query<HashMap<String, String>>| {
                    let calls = Arc::clone(&calls);
                    let requests = Arc::clone(&requests);
                    let day = day.clone();
                    async move {
                        requests.lock().await.push(query.clone());
                        let call = calls.fetch_add(1, Ordering::SeqCst);
                        let page = query
                            .get("page")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1);
                        let page_size = query
                            .get("page_size")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1_000);
                        let total = if call == 0 {
                            SNAPSHOT_TOTAL
                        } else {
                            GROWN_TOTAL
                        };
                        let pages = (total + page_size - 1) / page_size;
                        let offset = (page - 1) * page_size;
                        let count = (total - offset).clamp(0, page_size);
                        let items = (0..count)
                            .map(|index| {
                                let row_index = offset + index;
                                json!({
                                    "id": format!("usage-open-multi-{row_index:04}"),
                                    "created_at": format!("{day}T08:00:00+08:00"),
                                    "model": "gpt-5.4",
                                    "actual_cost": 0.5,
                                    "total_cost": 0.5,
                                    "input_tokens": 10,
                                    "output_tokens": 5,
                                    "total_tokens": 15
                                })
                            })
                            .collect::<Vec<_>>();
                        Json(json!({
                            "items": items,
                            "page": page,
                            "page_size": page_size,
                            "total": total,
                            "pages": pages
                        }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve upstream mock");
        });
        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-open-multi",
            "site-open-multi",
            "开放多页账号",
        );

        sync_usage_scope(
            &ctx,
            "account-open-multi",
            DataSyncTrigger::Manual,
            Some(day.clone()),
            Some(day),
        )
        .await
        .expect("multi-page snapshot sync");

        let rows =
            repositories::list_usage_row_cache(&ctx.db, "account-open-multi", None, None, None)
                .expect("read multi-page snapshot");
        assert_eq!(rows.len(), SNAPSHOT_TOTAL as usize);
        assert!(rows.iter().any(|row| row.row.id == "usage-open-multi-1998"));
        assert!(!rows.iter().any(|row| row.row.id == "usage-open-multi-1999"));
        assert!(!rows.iter().any(|row| row.row.id == "usage-open-multi-2000"));
        let requests = requests.lock().await;
        assert_eq!(requests.len(), 4);
        assert!(requests.iter().all(|query| {
            query
                .get("page")
                .and_then(|value| value.parse::<i64>().ok())
                .is_none_or(|page| page <= 2)
        }));
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        server.abort();
    }

    #[tokio::test]
    async fn auto_usage_sync_never_requests_a_history_date_window() {
        let requests = Arc::new(Mutex::new(Vec::<HashMap<String, String>>::new()));
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let requests = Arc::clone(&requests);
                move |Query(query): Query<HashMap<String, String>>| {
                    let requests = Arc::clone(&requests);
                    async move {
                        requests.lock().await.push(query.clone());
                        let page = query
                            .get("page")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1);
                        let page_size = query
                            .get("page_size")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(100);
                        Json(json!({
                            "items": [],
                            "page": page,
                            "page_size": page_size,
                            "total": 0,
                            "pages": 1
                        }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve upstream mock");
        });
        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-auto-only",
            "site-auto-only",
            "Auto 增量账号",
        );
        let audit_date = NaiveDate::from_ymd_opt(2026, 7, 15).expect("audit date");
        let now = super::usage_sync_timestamp();
        repositories::advance_usage_history_completed_through_date(
            &ctx.db,
            "account-auto-only",
            Some(&audit_date.to_string()),
            &audit_date.to_string(),
            Some(&audit_date.to_string()),
            &now,
        )
        .expect("seed prior audit state");

        let result = sync_account_data(
            &ctx,
            "account-auto-only",
            SyncAccountDataInput {
                scope: DataSyncScope::Usage,
                trigger_source: DataSyncTrigger::Auto,
            },
        )
        .await
        .expect("auto latest sync");

        assert_eq!(result.status.statuses[0].state, AccountSyncState::Succeeded);
        let requests = requests.lock().await;
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0].get("page_size").map(String::as_str),
            Some("100")
        );
        assert!(!requests[0].contains_key("start_date"));
        assert!(!requests[0].contains_key("end_date"));
        server.abort();
    }

    #[tokio::test]
    async fn startup_recent_four_day_read_scans_all_dates_once_per_day_and_rolls_forward() {
        let requests = Arc::new(Mutex::new(Vec::<HashMap<String, String>>::new()));
        let dashboard_hits = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route(
                "/api/v1/usage",
                get({
                    let requests = Arc::clone(&requests);
                    move |Query(query): Query<HashMap<String, String>>| {
                        let requests = Arc::clone(&requests);
                        async move {
                            requests.lock().await.push(query.clone());
                            let page = query
                                .get("page")
                                .and_then(|value| value.parse::<i64>().ok())
                                .unwrap_or(1);
                            let page_size = query
                                .get("page_size")
                                .and_then(|value| value.parse::<i64>().ok())
                                .unwrap_or(1_000);
                            let Some(date) = query.get("start_date").cloned() else {
                                return Json(json!({
                                    "items": [],
                                    "page": page,
                                    "page_size": page_size,
                                    "total": 0,
                                    "pages": 1
                                }));
                            };
                            Json(json!({
                                "items": [json!({
                                    "id": format!("startup-{date}"),
                                    "created_at": format!("{date}T08:00:00+08:00"),
                                    "model": "gpt-5.4",
                                    "actual_cost": 0.5,
                                    "total_cost": 0.5,
                                    "input_tokens": 10,
                                    "output_tokens": 5,
                                    "total_tokens": 15
                                })],
                                "page": page,
                                "page_size": page_size,
                                "total": 1,
                                "pages": 1
                            }))
                        }
                    }
                }),
            )
            .route(
                "/api/v1/usage/dashboard/stats",
                get({
                    let dashboard_hits = Arc::clone(&dashboard_hits);
                    move || {
                        let dashboard_hits = Arc::clone(&dashboard_hits);
                        async move {
                            dashboard_hits.fetch_add(1, Ordering::SeqCst);
                            Json(json!({ "today_requests": 1, "total_requests": 1 }))
                        }
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve upstream mock");
        });
        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-startup-four-day",
            "site-startup-four-day",
            "启动四日账号",
        );
        usage_service::get_overview_dashboard_stats(&ctx, "account-startup-four-day", false)
            .await
            .expect("warm dashboard stats cache");
        assert_eq!(dashboard_hits.load(Ordering::SeqCst), 1);
        let today = NaiveDate::from_ymd_opt(2026, 7, 21).expect("today");
        let checkpoint_at = super::usage_sync_timestamp();
        repositories::advance_usage_history_completed_through_date(
            &ctx.db,
            "account-startup-four-day",
            Some("2026-06-01"),
            "2026-06-10",
            Some("2026-06-01"),
            &checkpoint_at,
        )
        .expect("seed completed initial history checkpoint");
        repositories::mark_usage_history_active(
            &ctx.db,
            "account-startup-four-day",
            "2026-06-11",
            &checkpoint_at,
            &checkpoint_at,
        )
        .expect("seed active initial history checkpoint");

        sync_startup_recent_four_day_usage_reads_for_today(&ctx, today).await;
        usage_service::get_overview_dashboard_stats(&ctx, "account-startup-four-day", false)
            .await
            .expect("startup usage writes invalidate dashboard stats");
        assert_eq!(dashboard_hits.load(Ordering::SeqCst), 2);

        let requests_after_first = requests.lock().await.clone();
        assert_eq!(requests_after_first.len(), 9);
        assert!(!requests_after_first[0].contains_key("start_date"));
        assert_eq!(
            requests_after_first[0].get("page_size").map(String::as_str),
            Some("1")
        );
        for offset in 0..4 {
            let date = today
                .checked_sub_days(Days::new(offset))
                .expect("four-day date")
                .to_string();
            assert_eq!(
                requests_after_first
                    .iter()
                    .filter(|query| query.get("start_date") == Some(&date))
                    .count(),
                2,
                "each date needs an initial and postflight request"
            );
        }
        assert!(requests_after_first
            .iter()
            .filter(|query| query.contains_key("start_date"))
            .all(|query| {
                query.get("start_date") == query.get("end_date")
                    && query.get("page_size").map(String::as_str) == Some("1000")
            }));
        assert_eq!(
            requests_after_first
                .last()
                .and_then(|query| query.get("start_date")),
            Some(&today.to_string())
        );

        sync_startup_recent_four_day_usage_reads_for_today(&ctx, today).await;
        assert_eq!(
            requests.lock().await.len(),
            9,
            "same day must skip upstream"
        );
        usage_service::get_overview_dashboard_stats(&ctx, "account-startup-four-day", false)
            .await
            .expect("same-day startup skip keeps dashboard stats cache");
        assert_eq!(dashboard_hits.load(Ordering::SeqCst), 2);

        let tomorrow = today.succ_opt().expect("tomorrow");
        sync_startup_recent_four_day_usage_reads_for_today(&ctx, tomorrow).await;
        assert_eq!(
            requests.lock().await.len(),
            18,
            "next day must roll forward"
        );
        usage_service::get_overview_dashboard_stats(&ctx, "account-startup-four-day", false)
            .await
            .expect("rolled startup usage write invalidates dashboard stats");
        assert_eq!(dashboard_hits.load(Ordering::SeqCst), 3);

        let request_count_before_zero_write_scan = requests.lock().await.len();
        let usage_row_count_before_zero_write_scan = repositories::list_usage_row_cache(
            &ctx.db,
            "account-startup-four-day",
            None,
            None,
            None,
        )
        .expect("load scanned usage cache")
        .len();
        let reset_date = today.to_string();
        ctx.db
            .connect()
            .expect("connect usage history state")
            .execute(
                "UPDATE account_usage_history_states
                 SET last_startup_recent_four_day_read_date = ?1
                 WHERE account_id = ?2",
                rusqlite::params![reset_date, "account-startup-four-day"],
            )
            .expect("force a real zero-write startup rescan");
        sync_startup_recent_four_day_usage_reads_for_today(&ctx, tomorrow).await;
        assert_eq!(
            requests.lock().await.len(),
            request_count_before_zero_write_scan + 9,
            "forced rescan must still read the upstream usage windows"
        );
        assert_eq!(
            repositories::list_usage_row_cache(
                &ctx.db,
                "account-startup-four-day",
                None,
                None,
                None,
            )
            .expect("load zero-write scan cache")
            .len(),
            usage_row_count_before_zero_write_scan,
            "identical startup rows must not insert new usage cache records"
        );
        usage_service::get_overview_dashboard_stats(&ctx, "account-startup-four-day", false)
            .await
            .expect("zero-write startup rescan keeps dashboard stats cache");
        assert_eq!(dashboard_hits.load(Ordering::SeqCst), 3);

        let state = repositories::load_usage_history_state(&ctx.db, "account-startup-four-day")
            .expect("load state")
            .expect("state exists");
        assert_eq!(
            state.last_startup_recent_four_day_read_date.as_deref(),
            Some(tomorrow.to_string().as_str())
        );
        assert_eq!(state.state, repositories::UsageHistoryState::Backfilling);
        assert_eq!(state.active_date.as_deref(), Some("2026-06-11"));
        assert_eq!(state.completed_through_date.as_deref(), Some("2026-06-10"));
        assert!(state.recent_reconciled_at.is_some());
        server.abort();
    }

    #[tokio::test]
    async fn startup_recent_four_day_read_stops_before_today_when_initial_history_probe_fails() {
        let requests = Arc::new(Mutex::new(Vec::<HashMap<String, String>>::new()));
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let requests = Arc::clone(&requests);
                move |Query(query): Query<HashMap<String, String>>| {
                    let requests = Arc::clone(&requests);
                    async move {
                        requests.lock().await.push(query);
                        StatusCode::BAD_REQUEST
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve upstream mock");
        });
        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-startup-history-failure",
            "site-startup-history-failure",
            "启动历史失败账号",
        );
        let today = NaiveDate::from_ymd_opt(2026, 7, 21).expect("today");

        sync_startup_recent_four_day_usage_reads_for_today(&ctx, today).await;

        let requests = requests.lock().await;
        assert!(!requests.is_empty());
        let only_history_probe_requests = requests
            .iter()
            .all(|query| !query.contains_key("start_date") && !query.contains_key("end_date"));
        assert!(only_history_probe_requests);
        drop(requests);
        let state =
            repositories::load_usage_history_state(&ctx.db, "account-startup-history-failure")
                .expect("load failed history state")
                .expect("history state exists");
        assert_eq!(state.state, repositories::UsageHistoryState::NeedsAudit);
        assert!(state.last_startup_recent_four_day_read_date.is_none());
        server.abort();
    }

    #[tokio::test]
    async fn failed_startup_recent_four_day_read_marks_needs_audit_and_preserves_checkpoint() {
        let requests = Arc::new(Mutex::new(Vec::<HashMap<String, String>>::new()));
        let today = NaiveDate::from_ymd_opt(2026, 7, 21).expect("today");
        let failing_date = today
            .checked_sub_days(Days::new(1))
            .expect("failing date")
            .to_string();
        let failing_date_for_mock = failing_date.clone();
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let requests = Arc::clone(&requests);
                move |Query(query): Query<HashMap<String, String>>| {
                    let requests = Arc::clone(&requests);
                    let failing_date = failing_date_for_mock.clone();
                    async move {
                        requests.lock().await.push(query.clone());
                        if query.get("start_date") == Some(&failing_date) {
                            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                        }
                        let page = query
                            .get("page")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1);
                        let page_size = query
                            .get("page_size")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(100);
                        Json(json!({
                            "items": [],
                            "page": page,
                            "page_size": page_size,
                            "total": 0,
                            "pages": 1
                        }))
                        .into_response()
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve upstream mock");
        });
        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-startup-four-day-failure",
            "site-startup-four-day-failure",
            "启动四日失败账号",
        );
        let checkpoint_at = super::usage_sync_timestamp();
        repositories::advance_usage_history_completed_through_date(
            &ctx.db,
            "account-startup-four-day-failure",
            Some("2026-06-01"),
            "2026-06-10",
            Some("2026-06-01"),
            &checkpoint_at,
        )
        .expect("seed completed initial history checkpoint");
        repositories::mark_usage_history_active(
            &ctx.db,
            "account-startup-four-day-failure",
            "2026-06-11",
            &checkpoint_at,
            &checkpoint_at,
        )
        .expect("seed active initial history checkpoint");

        sync_startup_recent_four_day_usage_reads_for_today(&ctx, today).await;

        let state =
            repositories::load_usage_history_state(&ctx.db, "account-startup-four-day-failure")
                .expect("load failed state")
                .expect("state exists");
        assert!(state.last_startup_recent_four_day_read_date.is_none());
        assert_eq!(state.active_date.as_deref(), Some("2026-06-11"));
        assert_eq!(state.completed_through_date.as_deref(), Some("2026-06-10"));
        assert_eq!(state.state, repositories::UsageHistoryState::NeedsAudit);
        assert_eq!(
            super::usage_history_resume_date(
                &state,
                NaiveDate::from_ymd_opt(2026, 6, 1).expect("observed earliest date"),
            )
            .expect("resume initial history"),
            NaiveDate::from_ymd_opt(2026, 6, 11).expect("active resume date")
        );

        let auto_result = sync_account_data(
            &ctx,
            "account-startup-four-day-failure",
            SyncAccountDataInput {
                scope: DataSyncScope::Usage,
                trigger_source: DataSyncTrigger::Auto,
            },
        )
        .await
        .expect("auto latest sync remains independent");
        assert_eq!(
            auto_result.status.statuses[0].state,
            AccountSyncState::Succeeded
        );
        let state =
            repositories::load_usage_history_state(&ctx.db, "account-startup-four-day-failure")
                .expect("reload failed state")
                .expect("state exists");
        assert!(state.last_startup_recent_four_day_read_date.is_none());
        let requests = requests.lock().await;
        assert!(requests.iter().any(|query| {
            query.get("start_date") == Some(&failing_date)
                && query.get("page_size").map(String::as_str) == Some("1000")
        }));
        assert!(requests.iter().any(|query| {
            !query.contains_key("start_date")
                && !query.contains_key("end_date")
                && query.get("page_size").map(String::as_str) == Some("100")
        }));
        server.abort();
    }

    #[test]
    fn incomplete_history_checkpoint_restarts_from_observed_earliest_date() {
        let ctx = build_test_context();
        seed_account(
            &ctx,
            "http://127.0.0.1",
            "account-incomplete-history",
            "site-incomplete-history",
            "不完整检查点账号",
        );
        let checkpoint_at = super::usage_sync_timestamp();
        repositories::mark_usage_history_active(
            &ctx.db,
            "account-incomplete-history",
            "2026-07-20",
            &checkpoint_at,
            &checkpoint_at,
        )
        .expect("seed incomplete history checkpoint");

        let state = repositories::load_usage_history_state(&ctx.db, "account-incomplete-history")
            .expect("load incomplete history checkpoint")
            .expect("history checkpoint exists");
        assert!(state.earliest_date.is_none());
        assert_eq!(
            super::usage_history_resume_date(
                &state,
                NaiveDate::from_ymd_opt(2026, 5, 6).expect("observed earliest date"),
            )
            .expect("restart incomplete history"),
            NaiveDate::from_ymd_opt(2026, 5, 6).expect("expected restart date")
        );
    }

    #[tokio::test]
    async fn scheduled_usage_sync_skips_when_account_usage_gate_is_busy() {
        let ctx = build_test_context();
        let gate = ctx
            .live_resources
            .acquire_usage_account_gate("account-scheduler-busy")
            .await;

        let result = super::sync_scheduled_account_data(&ctx, "account-scheduler-busy")
            .await
            .expect("scheduler busy path");

        assert!(result.is_none());
        drop(gate);
    }

    #[tokio::test]
    async fn scheduled_usage_join_releases_preacquired_usage_gate() {
        let ctx = build_test_context();
        let account_id = "account-scheduler-join";
        let handle = Arc::new(SyncTaskHandle {
            state: Mutex::new(super::super::context::SyncTaskState {
                run: crate::contracts::TaskRunRecord {
                    id: "run-scheduler-join".into(),
                    account_id: account_id.into(),
                    scope: DataSyncScope::Usage,
                    primary_trigger_source: DataSyncTrigger::Manual,
                    status: TaskRunStatus::Running,
                    join_count: 0,
                    started_at: "2026-08-14T00:00:00Z".into(),
                    finished_at: None,
                    error_message: None,
                },
                progress: Some(initial_sync_progress(&DataSyncScope::Usage)),
                completed: false,
                result: None,
            }),
            notify: Notify::new(),
        });
        ctx.sync_tasks
            .lock()
            .await
            .insert(format!("{account_id}:usage"), Arc::clone(&handle));

        let scheduled_ctx = ctx.clone();
        let scheduled = tokio::spawn(async move {
            super::sync_scheduled_account_data(&scheduled_ctx, account_id).await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if handle.state.lock().await.run.join_count == 1 {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("scheduled join must attach to the existing task");

        let released_gate = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Some(gate) = ctx
                    .live_resources
                    .try_acquire_usage_account_gate(account_id)
                    .await
                {
                    return gate;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("joining a task must release the scheduler usage gate");
        drop(released_gate);
        scheduled.abort();
        let _ = scheduled.await;
    }

    #[tokio::test]
    async fn scheduled_usage_sync_stops_before_task_and_upstream_when_restart_required() {
        let upstream_hits = Arc::new(AtomicUsize::new(0));
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let upstream_hits = Arc::clone(&upstream_hits);
                move || {
                    let upstream_hits = Arc::clone(&upstream_hits);
                    async move {
                        upstream_hits.fetch_add(1, Ordering::SeqCst);
                        Json(json!({
                            "items": [],
                            "page": 1,
                            "page_size": 100,
                            "total": 0,
                            "pages": 1
                        }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind restart gate listener");
        let address = listener.local_addr().expect("read restart gate listener");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve restart gate upstream mock");
        });
        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-restart-required",
            "site-restart-required",
            "等待重启账号",
        );
        ctx.db
            .set_migration_phase(DatabaseMigrationPhase::RestartRequired, None)
            .expect("enter restart-required phase");

        let error = super::sync_scheduled_account_data(&ctx, "account-restart-required")
            .await
            .expect_err("restart-required phase should reject scheduled sync");

        assert!(error.to_string().contains("请重启"));
        assert!(ctx.sync_tasks.lock().await.is_empty());
        assert_eq!(upstream_hits.load(Ordering::SeqCst), 0);
        server.abort();
    }

    #[tokio::test]
    async fn auto_usage_sync_stops_after_a_cached_tail_on_the_first_page() {
        let requests = Arc::new(Mutex::new(Vec::<HashMap<String, String>>::new()));
        let first_page = vec![
            usage_item("usage-new", 0),
            usage_item("usage-known-1", 1),
            usage_item("usage-known-2", 2),
        ];
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let requests = Arc::clone(&requests);
                let first_page = first_page.clone();
                move |Query(query): Query<HashMap<String, String>>| {
                    let requests = Arc::clone(&requests);
                    let first_page = first_page.clone();
                    async move {
                        requests.lock().await.push(query.clone());
                        Json(json!({
                            "items": first_page,
                            "page": 1,
                            "page_size": 100,
                            "total": 3,
                            "pages": 1
                        }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-latest-first-page",
            "site-latest-first-page",
            "最新增量账号",
        );
        let known_one = normalize_usage_row(&usage_item("usage-known-1", 1));
        let known_two = normalize_usage_row(&usage_item("usage-known-2", 2));
        repositories::merge_usage_row_cache(
            &ctx.db,
            "account-latest-first-page",
            &[known_one, known_two],
            "2026-07-21T13:00:00+08:00",
        )
        .expect("seed cached tail");

        let changed = sync_usage_scope(
            &ctx,
            "account-latest-first-page",
            DataSyncTrigger::Auto,
            None,
            None,
        )
        .await
        .expect("latest usage sync");

        assert_eq!(changed, 1);
        let requests = requests.lock().await;
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0].get("page_size").map(String::as_str),
            Some("100")
        );
        assert_eq!(
            requests[0].get("sort_order").map(String::as_str),
            Some("desc")
        );
        assert!(!requests[0].contains_key("start_date"));
        assert!(!requests[0].contains_key("end_date"));
    }

    #[tokio::test]
    async fn auto_usage_sync_reads_the_next_page_until_it_reaches_a_cached_tail() {
        let requests = Arc::new(Mutex::new(Vec::<String>::new()));
        let first_page = (0..100)
            .map(|index| usage_item(&format!("usage-first-{index:03}"), index))
            .collect::<Vec<_>>();
        let second_page = (0..50)
            .map(|index| {
                let sequence = 100 + index;
                let prefix = if index < 20 {
                    "usage-second-new"
                } else {
                    "usage-second-known"
                };
                usage_item(&format!("{prefix}-{index:03}"), sequence)
            })
            .collect::<Vec<_>>();
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let requests = Arc::clone(&requests);
                let first_page = first_page.clone();
                let second_page = second_page.clone();
                move |Query(query): Query<HashMap<String, String>>| {
                    let requests = Arc::clone(&requests);
                    let first_page = first_page.clone();
                    let second_page = second_page.clone();
                    async move {
                        let page = query.get("page").cloned().unwrap_or_default();
                        requests.lock().await.push(page.clone());
                        let items = if page == "1" { first_page } else { second_page };
                        Json(json!({
                            "items": items,
                            "page": page.parse::<i64>().unwrap_or_default(),
                            "page_size": 100,
                            "total": 150,
                            "pages": 2
                        }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-latest-two-pages",
            "site-latest-two-pages",
            "两页增量账号",
        );
        let cached_tail = (20..50)
            .map(|index| {
                normalize_usage_row(&usage_item(
                    &format!("usage-second-known-{index:03}"),
                    100 + index,
                ))
            })
            .collect::<Vec<_>>();
        repositories::merge_usage_row_cache(
            &ctx.db,
            "account-latest-two-pages",
            &cached_tail,
            "2026-07-21T13:00:00+08:00",
        )
        .expect("seed second page tail");

        let changed = sync_usage_scope(
            &ctx,
            "account-latest-two-pages",
            DataSyncTrigger::Auto,
            None,
            None,
        )
        .await
        .expect("two page latest usage sync");

        assert_eq!(changed, 120);
        assert_eq!(requests.lock().await.as_slice(), ["1", "2"]);
        server.abort();
    }

    #[tokio::test]
    async fn auto_usage_sync_does_not_stop_when_a_cached_row_is_followed_by_an_unknown_row() {
        let requests = Arc::new(Mutex::new(Vec::<String>::new()));
        let first_page = (0..100)
            .map(|index| usage_item(&format!("usage-gap-{index:03}"), index))
            .collect::<Vec<_>>();
        let second_page = vec![usage_item("usage-gap-tail", 100)];
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let requests = Arc::clone(&requests);
                let first_page = first_page.clone();
                let second_page = second_page.clone();
                move |Query(query): Query<HashMap<String, String>>| {
                    let requests = Arc::clone(&requests);
                    let first_page = first_page.clone();
                    let second_page = second_page.clone();
                    async move {
                        let page = query.get("page").cloned().unwrap_or_default();
                        requests.lock().await.push(page.clone());
                        let items = if page == "1" { first_page } else { second_page };
                        Json(json!({
                            "items": items,
                            "page": page.parse::<i64>().unwrap_or_default(),
                            "page_size": 100,
                            "total": 101,
                            "pages": 2
                        }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-latest-gap",
            "site-latest-gap",
            "间隙增量账号",
        );
        let cached_first_page_row = normalize_usage_row(&usage_item("usage-gap-050", 50));
        let cached_second_page_row = normalize_usage_row(&usage_item("usage-gap-tail", 100));
        repositories::merge_usage_row_cache(
            &ctx.db,
            "account-latest-gap",
            &[cached_first_page_row, cached_second_page_row],
            "2026-07-21T13:00:00+08:00",
        )
        .expect("seed interrupted cache tail");

        sync_usage_scope(
            &ctx,
            "account-latest-gap",
            DataSyncTrigger::Auto,
            None,
            None,
        )
        .await
        .expect("gap latest usage sync");

        assert_eq!(requests.lock().await.as_slice(), ["1", "2"]);
        server.abort();
    }

    #[tokio::test]
    async fn auto_usage_sync_does_not_treat_this_run_page_overlap_as_a_cached_tail() {
        let requests = Arc::new(Mutex::new(Vec::<String>::new()));
        let first_page = (0..100)
            .map(|index| usage_item(&format!("usage-overlap-{index:03}"), index))
            .collect::<Vec<_>>();
        let third_page = vec![usage_item("usage-overlap-older", 100)];
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let requests = Arc::clone(&requests);
                let first_page = first_page.clone();
                let third_page = third_page.clone();
                move |Query(query): Query<HashMap<String, String>>| {
                    let requests = Arc::clone(&requests);
                    let first_page = first_page.clone();
                    let third_page = third_page.clone();
                    async move {
                        let page = query.get("page").cloned().unwrap_or_default();
                        requests.lock().await.push(page.clone());
                        let items = match page.as_str() {
                            "1" | "2" => first_page,
                            "3" => third_page,
                            _ => Vec::new(),
                        };
                        Json(json!({
                            "items": items,
                            "page": page.parse::<i64>().unwrap_or_default(),
                            "page_size": 100,
                            "total": 201,
                            "pages": 3
                        }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-latest-overlap",
            "site-latest-overlap",
            "分页重叠账号",
        );

        sync_usage_scope(
            &ctx,
            "account-latest-overlap",
            DataSyncTrigger::Auto,
            None,
            None,
        )
        .await
        .expect("overlapping latest usage sync");

        assert_eq!(requests.lock().await.as_slice(), ["1", "2", "3"]);
        let rows =
            repositories::list_usage_row_cache(&ctx.db, "account-latest-overlap", None, None, None)
                .expect("read merged overlap rows");
        assert!(rows.iter().any(|row| row.row.id == "usage-overlap-older"));
        server.abort();
    }

    #[tokio::test]
    async fn auto_usage_sync_stops_at_a_short_page_without_a_cached_tail() {
        let requests = Arc::new(Mutex::new(Vec::<String>::new()));
        let items = vec![
            usage_item("usage-natural-1", 0),
            usage_item("usage-natural-2", 1),
        ];
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let requests = Arc::clone(&requests);
                move |Query(query): Query<HashMap<String, String>>| {
                    let requests = Arc::clone(&requests);
                    let items = items.clone();
                    async move {
                        let page = query.get("page").cloned().unwrap_or_default();
                        requests.lock().await.push(page.clone());
                        Json(json!({
                            "items": items,
                            "page": page.parse::<i64>().unwrap_or_default(),
                            "page_size": 100,
                            "total": 2,
                            "pages": 1
                        }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-latest-natural-end",
            "site-latest-natural-end",
            "自然末页账号",
        );

        let merged = sync_usage_scope(
            &ctx,
            "account-latest-natural-end",
            DataSyncTrigger::Auto,
            None,
            None,
        )
        .await
        .expect("short latest usage sync");

        assert_eq!(merged, 2);
        assert_eq!(requests.lock().await.as_slice(), ["1"]);
        server.abort();
    }

    #[tokio::test]
    async fn auto_usage_sync_stops_at_an_empty_page_without_a_cached_tail() {
        let requests = Arc::new(Mutex::new(Vec::<String>::new()));
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let requests = Arc::clone(&requests);
                move |Query(query): Query<HashMap<String, String>>| {
                    let requests = Arc::clone(&requests);
                    async move {
                        let page = query.get("page").cloned().unwrap_or_default();
                        requests.lock().await.push(page.clone());
                        Json(json!({
                            "items": [],
                            "page": page.parse::<i64>().unwrap_or_default(),
                            "page_size": 100,
                            "total": 0,
                            "pages": 0
                        }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-latest-empty-page",
            "site-latest-empty-page",
            "空页账号",
        );

        let merged = sync_usage_scope(
            &ctx,
            "account-latest-empty-page",
            DataSyncTrigger::Auto,
            None,
            None,
        )
        .await
        .expect("empty latest usage sync");

        assert_eq!(merged, 0);
        assert_eq!(requests.lock().await.as_slice(), ["1"]);
        server.abort();
    }

    #[tokio::test]
    async fn auto_usage_sync_stops_at_a_confirmed_last_full_page_without_a_cached_tail() {
        let requests = Arc::new(Mutex::new(Vec::<String>::new()));
        let items = (0..100)
            .map(|index| usage_item(&format!("usage-last-page-{index:03}"), index))
            .collect::<Vec<_>>();
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let requests = Arc::clone(&requests);
                move |Query(query): Query<HashMap<String, String>>| {
                    let requests = Arc::clone(&requests);
                    let items = items.clone();
                    async move {
                        let page = query.get("page").cloned().unwrap_or_default();
                        requests.lock().await.push(page.clone());
                        Json(json!({
                            "items": items,
                            "page": page.parse::<i64>().unwrap_or_default(),
                            "page_size": 100,
                            "total": 100,
                            "pages": 1
                        }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-latest-last-page",
            "site-latest-last-page",
            "末页账号",
        );

        let merged = sync_usage_scope(
            &ctx,
            "account-latest-last-page",
            DataSyncTrigger::Auto,
            None,
            None,
        )
        .await
        .expect("last full page latest usage sync");

        assert_eq!(merged, 100);
        assert_eq!(requests.lock().await.as_slice(), ["1"]);
        server.abort();
    }

    #[tokio::test]
    async fn auto_usage_sync_stops_after_the_fifty_page_budget_without_a_cached_tail() {
        let requests = Arc::new(Mutex::new(Vec::<i64>::new()));
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let requests = Arc::clone(&requests);
                move |Query(query): Query<HashMap<String, String>>| {
                    let requests = Arc::clone(&requests);
                    async move {
                        let page = query
                            .get("page")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or_default();
                        requests.lock().await.push(page);
                        let items = (0..100)
                            .map(|index| {
                                usage_item(
                                    &format!("usage-budget-{page:02}-{index:03}"),
                                    (page - 1) * 100 + index,
                                )
                            })
                            .collect::<Vec<_>>();
                        Json(json!({
                            "items": items,
                            "page": page,
                            "page_size": 100,
                            "total": 5_100,
                            "pages": 51
                        }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-latest-page-budget",
            "site-latest-page-budget",
            "分页预算账号",
        );

        let merged = sync_usage_scope(
            &ctx,
            "account-latest-page-budget",
            DataSyncTrigger::Auto,
            None,
            None,
        )
        .await
        .expect("page budget latest usage sync");

        let requests = requests.lock().await;
        assert_eq!(merged, 5_000);
        assert_eq!(requests.len(), 50);
        assert_eq!(requests.first(), Some(&1));
        assert_eq!(requests.last(), Some(&50));
        server.abort();
    }

    #[tokio::test]
    async fn auto_usage_sync_propagates_cache_presence_failures_without_merging_rows() {
        let item = usage_item("usage-cache-presence-error", 0);
        let app = Router::new().route(
            "/api/v1/usage",
            get(move || {
                let item = item.clone();
                async move {
                    Json(json!({
                        "items": [item],
                        "page": 1,
                        "page_size": 100,
                        "total": 1,
                        "pages": 1
                    }))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-latest-cache-error",
            "site-latest-cache-error",
            "缓存查询失败账号",
        );
        let reader =
            upstream_service::prepare_usage_read_client(&ctx, "account-latest-cache-error")
                .await
                .expect("prepare usage reader");
        let broken_db_path = ctx.paths.root.join("cache-presence-as-directory");
        std::fs::create_dir_all(&broken_db_path).expect("create invalid database path");
        let mut broken_ctx = ctx.clone();
        broken_ctx.db = Database::new(broken_db_path);
        let usage_writes = super::UsageWriteTracker::default();

        let result = super::sync_latest_usage_incremental_attempt(
            &broken_ctx,
            "account-latest-cache-error",
            &reader,
            None,
            1,
            &usage_writes,
        )
        .await;
        assert!(result.is_err(), "cache presence failure must be returned");

        assert!(repositories::list_usage_row_cache(
            &ctx.db,
            "account-latest-cache-error",
            None,
            None,
            None,
        )
        .expect("read original cache")
        .is_empty());
        server.abort();
    }

    #[tokio::test]
    async fn history_quantum_yield_stops_admission_and_drains_started_readers() {
        let page_two_started = Arc::new(Notify::new());
        let allow_page_two = Arc::new(AtomicBool::new(false));
        let allow_page_two_notify = Arc::new(Notify::new());
        let release_blocked_pages = Arc::new(AtomicBool::new(false));
        let release_blocked_pages_notify = Arc::new(Notify::new());
        let highest_requested_page = Arc::new(AtomicUsize::new(0));
        let day = shanghai_today()
            .checked_sub_days(Days::new(2))
            .expect("closed history day");
        let day_for_mock = day.to_string();
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let page_two_started = Arc::clone(&page_two_started);
                let allow_page_two = Arc::clone(&allow_page_two);
                let allow_page_two_notify = Arc::clone(&allow_page_two_notify);
                let release_blocked_pages = Arc::clone(&release_blocked_pages);
                let release_blocked_pages_notify = Arc::clone(&release_blocked_pages_notify);
                let highest_requested_page = Arc::clone(&highest_requested_page);
                move |Query(query): Query<HashMap<String, String>>| {
                    let page_two_started = Arc::clone(&page_two_started);
                    let allow_page_two = Arc::clone(&allow_page_two);
                    let allow_page_two_notify = Arc::clone(&allow_page_two_notify);
                    let release_blocked_pages = Arc::clone(&release_blocked_pages);
                    let release_blocked_pages_notify = Arc::clone(&release_blocked_pages_notify);
                    let highest_requested_page = Arc::clone(&highest_requested_page);
                    let day = day_for_mock.clone();
                    async move {
                        let page = query
                            .get("page")
                            .and_then(|value| value.parse::<usize>().ok())
                            .unwrap_or(1);
                        highest_requested_page.fetch_max(page, Ordering::SeqCst);
                        if page == 2 {
                            page_two_started.notify_one();
                            while !allow_page_two.load(Ordering::SeqCst) {
                                allow_page_two_notify.notified().await;
                            }
                        } else if page >= 3 {
                            while !release_blocked_pages.load(Ordering::SeqCst) {
                                release_blocked_pages_notify.notified().await;
                            }
                            return Json(json!({
                                "items": [],
                                "page": page,
                                "page_size": 1_000,
                                "total": 20_000,
                                "pages": 20
                            }));
                        }
                        let items = (0..1_000)
                            .map(|index| {
                                json!({
                                    "id": format!("history-quantum-{page:02}-{index:04}"),
                                    "created_at": format!("{day}T08:00:00+08:00"),
                                    "model": "gpt-5.4",
                                    "actual_cost": 0.1,
                                    "total_cost": 0.1,
                                    "input_tokens": 10,
                                    "output_tokens": 5,
                                    "total_tokens": 15
                                })
                            })
                            .collect::<Vec<_>>();
                        Json(json!({
                            "items": items,
                            "page": page,
                            "page_size": 1_000,
                            "total": 20_000,
                            "pages": 20
                        }))
                    }
                }
            }),
        );
        let server = TestAxumServer::start(move |_| app).await;
        let ctx = build_test_context();
        let account_id = "account-history-quantum";
        seed_account(
            &ctx,
            server.base_url(),
            account_id,
            "site-history-quantum",
            "历史让行账号",
        );
        let (account, site) = account_service::load_account_site(&ctx, account_id)
            .expect("load history account identity");
        let history_decision = ctx
            .runtime_coordination
            .try_acquire_due_work_lease(
                &site.base_url,
                &account.email,
                crate::application::runtime_coordination_service::BackgroundSyncDueWork {
                    history_maintenance: true,
                    ..Default::default()
                },
            )
            .await
            .expect("acquire history lease");
        let history_grant = match history_decision {
            crate::infrastructure::runtime_coordination::CoordinationDecision::Acquired(grant) => {
                grant
            }
            crate::infrastructure::runtime_coordination::CoordinationDecision::Waiting {
                ..
            } => {
                panic!("first runtime must acquire history lease")
            }
        };
        let peer =
            crate::application::runtime_coordination_service::RuntimeCoordinationService::from_paths_for_test(
                &ctx.paths,
            )
            .expect("initialize peer runtime");
        let mut reader = upstream_service::prepare_usage_read_client(&ctx, account_id)
            .await
            .expect("prepare history reader");
        let history_ctx = ctx.clone();
        let history_account_id = account_id.to_string();
        let usage_writes = super::UsageWriteTracker::default();
        let mut history_task = tokio::spawn(async move {
            let quantum = super::HistoryQuantum::with_max_duration(
                &history_grant.lease,
                Duration::from_secs(60),
            );
            let outcome = super::sync_usage_date_window(
                &history_ctx,
                &history_account_id,
                &mut reader,
                day,
                super::UsageHistoryCheckpointPolicy::Track,
                None,
                AccountSyncProgressPhase::HistoryWindow,
                Some(&quantum),
                &usage_writes,
            )
            .await;
            drop(quantum);
            (outcome, history_grant.lease)
        });

        tokio::time::timeout(Duration::from_secs(30), page_two_started.notified())
            .await
            .expect("page two must start");
        let peer_decision = peer
            .try_acquire_due_work_lease(
                &site.base_url,
                &account.email,
                crate::application::runtime_coordination_service::BackgroundSyncDueWork {
                    fresh_usage: true,
                    ..Default::default()
                },
            )
            .await
            .expect("enqueue peer fresh demand");
        assert!(matches!(
            peer_decision,
            crate::infrastructure::runtime_coordination::CoordinationDecision::Waiting { .. }
        ));
        allow_page_two.store(true, Ordering::SeqCst);
        allow_page_two_notify.notify_waiters();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !history_task.is_finished(),
            "yield must drain already-started readers before returning"
        );
        assert!(highest_requested_page.load(Ordering::SeqCst) <= 17);

        release_blocked_pages.store(true, Ordering::SeqCst);
        release_blocked_pages_notify.notify_waiters();
        let (outcome, lease) = tokio::time::timeout(Duration::from_secs(30), &mut history_task)
            .await
            .expect("history quantum must finish after reader drain")
            .expect("history task must not panic");
        match outcome.expect("history window outcome") {
            super::UsageWindowOutcome::Yielded { merged_count } => {
                assert_eq!(merged_count, 2_000);
            }
            super::UsageWindowOutcome::Completed(_) => panic!("peer Fresh demand must force yield"),
        }
        assert!(lease.release().await.expect("release history lease"));
        assert!(highest_requested_page.load(Ordering::SeqCst) <= 17);
        let checkpoint = repositories::load_usage_history_state(&ctx.db, account_id)
            .expect("load history checkpoint")
            .expect("history checkpoint exists");
        assert_eq!(
            checkpoint.active_date.as_deref(),
            Some(day.to_string().as_str())
        );
        assert!(checkpoint.completed_through_date.is_none());
        server.shutdown().await;
    }

    #[tokio::test]
    async fn usage_window_caps_page_concurrency_and_recovers_workers_from_401_once() {
        const TOTAL_ROWS: i64 = 17_000;
        let active_requests = Arc::new(AtomicUsize::new(0));
        let peak_requests = Arc::new(AtomicUsize::new(0));
        let refresh_hits = Arc::new(AtomicUsize::new(0));
        let closed_day = super::shanghai_today()
            .checked_sub_days(Days::new(2))
            .expect("closed history day")
            .to_string();
        let app = {
            let active_requests = Arc::clone(&active_requests);
            let peak_requests = Arc::clone(&peak_requests);
            let refresh_hits = Arc::clone(&refresh_hits);
            let closed_day = closed_day.clone();
            Router::new()
                .route(
                    "/api/v1/usage",
                    get(move |headers: axum::http::HeaderMap, Query(query): Query<HashMap<String, String>>| {
                        let active_requests = Arc::clone(&active_requests);
                        let peak_requests = Arc::clone(&peak_requests);
                        let closed_day = closed_day.clone();
                        async move {
                            let page = query
                                .get("page")
                                .and_then(|value| value.parse::<i64>().ok())
                                .unwrap_or(1);
                            let page_size = query
                                .get("page_size")
                                .and_then(|value| value.parse::<i64>().ok())
                                .unwrap_or(1_000);
                            let current = active_requests.fetch_add(1, Ordering::SeqCst) + 1;
                            loop {
                                let observed = peak_requests.load(Ordering::SeqCst);
                                if current <= observed
                                    || peak_requests
                                        .compare_exchange(
                                            observed,
                                            current,
                                            Ordering::SeqCst,
                                            Ordering::SeqCst,
                                        )
                                        .is_ok()
                                {
                                    break;
                                }
                            }
                            tokio::time::sleep(Duration::from_millis(25)).await;
                            active_requests.fetch_sub(1, Ordering::SeqCst);

                            let authorization = headers
                                .get("authorization")
                                .and_then(|value| value.to_str().ok())
                                .unwrap_or_default();
                            if authorization == "Bearer old-token"
                                && query.contains_key("start_date")
                                && page > 1
                                && page_size == 1_000
                            {
                                return StatusCode::UNAUTHORIZED.into_response();
                            }

                            let total = TOTAL_ROWS;
                            let pages = (total + page_size - 1) / page_size;
                            let offset = (page - 1) * page_size;
                            let count = (total - offset).clamp(0, page_size);
                            let date = query
                                .get("start_date")
                                .cloned()
                                .unwrap_or_else(|| closed_day.clone());
                            let items = (0..count)
                                .map(|index| {
                                    let row_index = offset + index;
                                    json!({
                                        "id": format!("usage-page-{row_index:05}"),
                                        "created_at": format!("{date}T08:00:00+08:00"),
                                        "model": "gpt-5.4",
                                        "actual_cost": 0.5,
                                        "total_cost": 0.5,
                                        "input_tokens": 10,
                                        "output_tokens": 5,
                                        "total_tokens": 15
                                    })
                                })
                                .collect::<Vec<_>>();
                            Json(json!({
                                "items": items,
                                "page": page,
                                "page_size": page_size,
                                "total": total,
                                "pages": pages
                            }))
                            .into_response()
                        }
                    }),
                )
                .route(
                    "/api/v1/user/profile",
                    get(|headers: axum::http::HeaderMap| async move {
                        let authorization = headers
                            .get("authorization")
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or_default();
                        if authorization == "Bearer old-token" {
                            StatusCode::UNAUTHORIZED.into_response()
                        } else {
                            Json(json!({ "id": "user-1" })).into_response()
                        }
                    }),
                )
                .route(
                    "/api/v1/auth/refresh",
                    post(move || {
                        let refresh_hits = Arc::clone(&refresh_hits);
                        async move {
                            refresh_hits.fetch_add(1, Ordering::SeqCst);
                            Json(json!({
                                "code": 0,
                                "data": {
                                    "access_token": "fresh-token",
                                    "refresh_token": "refresh-token"
                                }
                            }))
                        }
                    }),
                )
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve upstream mock");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-window-concurrency",
            "site-window-concurrency",
            "并发回填账号",
        );
        repositories::save_session(
            &ctx.db,
            "account-window-concurrency",
            &StoredSession {
                saved_at: "2026-07-20T00:00:00Z".into(),
                access_token: Some("old-token".into()),
                refresh_token: Some("refresh-token".into()),
                token_type: Some("bearer".into()),
                cookie_jar_json: None,
            },
        )
        .expect("replace session with expiring token");

        let run = crate::contracts::TaskRunRecord {
            id: "run-window-progress".into(),
            account_id: "account-window-concurrency".into(),
            scope: DataSyncScope::Usage,
            primary_trigger_source: DataSyncTrigger::Manual,
            status: TaskRunStatus::Running,
            join_count: 0,
            started_at: "2026-07-26T00:00:00Z".into(),
            finished_at: None,
            error_message: None,
        };
        let handle = Arc::new(SyncTaskHandle {
            state: Mutex::new(super::super::context::SyncTaskState {
                run,
                progress: Some(initial_sync_progress(&DataSyncScope::Usage)),
                completed: false,
                result: None,
            }),
            notify: tokio::sync::Notify::new(),
        });
        let reporter = SyncProgressReporter::new(Arc::clone(&handle));
        let mut reader =
            upstream_service::prepare_usage_read_client(&ctx, "account-window-concurrency")
                .await
                .expect("prepare usage reader");
        let date = NaiveDate::parse_from_str(&closed_day, "%Y-%m-%d").expect("closed day");
        let usage_writes = super::UsageWriteTracker::default();

        super::sync_usage_date_window(
            &ctx,
            "account-window-concurrency",
            &mut reader,
            date,
            super::UsageHistoryCheckpointPolicy::Preserve,
            Some(&reporter),
            AccountSyncProgressPhase::HistoryWindow,
            None,
            &usage_writes,
        )
        .await
        .expect("history window sync");

        assert!(peak_requests.load(Ordering::SeqCst) <= 16);
        assert_eq!(refresh_hits.load(Ordering::SeqCst), 1);
        let progress_state = handle.state.lock().await;
        let detail = progress_state
            .progress
            .as_ref()
            .and_then(|progress| progress.stages.first())
            .and_then(|stage| stage.detail.as_ref())
            .expect("window progress remains observable");
        assert_eq!(detail.processed, Some(TOTAL_ROWS));
        assert_eq!(detail.total, Some(TOTAL_ROWS));
        assert_eq!(detail.unit, Some(AccountSyncProgressUnit::Records));
        assert_eq!(detail.attempt, Some(2));
        drop(progress_state);
        assert_eq!(
            repositories::list_usage_row_cache(
                &ctx.db,
                "account-window-concurrency",
                None,
                None,
                None,
            )
            .expect("read usage cache")
            .len(),
            TOTAL_ROWS as usize
        );
        let session = repositories::load_session(&ctx.db, "account-window-concurrency")
            .expect("load recovered session")
            .expect("session exists");
        assert_eq!(session.access_token.as_deref(), Some("fresh-token"));
        server.abort();
    }

    #[tokio::test]
    async fn usage_page_slots_are_shared_across_two_accounts() {
        const TOTAL_ROWS: i64 = 17_000;
        let active_requests = Arc::new(AtomicUsize::new(0));
        let peak_requests = Arc::new(AtomicUsize::new(0));
        let closed_day = super::shanghai_today()
            .checked_sub_days(Days::new(2))
            .expect("closed history day")
            .to_string();
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let active_requests = Arc::clone(&active_requests);
                let peak_requests = Arc::clone(&peak_requests);
                let closed_day = closed_day.clone();
                move |Query(query): Query<HashMap<String, String>>| {
                    let active_requests = Arc::clone(&active_requests);
                    let peak_requests = Arc::clone(&peak_requests);
                    let closed_day = closed_day.clone();
                    async move {
                        let page = query
                            .get("page")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1);
                        let page_size = query
                            .get("page_size")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1_000);
                        let current = active_requests.fetch_add(1, Ordering::SeqCst) + 1;
                        loop {
                            let observed = peak_requests.load(Ordering::SeqCst);
                            if current <= observed
                                || peak_requests
                                    .compare_exchange(
                                        observed,
                                        current,
                                        Ordering::SeqCst,
                                        Ordering::SeqCst,
                                    )
                                    .is_ok()
                            {
                                break;
                            }
                        }
                        tokio::time::sleep(Duration::from_millis(15)).await;
                        active_requests.fetch_sub(1, Ordering::SeqCst);

                        let total = TOTAL_ROWS;
                        let pages = (total + page_size - 1) / page_size;
                        let offset = (page - 1) * page_size;
                        let count = (total - offset).clamp(0, page_size);
                        let date = query
                            .get("start_date")
                            .cloned()
                            .unwrap_or_else(|| closed_day.clone());
                        let items = (0..count)
                            .map(|index| {
                                let row_index = offset + index;
                                json!({
                                    "id": format!("usage-shared-{row_index:05}"),
                                    "created_at": format!("{date}T08:00:00+08:00"),
                                    "model": "gpt-5.4",
                                    "actual_cost": 0.5,
                                    "total_cost": 0.5,
                                    "input_tokens": 10,
                                    "output_tokens": 5,
                                    "total_tokens": 15
                                })
                            })
                            .collect::<Vec<_>>();
                        Json(json!({
                            "items": items,
                            "page": page,
                            "page_size": page_size,
                            "total": total,
                            "pages": pages
                        }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve upstream mock");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-window-a",
            "site-window-a",
            "账号 A",
        );
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-window-b",
            "site-window-b",
            "账号 B",
        );

        let (first, second) = tokio::join!(
            sync_initial_usage_history_if_needed(&ctx, "account-window-a"),
            sync_initial_usage_history_if_needed(&ctx, "account-window-b"),
        );
        first.expect("first account history sync");
        second.expect("second account history sync");

        assert!(peak_requests.load(Ordering::SeqCst) <= 16);
        for account_id in ["account-window-a", "account-window-b"] {
            assert_eq!(
                repositories::list_usage_row_cache(&ctx.db, account_id, None, None, None)
                    .expect("read account usage cache")
                    .len(),
                TOTAL_ROWS as usize
            );
        }
        server.abort();
    }

    #[tokio::test]
    async fn usage_page_rate_limit_releases_local_slot_and_shared_permit_without_waiting() {
        let hits = Arc::new(AtomicUsize::new(0));
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let hits = Arc::clone(&hits);
                move || {
                    let hits = Arc::clone(&hits);
                    async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        (
                            StatusCode::TOO_MANY_REQUESTS,
                            [(axum::http::header::RETRY_AFTER, "2")],
                            "slow down",
                        )
                    }
                }
            }),
        );
        let server = TestAxumServer::start(move |_| app).await;
        let ctx = build_test_context();
        seed_account(
            &ctx,
            server.base_url(),
            "account-usage-retry-release",
            "site-usage-retry-release",
            "用量重试释放账号",
        );
        let reader =
            upstream_service::prepare_usage_read_client(&ctx, "account-usage-retry-release")
                .await
                .expect("prepare usage reader");

        let mut held_slots = Vec::new();
        for _ in 0..crate::application::resource_coordinator::MAX_USAGE_PAGE_SLOTS - 1 {
            held_slots.push(
                ctx.live_resources
                    .try_acquire_usage_page_slot()
                    .expect("probe usage page slot")
                    .expect("reserve usage page slot"),
            );
        }

        let retry_ctx = ctx.clone();
        let retry_task = tokio::spawn(async move {
            super::fetch_usage_page_with_retry(
                &retry_ctx,
                &reader,
                None,
                1,
                1_000,
                UsagePageOrder::Desc,
                None,
            )
            .await
        });

        tokio::time::timeout(Duration::from_secs(1), async {
            while hits.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("first usage request must reach the mock");

        let site_key = ctx
            .runtime_coordination
            .site_key(server.base_url())
            .expect("derive test site key");
        let coordination = rusqlite::Connection::open(&ctx.paths.coordination_db_path)
            .expect("open coordination database");
        let observed_slot = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let active_permits = coordination
                    .query_row(
                        "SELECT COUNT(*) FROM site_request_leases WHERE site_key = ?1",
                        rusqlite::params![site_key.as_slice()],
                        |row| row.get::<_, i64>(0),
                    )
                    .expect("count active site permits");
                if active_permits == 0 {
                    if let Some(slot) = ctx
                        .live_resources
                        .try_acquire_usage_page_slot()
                        .expect("probe released usage page slot")
                    {
                        break slot;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("retry wait must release its local slot and shared permit");

        assert_eq!(hits.load(Ordering::SeqCst), 1);
        let result = tokio::time::timeout(Duration::from_secs(1), retry_task)
            .await
            .expect("rate-limited usage request must finish without local waiting")
            .expect("join rate-limited usage request");
        let error = match result {
            Ok(_) => panic!("single-address 429 must return a structured failover error"),
            Err(error) => error,
        };
        let failure = error
            .downcast_ref::<crate::application::site_failover_service::SiteFailoverError>()
            .expect("structured site failover error");
        assert_eq!(
            failure.code,
            crate::application::site_failover_service::SiteFailoverErrorCode::AllAddressesRateLimited
        );
        assert!(failure.retry_after_ms.is_some_and(|delay| delay > 0));

        drop(observed_slot);
        drop(held_slots);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn initial_usage_history_sync_uses_date_checkpoint_instead_of_legacy_marker() {
        let requested_windows = Arc::new(Mutex::new(Vec::<Option<String>>::new()));
        let dashboard_hits = Arc::new(AtomicUsize::new(0));
        let closed_day = super::shanghai_today()
            .checked_sub_days(Days::new(2))
            .expect("closed history day")
            .to_string();
        let app = Router::new()
            .route(
                "/api/v1/usage",
                get({
                    let requested_windows = Arc::clone(&requested_windows);
                    let closed_day = closed_day.clone();
                    move |Query(query): Query<HashMap<String, String>>| {
                        let requested_windows = Arc::clone(&requested_windows);
                        let closed_day = closed_day.clone();
                        async move {
                            let requested_day = query.get("start_date").cloned();
                            requested_windows.lock().await.push(requested_day.clone());
                            let page = query
                                .get("page")
                                .and_then(|value| value.parse::<i64>().ok())
                                .unwrap_or(1);
                            let page_size = query
                                .get("page_size")
                                .and_then(|value| value.parse::<i64>().ok())
                                .unwrap_or(1_000);
                            let all_items = vec![
                                json!({
                                    "id": "usage-history-1",
                                    "created_at": format!("{closed_day}T08:00:00+08:00"),
                                    "model": "gpt-5.4",
                                    "actual_cost": 0.5,
                                    "total_cost": 0.5,
                                    "input_tokens": 10,
                                    "output_tokens": 5,
                                    "total_tokens": 15
                                }),
                                json!({
                                    "id": "usage-history-2",
                                    "created_at": format!("{closed_day}T09:00:00+08:00"),
                                    "model": "gpt-5.4",
                                    "actual_cost": 0.6,
                                    "total_cost": 0.6,
                                    "input_tokens": 12,
                                    "output_tokens": 6,
                                    "total_tokens": 18
                                }),
                                json!({
                                    "id": "usage-history-3",
                                    "created_at": format!("{closed_day}T10:00:00+08:00"),
                                    "model": "gpt-5.4",
                                    "actual_cost": 0.7,
                                    "total_cost": 0.7,
                                    "input_tokens": 14,
                                    "output_tokens": 7,
                                    "total_tokens": 21
                                }),
                            ];
                            let (items, total, pages) = if requested_day.is_none() && page_size == 1
                            {
                                (vec![all_items[0].clone()], 3_i64, 3_i64)
                            } else if requested_day.is_none() {
                                (
                                    all_items.iter().rev().cloned().collect::<Vec<_>>(),
                                    3_i64,
                                    1_i64,
                                )
                            } else if requested_day.as_deref() == Some(closed_day.as_str()) {
                                (all_items, 3_i64, 1_i64)
                            } else {
                                (Vec::new(), 0_i64, 1_i64)
                            };
                            Json(json!({
                                "items": items,
                                "page": page,
                                "page_size": page_size,
                                "total": total,
                                "pages": pages
                            }))
                        }
                    }
                }),
            )
            .route(
                "/api/v1/usage/dashboard/stats",
                get({
                    let dashboard_hits = Arc::clone(&dashboard_hits);
                    move || {
                        let dashboard_hits = Arc::clone(&dashboard_hits);
                        async move {
                            dashboard_hits.fetch_add(1, Ordering::SeqCst);
                            Json(json!({ "today_requests": 1, "total_requests": 1 }))
                        }
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-initial-history",
            "site-initial-history",
            "首次账号",
        );
        usage_service::get_overview_dashboard_stats(&ctx, "account-initial-history", false)
            .await
            .expect("warm dashboard stats cache");
        assert_eq!(dashboard_hits.load(Ordering::SeqCst), 1);

        let first = sync_initial_usage_history_if_needed(&ctx, "account-initial-history")
            .await
            .expect("initial history sync");
        usage_service::get_overview_dashboard_stats(&ctx, "account-initial-history", false)
            .await
            .expect("history write invalidates dashboard stats");
        assert_eq!(dashboard_hits.load(Ordering::SeqCst), 2);
        let second = sync_initial_usage_history_if_needed(&ctx, "account-initial-history")
            .await
            .expect("repeat initial history sync");
        usage_service::get_overview_dashboard_stats(&ctx, "account-initial-history", false)
            .await
            .expect("unchanged history keeps dashboard stats cache");
        assert_eq!(dashboard_hits.load(Ordering::SeqCst), 2);
        sync_usage_scope(
            &ctx,
            "account-initial-history",
            DataSyncTrigger::Auto,
            None,
            None,
        )
        .await
        .expect("default sync must retain initial history");
        usage_service::get_overview_dashboard_stats(&ctx, "account-initial-history", false)
            .await
            .expect("unchanged latest usage keeps dashboard stats cache");
        assert_eq!(dashboard_hits.load(Ordering::SeqCst), 2);

        assert_eq!(first, 3);
        assert_eq!(second, 0);
        assert!(requested_windows
            .lock()
            .await
            .iter()
            .any(|window| window.as_deref() == Some(closed_day.as_str())));
        let rows = repositories::list_usage_row_cache(
            &ctx.db,
            "account-initial-history",
            None,
            None,
            None,
        )
        .expect("read cached history");
        assert_eq!(rows.len(), 3);
        let state = repositories::load_usage_history_state(&ctx.db, "account-initial-history")
            .expect("load history state")
            .expect("history state exists");
        assert_eq!(
            state.completed_through_date.as_deref(),
            Some(closed_day.as_str())
        );
        server.abort();
    }

    #[tokio::test]
    async fn initial_usage_history_sync_does_not_skip_accounts_with_existing_usage_cache() {
        let upstream_hits = Arc::new(AtomicUsize::new(0));
        let closed_day = super::shanghai_today()
            .checked_sub_days(Days::new(2))
            .expect("closed history day")
            .to_string();
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let upstream_hits = Arc::clone(&upstream_hits);
                let closed_day = closed_day.clone();
                move |Query(query): Query<HashMap<String, String>>| {
                    let upstream_hits = Arc::clone(&upstream_hits);
                    let closed_day = closed_day.clone();
                    async move {
                        upstream_hits.fetch_add(1, Ordering::SeqCst);
                        let page = query
                            .get("page")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1);
                        let page_size = query
                            .get("page_size")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1_000);
                        let item = json!({
                            "id": "upstream-history-row",
                            "created_at": format!("{closed_day}T08:00:00+08:00"),
                            "model": "gpt-5.4",
                            "actual_cost": 0.5,
                            "total_cost": 0.5,
                            "input_tokens": 10,
                            "output_tokens": 5,
                            "total_tokens": 15
                        });
                        Json(json!({
                            "items": [item],
                            "page": page,
                            "page_size": page_size,
                            "total": 1,
                            "pages": 1
                        }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve upstream mock");
        });
        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-existing-history",
            "site-existing-history",
            "已有用量账号",
        );
        let row = crate::infrastructure::sub2api::normalizers::normalize_usage_row(&json!({
            "id": "existing-usage",
            "created_at": format!("{closed_day}T07:00:00+08:00"),
            "model": "gpt-5.4",
            "actual_cost": 0.4,
            "total_cost": 0.4,
            "input_tokens": 8,
            "output_tokens": 4,
            "total_tokens": 12
        }));
        repositories::merge_usage_row_cache(
            &ctx.db,
            "account-existing-history",
            &[row],
            "2026-07-15T00:00:00+08:00",
        )
        .expect("seed existing usage cache");

        let synced = sync_initial_usage_history_if_needed(&ctx, "account-existing-history")
            .await
            .expect("existing cache must still reconcile upstream history");

        assert_eq!(synced, 1);
        assert_eq!(upstream_hits.load(Ordering::SeqCst), 4);
        assert_eq!(
            repositories::list_usage_row_cache(
                &ctx.db,
                "account-existing-history",
                None,
                None,
                None
            )
            .expect("read usage cache")
            .len(),
            2
        );
        server.abort();
    }

    #[tokio::test]
    async fn refresh_account_wrapper_returns_account_and_full_run() {
        let app = Router::new()
            .route(
                "/api/v1/user/profile",
                get(|| async {
                    Json(json!({
                        "email": "demo@example.com",
                        "balance": 18.0
                    }))
                }),
            )
            .route(
                "/api/v1/user/platform-quotas",
                get(|| async { Json(json!({ "platform_quotas": [] })) }),
            )
            .route(
                "/api/v1/subscriptions",
                get(|| async { Json(json!({ "items": [] })) }),
            )
            .route(
                "/api/v1/subscriptions/summary",
                get(|| async {
                    Json(json!({
                        "active_count": 0,
                        "total_used_usd": 0.0,
                        "subscriptions": []
                    }))
                }),
            )
            .route(
                "/api/v1/groups/available",
                get(|| async { Json(json!({ "items": [] })) }),
            )
            .route(
                "/api/v1/keys",
                get(|| async { Json(json!({ "items": [] })) }),
            )
            .route(
                "/api/v1/usage",
                get(|Query(query): Query<HashMap<String, String>>| async move {
                    let page = query
                        .get("page")
                        .and_then(|value| value.parse::<i64>().ok())
                        .unwrap_or(1);
                    let page_size = query
                        .get("page_size")
                        .and_then(|value| value.parse::<i64>().ok())
                        .unwrap_or(1_000);
                    Json(json!({
                        "items": [],
                        "page": page,
                        "page_size": page_size,
                        "total": 0,
                        "pages": 1
                    }))
                }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-4c",
            "site-4c",
            "刷新账号",
        );

        let result = refresh_account(&ctx, "account-4c", RefreshTriggerSource::Manual)
            .await
            .expect("refresh account wrapper");

        assert_eq!(result.account.account.id, "account-4c");
        assert_eq!(result.account.session_state, "ready");
        assert_eq!(result.run.scope, DataSyncScope::Full);
        assert_eq!(result.run.primary_trigger_source, DataSyncTrigger::Manual);
        assert_eq!(
            result.run.status,
            crate::contracts::TaskRunStatus::Succeeded
        );
    }

    #[tokio::test]
    async fn derives_sync_status_from_existing_usage_cache() {
        let ctx = build_test_context();
        seed_account(
            &ctx,
            "http://127.0.0.1:16661",
            "account-5",
            "site-5",
            "迁移账号",
        );

        let updated_at = "2026-06-11T00:21:00+08:00";
        repositories::merge_usage_row_cache(
            &ctx.db,
            "account-5",
            &[UsageRow {
                id: "usage-1".into(),
                upstream_user_id: None,
                api_key_id: None,
                upstream_account_id: None,
                request_id: None,
                created_at: "2026-06-06T00:16:00+08:00".into(),
                model: "gpt-4.1-mini".into(),
                reasoning_effort: None,
                endpoint: Some("/responses".into()),
                upstream_endpoint: None,
                group_id: None,
                subscription_id: None,
                actual_cost: 0.5,
                total_cost: 0.5,
                input_tokens: 200,
                output_tokens: 300,
                input_cost: None,
                output_cost: None,
                cache_creation_tokens: Some(0),
                cache_read_tokens: Some(0),
                cache_creation_5m_tokens: None,
                cache_creation_1h_tokens: None,
                cache_creation_cost: None,
                cache_read_cost: None,
                total_tokens: 500,
                first_token_ms: None,
                duration_ms: Some(2222),
                billing_mode: None,
                request_type: None,
                stream: None,
                openai_ws_mode: None,
                billing_type: None,
                service_tier: None,
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
                api_key_name: Some("mock-key".into()),
                platform: Some("openai".into()),
                subscription_name: Some("Mock Annual".into()),
                group_name: Some("Mock Group".into()),
                subscription_type: None,
            }],
            updated_at,
        )
        .expect("save usage cache");

        let status = get_account_sync_status(&ctx, "account-5")
            .await
            .expect("sync status");
        assert_eq!(status.statuses.len(), 1);
        assert_eq!(status.statuses[0].scope, DataSyncScope::Usage);
        assert_eq!(status.statuses[0].state, AccountSyncState::Succeeded);
        assert_eq!(status.statuses[0].item_count, 1);

        let today = super::shanghai_today();
        let today_text = today.to_string();
        let closed_history_end = today
            .checked_sub_days(Days::new(2))
            .expect("closed history date")
            .to_string();
        let checkpoint_at = format!("{today_text}T00:00:00+08:00");
        repositories::advance_usage_history_completed_through_date(
            &ctx.db,
            "account-5",
            Some(&closed_history_end),
            &closed_history_end,
            Some(&closed_history_end),
            &checkpoint_at,
        )
        .expect("advance clean history checkpoint");
        repositories::mark_startup_recent_four_day_usage_read_completed(
            &ctx.db,
            "account-5",
            &today_text,
            &checkpoint_at,
        )
        .expect("mark startup recent usage read complete");

        let clean_checkpoint_status = get_account_sync_status(&ctx, "account-5")
            .await
            .expect("clean checkpoint sync status");
        assert_eq!(clean_checkpoint_status.statuses.len(), 1);
        assert_eq!(
            clean_checkpoint_status.statuses[0].scope,
            DataSyncScope::Usage
        );
        assert_eq!(
            clean_checkpoint_status.statuses[0].state,
            AccountSyncState::Succeeded
        );
        assert!(clean_checkpoint_status.statuses[0].last_error.is_none());
    }

    #[test]
    fn repairs_missing_usage_cache_from_legacy_rows() {
        let ctx = build_test_context();
        seed_account(
            &ctx,
            "http://127.0.0.1:16661",
            "account-6",
            "site-6",
            "旧用量账号",
        );

        let conn = ctx.db.connect().expect("open sqlite");
        conn.execute(
            "CREATE TABLE usage_history (
                account_id TEXT NOT NULL,
                row_json TEXT NOT NULL,
                first_seen_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL
            )",
            [],
        )
        .expect("create legacy usage_history");
        conn.execute(
            "INSERT INTO usage_history (account_id, row_json, first_seen_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                "account-6",
                serde_json::to_string(&UsageRow {
                    id: "legacy-usage-1".into(),
                    upstream_user_id: None,
                    api_key_id: Some(1),
                    upstream_account_id: None,
                    request_id: None,
                    created_at: "2026-06-06T00:16:00+08:00".into(),
                    model: "gpt-4.1-mini".into(),
                    reasoning_effort: None,
                    endpoint: Some("/responses".into()),
                    upstream_endpoint: None,
                    group_id: None,
                    subscription_id: None,
                    actual_cost: 0.5,
                    total_cost: 0.5,
                    input_tokens: 200,
                    output_tokens: 300,
                    input_cost: None,
                    output_cost: None,
                    cache_creation_tokens: Some(0),
                    cache_read_tokens: Some(0),
                    cache_creation_5m_tokens: None,
                    cache_creation_1h_tokens: None,
                    cache_creation_cost: None,
                    cache_read_cost: None,
                    total_tokens: 500,
                    first_token_ms: None,
                    duration_ms: Some(2222),
                    billing_mode: None,
                    request_type: None,
                    stream: None,
                    openai_ws_mode: None,
                    billing_type: None,
                    service_tier: None,
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
                    api_key_name: Some("legacy-key".into()),
                    platform: Some("openai".into()),
                    subscription_name: Some("Legacy Plan".into()),
                    group_name: Some("Legacy Group".into()),
                    subscription_type: None,
                })
                .expect("serialize legacy usage row"),
                "2026-06-06T00:16:00+08:00",
                "2026-06-06T00:16:00+08:00"
            ],
        )
        .expect("insert legacy usage row");
        drop(conn);

        repair_usage_cache_from_legacy(&ctx).expect("repair usage cache");

        let usage_rows = repositories::list_usage_row_cache(&ctx.db, "account-6", None, None, None)
            .expect("read repaired usage cache");
        assert_eq!(usage_rows.len(), 1);
        assert_eq!(usage_rows[0].row.id, "legacy-usage-1");
        assert_eq!(usage_rows[0].row.total_tokens, 500);
    }

    fn build_test_context() -> AppContext {
        let root =
            std::env::temp_dir().join(format!("api-token-dc-tests-{}", uuid::Uuid::new_v4()));
        let paths = AppPaths::from_root(root);
        paths.ensure().expect("ensure app paths");
        let db = Database::new(paths.db_path.clone());
        let _ = db.connect().expect("init sqlite");
        AppContext {
            runtime_coordination: crate::application::runtime_coordination_service::RuntimeCoordinationService::from_paths_for_test(&paths)
                .expect("initialize test runtime coordination"),
            paths,
            db,
            sync_tasks: Arc::new(Mutex::new(HashMap::<String, Arc<SyncTaskHandle>>::new())),
            live_resources: crate::application::resource_coordinator::ResourceCoordinator::default(
            ),
            native_notifications_enabled: false,
        }
    }

    fn seed_account(
        ctx: &AppContext,
        base_url: &str,
        account_id: &str,
        site_id: &str,
        label: &str,
    ) {
        repositories::insert_site(
            &ctx.db,
            &SiteRecord {
                id: site_id.into(),
                name: "Test Site".into(),
                base_url: base_url.into(),
                created_at: "2026-06-28T00:00:00Z".into(),
                updated_at: "2026-06-28T00:00:00Z".into(),
                ..SiteRecord::default()
            },
        )
        .expect("insert site");
        repositories::insert_account(
            &ctx.db,
            &AccountRecord {
                id: account_id.into(),
                site_id: site_id.into(),
                label: label.into(),
                email: "demo@example.com".into(),
                balance_warning: -1.0,
                last_login_at: None,
                created_at: "2026-06-28T00:00:00Z".into(),
                updated_at: "2026-06-28T00:00:00Z".into(),
            },
        )
        .expect("insert account");
        repositories::save_session(
            &ctx.db,
            account_id,
            &StoredSession {
                saved_at: "2026-06-28T00:00:00Z".into(),
                access_token: Some("token".into()),
                refresh_token: None,
                token_type: Some("bearer".into()),
                cookie_jar_json: None,
            },
        )
        .expect("save session");
    }

    fn usage_item(id: &str, sequence: i64) -> serde_json::Value {
        let created_at = (chrono::DateTime::parse_from_rfc3339("2026-07-21T00:00:00+08:00")
            .expect("parse fixture timestamp")
            + chrono::Duration::seconds(10_000 - sequence))
        .to_rfc3339();
        json!({
            "id": id,
            "created_at": created_at,
            "model": "gpt-5.4",
            "actual_cost": 0.5,
            "total_cost": 0.5,
            "input_tokens": 10,
            "output_tokens": 5,
            "total_tokens": 15
        })
    }
}
