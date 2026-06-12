use serde_json::Value;
use tauri::State;

use crate::application::{
    account_service, auth_service, dashboard_service, keys_service, profile_service, proxy_service,
    site_service, usage_service, AppContext,
};
use crate::contracts::{
    AccountRuntime, DashboardModelsPayload, DailyUsagePoint, GroupRecord, KeyMutationInput,
    LoginFlowResult, ManagedKeyRecord, OrderRecord, OverviewPayload, PaginatedResult,
    PaymentConfigRecord, PlatformQuotaPayload, ProfileUpdateInput, SiteRecord,
    SubscriptionSummaryPayload, UsageRow, UsageStatsRecord, UsageTrendPayload, UserProfileRecord,
};

#[tauri::command]
pub fn health() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[tauri::command]
pub fn get_overview(ctx: State<'_, AppContext>) -> Result<OverviewPayload, String> {
    dashboard_service::get_overview(&ctx).map_err(to_message)
}

#[tauri::command]
pub fn create_site(ctx: State<'_, AppContext>, payload: crate::contracts::SiteInput) -> Result<SiteRecord, String> {
    site_service::create_site(&ctx, payload).map_err(to_message)
}

#[tauri::command]
pub fn update_site(
    ctx: State<'_, AppContext>,
    site_id: String,
    name: Option<String>,
    base_url: Option<String>,
) -> Result<SiteRecord, String> {
    site_service::update_site(&ctx, &site_id, name, base_url).map_err(to_message)
}

#[tauri::command]
pub fn remove_site(ctx: State<'_, AppContext>, site_id: String) -> Result<bool, String> {
    site_service::remove_site(&ctx, &site_id).map_err(to_message)
}

#[tauri::command]
pub fn create_account(
    ctx: State<'_, AppContext>,
    payload: crate::contracts::AccountInput,
) -> Result<AccountRuntime, String> {
    account_service::create_account(&ctx, payload).map_err(to_message)
}

#[tauri::command]
pub fn update_account(
    ctx: State<'_, AppContext>,
    account_id: String,
    label: Option<String>,
    email: Option<String>,
    balance_warning: Option<f64>,
) -> Result<AccountRuntime, String> {
    account_service::update_account(&ctx, &account_id, label, email, balance_warning).map_err(to_message)
}

#[tauri::command]
pub fn remove_account(ctx: State<'_, AppContext>, account_id: String) -> Result<bool, String> {
    account_service::remove_account(&ctx, &account_id).map_err(to_message)
}

