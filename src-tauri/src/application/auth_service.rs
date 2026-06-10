use anyhow::{anyhow, Context, Result};
use chrono::Utc;

use crate::contracts::{AccountRuntime, LoginFlowResult, StoredCredential};
use crate::infrastructure::sqlite::repositories;
use crate::infrastructure::sub2api::client::Sub2ApiClient;

use super::{account_service, dashboard_service, AppContext};

pub async fn login_account(
    ctx: &AppContext,
    account_id: &str,
    password: &str,
) -> Result<LoginFlowResult> {
    let (account, site) = account_service::load_account_site(ctx, account_id)?;
    let mut client = Sub2ApiClient::new(&site.base_url, None)?;
    let challenge = client.login(&account.email, password).await?;
    if challenge.requires2fa {
        repositories::save_credential(
            &ctx.db,
            &StoredCredential {
                account_id: account.id.clone(),
                email: account.email.clone(),
                password: password.to_string(),
                saved_at: Utc::now().to_rfc3339(),
            },
        )?;
        return Ok(LoginFlowResult::TwoFa {
            temp_token: challenge.temp_token.unwrap_or_default(),
            email_masked: challenge
                .email_masked
                .or_else(|| Some(mask_email(&account.email))),
            message: Some("当前站点要求 2FA 验证，请继续输入验证码。".into()),
        });
    }

    let snapshot = client.build_snapshot(&account, &site).await?;
    repositories::save_snapshot(&ctx.db, &account.id, &snapshot)?;
    repositories::clear_error(&ctx.db, &account.id)?;
    repositories::save_session(&ctx.db, &account.id, &client.serialize())?;
    repositories::save_credential(
        &ctx.db,
        &StoredCredential {
            account_id: account.id.clone(),
            email: account.email.clone(),
            password: password.to_string(),
            saved_at: Utc::now().to_rfc3339(),
        },
    )?;

    let mut updated = account.clone();
    updated.last_login_at = Some(Utc::now().to_rfc3339());
    updated.updated_at = Utc::now().to_rfc3339();
    repositories::update_account(&ctx.db, &updated)?;

    let runtime = account_service::wrap_runtime(ctx, updated, Some(snapshot), None)?;
    Ok(LoginFlowResult::Success { account: runtime })
}

pub fn persist_account_credential(
    ctx: &AppContext,
    account_id: &str,
    password: &str,
) -> Result<bool> {
    let account = repositories::find_account(&ctx.db, account_id)?
        .context("账号不存在。")?;
    if password.trim().is_empty() {
        return Err(anyhow!("密码不能为空。"));
    }

    repositories::save_credential(
        &ctx.db,
        &StoredCredential {
            account_id: account.id.clone(),
            email: account.email.clone(),
            password: password.to_string(),
            saved_at: Utc::now().to_rfc3339(),
        },
    )?;
    Ok(true)
}

pub async fn login_account_2fa(
    ctx: &AppContext,
    account_id: &str,
    temp_token: &str,
    code: &str,
) -> Result<AccountRuntime> {
    let (account, site) = account_service::load_account_site(ctx, account_id)?;
    let mut client = Sub2ApiClient::new(&site.base_url, None)?;
    client.complete_2fa(temp_token, code).await?;
    let snapshot = client.build_snapshot(&account, &site).await?;
    repositories::save_snapshot(&ctx.db, &account.id, &snapshot)?;
    repositories::clear_error(&ctx.db, &account.id)?;
    repositories::save_session(&ctx.db, &account.id, &client.serialize())?;

    let mut updated = account.clone();
    updated.last_login_at = Some(Utc::now().to_rfc3339());
    updated.updated_at = Utc::now().to_rfc3339();
    repositories::update_account(&ctx.db, &updated)?;

    account_service::wrap_runtime(ctx, updated, Some(snapshot), None)
}

pub async fn refresh_account(ctx: &AppContext, account_id: &str) -> Result<AccountRuntime> {
    let (account, site) = account_service::load_account_site(ctx, account_id)?;
    let session = repositories::load_session(&ctx.db, &account.id)?;
    let mut client = Sub2ApiClient::new(&site.base_url, session)?;
    ensure_authorized(ctx, &mut client, &account).await?;

    match client.build_snapshot(&account, &site).await {
        Ok(snapshot) => {
            repositories::save_snapshot(&ctx.db, &account.id, &snapshot)?;
            repositories::clear_error(&ctx.db, &account.id)?;
            repositories::save_session(&ctx.db, &account.id, &client.serialize())?;
            account_service::wrap_runtime(ctx, account, Some(snapshot), None)
        }
        Err(error) if is_auth_expired_error(&error) => {
            relogin_with_saved_credential(ctx, &mut client, &account).await?;
            let snapshot = client.build_snapshot(&account, &site).await?;
            repositories::save_snapshot(&ctx.db, &account.id, &snapshot)?;
            repositories::clear_error(&ctx.db, &account.id)?;
            repositories::save_session(&ctx.db, &account.id, &client.serialize())?;
            account_service::wrap_runtime(ctx, account, Some(snapshot), None)
        }
        Err(error) => {
            repositories::save_error(&ctx.db, &account.id, &error.to_string())?;
            Err(error)
        }
    }
}

pub async fn refresh_all_accounts(ctx: &AppContext) -> Result<crate::contracts::OverviewPayload> {
    let ids = repositories::list_account_ids(&ctx.db)?;
    for account_id in ids {
        let _ = refresh_account(ctx, &account_id).await;
    }
    dashboard_service::get_overview(ctx)
}

pub async fn ensure_authorized(
    ctx: &AppContext,
    client: &mut Sub2ApiClient,
    account: &crate::contracts::AccountRecord,
) -> Result<()> {
    if client.has_tokens() {
        return Ok(());
    }
    relogin_with_saved_credential(ctx, client, account).await
}

pub async fn relogin_with_saved_credential(
    ctx: &AppContext,
    client: &mut Sub2ApiClient,
    account: &crate::contracts::AccountRecord,
) -> Result<()> {
    let credential = repositories::load_credential(&ctx.db, &account.id)?
        .context(format!("账号 {} 尚未保存可恢复凭据，请重新登录。", account.label))?;
    let challenge = client.login(&account.email, &credential.password).await?;
    if challenge.requires2fa {
        return Err(anyhow!("账号需要 2FA 验证，请手动重新登录一次。"));
    }
    repositories::save_credential(
        &ctx.db,
        &StoredCredential {
            account_id: account.id.clone(),
            email: account.email.clone(),
            password: credential.password,
            saved_at: Utc::now().to_rfc3339(),
        },
    )?;
    Ok(())
}

pub fn is_auth_expired_error(error: &anyhow::Error) -> bool {
    error.to_string().contains("认证已失效")
}

pub fn mask_email(email: &str) -> String {
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
