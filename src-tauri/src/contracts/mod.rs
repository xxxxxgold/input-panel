use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteRecord {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub created_at: String,
    pub updated_at: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionRecord {
    pub id: String,
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
    pub api_key_id: Option<i64>,
    pub created_at: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub endpoint: Option<String>,
    pub upstream_endpoint: Option<String>,
    pub actual_cost: f64,
    pub total_cost: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub input_cost: Option<f64>,
    pub output_cost: Option<f64>,
    pub cache_creation_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub cache_creation_cost: Option<f64>,
    pub cache_read_cost: Option<f64>,
    pub total_tokens: i64,
    pub first_token_ms: Option<i64>,
    pub duration_ms: Option<i64>,
    pub billing_mode: Option<String>,
    pub request_type: Option<String>,
    pub stream: Option<bool>,
    pub billing_type: Option<i64>,
    pub image_count: Option<i64>,
    pub image_size: Option<String>,
    pub image_input_size: Option<String>,
    pub image_output_size: Option<String>,
    pub image_output_tokens: Option<i64>,
    pub image_output_cost: Option<f64>,
    pub image_size_source: Option<String>,
    pub image_size_breakdown: Option<String>,
    pub media_type: Option<String>,
    pub rate_multiplier: Option<f64>,
    pub user_agent: Option<String>,
    pub api_key_name: Option<String>,
    pub platform: Option<String>,
    pub subscription_name: Option<String>,
    pub group_name: Option<String>,
    pub subscription_type: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskRunStatus {
    Running,
    Succeeded,
    Failed,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteInput {
    pub name: String,
    pub base_url: String,
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
    pub ip_whitelist: Option<String>,
    pub ip_blacklist: Option<String>,
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
    pub ip_whitelist: Option<String>,
    pub ip_blacklist: Option<String>,
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
pub struct AccountProfileCacheRecord {
    pub account_id: String,
    pub payload: UserProfileRecord,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPlatformQuotaCacheRecord {
    pub account_id: String,
    pub payload: PlatformQuotaPayload,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSubscriptionCacheRecord {
    pub account_id: String,
    pub subscription_id: String,
    pub row: SubscriptionRecord,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSubscriptionSummaryCacheRecord {
    pub account_id: String,
    pub payload: SubscriptionSummaryPayload,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountGroupCacheRecord {
    pub account_id: String,
    pub group_id: i64,
    pub row: GroupRecord,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountKeyCacheRecord {
    pub account_id: String,
    pub key_id: String,
    pub row: ManagedKeyRecord,
    pub updated_at: String,
    pub first_seen_at: String,
    pub last_seen_at: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DataCenterState {
    pub sites: Vec<SiteRecord>,
    pub accounts: Vec<AccountRecord>,
    pub sessions: HashMap<String, StoredSession>,
    pub profiles: HashMap<String, AccountProfileCacheRecord>,
    pub platform_quotas: HashMap<String, AccountPlatformQuotaCacheRecord>,
    pub subscription_summaries: HashMap<String, AccountSubscriptionSummaryCacheRecord>,
    pub subscriptions: HashMap<String, Vec<AccountSubscriptionCacheRecord>>,
    pub groups: HashMap<String, Vec<AccountGroupCacheRecord>>,
    pub keys: HashMap<String, Vec<AccountKeyCacheRecord>>,
    pub usage_rows: HashMap<String, Vec<AccountUsageRowCacheRecord>>,
    pub sync_statuses: HashMap<String, Vec<AccountSyncStatusRecord>>,
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
    pub close_behavior: CloseBehavior,
    #[serde(default = "default_auto_refresh_enabled")]
    pub auto_refresh_enabled: bool,
    #[serde(default = "default_auto_refresh_interval_seconds")]
    pub auto_refresh_interval_seconds: i64,
    #[serde(default = "default_auto_refresh_enabled", alias = "autoRefreshSnapshotEnabled")]
    pub auto_refresh_core_enabled: bool,
    #[serde(default = "default_auto_refresh_interval_seconds", alias = "autoRefreshSnapshotIntervalSeconds")]
    pub auto_refresh_core_interval_seconds: i64,
    #[serde(default = "default_auto_refresh_enabled", alias = "autoRefreshAccountScopedEnabled")]
    pub auto_refresh_keys_enabled: bool,
    #[serde(default = "default_auto_refresh_interval_seconds", alias = "autoRefreshAccountScopedIntervalSeconds")]
    pub auto_refresh_keys_interval_seconds: i64,
    #[serde(default = "default_auto_refresh_enabled")]
    pub auto_refresh_usage_enabled: bool,
    #[serde(default = "default_auto_refresh_interval_seconds")]
    pub auto_refresh_usage_interval_seconds: i64,
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
            close_behavior: CloseBehavior::Ask,
            auto_refresh_enabled: true,
            auto_refresh_interval_seconds: 9,
            auto_refresh_core_enabled: true,
            auto_refresh_core_interval_seconds: 9,
            auto_refresh_keys_enabled: true,
            auto_refresh_keys_interval_seconds: 9,
            auto_refresh_usage_enabled: true,
            auto_refresh_usage_interval_seconds: 9,
            theme: "light".into(),
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
    pub close_behavior: Option<CloseBehavior>,
    pub auto_refresh_enabled: Option<bool>,
    pub auto_refresh_interval_seconds: Option<i64>,
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
    pub theme: Option<String>,
}

fn default_auto_refresh_enabled() -> bool {
    true
}

fn default_auto_refresh_interval_seconds() -> i64 {
    9
}

fn default_floating_panel_opacity() -> f64 {
    0.82
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum LoginFlowResult {
    #[serde(rename = "success")]
    Success { account: AccountRuntime },
    #[serde(rename = "2fa")]
    TwoFa {
        temp_token: String,
        email_masked: Option<String>,
        message: Option<String>,
    },
}

