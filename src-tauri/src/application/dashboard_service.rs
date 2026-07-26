use anyhow::{Context, Result};
use chrono::{Days, NaiveDate, Utc};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::{sync::Semaphore, task::JoinSet, time::timeout};

use crate::contracts::{
    AccountAlert, AccountCacheView, AccountRecord, AccountRuntime, OverviewKeyRecord,
    OverviewModelPoint, OverviewPayload, OverviewSubscriptionRecord, OverviewTotals, OverviewUsageRow,
    PlatformPoint, SiteRecord, StoredSession, TrendPoint,
};
use crate::infrastructure::datetime::{shanghai_today, storage_timestamp_date};
use crate::infrastructure::sqlite::repositories;

use super::{account_service, desktop_ui_service, AppContext};

const OVERVIEW_TREND_DAYS: u64 = 7;
const OVERVIEW_SHELL_USAGE_LIMIT: i64 = 10;
// 每账号 live runtime 会并发发起 3 个上游请求，这里限制同时加载的账号数，
// 避免账号多时对上游造成瞬时请求风暴。
const OVERVIEW_LIVE_ACCOUNT_CONCURRENCY: usize = 3;

pub async fn get_overview(ctx: &AppContext) -> Result<OverviewPayload> {
    let sites = repositories::list_sites(&ctx.db)?;
    let accounts = repositories::list_accounts(&ctx.db)?;
    let sessions = repositories::list_sessions(&ctx.db)?;
    let accounts = build_runtime_accounts(ctx, &sites, &accounts, &sessions).await?;
    Ok(build_overview_payload(&sites, &accounts))
}

pub fn get_overview_shell(ctx: &AppContext) -> Result<OverviewPayload> {
    let sites = repositories::list_sites(&ctx.db)?;
    let accounts = repositories::list_accounts(&ctx.db)?;
    let sessions = repositories::list_sessions(&ctx.db)?;
    let accounts = build_runtime_shell_accounts(ctx, &sites, &accounts, &sessions, true)?;
    Ok(build_overview_payload(&sites, &accounts))
}

pub fn get_overview_shell_lite(ctx: &AppContext) -> Result<OverviewPayload> {
    let sites = repositories::list_sites(&ctx.db)?;
    let accounts = repositories::list_accounts(&ctx.db)?;
    let sessions = repositories::list_sessions(&ctx.db)?;
    let accounts = build_runtime_shell_accounts(ctx, &sites, &accounts, &sessions, false)?;
    Ok(build_overview_payload(&sites, &accounts))
}

