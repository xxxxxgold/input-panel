use anyhow::{Context, Result};
use chrono::Days;

use crate::contracts::{
    AccountCacheStats, AccountCacheView, AccountInput, AccountRecord, AccountRuntime, KeyRecord,
    SubscriptionRecord, TrendPoint, UsageRow, UserProfileRecord,
};
use crate::domain::alerts::build_alerts;
use crate::infrastructure::datetime::{now_storage_timestamp, shanghai_today};
use crate::infrastructure::sqlite::repositories;

use super::{
    data_center_service, resource_coordinator::LiveResourceKind,
    upstream_service::UpstreamRequestPolicy, AppContext,
};

pub fn create_account(ctx: &AppContext, payload: AccountInput) -> Result<AccountRuntime> {
    let now = now_storage_timestamp();
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
    let mut account = repositories::find_account(&ctx.db, account_id)?.context("账号不存在。")?;
    if let Some(label) = label {
        account.label = label.trim().to_string();
    }
    if let Some(email) = email {
        account.email = email.trim().to_string();
    }
    if let Some(balance_warning) = balance_warning {
        account.balance_warning = normalize_balance_warning(balance_warning);
    }
    account.updated_at = now_storage_timestamp();
    repositories::update_account(&ctx.db, &account)?;
    wrap_runtime(ctx, account, None, None)
}

pub fn remove_account(ctx: &AppContext, account_id: &str) -> Result<bool> {
    repositories::delete_account(&ctx.db, account_id)?;
    Ok(true)
}

pub fn load_account_site(
    ctx: &AppContext,
    account_id: &str,
) -> Result<(AccountRecord, crate::contracts::SiteRecord)> {
    let account = repositories::find_account(&ctx.db, account_id)?.context("账号不存在。")?;
    let site =
        repositories::find_site(&ctx.db, &account.site_id)?.context("账号所属站点不存在。")?;
    Ok((account, site))
}

pub fn wrap_runtime(
    ctx: &AppContext,
    account: AccountRecord,
    cache_view: Option<AccountCacheView>,
    last_error: Option<String>,
) -> Result<AccountRuntime> {
    let site = repositories::find_site(&ctx.db, &account.site_id)?;
    let has_session = repositories::load_session(&ctx.db, &account.id)?.is_some();
    let has_cache_view = cache_view.is_some();
    let resolved_error = last_error;

    Ok(AccountRuntime {
        account,
        site,
        cache_view,
        session_state: if has_cache_view || has_session {
            "ready".into()
        } else if resolved_error.is_some() {
            "expired".into()
        } else {
            "missing".into()
        },
        last_error: resolved_error,
    })
}

pub async fn load_live_runtime(ctx: &AppContext, account: AccountRecord) -> Result<AccountRuntime> {
    let site = repositories::find_site(&ctx.db, &account.site_id)?;
    let has_session = repositories::load_session(&ctx.db, &account.id)?.is_some();
    let Some(site_ref) = site.as_ref() else {
        return Ok(AccountRuntime {
            account,
            site,
            cache_view: None,
            session_state: "missing".into(),
            last_error: Some("账号所属站点不存在。".into()),
        });
    };
    if !has_session {
        return Ok(AccountRuntime {
            account,
            site,
            cache_view: None,
            session_state: "missing".into(),
            last_error: None,
        });
    }

    let now = now_storage_timestamp();
    let usage_ctx = ctx.clone();
    let usage_account_id = account.id.clone();
    let usage_snapshot_task = tokio::task::spawn_blocking(move || {
        load_usage_cache_snapshot(&usage_ctx, &usage_account_id)
    });
    let (usage_snapshot_result, profile_result, keys_result, subscriptions_result) = tokio::join!(
        usage_snapshot_task,
        ctx.live_resources
            .get_or_fetch(&account.id, LiveResourceKind::Profile, false, || async {
                data_center_service::fetch_profile(
                    ctx,
                    &account.id,
                    UpstreamRequestPolicy::ReadOnly,
                )
                .await
            },),
        ctx.live_resources
            .get_or_fetch(&account.id, LiveResourceKind::Keys, false, || async {
                data_center_service::fetch_keys(ctx, &account.id, UpstreamRequestPolicy::ReadOnly)
                    .await
            },),
        ctx.live_resources.get_or_fetch(
            &account.id,
            LiveResourceKind::Subscriptions,
            false,
            || async {
                data_center_service::fetch_subscriptions(
                    ctx,
                    &account.id,
                    UpstreamRequestPolicy::ReadOnly,
                )
                .await
            },
        ),
    );
    let (stats, recent_usage, trend) = usage_snapshot_result
        .map_err(anyhow::Error::from)?
        .context("读取本地 usage 缓存失败。")?;

    let mut errors = Vec::new();
    let profile = match profile_result {
        Ok(profile) => profile,
        Err(error) => {
            errors.push(error.to_string());
            fallback_profile(&account)
        }
    };
    let keys = match keys_result {
        Ok(keys) => keys,
        Err(error) => {
            errors.push(error.to_string());
            Vec::new()
        }
    };
    let subscriptions = match subscriptions_result {
        Ok(subscriptions) => subscriptions,
        Err(error) => {
            errors.push(error.to_string());
            Vec::new()
        }
    };
    let last_error = errors.first().cloned();
    let key_rows = keys.iter().map(|item| item.key.clone()).collect::<Vec<_>>();
    let cache_view = Some(build_runtime_cache_view(
        &account,
        site_ref,
        &profile,
        key_rows,
        subscriptions,
        stats,
        recent_usage,
        trend,
        now,
    ));

    Ok(AccountRuntime {
        account,
        site,
        cache_view,
        session_state: if last_error.is_none() {
            "ready".into()
        } else {
            "expired".into()
        },
        last_error,
    })
}

