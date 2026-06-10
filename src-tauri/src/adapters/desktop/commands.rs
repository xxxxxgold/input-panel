use serde_json::Value;
use tauri::State;

use crate::application::{
    account_service, auth_service, dashboard_service, proxy_service, site_service, AppContext,
};
use crate::contracts::{AccountRuntime, LoginFlowResult, OverviewPayload, SiteRecord};

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
