use crate::models::{AccountInput, AccountRuntime, AccountSnapshot, LoginFlowResult, OverviewPayload, SiteInput};
use crate::overview::build_overview;
use crate::store;
use crate::sub2api::Sub2ApiClient;
use anyhow::{Context, Result};
use chrono::Utc;
use serde_json::Value;
use tauri::AppHandle;

#[tauri::command]
pub fn health() -> String {
    Utc::now().to_rfc3339()
}

#[tauri::command]
pub fn get_overview(app: AppHandle) -> Result<OverviewPayload, String> {
    let state = store::read_state(&app).map_err(to_message)?;
    Ok(build_overview(&state))
}

#[tauri::command]
pub fn create_site(app: AppHandle, payload: SiteInput) -> Result<crate::models::SiteRecord, String> {
    store::add_site(&app, payload).map_err(to_message)
}

#[tauri::command]
pub fn update_site(
    app: AppHandle,
    site_id: String,
    name: Option<String>,
    base_url: Option<String>,
) -> Result<crate::models::SiteRecord, String> {
    store::update_site(&app, &site_id, name, base_url).map_err(to_message)
}

#[tauri::command]
pub fn remove_site(app: AppHandle, site_id: String) -> Result<bool, String> {
    store::remove_site(&app, &site_id).map_err(to_message)?;
    Ok(true)
}

#[tauri::command]
pub fn create_account(app: AppHandle, payload: AccountInput) -> Result<AccountRuntime, String> {
    let account = store::add_account(&app, payload).map_err(to_message)?;
    wrap_runtime(&app, account, None, None).map_err(to_message)
}

#[tauri::command]
pub fn update_account(
    app: AppHandle,
    account_id: String,
    label: Option<String>,
    email: Option<String>,
    balance_warning: Option<f64>,
) -> Result<AccountRuntime, String> {
    let account = store::update_account(&app, &account_id, label, email, balance_warning, None)
        .map_err(to_message)?;
    let state = store::read_state(&app).map_err(to_message)?;
    let snapshot = state.snapshots.get(&account.id).cloned();
    let last_error = state.errors.get(&account.id).cloned().flatten();
    wrap_runtime(&app, account, snapshot, last_error).map_err(to_message)
}

#[tauri::command]
pub fn remove_account(app: AppHandle, account_id: String) -> Result<bool, String> {
    store::remove_account(&app, &account_id).map_err(to_message)?;
    Ok(true)
}

#[tauri::command]
pub async fn login_account(
    app: AppHandle,
    account_id: String,
    password: String,
) -> Result<LoginFlowResult, String> {
    let state = store::read_state(&app).map_err(to_message)?;
    let account = state
        .accounts
        .iter()
        .find(|item| item.id == account_id)
        .cloned()
        .context("账号不存在")
        .map_err(to_message)?;
    let site = state
        .sites
        .iter()
        .find(|item| item.id == account.site_id)
        .cloned()
        .context("账号所属站点不存在")
        .map_err(to_message)?;

    let mut client = Sub2ApiClient::new(&site.base_url, None).map_err(to_message)?;
    let challenge = client.login(&account.email, &password).await.map_err(to_message)?;
    if challenge.requires2fa {
        store::save_credential(&app, &account.id, &account.email, &password).map_err(to_message)?;
        return Ok(LoginFlowResult::TwoFa {
            temp_token: challenge.temp_token.unwrap_or_default(),
            email_masked: challenge
                .email_masked
                .or_else(|| Some(mask_email(&account.email))),
            message: Some("当前站点要求 2FA 验证，请继续输入验证码。".into()),
        });
    }
    let snapshot = client
        .build_snapshot(&account, &site)
        .await
        .map_err(to_message)?;
    store::save_snapshot(&app, &account.id, snapshot.clone()).map_err(to_message)?;
    store::save_session(&app, &account.id, &client.serialize()).map_err(to_message)?;
    store::save_credential(&app, &account.id, &account.email, &password).map_err(to_message)?;
    let updated = store::update_account(
        &app,
        &account.id,
        None,
        None,
        None,
        Some(Utc::now().to_rfc3339()),
    )
    .map_err(to_message)?;
    wrap_runtime(&app, updated, Some(snapshot), None)
        .map(|account| LoginFlowResult::Success { account })
        .map_err(to_message)
}

