use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const DEFAULT_SITE_FAILOVER_COOLDOWN_SECONDS: u32 = 60;
pub const DEFAULT_SITE_MAX_ATTEMPTS_PER_ADDRESS: u32 = 1;

fn default_site_failover_cooldown_seconds() -> u32 {
    DEFAULT_SITE_FAILOVER_COOLDOWN_SECONDS
}

fn default_site_max_attempts_per_address() -> u32 {
    DEFAULT_SITE_MAX_ATTEMPTS_PER_ADDRESS
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteRecord {
    pub id: String,
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub fallback_base_urls: Vec<String>,
    #[serde(default = "default_site_failover_cooldown_seconds")]
    pub failover_cooldown_seconds: u32,
    #[serde(default = "default_site_max_attempts_per_address")]
    pub max_attempts_per_address: u32,
    pub created_at: String,
    pub updated_at: String,
}

impl Default for SiteRecord {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            base_url: String::new(),
            fallback_base_urls: Vec::new(),
            failover_cooldown_seconds: DEFAULT_SITE_FAILOVER_COOLDOWN_SECONDS,
            max_attempts_per_address: DEFAULT_SITE_MAX_ATTEMPTS_PER_ADDRESS,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PublicEndpointRecord {
    pub name: String,
    pub endpoint: String,
    pub description: String,
    pub ping_latency_ms: Option<i64>,
    pub ping_status_code: Option<u16>,
    pub ping_checked_at: Option<String>,
    pub ping_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SitePublicEndpointsPayload {
    pub site_id: String,
    pub site_name: String,
    pub api_base_url: String,
    pub endpoints: Vec<PublicEndpointRecord>,
    pub fetched_at: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupRecord {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub platform: String,
    pub rate_multiplier: f64,
    pub subscription_type: Option<String>,
    pub daily_limit_usd: Option<f64>,
    pub weekly_limit_usd: Option<f64>,
    pub monthly_limit_usd: Option<f64>,
    pub allow_messages_dispatch: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRecord {
    pub id: String,
    pub site_id: String,
    pub label: String,
    pub email: String,
    pub balance_warning: f64,
    pub last_login_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionQuotaWindow {
    pub current: f64,
    pub limit: f64,
    pub window_start: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionIdentityKind {
    Group,
    Upstream,
    Fallback,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionRecord {
    pub id: String,
    /// 账号内可持久化的订阅身份键，由后端统一生成。
    pub subscription_key: String,
    pub identity_kind: SubscriptionIdentityKind,
    /// 上游缺少稳定身份且当前快照存在冲突时，禁止写入独立配置。
    #[serde(default)]
    pub identity_ambiguous: bool,
    #[serde(skip)]
    pub(crate) upstream_subscription_id: Option<String>,
    #[serde(skip)]
    pub(crate) fallback_identity: String,
    pub group_id: Option<i64>,
    pub name: String,
    pub status: String,
    pub group_name: Option<String>,
    pub platform: Option<String>,
    pub expires_at: Option<String>,
    pub daily: Option<SubscriptionQuotaWindow>,
    pub weekly: Option<SubscriptionQuotaWindow>,
    pub monthly: Option<SubscriptionQuotaWindow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyRecord {
    pub id: String,
    pub group_id: Option<i64>,
    pub name: String,
    pub status: String,
    pub platform: Option<String>,
    pub group_name: Option<String>,
    pub expires_at: Option<String>,
    pub last_used_at: Option<String>,
    pub quota: Option<f64>,
    pub quota_used: Option<f64>,
    pub rate_limit5h: Option<f64>,
    pub rate_limit1d: Option<f64>,
    pub rate_limit7d: Option<f64>,
    pub usage5h: Option<f64>,
    pub usage1d: Option<f64>,
    pub usage7d: Option<f64>,
    pub current_concurrency: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedKeyRecord {
    #[serde(flatten)]
    pub key: KeyRecord,
    pub api_key_id: Option<i64>,
    pub raw_key: Option<String>,
    pub user_id: Option<i64>,
    pub ip_whitelist: Option<String>,
    pub ip_blacklist: Option<String>,
    pub window5h_start: Option<String>,
    pub window1d_start: Option<String>,
    pub window7d_start: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    pub id: String,
    pub upstream_user_id: Option<i64>,
    pub api_key_id: Option<i64>,
    pub upstream_account_id: Option<i64>,
    pub request_id: Option<String>,
    pub created_at: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub endpoint: Option<String>,
    pub upstream_endpoint: Option<String>,
    pub group_id: Option<i64>,
    pub subscription_id: Option<i64>,
    pub actual_cost: f64,
    pub total_cost: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub input_cost: Option<f64>,
    pub output_cost: Option<f64>,
    pub cache_creation_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub cache_creation_5m_tokens: Option<i64>,
    pub cache_creation_1h_tokens: Option<i64>,
    pub cache_creation_cost: Option<f64>,
    pub cache_read_cost: Option<f64>,
    pub total_tokens: i64,
    pub first_token_ms: Option<i64>,
    pub duration_ms: Option<i64>,
    pub billing_mode: Option<String>,
    pub request_type: Option<String>,
    pub stream: Option<bool>,
    pub openai_ws_mode: Option<bool>,
    pub billing_type: Option<i64>,
    pub service_tier: Option<String>,
    pub long_context_billing_applied: Option<bool>,
    pub image_count: Option<i64>,
    pub image_input_tokens: Option<i64>,
    pub image_size: Option<String>,
    pub image_input_size: Option<String>,
    pub image_output_size: Option<String>,
    pub image_output_tokens: Option<i64>,
    pub image_input_cost: Option<f64>,
    pub image_output_cost: Option<f64>,
    pub image_size_source: Option<String>,
    pub image_size_breakdown: Option<String>,
    pub media_type: Option<String>,
    pub rate_multiplier: Option<f64>,
    pub user_agent: Option<String>,
    pub ip_address: Option<String>,
    pub cache_ttl_overridden: Option<bool>,
    pub api_key_name: Option<String>,
    pub platform: Option<String>,
    pub subscription_name: Option<String>,
    pub group_name: Option<String>,
    pub subscription_type: Option<String>,
}

/// 文本筛选的匹配方式。值在 application 边界统一 trim/lowercase 后再签名。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum UsageTextMatchMode {
    #[default]
    Exact,
    Prefix,
}

/// Usage 文本筛选值，支持大小写不敏感的精确或前缀匹配。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTextFilter {
    pub value: String,
    #[serde(default)]
    pub mode: UsageTextMatchMode,
}

impl From<&str> for UsageTextFilter {
    fn from(value: &str) -> Self {
        Self {
            value: value.to_string(),
            mode: UsageTextMatchMode::Exact,
        }
    }
}

impl From<String> for UsageTextFilter {
    fn from(value: String) -> Self {
        Self {
            value,
            mode: UsageTextMatchMode::Exact,
        }
    }
}

/// Usage 整数范围。未填写的一侧不参与 SQL 条件。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageI64Range {
    pub min: Option<i64>,
    pub max: Option<i64>,
}

/// Usage 浮点范围。application 层会拒绝 NaN、无穷、负数和反向范围。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageF64Range {
    pub min: Option<f64>,
    pub max: Option<f64>,
}

/// Usage 明细、统计和 facet 共用的完整筛选契约。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct UsageFilter {
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub usage_id: Option<UsageTextFilter>,
    pub request_id: Option<UsageTextFilter>,
    pub api_key_id: Option<i64>,
    pub api_key_name: Option<UsageTextFilter>,
    pub upstream_user_id: Option<i64>,
    pub upstream_account_id: Option<i64>,
    pub model: Option<UsageTextFilter>,
    pub platform: Option<UsageTextFilter>,
    pub endpoint: Option<UsageTextFilter>,
    pub upstream_endpoint: Option<UsageTextFilter>,
    pub group_id: Option<i64>,
    pub group_name: Option<UsageTextFilter>,
    pub subscription_id: Option<i64>,
    pub subscription_name: Option<UsageTextFilter>,
    pub subscription_type: Option<UsageTextFilter>,
    pub service_tier: Option<UsageTextFilter>,
    pub reasoning_effort: Option<UsageTextFilter>,
    pub request_type: Option<UsageTextFilter>,
    pub billing_type: Option<i64>,
    pub billing_mode: Option<UsageTextFilter>,
    pub stream: Option<bool>,
    pub openai_ws_mode: Option<bool>,
    pub long_context_billing_applied: Option<bool>,
    pub cache_ttl_overridden: Option<bool>,
    pub input_tokens: UsageI64Range,
    pub output_tokens: UsageI64Range,
    pub total_tokens: UsageI64Range,
    pub cache_creation_tokens: UsageI64Range,
    pub cache_read_tokens: UsageI64Range,
    pub cache_creation_5m_tokens: UsageI64Range,
    pub cache_creation_1h_tokens: UsageI64Range,
    pub image_input_tokens: UsageI64Range,
    pub image_output_tokens: UsageI64Range,
    pub actual_cost: UsageF64Range,
    pub total_cost: UsageF64Range,
    pub input_cost: UsageF64Range,
    pub output_cost: UsageF64Range,
    pub cache_creation_cost: UsageF64Range,
    pub cache_read_cost: UsageF64Range,
    pub image_input_cost: UsageF64Range,
    pub image_output_cost: UsageF64Range,
    pub rate_multiplier: UsageF64Range,
    pub duration_ms: UsageI64Range,
    pub first_token_ms: UsageI64Range,
    pub image_count: UsageI64Range,
    pub media_type: Option<UsageTextFilter>,
    pub image_size: Option<UsageTextFilter>,
    pub image_input_size: Option<UsageTextFilter>,
    pub image_output_size: Option<UsageTextFilter>,
    pub image_size_source: Option<UsageTextFilter>,
    pub image_size_breakdown: Option<UsageTextFilter>,
    pub ip_address: Option<UsageTextFilter>,
    pub user_agent_query: Option<String>,
}

/// Usage 明细游标方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum UsageCursorDirection {
    #[default]
    Next,
    Previous,
}

fn default_usage_page_size() -> i64 {
    20
}

fn default_usage_facet_limit() -> i64 {
    50
}

/// Usage 明细的 keyset 请求，不包含页码或精确总数。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageListRequest {
    #[serde(default)]
    pub filter: UsageFilter,
    #[serde(default = "default_usage_page_size")]
    pub page_size: i64,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub direction: UsageCursorDirection,
}

impl Default for UsageListRequest {
    fn default() -> Self {
        Self {
            filter: UsageFilter::default(),
            page_size: default_usage_page_size(),
            cursor: None,
            direction: UsageCursorDirection::Next,
        }
    }
}

/// Usage 游标分页响应。`total` 仅在已有独立统计结果时填充。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCursorPage<T> {
    pub items: Vec<T>,
    pub page_size: i64,
    pub next_cursor: Option<String>,
    pub previous_cursor: Option<String>,
    pub has_next: bool,
    pub has_previous: bool,
    pub total: Option<i64>,
}

/// 可枚举的 Usage facet 字段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UsageFacetField {
    ApiKey,
    Model,
    Platform,
    Endpoint,
    UpstreamEndpoint,
    Group,
    Subscription,
    SubscriptionType,
    ServiceTier,
    ReasoningEffort,
    RequestType,
    BillingType,
    BillingMode,
    MediaType,
    ImageSize,
    ImageInputSize,
    ImageOutputSize,
    ImageSizeSource,
    ImageSizeBreakdown,
}

/// Usage facet 请求，候选来自完整账号/日期范围而非当前明细页。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageFacetRequest {
    #[serde(default)]
    pub filter: UsageFilter,
    pub field: UsageFacetField,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default = "default_usage_facet_limit")]
    pub limit: i64,
}