fn load_usage_cache_snapshot(
    ctx: &AppContext,
    account_id: &str,
) -> Result<(AccountCacheStats, Vec<UsageRow>, Vec<TrendPoint>)> {
    let mut stats = repositories::summarize_usage_row_cache(&ctx.db, account_id)?;
    stats.by_platform = repositories::list_usage_platform_points(&ctx.db, account_id)?;
    stats.by_model = repositories::list_usage_model_points(&ctx.db, account_id)?;
    let today = shanghai_today();
    let trend_start = (today - Days::new(6)).to_string();
    let trend_end = today.to_string();
    let recent_usage = repositories::list_recent_usage_rows(&ctx.db, account_id, 20)?;
    let trend = repositories::list_usage_trend_points(
        &ctx.db,
        account_id,
        Some(&trend_start),
        Some(&trend_end),
    )?;
    Ok((stats, recent_usage, trend))
}

pub fn normalize_balance_warning(value: f64) -> f64 {
    if !value.is_finite() || value < 0.0 {
        -1.0
    } else {
        value
    }
}

pub(crate) fn build_runtime_cache_view(
    account: &AccountRecord,
    site: &crate::contracts::SiteRecord,
    profile: &UserProfileRecord,
    key_rows: Vec<KeyRecord>,
    subscriptions: Vec<SubscriptionRecord>,
    mut stats: AccountCacheStats,
    recent_usage: Vec<UsageRow>,
    trend: Vec<TrendPoint>,
    fetched_at: String,
) -> AccountCacheView {
    let balance = profile.balance;
    let alerts = build_alerts(account, site, balance, &key_rows, &fetched_at);
    stats.total_api_keys = key_rows.len() as i64;
    stats.active_api_keys = key_rows
        .iter()
        .filter(|item| item.status == "active")
        .count() as i64;

    AccountCacheView {
        fetched_at,
        online: true,
        site_name: site.name.clone(),
        balance,
        stats,
        recent_usage,
        trend,
        keys: key_rows,
        subscriptions: subscriptions.clone(),
        active_subscription: subscriptions
            .iter()
            .find(|item| item.status == "active")
            .cloned()
            .or_else(|| subscriptions.first().cloned()),
        alerts,
    }
}

fn fallback_profile(account: &AccountRecord) -> UserProfileRecord {
    UserProfileRecord {
        id: 0,
        email: account.email.clone(),
        username: None,
        avatar_url: None,
        role: "user".into(),
        balance: 0.0,
        concurrency: 0,
        status: "unknown".into(),
        last_active_at: None,
        created_at: Some(account.created_at.clone()),
        updated_at: Some(account.updated_at.clone()),
        total_recharged: None,
        rpm_limit: None,
        balance_notify_enabled: Some(false),
        balance_notify_threshold_type: None,
        balance_notify_threshold: None,
        balance_notify_extra_emails: Some(Vec::new()),
        identities: std::collections::HashMap::new(),
        auth_bindings: std::collections::HashMap::new(),
        identity_bindings: std::collections::HashMap::new(),
    }
}
