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
    pub cache_creation_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub total_tokens: i64,
    pub first_token_ms: Option<i64>,
    pub duration_ms: Option<i64>,
    pub billing_mode: Option<String>,
    pub request_type: Option<String>,
    pub stream: Option<bool>,
    pub billing_type: Option<i64>,
    pub user_agent: Option<String>,
    pub api_key_name: Option<String>,
    pub platform: Option<String>,
    pub subscription_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageHistoryRow {
    #[serde(flatten)]
    pub row: UsageRow,
    pub first_seen_at: String,
    pub last_seen_at: String,
    pub is_latest: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendPoint {
    pub bucket: String,
    pub actual_cost: f64,
    pub total_cost: f64,
    pub requests: i64,
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
pub struct SnapshotStats {
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
pub struct SnapshotAlert {
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
pub struct AccountSnapshot {
    pub fetched_at: String,
    pub online: bool,
    pub site_name: String,
    pub site_url: String,
    pub account_label: String,
    pub email_masked: Option<String>,
    pub balance: f64,
    pub currency: String,
    pub stats: SnapshotStats,
    pub usage_summary: UsageSummary,
    pub recent_usage: Vec<UsageRow>,
    pub request_history: Vec<UsageHistoryRow>,
    pub trend: Vec<TrendPoint>,
    pub keys: Vec<KeyRecord>,
    pub subscriptions: Vec<SubscriptionRecord>,
    pub active_subscription: Option<SubscriptionRecord>,
    pub alerts: Vec<SnapshotAlert>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRuntime {
    #[serde(flatten)]
    pub account: AccountRecord,
    pub site: Option<SiteRecord>,
    pub snapshot: Option<AccountSnapshot>,
    pub session_state: String,
    pub last_error: Option<String>,
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
    pub alerts: Vec<SnapshotAlert>,
    pub platform_series: Vec<PlatformPoint>,
    pub trend: Vec<TrendPoint>,
    pub generated_at: String,
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
pub struct StoredSession {
    pub saved_at: String,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredentialMeta {
    pub saved_at: String,
    pub email: String,
    pub has_password: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoredState {
    pub sites: Vec<SiteRecord>,
    pub accounts: Vec<AccountRecord>,
    pub snapshots: HashMap<String, AccountSnapshot>,
    pub errors: HashMap<String, Option<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginChallenge {
    pub requires2fa: bool,
    pub temp_token: Option<String>,
    pub email_masked: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LoginFlowResult {
    Success { account: AccountRuntime },
    #[serde(rename_all = "camelCase")]
    TwoFa {
        temp_token: String,
        email_masked: Option<String>,
        message: Option<String>,
    },
}