/// 单个 facet 候选及其匹配记录数。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageFacetItem {
    pub value: String,
    pub label: String,
    pub count: i64,
}

/// 有界 facet 响应。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageFacetPage {
    pub field: UsageFacetField,
    pub items: Vec<UsageFacetItem>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendPoint {
    pub bucket: String,
    pub actual_cost: f64,
    pub total_cost: f64,
    pub requests: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_read_tokens: i64,
    pub total_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformPoint {
    pub platform: String,
    pub total_actual_cost: f64,
    pub today_actual_cost: f64,
    pub total_requests: i64,
    pub total_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewModelPoint {
    pub model: String,
    pub requests: i64,
    pub total_tokens: i64,
    pub actual_cost: f64,
    pub total_cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountCacheStats {
    pub total_api_keys: i64,
    pub active_api_keys: i64,
    pub today_requests: i64,
    pub total_requests: i64,
    pub today_actual_cost: f64,
    pub total_actual_cost: f64,
    pub today_cost: f64,
    pub total_cost: f64,
    pub today_tokens: i64,
    pub total_tokens: i64,
    pub today_input_tokens: i64,
    pub today_output_tokens: i64,
    pub average_duration_ms: f64,
    pub by_platform: Vec<PlatformPoint>,
    #[serde(default)]
    pub by_model: Vec<OverviewModelPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub total_requests: i64,
    pub total_tokens: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_actual_cost: f64,
    pub total_cost: f64,
    pub average_duration_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountAlert {
    pub id: String,
    pub severity: String,
    pub title: String,
    pub detail: String,
    pub site_id: String,
    pub account_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountCacheView {
    pub fetched_at: String,
    pub online: bool,
    pub site_name: String,
    pub balance: f64,
    pub stats: AccountCacheStats,
    pub recent_usage: Vec<UsageRow>,
    pub trend: Vec<TrendPoint>,
    pub keys: Vec<KeyRecord>,
    pub subscriptions: Vec<SubscriptionRecord>,
    pub active_subscription: Option<SubscriptionRecord>,
    pub alerts: Vec<AccountAlert>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRuntime {
    #[serde(flatten)]
    pub account: AccountRecord,
    pub site: Option<SiteRecord>,
    pub cache_view: Option<AccountCacheView>,
    pub session_state: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RefreshTriggerSource {
    #[default]
    Manual,
    StaleAuto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshAccountTaskResponse {
    pub account: AccountRuntime,
    pub run: TaskRunRecord,
    pub status: AccountSyncStatusPayload,
    pub changed_usage_rows: Vec<UsageRow>,
    #[serde(skip)]
    pub(crate) notification_owner: bool,
    #[serde(skip)]
    pub(crate) usage_notification_eligible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum DataSyncTrigger {
    #[default]
    Manual,
    StaleAuto,
    PostWrite,
    Bootstrap,
    Auto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default, Hash)]
#[serde(rename_all = "snake_case")]
pub enum DataSyncScope {
    #[default]
    Core,
    Subscriptions,
    Keys,
    Usage,
    Full,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountSyncState {
    Idle,
    Running,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountSyncProgressStageId {
    Core,
    Subscriptions,
    Keys,
    Usage,
    SubscriptionRules,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountSyncProgressStageState {
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountSyncProgressPhase {
    HistoryDiscovery,
    HistoryWindow,
    RecentWindow,
    LatestIncremental,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountSyncProgressUnit {
    Records,
    Pages,
    Days,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountSyncWaitKind {
    RateLimited,
    RequestBudget,
    PeerRuntime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountSyncProgressWait {
    pub kind: AccountSyncWaitKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_attempt: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountSyncProgressDetail {
    pub phase: Option<AccountSyncProgressPhase>,
    pub processed: Option<i64>,
    pub total: Option<i64>,
    pub unit: Option<AccountSyncProgressUnit>,
    pub current_date: Option<String>,
    pub attempt: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait: Option<AccountSyncProgressWait>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountSyncProgressStage {
    pub id: AccountSyncProgressStageId,
    pub state: AccountSyncProgressStageState,
    pub detail: Option<AccountSyncProgressDetail>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountSyncProgress {
    pub stages: Vec<AccountSyncProgressStage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskRunStatus {
    Running,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncFailureCategory {
    Unauthorized,
    RateLimited,
    Http,
    Timeout,
    Transport,
    Decode,
    Business,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncFailurePayload {
    pub category: SyncFailureCategory,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    pub retry_exhausted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncFailureResponse {
    pub error: String,
    pub failure: SyncFailurePayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunRecord {
    pub id: String,
    pub account_id: String,
    pub scope: DataSyncScope,
    pub primary_trigger_source: DataSyncTrigger,
    pub status: TaskRunStatus,
    pub join_count: i64,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSyncStatusRecord {
    pub account_id: String,
    pub scope: DataSyncScope,
    pub state: AccountSyncState,
    pub last_attempt_at: Option<String>,
    pub last_success_at: Option<String>,
    pub last_error: Option<String>,
    pub item_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<SyncFailurePayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovered_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<AccountSyncProgress>,
}

fn default_scheduler_subscription_interval_seconds() -> u64 {
    30
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerConfigPayload {
    pub enabled: bool,
    pub interval_seconds: u64,
    #[serde(default = "default_scheduler_subscription_interval_seconds")]
    pub subscription_interval_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCoordinationConfigPayload {
    pub site_requests_per_second: u32,
    pub site_max_in_flight: u32,
    pub usage_page_max_in_flight: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamNetworkConfigPayload {
    pub use_system_proxy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountSyncStatusPayload {
    pub account_id: String,
    pub statuses: Vec<AccountSyncStatusRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncAccountDataInput {
    pub scope: DataSyncScope,
    pub trigger_source: DataSyncTrigger,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewUsageRow {
    #[serde(flatten)]
    pub row: UsageRow,
    pub account_id: String,
    pub account_label: String,
    pub site_id: String,
    pub site_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewSubscriptionRecord {
    #[serde(flatten)]
    pub subscription: SubscriptionRecord,
    pub account_id: String,
    pub account_label: String,
    pub site_id: String,
    pub site_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewKeyRecord {
    #[serde(flatten)]
    pub key: KeyRecord,
    pub account_id: String,
    pub account_label: String,
    pub site_id: String,
    pub site_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewTotals {
    pub balance: f64,
    pub total_sites: i64,
    pub total_accounts: i64,
    pub total_api_keys: i64,
    pub active_api_keys: i64,
    pub today_requests: i64,
    pub total_requests: i64,
    pub today_actual_cost: f64,
    pub total_actual_cost: f64,
    pub today_tokens: i64,
    pub total_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewPayload {
    pub sites: Vec<SiteRecord>,
    pub accounts: Vec<AccountRuntime>,
    pub totals: OverviewTotals,
    pub alerts: Vec<AccountAlert>,
    pub platform_series: Vec<PlatformPoint>,
    #[serde(default)]
    pub model_series: Vec<OverviewModelPoint>,
    pub trend: Vec<TrendPoint>,
    pub recent_usage: Vec<OverviewUsageRow>,
    pub subscriptions: Vec<OverviewSubscriptionRecord>,
    pub keys: Vec<OverviewKeyRecord>,
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginatedResult<T> {
    pub items: Vec<T>,
    pub page: i64,
    pub page_size: i64,
    pub total: i64,
    pub pages: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatsRecord {
    pub total_requests: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cache_tokens: Option<i64>,
    pub total_cache_creation_tokens: Option<i64>,
    pub total_cache_read_tokens: Option<i64>,
    pub total_tokens: i64,
    pub total_cost: f64,
    pub total_actual_cost: f64,
    pub average_duration_ms: f64,
    pub rpm: Option<f64>,
    pub tpm: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageExtremesPayload {
    pub longest_first_token: Option<UsageRow>,
    pub highest_actual_cost: Option<UsageRow>,
    pub highest_input_tokens: Option<UsageRow>,
    pub highest_output_tokens: Option<UsageRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewDashboardStatsPayload {
    pub today_stats: UsageStatsRecord,
    pub total_stats: UsageStatsRecord,
    pub total_api_keys: i64,
    pub active_api_keys: i64,
    pub platform_series: Vec<PlatformPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyUsagePoint {
    pub date: String,
    pub requests: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: Option<i64>,
    pub cache_write_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub actual_cost: Option<f64>,
    pub total_cost: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsagePoint {
    pub model: String,
    pub requests: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub total_tokens: i64,
    pub cost: Option<f64>,
    pub actual_cost: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyUsageTokenStats {
    pub requests: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub total_tokens: i64,
    pub cost: Option<f64>,
    pub actual_cost: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyUsageSubscriptionSnapshot {
    pub daily_limit_usd: Option<f64>,
    pub daily_usage_usd: Option<f64>,
    pub weekly_limit_usd: Option<f64>,
    pub weekly_usage_usd: Option<f64>,
    pub monthly_limit_usd: Option<f64>,
    pub monthly_usage_usd: Option<f64>,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyUsageSummaryPayload {
    pub daily_usage: Vec<DailyUsagePoint>,
    pub today: KeyUsageTokenStats,
    pub total: KeyUsageTokenStats,
    pub average_duration_ms: Option<f64>,
    pub rpm: Option<f64>,
    pub tpm: Option<f64>,
    pub plan_name: Option<String>,
    pub remaining: Option<f64>,
    pub subscription: Option<KeyUsageSubscriptionSnapshot>,
    pub model_stats: Vec<ModelUsagePoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTrendPayload {
    pub start_date: String,
    pub end_date: String,
    pub granularity: Option<String>,
    pub trend: Vec<DailyUsagePoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardModelsPayload {
    pub start_date: String,
    pub end_date: String,
    pub models: Vec<ModelUsagePoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageInsightPoint {
    pub name: String,
    pub requests: i64,
    pub total_tokens: i64,
    pub actual_cost: f64,
    pub total_cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageInsightsPayload {
    pub start_date: String,
    pub end_date: String,
    pub total_requests: i64,
    pub groups: Vec<UsageInsightPoint>,
    pub endpoints: Vec<UsageInsightPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAnalyticsAggregatePoint {
    pub key: String,
    pub label: String,
    pub is_other: bool,
    pub requests: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_read_tokens: i64,
    pub total_tokens: i64,
    pub total_cost: f64,
    pub actual_cost: f64,
    pub average_first_token_ms: f64,
    pub average_duration_ms: f64,
    pub average_rate_multiplier: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAnalyticsHeatmapPoint {
    pub weekday: i64,
    pub hour: i64,
    pub requests: i64,
    pub actual_cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAnalyticsFlowPoint {
    pub key: String,
    pub label: String,
    pub is_other: bool,
    pub source: String,
    pub target: String,
    pub requests: i64,
    pub actual_cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAnalyticsCostPoint {
    pub key: String,
    pub label: String,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAnalyticsPercentilePoint {
    pub p50: f64,
    pub p90: f64,
    pub p99: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAnalyticsLatencyPercentiles {
    pub first_token: Option<UsageAnalyticsPercentilePoint>,
    pub duration: Option<UsageAnalyticsPercentilePoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAnalyticsPayload {
    pub version: i64,
    pub start_date: String,
    pub end_date: String,
    pub generated_at: String,
    pub matched_rows: i64,
    pub top_n: i64,
    pub totals: UsageStatsRecord,
    pub trend: Vec<DailyUsagePoint>,
    pub models: Vec<UsageAnalyticsAggregatePoint>,
    pub platforms: Vec<UsageAnalyticsAggregatePoint>,
    pub endpoints: Vec<UsageAnalyticsAggregatePoint>,
    pub api_keys: Vec<UsageAnalyticsAggregatePoint>,
    pub groups: Vec<UsageAnalyticsAggregatePoint>,
    pub subscriptions: Vec<UsageAnalyticsAggregatePoint>,
    pub reasoning_efforts: Vec<UsageAnalyticsAggregatePoint>,
    pub request_types: Vec<UsageAnalyticsAggregatePoint>,
    pub reasoning_request_combinations: Vec<UsageAnalyticsAggregatePoint>,
    pub user_agents: Vec<UsageAnalyticsAggregatePoint>,
    pub hourly_heatmap: Vec<UsageAnalyticsHeatmapPoint>,
    pub endpoint_flows: Vec<UsageAnalyticsFlowPoint>,
    pub cost_breakdown: Vec<UsageAnalyticsCostPoint>,
    pub latency_percentiles: UsageAnalyticsLatencyPercentiles,
    pub extremes: Vec<UsageRow>,
    pub sample_rows: Vec<UsageRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyUsageStatsRecord {
    pub requests: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub actual_cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionKeyUsageItem {
    pub key_id: String,
    pub api_key_id: Option<i64>,
    pub raw_key_available: bool,
    pub key_name: String,
    pub status: String,
    pub platform: Option<String>,
    pub group_name: Option<String>,
    pub plan_name: Option<String>,
    pub quota_mode: Option<String>,
    pub quota_remaining: Option<f64>,
    pub quota_limit: Option<f64>,
    pub requests: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub actual_cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionKeyUsagePayload {
    pub items: Vec<SubscriptionKeyUsageItem>,
    pub total_requests: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_tokens: i64,
    pub total_actual_cost: f64,
    pub active_key_count: i64,
    pub inactive_key_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserIdentityBinding {
    pub provider: String,
    pub bound: bool,
    pub bound_count: i64,
    pub display_name: Option<String>,
    pub subject_hint: Option<String>,
    pub provider_key: Option<String>,
    pub verified_at: Option<String>,
    pub can_bind: bool,
    pub can_unbind: bool,
    pub note: Option<String>,
    pub note_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfileRecord {
    pub id: i64,
    pub email: String,
    pub username: Option<String>,
    pub avatar_url: Option<String>,
    pub role: String,
    pub balance: f64,
    pub concurrency: i64,
    pub status: String,
    pub last_active_at: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub total_recharged: Option<f64>,
    pub rpm_limit: Option<f64>,
    pub balance_notify_enabled: Option<bool>,
    pub balance_notify_threshold_type: Option<String>,
    pub balance_notify_threshold: Option<f64>,
    pub balance_notify_extra_emails: Option<Vec<String>>,
    pub identities: HashMap<String, UserIdentityBinding>,
    pub auth_bindings: HashMap<String, UserIdentityBinding>,
    pub identity_bindings: HashMap<String, UserIdentityBinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformQuotaRecord {
    pub platform: Option<String>,
    pub quota: Option<f64>,
    pub used: Option<f64>,
    pub remaining: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformQuotaPayload {
    pub platform_quotas: Vec<PlatformQuotaRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionSummaryRecord {
    pub id: i64,
    pub group_id: i64,
    pub group_name: String,
    pub status: String,
    pub daily_used_usd: f64,
    pub daily_limit_usd: f64,
    pub weekly_used_usd: f64,
    pub monthly_used_usd: f64,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionSummaryPayload {
    pub active_count: i64,
    pub total_used_usd: f64,
    pub subscriptions: Vec<SubscriptionSummaryRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionQuotaAlertThresholdMode {
    AmountUsd,
    UsagePercent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionQuotaAlertRule {
    pub enabled: bool,
    pub threshold_mode: SubscriptionQuotaAlertThresholdMode,
    pub threshold_value: f64,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionQuotaAlertConfig {
    pub subscription_key: String,
    pub rule: SubscriptionQuotaAlertRule,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionQuotaAlertSettingsPayload {
    pub default_rule: SubscriptionQuotaAlertRule,
    pub overrides: Vec<SubscriptionQuotaAlertConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionQuotaAlertUpsertInput {
    pub subscription_key: String,
    pub enabled: bool,
    pub threshold_mode: SubscriptionQuotaAlertThresholdMode,
    pub threshold_value: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionQuotaAlertWindowKind {
    Daily,
    Weekly,
    Monthly,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionQuotaAlertTriggeredWindow {
    pub kind: SubscriptionQuotaAlertWindowKind,
    pub current: f64,
    pub limit: Option<f64>,
    pub window_start: Option<String>,
    pub usage_percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionQuotaAlertEventPayload {
    pub id: String,
    pub dedupe_key: String,
    pub account_id: String,
    pub subscription_key: String,
    pub subscription_name: String,
    pub threshold_mode: SubscriptionQuotaAlertThresholdMode,
    pub threshold_value: f64,
    pub config_revision: i64,
    pub triggered_windows: Vec<SubscriptionQuotaAlertTriggeredWindow>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionSwitchTriggerReason {
    BalanceLow,
    SourceSubscriptionAmountThresholdReached,
    SourceSubscriptionPercentThresholdReached,
    SourceSubscriptionUnavailable,
    SourceSubscriptionQuotaExhausted,
    CandidateSubscriptionUnavailable,
    CandidateSubscriptionQuotaExhausted,
    CandidateSubscriptionAmountThresholdReached,
    CandidateSubscriptionPercentThresholdReached,
    StrictPriorityReconciled,
    Restored,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionSwitchRuntimeState {
    Idle,
    Switched,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionSwitchThresholdMode {
    AmountUsd,
    UsagePercent,
}

/// 订阅候补链中的单个节点及其独立切换阈值。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionSwitchChainNode {
    pub group_id: i64,
    pub threshold_mode: SubscriptionSwitchThresholdMode,
    pub threshold_value: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionSwitchRuleRecord {
    pub account_id: String,
    pub key_id: String,
    pub source_group_id: i64,
    pub enabled: bool,
    /// 第一项是用户选择的链首（source）, 后续项按切换优先级排列。
    pub chain_nodes: Vec<SubscriptionSwitchChainNode>,
    pub auto_restore: bool,
    /// 开启后优先回到当前节点之前第一个仍满足阈值条件的订阅。
    pub strict_mode: bool,
    pub runtime_state: SubscriptionSwitchRuntimeState,
    pub active_target_group_id: Option<i64>,
    pub last_trigger_reason: Option<SubscriptionSwitchTriggerReason>,
    pub last_switched_at: Option<String>,
    pub last_restored_at: Option<String>,
    pub last_error: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionSwitchRuleUpsertInput {
    pub enabled: bool,
    pub source_group_id: i64,
    /// 第一项必须与 source_group_id 一致; source_group_id 由用户选择的链首决定, 且至少包含一个候补节点。
    pub chain_nodes: Vec<SubscriptionSwitchChainNode>,
    pub auto_restore: bool,
    pub strict_mode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionSwitchEvaluationResult {
    pub account_id: String,
    pub key_id: String,
    pub source_group_id: i64,
    pub runtime_state: SubscriptionSwitchRuntimeState,
    pub active_target_group_id: Option<i64>,
    pub last_trigger_reason: Option<SubscriptionSwitchTriggerReason>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteInput {
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub fallback_base_urls: Vec<String>,
    #[serde(default = "default_site_failover_cooldown_seconds")]
    pub failover_cooldown_seconds: u32,
    #[serde(default = "default_site_max_attempts_per_address")]
    pub max_attempts_per_address: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SitePatchInput {
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub fallback_base_urls: Option<Vec<String>>,
    pub failover_cooldown_seconds: Option<u32>,
    pub max_attempts_per_address: Option<u32>,
}

/// 站点地址在故障转移拓扑中的角色。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SiteFailoverAddressKind {
    Primary,
    Fallback,
}

/// 站点地址当前可向用户展示的运行状态。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SiteFailoverAddressStatusKind {
    Active,
    Pending,
    Cooling,
}

/// 单个主站或备用站点地址的运行状态。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SiteFailoverAddressStatus {
    pub base_url: String,
    pub kind: SiteFailoverAddressKind,
    pub status: SiteFailoverAddressStatusKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cooldown_until: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cooldown_remaining_seconds: Option<u64>,
}

/// 编辑站点弹窗读取的完整故障转移运行快照。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SiteFailoverStatusPayload {
    pub site_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_base_url: Option<String>,
    pub evaluation_revision: i64,
    pub transition_revision: i64,
    pub server_now: String,
    pub addresses: Vec<SiteFailoverAddressStatus>,
}

/// 请求测试一个当前站点拓扑中的地址。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SiteEndpointTestInput {
    pub base_url: String,
}

/// 单地址只读连接测试结果；失败不会改变配置或故障转移状态。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SiteEndpointTestResult {
    pub base_url: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    pub checked_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// 请求解除当前拓扑中单个地址的冷却状态。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SiteCooldownClearInput {
    pub base_url: String,
}

/// 活动地址实际变化时写入的事件类型。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SiteFailoverTransitionKind {
    SwitchedToFallback,
    PrimaryRestored,
}

/// 前端一次性提示所需的可读站点切换事件。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SiteFailoverTransitionEvent {
    pub revision: i64,
    pub site_id: String,
    pub site_name: String,
    pub from_base_url: String,
    pub to_base_url: String,
    pub kind: SiteFailoverTransitionKind,
    pub occurred_at: String,
}

/// 自指定 revision 之后的有界站点切换事件批次。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SiteFailoverTransitionBatch {
    pub latest_revision: i64,
    pub reset_required: bool,
    pub events: Vec<SiteFailoverTransitionEvent>,
}

/// HTTP 与 Tauri 共用的结构化错误载荷。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransportErrorPayload {
    pub error: String,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInput {
    pub site_id: String,
    pub label: String,
    pub email: String,
    pub balance_warning: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KeyMutationInput {
    pub name: String,
    pub group_id: Option<i64>,
    pub custom_key: Option<String>,
    pub ip_whitelist: Option<Vec<String>>,
    pub ip_blacklist: Option<Vec<String>>,
    pub quota: Option<f64>,
    pub expires_in_days: Option<i64>,
    pub status: Option<String>,
    pub rate_limit5h: Option<f64>,
    pub rate_limit1d: Option<f64>,
    pub rate_limit7d: Option<f64>,
    pub reset_quota: Option<bool>,
    pub reset_rate_limit_usage: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KeyPatchInput {
    pub name: Option<String>,
    pub group_id: Option<i64>,
    pub custom_key: Option<String>,
    pub ip_whitelist: Option<Vec<String>>,
    pub ip_blacklist: Option<Vec<String>>,
    pub quota: Option<f64>,
    pub expires_in_days: Option<i64>,
    pub status: Option<String>,
    pub rate_limit5h: Option<f64>,
    pub rate_limit1d: Option<f64>,
    pub rate_limit7d: Option<f64>,
    pub reset_quota: Option<bool>,
    pub reset_rate_limit_usage: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfileUpdateInput {
    pub email: Option<String>,
    pub username: Option<String>,
    pub balance_notify_enabled: Option<bool>,
    pub balance_notify_threshold_type: Option<String>,
    pub balance_notify_threshold: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailIdentityBindInput {
    pub email: String,
    pub verify_code: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub saved_at: String,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub token_type: Option<String>,
    pub cookie_jar_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredential {
    pub account_id: String,
    pub email: String,
    pub password: String,
    pub saved_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageRowCacheRecord {
    pub account_id: String,
    pub usage_id: String,
    pub occurred_at: String,
    pub row: UsageRow,
    pub updated_at: String,
    pub first_seen_at: String,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginChallenge {
    pub requires2fa: bool,
    pub temp_token: Option<String>,
    pub email_masked: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AppLaunchMode {
    Main,
    Floating,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CloseBehavior {
    Ask,
    SwitchToFloating,
    ExitApp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FloatingNotificationDensity {
    Compact,
    Standard,
    Relaxed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum FloatingNotificationSoundSource {
    #[default]
    Default,
    Custom,
    System,
    Muted,
}

pub const DEFAULT_FLOATING_NOTIFICATION_SOUND_VOLUME: i64 = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUiPrefs {
    pub version: i64,
    pub launch_mode: AppLaunchMode,
    pub open_floating_in_main_mode: bool,
    #[serde(default)]
    pub keep_floating_panel_visible: bool,
    #[serde(default = "default_floating_panel_opacity")]
    pub floating_panel_opacity: f64,
    #[serde(default = "default_floating_notification_duration_ms")]
    pub floating_notification_duration_ms: i64,
    #[serde(default = "default_floating_notification_density")]
    pub floating_notification_density: FloatingNotificationDensity,
    #[serde(default = "default_floating_notification_max_visible")]
    pub floating_notification_max_visible: i64,
    #[serde(default)]
    pub floating_notification_sound_source: FloatingNotificationSoundSource,
    #[serde(default)]
    pub floating_notification_sound_file_name: Option<String>,
    #[serde(default)]
    pub floating_notification_sound_storage_key: Option<String>,
    #[serde(default = "default_floating_notification_sound_volume")]
    pub floating_notification_sound_volume: i64,
    pub close_behavior: CloseBehavior,
    #[serde(default = "default_auto_refresh_enabled")]
    pub auto_refresh_enabled: bool,
    #[serde(default = "default_auto_refresh_interval_seconds")]
    pub auto_refresh_interval_seconds: i64,
    #[serde(default = "default_auto_refresh_enabled")]
    pub auto_refresh_service_status_enabled: bool,
    #[serde(
        default = "default_auto_refresh_enabled",
        alias = "autoRefreshSnapshotEnabled"
    )]
    pub auto_refresh_core_enabled: bool,
    #[serde(
        default = "default_auto_refresh_interval_seconds",
        alias = "autoRefreshSnapshotIntervalSeconds"
    )]
    pub auto_refresh_core_interval_seconds: i64,
    #[serde(
        default = "default_auto_refresh_enabled",
        alias = "autoRefreshAccountScopedEnabled"
    )]
    pub auto_refresh_keys_enabled: bool,
    #[serde(
        default = "default_auto_refresh_interval_seconds",
        alias = "autoRefreshAccountScopedIntervalSeconds"
    )]
    pub auto_refresh_keys_interval_seconds: i64,
    #[serde(default = "default_auto_refresh_enabled")]
    pub auto_refresh_usage_enabled: bool,
    #[serde(default = "default_auto_refresh_interval_seconds")]
    pub auto_refresh_usage_interval_seconds: i64,
    #[serde(default = "default_overview_account_runtime_timeout_ms")]
    pub overview_account_runtime_timeout_ms: i64,
    pub theme: String,
}

impl Default for DesktopUiPrefs {
    fn default() -> Self {
        Self {
            version: 1,
            launch_mode: AppLaunchMode::Main,
            open_floating_in_main_mode: true,
            keep_floating_panel_visible: false,
            floating_panel_opacity: 0.82,
            floating_notification_duration_ms: 7_000,
            floating_notification_density: FloatingNotificationDensity::Standard,
            floating_notification_max_visible: 3,
            floating_notification_sound_source: FloatingNotificationSoundSource::Default,
            floating_notification_sound_file_name: None,
            floating_notification_sound_storage_key: None,
            floating_notification_sound_volume: DEFAULT_FLOATING_NOTIFICATION_SOUND_VOLUME,
            close_behavior: CloseBehavior::Ask,
            auto_refresh_enabled: true,
            auto_refresh_interval_seconds: 9,
            auto_refresh_service_status_enabled: true,
            auto_refresh_core_enabled: true,
            auto_refresh_core_interval_seconds: 9,
            auto_refresh_keys_enabled: true,
            auto_refresh_keys_interval_seconds: 9,
            auto_refresh_usage_enabled: true,
            auto_refresh_usage_interval_seconds: 9,
            overview_account_runtime_timeout_ms: 4_500,
            theme: "sakura-signal".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUiPrefsPatch {
    pub launch_mode: Option<AppLaunchMode>,
    pub open_floating_in_main_mode: Option<bool>,
    pub keep_floating_panel_visible: Option<bool>,
    pub floating_panel_opacity: Option<f64>,
    pub floating_notification_duration_ms: Option<i64>,
    pub floating_notification_density: Option<FloatingNotificationDensity>,
    pub floating_notification_max_visible: Option<i64>,
    pub floating_notification_sound_volume: Option<i64>,
    pub close_behavior: Option<CloseBehavior>,
    pub auto_refresh_enabled: Option<bool>,
    pub auto_refresh_interval_seconds: Option<i64>,
    pub auto_refresh_service_status_enabled: Option<bool>,
    #[serde(alias = "autoRefreshSnapshotEnabled")]
    pub auto_refresh_core_enabled: Option<bool>,
    #[serde(alias = "autoRefreshSnapshotIntervalSeconds")]
    pub auto_refresh_core_interval_seconds: Option<i64>,
    #[serde(alias = "autoRefreshAccountScopedEnabled")]
    pub auto_refresh_keys_enabled: Option<bool>,
    #[serde(alias = "autoRefreshAccountScopedIntervalSeconds")]
    pub auto_refresh_keys_interval_seconds: Option<i64>,
    pub auto_refresh_usage_enabled: Option<bool>,
    pub auto_refresh_usage_interval_seconds: Option<i64>,
    pub overview_account_runtime_timeout_ms: Option<i64>,
    pub theme: Option<String>,
}

fn default_auto_refresh_enabled() -> bool {
    true
}

fn default_auto_refresh_interval_seconds() -> i64 {
    9
}

fn default_overview_account_runtime_timeout_ms() -> i64 {
    4_500
}

fn default_floating_panel_opacity() -> f64 {
    0.82
}

fn default_floating_notification_duration_ms() -> i64 {
    7_000
}

fn default_floating_notification_density() -> FloatingNotificationDensity {
    FloatingNotificationDensity::Standard
}

fn default_floating_notification_max_visible() -> i64 {
    3
}

fn default_floating_notification_sound_volume() -> i64 {
    DEFAULT_FLOATING_NOTIFICATION_SOUND_VOLUME
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenMainWindowPayload {
    pub nav: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatusProbeRecord {
    #[serde(alias = "ts")]
    pub ts: i64,
    #[serde(alias = "ok")]
    pub ok: bool,
    #[serde(alias = "latency_ms")]
    pub latency_ms: Option<i64>,
    #[serde(alias = "error")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatusServiceRecord {
    #[serde(alias = "model")]
    pub model: String,
    #[serde(alias = "uptime_pct")]
    pub uptime_pct: f64,
    #[serde(alias = "last")]
    pub last: Option<ServiceStatusProbeRecord>,
    #[serde(alias = "history")]
    pub history: Vec<ServiceStatusProbeRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatusPayload {
    #[serde(alias = "all_ok")]
    pub all_ok: bool,
    #[serde(alias = "generated_at")]
    pub generated_at: i64,
    #[serde(alias = "services")]
    pub services: Vec<ServiceStatusServiceRecord>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ServiceStatusMonitorNotificationKind {
    ModelDown,
    ModelRecovered,
    MonitorUnavailable,
    MonitorRecovered,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ServiceStatusMonitorNotificationSeverity {
    Critical,
    Success,
}

/// 原生服务状态监控成功同步后推送给主窗口的最新快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatusMonitorSnapshotEvent {
    pub status: ServiceStatusPayload,
    pub synced_at_epoch_ms: i64,
}

/// 原生服务状态监控检测到状态切换后推送给前端的通知事件。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatusMonitorNotificationEvent {
    pub id: String,
    pub kind: ServiceStatusMonitorNotificationKind,
    pub severity: ServiceStatusMonitorNotificationSeverity,
    pub title: String,
    pub detail: String,
    pub created_at: String,
    pub dedupe_key: String,
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRadarModelIqEntry {
    pub id: String,
    pub label: String,
    pub model: String,
    pub reasoning_effort: String,
    pub score: f64,
    pub passed: i64,
    pub average_cost_usd: f64,
    pub status: Option<String>,
    pub observed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRadarModelIqPayload {
    pub items: Vec<CodexRadarModelIqEntry>,
    pub source_updated_at: String,
    pub fetched_at: String,
    pub last_error: Option<String>,
    pub is_stale: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRadarIntelligenceEfficiencyPoint {
    pub id: String,
    pub label: String,
    pub model: String,
    pub reasoning_effort: String,
    pub score: f64,
    pub passed: i64,
    pub valid_tasks: i64,
    pub average_cost_usd: Option<f64>,
    pub average_minutes: Option<f64>,
    pub combined_cost_index: Option<f64>,
    pub total_runs: i64,
    pub observed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRadarIntelligenceHistoryPoint {
    pub observed_at: String,
    pub score: f64,
    pub passed: i64,
    pub tasks: Option<i64>,
    pub total_tokens: Option<i64>,
    pub input_tokens: Option<i64>,
    pub cached_input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub wall_seconds: Option<i64>,
    pub average_cost_usd: Option<f64>,
    pub average_task_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRadarIntelligenceDetailItem {
    pub id: String,
    pub label: String,
    pub model: String,
    pub reasoning_effort: String,
    pub score: f64,
    pub status: String,
    pub passed: i64,
    pub tasks: Option<i64>,
    pub valid_tasks: Option<i64>,
    pub average_cost_usd: Option<f64>,
    pub total_tokens: Option<i64>,
    pub input_tokens: Option<i64>,
    pub cached_input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub wall_seconds: Option<i64>,
    pub average_task_seconds: Option<f64>,
    pub observed_at: String,
    pub history: Vec<CodexRadarIntelligenceHistoryPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRadarIntelligencePayload {
    pub efficiency_points: Vec<CodexRadarIntelligenceEfficiencyPoint>,
    pub detail_items: Vec<CodexRadarIntelligenceDetailItem>,
    pub source_updated_at: String,
    pub fetched_at: String,
    pub last_error: Option<String>,
    pub is_stale: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRadarFastRadarSummary {
    pub cost_multiplier: f64,
    pub e2e_multiplier: f64,
    pub ttft_delta_seconds: f64,
    pub tps_multiplier: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRadarFastRadarItem {
    pub model: String,
    pub standard_e2e_seconds: f64,
    pub fast_e2e_seconds: f64,
    pub e2e_multiplier: f64,
    pub standard_ttft_seconds: f64,
    pub fast_ttft_seconds: f64,
    pub ttft_change_label: String,
    pub standard_tps: f64,
    pub fast_tps: f64,
    pub tps_multiplier: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRadarFastRadarPayload {
    pub summary: CodexRadarFastRadarSummary,
    pub items: Vec<CodexRadarFastRadarItem>,
    pub source_updated_at: String,
    pub fetched_at: String,
    pub last_error: Option<String>,
    pub is_stale: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRadarInsightsTrendPoint {
    pub observed_at: String,
    pub score: f64,
    pub samples: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRadarRecommendationItem {
    pub id: String,
    pub model: String,
    pub reasoning_effort: String,
    pub score: f64,
    pub average_cost_usd: Option<f64>,
    pub average_minutes: Option<f64>,
    pub slot: Option<String>,
    pub trend: Vec<CodexRadarInsightsTrendPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRadarRecommendationGroup {
    pub key: String,
    pub title: String,
    pub rule: String,
    pub items: Vec<CodexRadarRecommendationItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRadarDegradationAlert {
    pub id: String,
    pub model: String,
    pub reasoning_effort: String,
    pub score: f64,
    pub average_24h_score: Option<f64>,
    pub average_48h_score: Option<f64>,
    pub drop_12h: Option<f64>,
    pub drop_from_24h_average: Option<f64>,
    pub drop_from_48h_average: Option<f64>,
    pub severity_score: Option<f64>,
    pub trend: Vec<CodexRadarInsightsTrendPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRadarInsightsPayload {
    pub recommendations: Vec<CodexRadarRecommendationGroup>,
    pub degradation_rule: String,
    pub degradation_alerts: Vec<CodexRadarDegradationAlert>,
    pub source_updated_at: String,
    pub fetched_at: String,
    pub last_error: Option<String>,
    pub is_stale: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum LoginFlowResult {
    #[serde(rename = "success")]
    Success { account: AccountRuntime },
    #[serde(rename = "2fa")]
    TwoFa {
        temp_token: String,
        /// 产生 2FA challenge 的规范化站点地址，完成验证时优先沿用。
        origin_base_url: String,
        email_masked: Option<String>,
        message: Option<String>,
    },
}

/// 系统设置展示的数据库存储运行状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStorageStatus {
    pub runtime_scope: String,
    pub current_database_path: String,
    pub current_directory: String,
    pub user_directory: String,
    pub program_directory: String,
    pub target_directory: String,
    pub override_active: bool,
    pub migration_supported: bool,
    pub migration_phase: String,
    pub restart_required: bool,
    pub last_error: Option<String>,
}

/// 数据库迁移只接受目录，文件名始终由后端固定。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStorageMigrationInput {
    pub target_directory: String,
}

/// 数据库迁移完成后的可核验结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStorageMigrationResult {
    pub source_path: String,
    pub target_path: String,
    pub source_retained: bool,
    pub bootstrap_updated: bool,
    pub restart_required: bool,
}