pub(crate) fn build_overview_payload(
    sites: &[crate::contracts::SiteRecord],
    accounts: &[AccountRuntime],
) -> OverviewPayload {
    let mut totals = OverviewTotals {
        balance: 0.0,
        total_sites: sites.len() as i64,
        total_accounts: accounts.len() as i64,
        total_api_keys: 0,
        active_api_keys: 0,
        today_requests: 0,
        total_requests: 0,
        today_actual_cost: 0.0,
        total_actual_cost: 0.0,
        today_tokens: 0,
        total_tokens: 0,
    };

    let mut alerts: Vec<AccountAlert> = Vec::new();
    let mut trend_map = std::collections::HashMap::<String, TrendPoint>::new();
    let mut recent_usage: Vec<OverviewUsageRow> = Vec::new();
    let mut subscriptions: Vec<OverviewSubscriptionRecord> = Vec::new();
    let mut keys: Vec<OverviewKeyRecord> = Vec::new();
    let mut platform_map = std::collections::HashMap::<String, PlatformPoint>::new();
    let mut model_map = std::collections::HashMap::<String, OverviewModelPoint>::new();

    for account in accounts {
        if let Some(cache_view) = &account.cache_view {
            totals.balance += cache_view.balance;
            totals.total_api_keys += cache_view.stats.total_api_keys;
            totals.active_api_keys += cache_view.stats.active_api_keys;
            totals.today_requests += cache_view.stats.today_requests;
            totals.total_requests += cache_view.stats.total_requests;
            totals.today_actual_cost += cache_view.stats.today_actual_cost;
            totals.total_actual_cost += cache_view.stats.total_actual_cost;
            totals.today_tokens += cache_view.stats.today_tokens;
            totals.total_tokens += cache_view.stats.total_tokens;

            alerts.extend(filter_account_alerts(account, cache_view));
            recent_usage.extend(cache_view.recent_usage.iter().cloned().map(|row| OverviewUsageRow {
                row,
                account_id: account.account.id.clone(),
                account_label: account.account.label.clone(),
                site_id: account.account.site_id.clone(),
                site_name: account
                    .site
                    .as_ref()
                    .map(|item| item.name.clone())
                    .unwrap_or_else(|| cache_view.site_name.clone()),
            }));

            subscriptions.extend(
                cache_view
                    .subscriptions
                    .iter()
                    .cloned()
                    .map(|subscription| OverviewSubscriptionRecord {
                        subscription,
                        account_id: account.account.id.clone(),
                        account_label: account.account.label.clone(),
                        site_id: account.account.site_id.clone(),
                        site_name: account
                            .site
                            .as_ref()
                            .map(|item| item.name.clone())
                            .unwrap_or_else(|| cache_view.site_name.clone()),
                    }),
            );

            keys.extend(cache_view.keys.iter().cloned().map(|key| OverviewKeyRecord {
                key,
                account_id: account.account.id.clone(),
                account_label: account.account.label.clone(),
                site_id: account.account.site_id.clone(),
                site_name: account
                    .site
                    .as_ref()
                    .map(|item| item.name.clone())
                    .unwrap_or_else(|| cache_view.site_name.clone()),
            }));

            for point in &cache_view.trend {
                let entry = trend_map.entry(point.bucket.clone()).or_insert(TrendPoint {
                    bucket: point.bucket.clone(),
                    actual_cost: 0.0,
                    total_cost: 0.0,
                    requests: 0,
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_creation_tokens: 0,
                    cache_read_tokens: 0,
                    total_tokens: 0,
                });
                entry.actual_cost += point.actual_cost;
                entry.total_cost += point.total_cost;
                entry.requests += point.requests;
                entry.input_tokens += point.input_tokens;
                entry.output_tokens += point.output_tokens;
                entry.cache_creation_tokens += point.cache_creation_tokens;
                entry.cache_read_tokens += point.cache_read_tokens;
                entry.total_tokens += point.total_tokens;
            }

            for point in &cache_view.stats.by_platform {
                let entry = platform_map.entry(point.platform.clone()).or_insert(PlatformPoint {
                    platform: point.platform.clone(),
                    total_actual_cost: 0.0,
                    today_actual_cost: 0.0,
                    total_requests: 0,
                    total_tokens: 0,
                });
                entry.total_actual_cost += point.total_actual_cost;
                entry.today_actual_cost += point.today_actual_cost;
                entry.total_requests += point.total_requests;
                entry.total_tokens += point.total_tokens;
            }

            for point in &cache_view.stats.by_model {
                let entry = model_map.entry(point.model.clone()).or_insert(OverviewModelPoint {
                    model: point.model.clone(),
                    requests: 0,
                    total_tokens: 0,
                    actual_cost: 0.0,
                    total_cost: 0.0,
                });
                entry.requests += point.requests;
                entry.total_tokens += point.total_tokens;
                entry.actual_cost += point.actual_cost;
                entry.total_cost += point.total_cost;
            }
        } else if let Some(last_error) = &account.last_error {
            alerts.push(AccountAlert {
                id: format!("{}:error", account.account.id),
                severity: "critical".into(),
                title: format!("{} 拉取失败", account.account.label),
                detail: last_error.clone(),
                site_id: account.account.site_id.clone(),
                account_id: account.account.id.clone(),
                created_at: Utc::now().to_rfc3339(),
            });
        }
    }

    alerts.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    recent_usage.sort_by(|a, b| {
        b.row
            .created_at
            .cmp(&a.row.created_at)
            .then_with(|| a.account_label.cmp(&b.account_label))
            .then_with(|| a.row.model.cmp(&b.row.model))
    });
    subscriptions.sort_by(|a, b| {
        let left_expiry = a
            .subscription
            .expires_at
            .as_deref()
            .unwrap_or("9999-12-31T23:59:59.999Z");
        let right_expiry = b
            .subscription
            .expires_at
            .as_deref()
            .unwrap_or("9999-12-31T23:59:59.999Z");
        left_expiry
            .cmp(right_expiry)
            .then_with(|| a.account_label.cmp(&b.account_label))
            .then_with(|| a.subscription.name.cmp(&b.subscription.name))
    });
    keys.sort_by(|a, b| {
        let left_used_at = a.key.last_used_at.as_deref().unwrap_or("");
        let right_used_at = b.key.last_used_at.as_deref().unwrap_or("");
        right_used_at
            .cmp(left_used_at)
            .then_with(|| a.account_label.cmp(&b.account_label))
            .then_with(|| a.key.name.cmp(&b.key.name))
    });

    let trend = build_recent_overview_trend(trend_map);

    let mut platform_series: Vec<PlatformPoint> = platform_map.into_values().collect();
    platform_series.sort_by(|a, b| {
        b.total_actual_cost
            .partial_cmp(&a.total_actual_cost)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut model_series: Vec<OverviewModelPoint> = model_map.into_values().collect();
    model_series.sort_by(|a, b| {
        b.actual_cost
            .partial_cmp(&a.actual_cost)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.requests.cmp(&a.requests))
            .then_with(|| a.model.cmp(&b.model))
    });

    OverviewPayload {
        sites: sites.to_vec(),
        accounts: accounts.to_vec(),
        totals,
        alerts,
        platform_series,
        model_series,
        trend,
        recent_usage,
        subscriptions,
        keys,
        generated_at: Utc::now().to_rfc3339(),
    }
}

async fn build_runtime_accounts(
    ctx: &AppContext,
    sites: &[SiteRecord],
    account_rows: &[AccountRecord],
    sessions: &HashMap<String, StoredSession>,
) -> Result<Vec<AccountRuntime>> {
    let overview_account_runtime_timeout_ms = desktop_ui_service::get_desktop_ui_prefs(ctx)
        .map(|prefs| prefs.overview_account_runtime_timeout_ms.max(1) as u64)
        .unwrap_or(desktop_ui_service::DEFAULT_OVERVIEW_ACCOUNT_RUNTIME_TIMEOUT_MS as u64);
    let site_by_id = sites
        .iter()
        .cloned()
        .map(|site| (site.id.clone(), site))
        .collect::<HashMap<_, _>>();
    let mut accounts = Vec::with_capacity(account_rows.len());
    accounts.resize_with(account_rows.len(), || None);
    let mut tasks = JoinSet::new();
    let live_permits = Arc::new(Semaphore::new(OVERVIEW_LIVE_ACCOUNT_CONCURRENCY));

    for (index, account) in account_rows.iter().cloned().enumerate() {
        let site = site_by_id.get(&account.site_id).cloned();
        let has_session = sessions.contains_key(&account.id);
        if !has_session {
            accounts[index] = Some(build_overview_runtime(account, site, "missing", None));
            continue;
        }
        if site.is_none() {
            accounts[index] = Some(build_overview_runtime(
                account,
                None,
                "missing",
                Some("账号所属站点不存在。".into()),
            ));
            continue;
        }

        let ctx = ctx.clone();
        let live_permits = Arc::clone(&live_permits);
        tasks.spawn(async move {
            let Ok(_permit) = live_permits.acquire_owned().await else {
                return Ok((
                    index,
                    build_overview_runtime(
                        account,
                        site,
                        "expired",
                        Some("总览并发控制器已关闭。".into()),
                    ),
                ));
            };
            let runtime = match timeout(
                Duration::from_millis(overview_account_runtime_timeout_ms),
                account_service::load_live_runtime(&ctx, account.clone()),
            )
            .await
            {
                Ok(Ok(runtime)) => runtime,
                Ok(Err(error)) => {
                    build_overview_runtime(account, site, "expired", Some(error.to_string()))
                }
                Err(_) => build_overview_runtime(
                    account,
                    site,
                    "expired",
                    Some(format!(
                        "总览拉取超时（{} ms），请稍后重试。",
                        overview_account_runtime_timeout_ms
                    )),
                ),
            };
            Ok::<_, anyhow::Error>((index, runtime))
        });
    }

    while let Some(task) = tasks.join_next().await {
        let (index, runtime) = task.map_err(anyhow::Error::from)??;
        accounts[index] = Some(runtime);
    }

    accounts
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .context("总览账号运行态未完整收集。")
}

fn build_overview_runtime(
    account: AccountRecord,
    site: Option<SiteRecord>,
    session_state: &str,
    last_error: Option<String>,
) -> AccountRuntime {
    AccountRuntime {
        account,
        site,
        cache_view: None,
        session_state: session_state.to_string(),
        last_error,
    }
}

fn build_runtime_shell_accounts(
    ctx: &AppContext,
    sites: &[SiteRecord],
    account_rows: &[AccountRecord],
    sessions: &HashMap<String, StoredSession>,
    include_recent_usage: bool,
) -> Result<Vec<AccountRuntime>> {
    let site_by_id = sites
        .iter()
        .cloned()
        .map(|site| (site.id.clone(), site))
        .collect::<HashMap<_, _>>();
    let mut accounts = Vec::with_capacity(account_rows.len());

    for account in account_rows.iter().cloned() {
        let site = site_by_id.get(&account.site_id).cloned();
        let Some(session) = sessions.get(&account.id) else {
            accounts.push(build_overview_runtime(account, site, "missing", None));
            continue;
        };
        let fetched_at = repositories::load_usage_cache_last_updated_at(&ctx.db, &account.id)?
            .unwrap_or_else(|| session.saved_at.clone());
        let site_name = site
            .as_ref()
            .map(|item| item.name.clone())
            .unwrap_or_else(|| "未命名站点".into());
        let today = shanghai_today();
        let trend_start = (today - Days::new(OVERVIEW_TREND_DAYS.saturating_sub(1))).to_string();
        let trend_end = today.to_string();
        let usage_summary = repositories::summarize_overview_usage_cache(
            &ctx.db,
            &account.id,
            Some(&trend_start),
            Some(&trend_end),
        )?;
        let recent_usage = if include_recent_usage {
            repositories::list_recent_usage_rows(&ctx.db, &account.id, OVERVIEW_SHELL_USAGE_LIMIT)?
        } else {
            Vec::new()
        };
        let cache_view = build_overview_shell_cache_view(
            site_name,
            fetched_at,
            usage_summary.stats,
            recent_usage,
            usage_summary.trend,
        );
        accounts.push(AccountRuntime {
            account,
            site,
            cache_view: Some(cache_view),
            session_state: "ready".into(),
            last_error: None,
        });
    }

    Ok(accounts)
}

fn build_overview_shell_cache_view(
    site_name: String,
    fetched_at: String,
    stats: crate::contracts::AccountCacheStats,
    recent_usage: Vec<crate::contracts::UsageRow>,
    trend: Vec<TrendPoint>,
) -> AccountCacheView {
    AccountCacheView {
        fetched_at,
        online: true,
        site_name,
        balance: 0.0,
        stats,
        recent_usage,
        trend,
        keys: Vec::new(),
        subscriptions: Vec::new(),
        active_subscription: None,
        alerts: Vec::new(),
    }
}

fn filter_account_alerts(
    account: &AccountRuntime,
    cache_view: &crate::contracts::AccountCacheView,
) -> Vec<AccountAlert> {
    cache_view
        .alerts
        .iter()
        .filter(|alert| account.account.balance_warning >= 0.0 || !is_balance_alert(alert))
        .cloned()
        .collect()
}

fn is_balance_alert(alert: &AccountAlert) -> bool {
    alert.id.ends_with(":balance-empty") || alert.id.ends_with(":balance-low")
}

fn build_recent_overview_trend(
    trend_map: std::collections::HashMap<String, TrendPoint>,
) -> Vec<TrendPoint> {
    let today = shanghai_today();
    let start = today - Days::new(OVERVIEW_TREND_DAYS.saturating_sub(1));
    let mut recent_points: std::collections::HashMap<NaiveDate, TrendPoint> = std::collections::HashMap::new();

    for point in trend_map.into_values() {
        let Some(date) = parse_trend_bucket(&point.bucket) else {
            continue;
        };
        if date < start || date > today {
            continue;
        }
        let entry = recent_points
            .entry(date)
            .or_insert_with(|| empty_trend_point(date.to_string()));
        entry.actual_cost += point.actual_cost;
        entry.total_cost += point.total_cost;
        entry.requests += point.requests;
        entry.input_tokens += point.input_tokens;
        entry.output_tokens += point.output_tokens;
        entry.cache_creation_tokens += point.cache_creation_tokens;
        entry.cache_read_tokens += point.cache_read_tokens;
        entry.total_tokens += point.total_tokens;
    }

    if recent_points.is_empty() {
        return Vec::new();
    }

    (0..OVERVIEW_TREND_DAYS)
        .map(|offset| {
            let date = start + Days::new(offset);
            recent_points
                .remove(&date)
                .unwrap_or_else(|| empty_trend_point(date.to_string()))
        })
        .collect()
}

fn empty_trend_point(bucket: String) -> TrendPoint {
    TrendPoint {
        bucket,
        actual_cost: 0.0,
        total_cost: 0.0,
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: 0,
    }
}

fn parse_trend_bucket(value: &str) -> Option<NaiveDate> {
    storage_timestamp_date(value)
        .ok()
        .or_else(|| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use axum::{routing::get, Json, Router};
    use chrono::Days;
    use serde_json::json;
    use tokio::sync::Mutex;

    use super::{build_overview_payload, get_overview};
    use crate::application::{context::SyncTaskHandle, keys_service, AppContext};
    use crate::contracts::{
        AccountRecord, AccountRuntime, AccountCacheView, KeyRecord, OverviewModelPoint, PlatformPoint, SiteRecord,
        AccountAlert, AccountCacheStats, StoredSession, SubscriptionRecord, TrendPoint, UsageRow,
    };
    use crate::infrastructure::files::AppPaths;
    use crate::infrastructure::datetime::shanghai_today;
    use crate::infrastructure::sqlite::{repositories, Database};

    #[test]
    fn aggregates_totals_and_collections() {
        let accounts = vec![build_runtime("account-1", "site-1", "主账号", Some(build_test_cache_view(
            vec![TrendPoint {
                bucket: "2026-06-05".into(),
                actual_cost: 1.3,
                total_cost: 1.6,
                requests: 30,
                input_tokens: 3600,
                output_tokens: 4200,
                cache_creation_tokens: 300,
                cache_read_tokens: 900,
                total_tokens: 9000,
            }],
            vec![AccountAlert {
                id: "alert-1".into(),
                severity: "high".into(),
                title: "余额偏低".into(),
                detail: "快要见底了".into(),
                site_id: "site-1".into(),
                account_id: "account-1".into(),
                created_at: "2026-06-05T08:00:00.000Z".into(),
            }],
        )), None)];

        let overview = build_overview_payload(&[build_site("site-1")], &accounts);

        assert_eq!(overview.totals.balance, 8.0);
        assert_eq!(overview.totals.total_api_keys, 2);
        assert_eq!(overview.alerts.len(), 1);
        assert_eq!(overview.recent_usage.len(), 1);
        assert_eq!(overview.keys.len(), 1);
        assert_eq!(overview.subscriptions.len(), 1);
        assert_eq!(overview.model_series.len(), 1);
        assert_eq!(overview.model_series[0].model, "gpt-4.1");
        assert!(overview.accounts[0].cache_view.is_some());
    }

    #[test]
    fn fills_recent_seven_day_window_and_filters_stale_trend_points() {
        let today = shanghai_today();
        let window_start = today - Days::new(6);
        let stale_day = window_start - Days::new(3);
        let mid_day = today - Days::new(2);

        let accounts = vec![
            build_runtime(
                "account-1",
                "site-1",
                "主账号",
                Some(build_test_cache_view(
                    vec![
                        TrendPoint {
                            bucket: stale_day.to_string(),
                            actual_cost: 9.9,
                            total_cost: 9.9,
                            requests: 99,
                            input_tokens: 900,
                            output_tokens: 900,
                            cache_creation_tokens: 90,
                            cache_read_tokens: 90,
                            total_tokens: 1800,
                        },
                        TrendPoint {
                            bucket: today.to_string(),
                            actual_cost: 1.25,
                            total_cost: 1.4,
                            requests: 2,
                            input_tokens: 120,
                            output_tokens: 40,
                            cache_creation_tokens: 0,
                            cache_read_tokens: 300,
                            total_tokens: 460,
                        },
                    ],
                    vec![],
                )),
                None,
            ),
            build_runtime(
                "account-2",
                "site-1",
                "副账号",
                Some(build_test_cache_view(
                    vec![
                        TrendPoint {
                            bucket: mid_day.to_string(),
                            actual_cost: 0.75,
                            total_cost: 0.8,
                            requests: 3,
                            input_tokens: 50,
                            output_tokens: 20,
                            cache_creation_tokens: 0,
                            cache_read_tokens: 80,
                            total_tokens: 150,
                        },
                        TrendPoint {
                            bucket: today.to_string(),
                            actual_cost: 0.5,
                            total_cost: 0.55,
                            requests: 1,
                            input_tokens: 30,
                            output_tokens: 10,
                            cache_creation_tokens: 0,
                            cache_read_tokens: 20,
                            total_tokens: 60,
                        },
                    ],
                    vec![],
                )),
                None,
            ),
        ];

        let overview = build_overview_payload(&[build_site("site-1")], &accounts);

        assert_eq!(overview.trend.len(), 7);
        assert_eq!(overview.trend.first().map(|item| item.bucket.as_str()), Some(window_start.to_string().as_str()));
        assert_eq!(overview.trend.last().map(|item| item.bucket.as_str()), Some(today.to_string().as_str()));
        assert!(overview.trend.iter().all(|item| item.bucket != stale_day.to_string()));

        let zero_bucket = (today - Days::new(1)).to_string();
        let zero_point = overview
            .trend
            .iter()
            .find(|item| item.bucket == zero_bucket)
            .expect("zero-filled bucket");
        assert_eq!(zero_point.requests, 0);
        assert_eq!(zero_point.actual_cost, 0.0);

        let today_bucket = today.to_string();
        let today_point = overview
            .trend
            .iter()
            .find(|item| item.bucket == today_bucket)
            .expect("today bucket");
        assert_eq!(today_point.requests, 3);
        assert!((today_point.actual_cost - 1.75).abs() < f64::EPSILON);
        assert_eq!(today_point.total_tokens, 520);
    }

    #[test]
    fn filters_stored_balance_alerts_when_balance_warning_is_disabled() {
        let mut cache_view = build_test_cache_view(
            vec![],
            vec![
                AccountAlert {
                    id: "account-1:balance-empty".into(),
                    severity: "critical".into(),
                    title: "主账号 余额已耗尽".into(),
                    detail: "AI INPUT 当前余额为 0".into(),
                    site_id: "site-1".into(),
                    account_id: "account-1".into(),
                    created_at: "2026-06-15T00:00:00Z".into(),
                },
                AccountAlert {
                    id: "account-1:keys-exhausted".into(),
                    severity: "medium".into(),
                    title: "主账号 存在额度耗尽的 Keys".into(),
                    detail: "共 1 个 key 处于 quota_exhausted 状态。".into(),
                    site_id: "site-1".into(),
                    account_id: "account-1".into(),
                    created_at: "2026-06-15T00:00:00Z".into(),
                },
            ],
        );
        cache_view.balance = 0.0;

        let mut account = build_runtime("account-1", "site-1", "主账号", Some(cache_view), None);
        account.account.balance_warning = -1.0;
        let overview = build_overview_payload(&[build_site("site-1")], &[account]);

        assert_eq!(overview.alerts.len(), 1);
        assert_eq!(overview.alerts[0].id, "account-1:keys-exhausted");
    }

    #[tokio::test]
    async fn overview_kpi_uses_live_key_rows_when_usage_cache_summary_has_no_key_counts() {
        let key_requests = Arc::new(AtomicUsize::new(0));
        let app = {
            let key_requests = Arc::clone(&key_requests);
            Router::new()
                .route(
                    "/api/v1/user/profile",
                    get(|| async { Json(json!({ "email": "mock@example.com", "balance": 12.5 })) }),
                )
                .route(
                    "/api/v1/subscriptions",
                    get(|| async { Json(json!({ "items": [] })) }),
                )
                .route(
                    "/api/v1/keys",
                    get(move || {
                        let key_requests = Arc::clone(&key_requests);
                        async move {
                            key_requests.fetch_add(1, Ordering::SeqCst);
                            Json(json!({
                                "items": [
                                    {
                                        "id": "key-live-active",
                                        "name": "Active Key",
                                        "status": "active",
                                        "platform": "openai"
                                    },
                                    {
                                        "id": "key-live-inactive",
                                        "name": "Inactive Key",
                                        "status": "inactive",
                                        "platform": "openai"
                                    }
                                ],
                                "pages": 1
                            }))
                        }
                    }),
                )
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind upstream mock");
        let address = listener.local_addr().expect("read upstream mock address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve upstream mock");
        });

        let ctx = build_live_key_source_test_context();
        seed_live_key_source_account(&ctx, &format!("http://{address}"));
        repositories::merge_usage_row_cache(
            &ctx.db,
            "account-live-keys",
            &[live_key_source_usage_row()],
            "2026-07-16T00:00:00Z",
        )
        .expect("seed usage cache");

        let usage_cache_summary = repositories::summarize_usage_row_cache(&ctx.db, "account-live-keys")
            .expect("summarize usage cache");
        assert_eq!(usage_cache_summary.total_api_keys, 0);
        assert_eq!(usage_cache_summary.active_api_keys, 0);
        assert_eq!(usage_cache_summary.total_requests, 1);

        let managed_keys = keys_service::list_managed_keys(&ctx, "account-live-keys", 1, 100, false)
            .await
            .expect("read live managed keys");
        assert_eq!(managed_keys.total, 2);
        assert_eq!(
            managed_keys
                .items
                .iter()
                .filter(|item| item.key.status == "active")
                .count(),
            1
        );

        let overview_result = get_overview(&ctx).await;
        server.abort();
        let overview = overview_result.expect("build overview from live keys");

        assert!(key_requests.load(Ordering::SeqCst) >= 1);
        assert_eq!(overview.totals.total_api_keys, 2);
        assert_eq!(overview.totals.active_api_keys, 1);
        assert_eq!(overview.keys.len(), 2);
        let cache_view = overview.accounts[0]
            .cache_view
            .as_ref()
            .expect("live account cache view");
        assert_eq!(cache_view.stats.total_api_keys, 2);
        assert_eq!(cache_view.stats.active_api_keys, 1);
    }

    fn build_site(id: &str) -> SiteRecord {
        SiteRecord {
            id: id.into(),
            name: "AI INPUT".into(),
            base_url: "https://ai.input.im".into(),
            created_at: "2026-06-05T00:00:00.000Z".into(),
            updated_at: "2026-06-05T00:00:00.000Z".into(),
        }
    }

    fn build_runtime(
        id: &str,
        site_id: &str,
        label: &str,
        cache_view: Option<AccountCacheView>,
        last_error: Option<String>,
    ) -> AccountRuntime {
        AccountRuntime {
            account: AccountRecord {
                id: id.into(),
                site_id: site_id.into(),
                label: label.into(),
                email: format!("{id}@example.com"),
                balance_warning: 5.0,
                last_login_at: Some("2026-06-05T00:00:00.000Z".into()),
                created_at: "2026-06-05T00:00:00.000Z".into(),
                updated_at: "2026-06-05T00:00:00.000Z".into(),
            },
            site: Some(build_site(site_id)),
            cache_view,
            session_state: "ready".into(),
            last_error,
        }
    }

    fn build_test_cache_view(trend: Vec<TrendPoint>, alerts: Vec<AccountAlert>) -> AccountCacheView {
        AccountCacheView {
            fetched_at: "2026-06-05T08:00:00.000Z".into(),
            online: true,
            site_name: "AI INPUT".into(),
            balance: 8.0,
                stats: AccountCacheStats {
                total_api_keys: 2,
                active_api_keys: 1,
                today_requests: 30,
                total_requests: 120,
                today_actual_cost: 1.3,
                total_actual_cost: 11.8,
                today_cost: 1.6,
                total_cost: 13.0,
                today_tokens: 9000,
                total_tokens: 22000,
                today_input_tokens: 4000,
                today_output_tokens: 5000,
                average_duration_ms: 520.0,
                by_platform: vec![PlatformPoint {
                    platform: "openai".into(),
                    total_actual_cost: 11.8,
                    today_actual_cost: 1.3,
                    total_requests: 120,
                    total_tokens: 22000,
                }],
                by_model: vec![OverviewModelPoint {
                    model: "gpt-4.1".into(),
                    requests: 120,
                    total_tokens: 22000,
                    actual_cost: 11.8,
                    total_cost: 13.0,
                }],
            },
            recent_usage: vec![UsageRow {
                id: "usage-1".into(),
                upstream_user_id: None,
                api_key_id: Some(1),
                upstream_account_id: None,
                request_id: None,
                created_at: "2026-06-05T08:10:00.000Z".into(),
                model: "gpt-4.1".into(),
                reasoning_effort: None,
                endpoint: Some("/responses".into()),
                upstream_endpoint: None,
                group_id: None,
                subscription_id: None,
                actual_cost: 0.31,
                total_cost: 0.34,
                input_tokens: 1200,
                output_tokens: 800,
                input_cost: None,
                output_cost: None,
                cache_creation_tokens: Some(0),
                cache_read_tokens: Some(0),
                cache_creation_5m_tokens: None,
                cache_creation_1h_tokens: None,
                cache_creation_cost: None,
                cache_read_cost: None,
                total_tokens: 2000,
                first_token_ms: None,
                duration_ms: None,
                billing_mode: None,
                request_type: None,
                stream: None,
                openai_ws_mode: None,
                billing_type: None,
                image_count: None,
                image_size: None,
                image_input_size: None,
                image_output_size: None,
                image_output_tokens: None,
                image_output_cost: None,
                image_size_source: None,
                image_size_breakdown: None,
                media_type: None,
                rate_multiplier: None,
                user_agent: None,
                ip_address: None,
                cache_ttl_overridden: None,
                api_key_name: Some("主账号-Key-A".into()),
                platform: Some("openai".into()),
                subscription_name: None,
                group_name: None,
                subscription_type: None,
            }],
            trend,
            keys: vec![KeyRecord {
                id: "key-1".into(),
                group_id: None,
                name: "主账号-Key-A".into(),
                status: "active".into(),
                platform: Some("openai".into()),
                group_name: Some("默认分组".into()),
                expires_at: None,
                last_used_at: Some("2026-06-05T08:10:00.000Z".into()),
                quota: None,
                quota_used: None,
                rate_limit5h: None,
                rate_limit1d: None,
                rate_limit7d: None,
                usage5h: None,
                usage1d: None,
                usage7d: None,
                current_concurrency: None,
            }],
            subscriptions: vec![SubscriptionRecord {
                id: "subscription-1".into(),
                group_id: None,
                name: "主账号年度套餐".into(),
                status: "active".into(),
                group_name: Some("年度".into()),
                platform: Some("openai".into()),
                expires_at: Some("2026-12-31T00:00:00.000Z".into()),
                daily: None,
                weekly: None,
                monthly: None,
            }],
            active_subscription: None,
            alerts,
        }
    }

    fn build_live_key_source_test_context() -> AppContext {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .join("tmp")
            .join(format!(
                "dashboard-live-key-source-tests-{}",
                uuid::Uuid::new_v4()
            ));
        let paths = AppPaths::from_root(root);
        paths.ensure().expect("ensure test app paths");
        let db = Database::new(paths.db_path.clone());
        let _ = db.connect().expect("initialize test sqlite");
        AppContext {
            paths,
            db,
            sync_tasks: Arc::new(Mutex::new(HashMap::<String, Arc<SyncTaskHandle>>::new())),
            live_resources: crate::application::resource_coordinator::ResourceCoordinator::default(),
        }
    }

    fn seed_live_key_source_account(ctx: &AppContext, base_url: &str) {
        repositories::insert_site(
            &ctx.db,
            &SiteRecord {
                id: "site-live-keys".into(),
                name: "Local Mock Site".into(),
                base_url: base_url.into(),
                created_at: "2026-07-16T00:00:00Z".into(),
                updated_at: "2026-07-16T00:00:00Z".into(),
            },
        )
        .expect("insert test site");
        repositories::insert_account(
            &ctx.db,
            &AccountRecord {
                id: "account-live-keys".into(),
                site_id: "site-live-keys".into(),
                label: "Local Mock Account".into(),
                email: "mock@example.com".into(),
                balance_warning: -1.0,
                last_login_at: Some("2026-07-16T00:00:00Z".into()),
                created_at: "2026-07-16T00:00:00Z".into(),
                updated_at: "2026-07-16T00:00:00Z".into(),
            },
        )
        .expect("insert test account");
        repositories::save_session(
            &ctx.db,
            "account-live-keys",
            &StoredSession {
                saved_at: "2026-07-16T00:00:00Z".into(),
                access_token: Some("mock-access".into()),
                refresh_token: None,
                token_type: Some("bearer".into()),
                cookie_jar_json: None,
            },
        )
        .expect("save test session");
    }

    fn live_key_source_usage_row() -> UsageRow {
        UsageRow {
            id: "usage-live-key-source".into(),
            upstream_user_id: None,
            api_key_id: Some(1),
            upstream_account_id: None,
            request_id: None,
            created_at: format!("{}T12:00:00+08:00", shanghai_today()),
            model: "gpt-4.1".into(),
            reasoning_effort: None,
            endpoint: Some("/responses".into()),
            upstream_endpoint: None,
            group_id: None,
            subscription_id: None,
            actual_cost: 0.1,
            total_cost: 0.1,
            input_tokens: 10,
            output_tokens: 20,
            input_cost: None,
            output_cost: None,
            cache_creation_tokens: None,
            cache_read_tokens: None,
            cache_creation_5m_tokens: None,
            cache_creation_1h_tokens: None,
            cache_creation_cost: None,
            cache_read_cost: None,
            total_tokens: 30,
            first_token_ms: None,
            duration_ms: None,
            billing_mode: None,
            request_type: None,
            stream: None,
            openai_ws_mode: None,
            billing_type: None,
            image_count: None,
            image_size: None,
            image_input_size: None,
            image_output_size: None,
            image_output_tokens: None,
            image_output_cost: None,
            image_size_source: None,
            image_size_breakdown: None,
            media_type: None,
            rate_multiplier: None,
            user_agent: None,
            ip_address: None,
            cache_ttl_overridden: None,
            api_key_name: Some("Active Key".into()),
            platform: Some("openai".into()),
            subscription_name: None,
            group_name: None,
            subscription_type: None,
        }
    }
}