#[tauri::command]
pub async fn login_account(
    ctx: State<'_, AppContext>,
    account_id: String,
    password: String,
) -> Result<LoginFlowResult, String> {
    auth_service::login_account(&ctx, &account_id, &password)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub fn persist_account_credential(
    ctx: State<'_, AppContext>,
    account_id: String,
    password: String,
) -> Result<bool, String> {
    auth_service::persist_account_credential(&ctx, &account_id, &password).map_err(to_message)
}

#[tauri::command]
pub async fn login_account_2fa(
    ctx: State<'_, AppContext>,
    account_id: String,
    temp_token: String,
    code: String,
) -> Result<AccountRuntime, String> {
    auth_service::login_account_2fa(&ctx, &account_id, &temp_token, &code)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn refresh_account(
    ctx: State<'_, AppContext>,
    account_id: String,
) -> Result<AccountRuntime, String> {
    auth_service::refresh_account(&ctx, &account_id)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn refresh_all_accounts(ctx: State<'_, AppContext>) -> Result<OverviewPayload, String> {
    auth_service::refresh_all_accounts(&ctx)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_available_groups(
    ctx: State<'_, AppContext>,
    account_id: String,
) -> Result<Vec<GroupRecord>, String> {
    keys_service::get_available_groups(&ctx, &account_id)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn list_managed_keys(
    ctx: State<'_, AppContext>,
    account_id: String,
    page: Option<i64>,
    page_size: Option<i64>,
) -> Result<PaginatedResult<ManagedKeyRecord>, String> {
    keys_service::list_managed_keys(&ctx, &account_id, page.unwrap_or(1), page_size.unwrap_or(20))
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_managed_key(
    ctx: State<'_, AppContext>,
    account_id: String,
    key_id: String,
) -> Result<ManagedKeyRecord, String> {
    keys_service::get_managed_key(&ctx, &account_id, &key_id)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn create_managed_key(
    ctx: State<'_, AppContext>,
    account_id: String,
    payload: KeyMutationInput,
) -> Result<ManagedKeyRecord, String> {
    keys_service::create_managed_key(&ctx, &account_id, payload)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn update_managed_key(
    ctx: State<'_, AppContext>,
    account_id: String,
    key_id: String,
    payload: KeyMutationInput,
) -> Result<ManagedKeyRecord, String> {
    keys_service::update_managed_key(&ctx, &account_id, &key_id, payload)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn delete_managed_key(
    ctx: State<'_, AppContext>,
    account_id: String,
    key_id: String,
) -> Result<bool, String> {
    keys_service::delete_managed_key(&ctx, &account_id, &key_id)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn list_usage_records(
    ctx: State<'_, AppContext>,
    account_id: String,
    page: Option<i64>,
    page_size: Option<i64>,
    api_key_id: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<PaginatedResult<UsageRow>, String> {
    usage_service::list_usage_records(
        &ctx,
        &account_id,
        usage_service::UsageListQuery {
            page: page.unwrap_or(1),
            page_size: page_size.unwrap_or(20),
            api_key_id,
            start_date,
            end_date,
        },
    )
    .await
    .map_err(to_message)
}

#[tauri::command]
pub async fn get_usage_stats(
    ctx: State<'_, AppContext>,
    account_id: String,
    period: Option<String>,
    api_key_id: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<UsageStatsRecord, String> {
    usage_service::get_usage_stats(
        &ctx,
        &account_id,
        usage_service::UsageStatsQuery {
            period,
            api_key_id,
            start_date,
            end_date,
        },
    )
    .await
    .map_err(to_message)
}

#[tauri::command]
pub async fn get_dashboard_models(
    ctx: State<'_, AppContext>,
    account_id: String,
    days: Option<i64>,
) -> Result<DashboardModelsPayload, String> {
    usage_service::get_dashboard_models(&ctx, &account_id, days.unwrap_or(7))
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_dashboard_trend(
    ctx: State<'_, AppContext>,
    account_id: String,
    days: Option<i64>,
) -> Result<UsageTrendPayload, String> {
    usage_service::get_dashboard_trend(&ctx, &account_id, days.unwrap_or(7))
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_key_daily_usage(
    ctx: State<'_, AppContext>,
    account_id: String,
    key_id: String,
    days: Option<i64>,
) -> Result<Vec<DailyUsagePoint>, String> {
    usage_service::get_key_daily_usage(&ctx, &account_id, &key_id, days.unwrap_or(30))
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_profile_record(
    ctx: State<'_, AppContext>,
    account_id: String,
) -> Result<UserProfileRecord, String> {
    profile_service::get_profile_record(&ctx, &account_id)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn update_profile_record(
    ctx: State<'_, AppContext>,
    account_id: String,
    payload: ProfileUpdateInput,
) -> Result<UserProfileRecord, String> {
    profile_service::update_profile_record(&ctx, &account_id, payload)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn change_profile_password(
    ctx: State<'_, AppContext>,
    account_id: String,
    old_password: String,
    new_password: String,
) -> Result<bool, String> {
    profile_service::change_profile_password(&ctx, &account_id, &old_password, &new_password)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_platform_quotas(
    ctx: State<'_, AppContext>,
    account_id: String,
) -> Result<PlatformQuotaPayload, String> {
    profile_service::get_platform_quotas(&ctx, &account_id)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_subscription_summary(
    ctx: State<'_, AppContext>,
    account_id: String,
) -> Result<SubscriptionSummaryPayload, String> {
    profile_service::get_subscription_summary(&ctx, &account_id)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_payment_config(
    ctx: State<'_, AppContext>,
    account_id: String,
) -> Result<PaymentConfigRecord, String> {
    profile_service::get_payment_config(&ctx, &account_id)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn list_orders(
    ctx: State<'_, AppContext>,
    account_id: String,
    page: Option<i64>,
    page_size: Option<i64>,
) -> Result<PaginatedResult<OrderRecord>, String> {
    profile_service::list_orders(&ctx, &account_id, page.unwrap_or(1), page_size.unwrap_or(20))
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn send_notify_email_code(
    ctx: State<'_, AppContext>,
    account_id: String,
    email: String,
) -> Result<bool, String> {
    profile_service::send_notify_email_code(&ctx, &account_id, &email)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn verify_notify_email(
    ctx: State<'_, AppContext>,
    account_id: String,
    email: String,
    code: String,
) -> Result<bool, String> {
    profile_service::verify_notify_email(&ctx, &account_id, &email, &code)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn remove_notify_email(
    ctx: State<'_, AppContext>,
    account_id: String,
    email: String,
) -> Result<bool, String> {
    profile_service::remove_notify_email(&ctx, &account_id, &email)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn toggle_notify_email(
    ctx: State<'_, AppContext>,
    account_id: String,
    email: String,
    disabled: bool,
) -> Result<UserProfileRecord, String> {
    profile_service::toggle_notify_email(&ctx, &account_id, &email, disabled)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn send_email_binding_code(
    ctx: State<'_, AppContext>,
    account_id: String,
    email: String,
) -> Result<bool, String> {
    profile_service::send_email_binding_code(&ctx, &account_id, &email)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn bind_email_identity(
    ctx: State<'_, AppContext>,
    account_id: String,
    email: String,
    code: String,
) -> Result<bool, String> {
    profile_service::bind_email_identity(&ctx, &account_id, &email, &code)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn unbind_auth_identity(
    ctx: State<'_, AppContext>,
    account_id: String,
    provider: String,
) -> Result<bool, String> {
    profile_service::unbind_auth_identity(&ctx, &account_id, &provider)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn account_proxy_request(
    ctx: State<'_, AppContext>,
    account_id: String,
    path: String,
    method: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    proxy_service::account_proxy_request(&ctx, &account_id, &path, &method, payload)
        .await
        .map_err(to_message)
}

fn to_message(error: anyhow::Error) -> String {
    error.to_string()
}