#[tauri::command]
pub fn persist_account_credential(
    app: AppHandle,
    account_id: String,
    password: String,
) -> Result<bool, String> {
    let state = store::read_state(&app).map_err(to_message)?;
    let account = state
        .accounts
        .iter()
        .find(|item| item.id == account_id)
        .cloned()
        .context("账号不存在")
        .map_err(to_message)?;
    if password.trim().is_empty() {
        return Err("密码不能为空。".into());
    }
    store::save_credential(&app, &account.id, &account.email, &password).map_err(to_message)?;
    Ok(true)
}

#[tauri::command]
pub async fn login_account_2fa(
    app: AppHandle,
    account_id: String,
    temp_token: String,
    code: String,
) -> Result<AccountRuntime, String> {
    let state = store::read_state(&app).map_err(to_message)?;
    let account = state
        .accounts
        .iter()
        .find(|item| item.id == account_id)
        .cloned()
        .context("账号不存在")
        .map_err(to_message)?;
    let site = state
        .sites
        .iter()
        .find(|item| item.id == account.site_id)
        .cloned()
        .context("账号所属站点不存在")
        .map_err(to_message)?;

    let mut client = Sub2ApiClient::new(&site.base_url, None).map_err(to_message)?;
    client
        .complete_2fa(&temp_token, &code)
        .await
        .map_err(to_message)?;
    let snapshot = client
        .build_snapshot(&account, &site)
        .await
        .map_err(to_message)?;
    store::save_snapshot(&app, &account.id, snapshot.clone()).map_err(to_message)?;
    store::save_session(&app, &account.id, &client.serialize()).map_err(to_message)?;
    let updated = store::update_account(
        &app,
        &account.id,
        None,
        None,
        None,
        Some(Utc::now().to_rfc3339()),
    )
    .map_err(to_message)?;
    wrap_runtime(&app, updated, Some(snapshot), None).map_err(to_message)
}

#[tauri::command]
pub async fn refresh_account(app: AppHandle, account_id: String) -> Result<AccountRuntime, String> {
    refresh_one(&app, &account_id).await.map_err(to_message)
}

#[tauri::command]
pub async fn refresh_all_accounts(app: AppHandle) -> Result<OverviewPayload, String> {
    let state = store::read_state(&app).map_err(to_message)?;
    for account in state.accounts {
        let _ = refresh_one(&app, &account.id).await;
    }
    let next_state = store::read_state(&app).map_err(to_message)?;
    Ok(build_overview(&next_state))
}

#[tauri::command]
pub async fn account_proxy_request(
    app: AppHandle,
    account_id: String,
    path: String,
    method: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    let state = store::read_state(&app).map_err(to_message)?;
    let account = state
        .accounts
        .iter()
        .find(|item| item.id == account_id)
        .cloned()
        .context("账号不存在")
        .map_err(to_message)?;
    let site = state
        .sites
        .iter()
        .find(|item| item.id == account.site_id)
        .cloned()
        .context("账号所属站点不存在")
        .map_err(to_message)?;
    let session = store::load_session(&app, &account_id).map_err(to_message)?;
    let mut client = Sub2ApiClient::new(&site.base_url, session).map_err(to_message)?;
    ensure_authorized(&app, &mut client, &account).await.map_err(to_message)?;

    if !path.starts_with("/api/v1/") {
        return Err("仅允许代理用户中心 API 路径。".into());
    }

    let request_payload = payload.clone();
    let data = match client.request_api(&path, &method, payload).await {
        Ok(data) => data,
        Err(error) if is_auth_expired_error(&error) => {
            relogin_with_saved_credential(&app, &mut client, &account)
                .await
                .map_err(to_message)?;
            client
                .request_api(&path, &method, request_payload)
                .await
                .map_err(to_message)?
        }
        Err(error) => return Err(to_message(error)),
    };
    store::save_session(&app, &account_id, &client.serialize()).map_err(to_message)?;
    Ok(data)
}

