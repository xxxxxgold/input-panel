use anyhow::{Context, Result};
use chrono::Utc;

use crate::contracts::{AccountInput, AccountRecord, AccountRuntime, AccountCacheView, AccountCacheStats};
use crate::infrastructure::sqlite::repositories;
use crate::domain::alerts::build_alerts;

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
    wrap_runtime(ctx, account, None, None)
}

pub fn remove_account(ctx: &AppContext, account_id: &str) -> Result<bool> {
    repositories::delete_account(&ctx.db, account_id)?;
    Ok(true)
}

pub fn load_account_site(ctx: &AppContext, account_id: &str) -> Result<(AccountRecord, crate::contracts::SiteRecord)> {
    let account = repositories::find_account(&ctx.db, account_id)?
        .context("账号不存在。")?;
    let site = repositories::find_site(&ctx.db, &account.site_id)?
        .context("账号所属站点不存在。")?;
    Ok((account, site))
}

pub fn wrap_runtime(
    ctx: &AppContext,
    account: AccountRecord,
    cache_view: Option<AccountCacheView>,
    last_error: Option<String>,
) -> Result<AccountRuntime> {
    let state = repositories::read_data_center_state(&ctx.db)?;
    let site = state.sites.iter().find(|item| item.id == account.site_id).cloned();
    let resolved_cache_view = build_runtime_cache_view(&state, &account, site.as_ref()).or(cache_view);
    let has_cache_view = resolved_cache_view.is_some();
    let resolved_error = state
        .sync_statuses
        .get(&account.id)
        .and_then(|rows| rows.iter().find(|item| item.last_error.is_some()))
        .and_then(|item| item.last_error.clone())
        .or(last_error);

    Ok(AccountRuntime {
        account,
        site,
        cache_view: resolved_cache_view,
        session_state: if has_cache_view {
            "ready".into()
        } else if resolved_error.is_some() {
            "expired".into()
        } else {
            "missing".into()
        },
        last_error: resolved_error,
    })
}

pub fn normalize_balance_warning(value: f64) -> f64 {
    if !value.is_finite() || value < 0.0 {
        -1.0
    } else {
        value
    }
}

pub(crate) fn build_runtime_cache_view(
    state: &crate::contracts::DataCenterState,
    account: &AccountRecord,
    site: Option<&crate::contracts::SiteRecord>,
) -> Option<AccountCacheView> {
    let profile = state.profiles.get(&account.id)?;
    let usage_rows = state
        .usage_rows
        .get(&account.id)
        .cloned()
        .unwrap_or_default();
    let key_rows = state
        .keys
        .get(&account.id)
        .cloned()
        .unwrap_or_default();
    let subscription_rows = state
        .subscriptions
        .get(&account.id)
        .cloned()
        .unwrap_or_default();
    let sync_statuses = state
        .sync_statuses
        .get(&account.id)
        .cloned()
        .unwrap_or_default();
    let fetched_at = sync_statuses
        .iter()
        .filter_map(|item| item.last_success_at.clone())
        .max()
        .unwrap_or_else(|| profile.updated_at.clone());
    let keys = key_rows.iter().map(|item| item.row.key.clone()).collect::<Vec<_>>();
    let subscriptions = subscription_rows
        .iter()
        .map(|item| item.row.clone())
        .collect::<Vec<_>>();
    let balance = profile.payload.balance;
    let site_ref = site.cloned()?;
    let alerts = build_alerts(account, &site_ref, balance, &keys, &fetched_at);
    let recent_usage = usage_rows
        .iter()
        .take(20)
        .map(|item| item.row.clone())
        .collect::<Vec<_>>();
    let trend = build_recent_trend(&usage_rows);

    Some(AccountCacheView {
        fetched_at,
        online: true,
        site_name: site_ref.name,
        balance,
        stats: build_cache_view_stats(&keys, &subscriptions, &usage_rows),
        recent_usage,
        trend,
        keys,
        subscriptions: subscriptions.clone(),
        active_subscription: subscriptions
            .iter()
            .find(|item| item.status == "active")
            .cloned()
            .or_else(|| subscriptions.first().cloned()),
        alerts,
    })
}

