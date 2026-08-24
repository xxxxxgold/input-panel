use anyhow::{Context, Result};
use chrono::Days;

use crate::contracts::{
    AccountAlertPreferences, AccountCacheStats, AccountCacheView, AccountInput, AccountRecord,
    AccountRuntime, AccountUpdateInput, KeyRecord, SubscriptionRecord, TrendPoint, UsageRow,
    UserProfileRecord,
};
use crate::domain::alerts::build_alerts;
use crate::infrastructure::datetime::{now_storage_timestamp, shanghai_today};
use crate::infrastructure::sqlite::repositories;

use super::{
    data_center_service, resource_coordinator::LiveResourceKind,
    upstream_service::UpstreamRequestPolicy, AppContext,
};

/// 账号保存后供桌面适配层决定是否执行一次即时额度重新评估的内部结果。
#[derive(Debug)]
pub struct AccountUpdateOutcome {
    pub account: AccountRuntime,
    pub subscription_quota_alert_transition:
        repositories::SubscriptionQuotaAlertPreferenceTransition,
}

pub fn create_account(ctx: &AppContext, payload: AccountInput) -> Result<AccountRuntime> {
    let alert_preferences = validate_alert_preferences(payload.alert_preferences)?;
    let now = now_storage_timestamp();
    let account = AccountRecord {
        id: uuid::Uuid::new_v4().to_string(),
        site_id: payload.site_id,
        label: payload.label.trim().to_string(),
        email: payload.email.trim().to_string(),
        balance_warning: balance_warning_from_preferences(&alert_preferences),
        last_login_at: None,
        created_at: now.clone(),
        updated_at: now,
    };
    repositories::insert_account_with_alert_preferences(
        &ctx.db,
        &account,
        alert_preferences.subscription_quota_alerts_enabled,
    )?;
    wrap_runtime(ctx, account, None, None)
}

/// 更新账号信息和提醒偏好。额度总开关与 evaluator/dispatcher 共用账号 gate。
pub async fn update_account(
    ctx: &AppContext,
    account_id: &str,
    payload: AccountUpdateInput,
) -> Result<AccountUpdateOutcome> {
    let _gate = ctx
        .live_resources
        .acquire_subscription_quota_alert_account_gate(account_id)
        .await;
    let mut account = repositories::find_account(&ctx.db, account_id)?.context("账号不存在。")?;
    let current_preferences = query_account_alert_preferences_for_account(ctx, &account)?;
    let alert_preferences = match payload.alert_preferences {
        Some(preferences) => validate_alert_preferences(preferences)?,
        None => current_preferences,
    };
    if let Some(label) = payload.label {
        account.label = label.trim().to_string();
    }
    if let Some(email) = payload.email {
        account.email = email.trim().to_string();
    }
    account.balance_warning = balance_warning_from_preferences(&alert_preferences);
    account.updated_at = now_storage_timestamp();
    let subscription_quota_alert_transition = repositories::update_account_with_alert_preferences(
        &ctx.db,
        &account,
        alert_preferences.subscription_quota_alerts_enabled,
    )?;
    Ok(AccountUpdateOutcome {
        account: wrap_runtime(ctx, account, None, None)?,
        subscription_quota_alert_transition,
    })
}

/// 查询账号表单所需的显式提醒偏好，兼容旧 balance_warning 和缺失的偏好行。
pub fn query_account_alert_preferences(
    ctx: &AppContext,
    account_id: &str,
) -> Result<AccountAlertPreferences> {
    let preferences = repositories::find_account_alert_preferences(&ctx.db, account_id)?
        .context("账号不存在。")?;
    Ok(account_alert_preferences_from_values(
        preferences.balance_warning,
        preferences.subscription_quota_alerts_enabled,
    ))
}

pub async fn remove_account(ctx: &AppContext, account_id: &str) -> Result<bool> {
    let _gate = ctx
        .live_resources
        .acquire_subscription_quota_alert_account_gate(account_id)
        .await;
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

fn validate_alert_preferences(
    preferences: AccountAlertPreferences,
) -> Result<AccountAlertPreferences> {
    if !preferences.low_balance_threshold.is_finite() || preferences.low_balance_threshold < 0.0 {
        anyhow::bail!("低余额提醒阈值必须是大于等于 0 的有限数字。")
    }
    Ok(preferences)
}

fn balance_warning_from_preferences(preferences: &AccountAlertPreferences) -> f64 {
    if preferences.low_balance_enabled {
        preferences.low_balance_threshold
    } else {
        -1.0
    }
}

fn query_account_alert_preferences_for_account(
    ctx: &AppContext,
    account: &AccountRecord,
) -> Result<AccountAlertPreferences> {
    let subscription_quota_alerts_enabled =
        repositories::subscription_quota_alerts_enabled(&ctx.db, &account.id)?
            .context("账号不存在。")?;
    Ok(account_alert_preferences_from_values(
        account.balance_warning,
        subscription_quota_alerts_enabled,
    ))
}

fn account_alert_preferences_from_values(
    balance_warning: f64,
    subscription_quota_alerts_enabled: bool,
) -> AccountAlertPreferences {
    let low_balance_enabled = balance_warning.is_finite() && balance_warning >= 0.0;
    AccountAlertPreferences {
        low_balance_enabled,
        low_balance_threshold: if low_balance_enabled {
            balance_warning
        } else {
            0.0
        },
        subscription_quota_alerts_enabled,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_default_preferences_are_valid() {
        assert_eq!(
            validate_alert_preferences(AccountAlertPreferences::default())
                .expect("validate product defaults"),
            AccountAlertPreferences {
                low_balance_enabled: false,
                low_balance_threshold: 0.0,
                subscription_quota_alerts_enabled: true,
            }
        );
    }

    #[test]
    fn explicit_low_balance_threshold_must_be_finite_and_non_negative() {
        for threshold in [-0.01, f64::NAN, f64::INFINITY] {
            let error = validate_alert_preferences(AccountAlertPreferences {
                low_balance_enabled: true,
                low_balance_threshold: threshold,
                subscription_quota_alerts_enabled: true,
            })
            .expect_err("reject invalid threshold");
            assert!(error
                .to_string()
                .contains("低余额提醒阈值必须是大于等于 0 的有限数字"));
        }
    }

    #[test]
    fn explicit_preferences_write_the_legacy_balance_encoding() {
        assert_eq!(
            balance_warning_from_preferences(&AccountAlertPreferences {
                low_balance_enabled: false,
                low_balance_threshold: 6.0,
                subscription_quota_alerts_enabled: true,
            }),
            -1.0
        );
        assert_eq!(
            balance_warning_from_preferences(&AccountAlertPreferences {
                low_balance_enabled: true,
                low_balance_threshold: 0.0,
                subscription_quota_alerts_enabled: false,
            }),
            0.0
        );
    }
}
