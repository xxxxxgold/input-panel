use anyhow::{Context, Result};
use chrono::Utc;

use crate::contracts::{AccountInput, AccountRecord, AccountRuntime, AccountSnapshot};
use crate::infrastructure::sqlite::repositories;

use super::AppContext;

pub fn create_account(ctx: &AppContext, payload: AccountInput) -> Result<AccountRuntime> {
    let now = Utc::now().to_rfc3339();
    let account = AccountRecord {
        id: uuid::Uuid::new_v4().to_string(),
        site_id: payload.site_id,
        label: payload.label.trim().to_string(),
        email: payload.email.trim().to_string(),
        balance_warning: normalize_balance_warning(payload.balance_warning),
        last_login_at: None,
        created_at: now.clone(),
        updated_at: now,
    };
    repositories::insert_account(&ctx.db, &account)?;
    wrap_runtime(ctx, account, None, None)
}

pub fn update_account(
    ctx: &AppContext,
    account_id: &str,
    label: Option<String>,
    email: Option<String>,
    balance_warning: Option<f64>,
) -> Result<AccountRuntime> {
    let mut account = repositories::find_account(&ctx.db, account_id)?
        .context("账号不存在。")?;
    if let Some(label) = label {
        account.label = label.trim().to_string();
    }
    if let Some(email) = email {
        account.email = email.trim().to_string();
    }
    if let Some(balance_warning) = balance_warning {
        account.balance_warning = normalize_balance_warning(balance_warning);
    }
    account.updated_at = Utc::now().to_rfc3339();
    repositories::update_account(&ctx.db, &account)?;
    let state = repositories::read_state(&ctx.db)?;
    let snapshot = state.snapshots.get(&account.id).cloned();
    let last_error = state.errors.get(&account.id).cloned().flatten();
    wrap_runtime(ctx, account, snapshot, last_error)
}

pub fn remove_account(ctx: &AppContext, account_id: &str) -> Result<bool> {
    repositories::delete_account(&ctx.db, account_id)?;
    Ok(true)
}

pub fn load_account_site(ctx: &AppContext, account_id: &str) -> Result<(AccountRecord, crate::contracts::SiteRecord)> {
    let state = repositories::read_state(&ctx.db)?;
    let account = state
        .accounts
        .into_iter()
        .find(|item| item.id == account_id)
        .context("账号不存在。")?;
    let site = state
        .sites
        .into_iter()
        .find(|item| item.id == account.site_id)
        .context("账号所属站点不存在。")?;
    Ok((account, site))
}

pub fn wrap_runtime(
    ctx: &AppContext,
    account: AccountRecord,
    snapshot: Option<AccountSnapshot>,
    last_error: Option<String>,
) -> Result<AccountRuntime> {
    let state = repositories::read_state(&ctx.db)?;
    let site = state.sites.iter().find(|item| item.id == account.site_id).cloned();
    let resolved_snapshot = state.snapshots.get(&account.id).cloned().or(snapshot);
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

pub fn normalize_balance_warning(value: f64) -> f64 {
    if !value.is_finite() || value < 0.0 {
        -1.0
    } else {
        value
    }
}