fn build_cache_view_stats(
    keys: &[crate::contracts::KeyRecord],
    _subscriptions: &[crate::contracts::SubscriptionRecord],
    usage_rows: &[crate::contracts::AccountUsageRowCacheRecord],
) -> AccountCacheStats {
    let today = chrono::Local::now().date_naive().to_string();
    let today_rows = usage_rows
        .iter()
        .filter(|item| item.occurred_at.starts_with(&today))
        .collect::<Vec<_>>();
    let platform_series = build_platform_series(usage_rows);
    AccountCacheStats {
        total_api_keys: keys.len() as i64,
        active_api_keys: keys.iter().filter(|item| item.status == "active").count() as i64,
        today_requests: today_rows.len() as i64,
        total_requests: usage_rows.len() as i64,
        today_actual_cost: today_rows.iter().map(|item| item.row.actual_cost).sum(),
        total_actual_cost: usage_rows.iter().map(|item| item.row.actual_cost).sum(),
        today_cost: today_rows.iter().map(|item| item.row.total_cost).sum(),
        total_cost: usage_rows.iter().map(|item| item.row.total_cost).sum(),
        today_tokens: today_rows.iter().map(|item| item.row.total_tokens).sum(),
        total_tokens: usage_rows.iter().map(|item| item.row.total_tokens).sum(),
        today_input_tokens: today_rows.iter().map(|item| item.row.input_tokens).sum(),
        today_output_tokens: today_rows.iter().map(|item| item.row.output_tokens).sum(),
        average_duration_ms: average_duration_ms(usage_rows),
        by_platform: platform_series,
    }
}

fn build_platform_series(
    usage_rows: &[crate::contracts::AccountUsageRowCacheRecord],
) -> Vec<crate::contracts::PlatformPoint> {
    let today = chrono::Local::now().date_naive().to_string();
    let mut map = std::collections::BTreeMap::<String, crate::contracts::PlatformPoint>::new();
    for item in usage_rows {
        let platform = item.row.platform.clone().unwrap_or_else(|| "unknown".into());
        let entry = map.entry(platform.clone()).or_insert(crate::contracts::PlatformPoint {
            platform,
            total_actual_cost: 0.0,
            today_actual_cost: 0.0,
            total_requests: 0,
            total_tokens: 0,
        });
        entry.total_actual_cost += item.row.actual_cost;
        entry.total_requests += 1;
        entry.total_tokens += item.row.total_tokens;
        if item.occurred_at.starts_with(&today) {
            entry.today_actual_cost += item.row.actual_cost;
        }
    }
    map.into_values().collect()
}

fn average_duration_ms(usage_rows: &[crate::contracts::AccountUsageRowCacheRecord]) -> f64 {
    let durations = usage_rows
        .iter()
        .filter_map(|item| item.row.duration_ms.map(|value| value as f64))
        .collect::<Vec<_>>();
    if durations.is_empty() {
        return 0.0;
    }
    durations.iter().sum::<f64>() / durations.len() as f64
}

fn build_recent_trend(
    usage_rows: &[crate::contracts::AccountUsageRowCacheRecord],
) -> Vec<crate::contracts::TrendPoint> {
    let mut grouped = std::collections::BTreeMap::<String, crate::contracts::TrendPoint>::new();
    for item in usage_rows {
        let bucket = item
            .occurred_at
            .split('T')
            .next()
            .unwrap_or(&item.occurred_at)
            .to_string();
        let entry = grouped.entry(bucket.clone()).or_insert(crate::contracts::TrendPoint {
            bucket,
            actual_cost: 0.0,
            total_cost: 0.0,
            requests: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            total_tokens: 0,
        });
        entry.actual_cost += item.row.actual_cost;
        entry.total_cost += item.row.total_cost;
        entry.requests += 1;
        entry.input_tokens += item.row.input_tokens;
        entry.output_tokens += item.row.output_tokens;
        entry.cache_creation_tokens += item.row.cache_creation_tokens.unwrap_or(0);
        entry.cache_read_tokens += item.row.cache_read_tokens.unwrap_or(0);
        entry.total_tokens += item.row.total_tokens;
    }
    grouped.into_values().collect()
}