async fn refresh_one(app: &AppHandle, account_id: &str) -> Result<AccountRuntime> {
    let state = store::read_state(app)?;
    let account = state
        .accounts
        .iter()
        .find(|item| item.id == account_id)
        .cloned()
        .context("账号不存在")?;
    let site = state
        .sites
        .iter()
        .find(|item| item.id == account.site_id)
        .cloned()
        .context("账号所属站点不存在")?;
    let session = store::load_session(app, account_id)?;
    let mut client = Sub2ApiClient::new(&site.base_url, session)?;
    ensure_authorized(app, &mut client, &account).await?;
    match client.build_snapshot(&account, &site).await {
        Ok(snapshot) => {
            store::save_snapshot(app, account_id, snapshot.clone())?;
            store::save_session(app, account_id, &client.serialize())?;
            wrap_runtime(app, account, Some(snapshot), None)
        }
        Err(error) if is_auth_expired_error(&error) => {
            relogin_with_saved_credential(app, &mut client, &account).await?;
            let snapshot = client.build_snapshot(&account, &site).await?;
            store::save_snapshot(app, account_id, snapshot.clone())?;
            store::save_session(app, account_id, &client.serialize())?;
            wrap_runtime(app, account, Some(snapshot), None)
        }
        Err(error) => {
            store::save_error(app, account_id, error.to_string())?;
            Err(error)
        }
    }
}

fn wrap_runtime(
    app: &AppHandle,
    account: crate::models::AccountRecord,
    snapshot: Option<AccountSnapshot>,
    last_error: Option<String>,
) -> Result<AccountRuntime> {
    let state = store::read_state(app)?;
    let site = state.sites.iter().find(|item| item.id == account.site_id).cloned();
    let resolved_snapshot = state
        .snapshots
        .get(&account.id)
        .cloned()
        .or(snapshot);
    let has_snapshot = resolved_snapshot.is_some();
    Ok(AccountRuntime {
        account,
        site,
        snapshot: resolved_snapshot,
        session_state: if has_snapshot {
            "ready".into()
        } else if last_error.is_some() {
            "expired".into()
        } else {
            "missing".into()
        },
        last_error,
    })
}

fn to_message(error: anyhow::Error) -> String {
    error.to_string()
}

fn mask_email(email: &str) -> String {
    let mut parts = email.split('@');
    let local = parts.next().unwrap_or_default();
    let domain = parts.next().unwrap_or_default();
    if local.is_empty() || domain.is_empty() {
        return email.to_string();
    }
    if local.len() <= 3 {
        return format!("{}***@{}", local.chars().next().unwrap_or('*'), domain);
    }
    format!("{}***@{}", &local[..3], domain)
}

async fn ensure_authorized(
    app: &AppHandle,
    client: &mut Sub2ApiClient,
    account: &crate::models::AccountRecord,
) -> Result<()> {
    let has_token = client.serialize().access_token.is_some() || client.serialize().refresh_token.is_some();
    if has_token {
        return Ok(());
    }
    relogin_with_saved_credential(app, client, account).await
}

async fn relogin_with_saved_credential(
    app: &AppHandle,
    client: &mut Sub2ApiClient,
    account: &crate::models::AccountRecord,
) -> Result<()> {
    let (_, password) = store::load_credential(app, &account.id)?
        .context(format!("账号 {} 尚未保存可恢复凭据，请重新登录。", account.label))?;
    let challenge = client.login(&account.email, &password).await?;
    if challenge.requires2fa {
        return Err(anyhow::anyhow!("账号需要 2FA 验证，请手动重新登录一次。"));
    }
    store::save_credential(app, &account.id, &account.email, &password)?;
    Ok(())
}

fn is_auth_expired_error(error: &anyhow::Error) -> bool {
    error.to_string().contains("认证已失效")
}
