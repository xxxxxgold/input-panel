use anyhow::Result;
use chrono::{Days, Local, NaiveDate, Utc};

use crate::contracts::{
    AccountRuntime, OverviewKeyRecord, OverviewPayload, OverviewSubscriptionRecord, OverviewTotals,
    OverviewUsageRow, PlatformPoint, AccountAlert, TrendPoint,
};
use crate::infrastructure::sqlite::repositories;

use super::{account_service, AppContext};

const OVERVIEW_TREND_DAYS: u64 = 7;

pub fn get_overview(ctx: &AppContext) -> Result<OverviewPayload> {
    let state = repositories::read_data_center_state(&ctx.db)?;
    let accounts = build_runtime_accounts(&state);
    Ok(build_overview_payload(&state.sites, &accounts))
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

    OverviewPayload {
        sites: sites.to_vec(),
        accounts: accounts.to_vec(),
        totals,
        alerts,
        platform_series,
        trend,
        recent_usage,
        subscriptions,
        keys,
        generated_at: Utc::now().to_rfc3339(),
    }
}

fn build_runtime_accounts(state: &crate::contracts::DataCenterState) -> Vec<AccountRuntime> {
    state
        .accounts
        .iter()
        .cloned()
        .map(|account| {
            let site = state.sites.iter().find(|item| item.id == account.site_id).cloned();
            let cache_view = account_service::build_runtime_cache_view(state, &account, site.as_ref());
            let last_error = state
                .sync_statuses
                .get(&account.id)
                .and_then(|rows| rows.iter().find_map(|item| item.last_error.clone()));
            let session_state = if cache_view.is_some() {
                "ready".to_string()
            } else if last_error.is_some() {
                "expired".to_string()
            } else {
                "missing".to_string()
            };
            AccountRuntime {
                account,
                site,
                cache_view,
                session_state,
                last_error,
            }
        })
        .collect()
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
    let today = Local::now().date_naive();
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
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.naive_local().date())
        .or_else(|| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
}

#[cfg(test)]
mod tests {
    use chrono::{Days, Local};

    use super::build_overview_payload;
    use crate::contracts::{
        AccountRecord, AccountRuntime, AccountCacheView, KeyRecord, PlatformPoint, SiteRecord,
        AccountAlert, AccountCacheStats, SubscriptionRecord, TrendPoint, UsageRow,
    };

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
        assert!(overview.accounts[0].cache_view.is_some());
    }

    #[test]
    fn fills_recent_seven_day_window_and_filters_stale_trend_points() {
        let today = Local::now().date_naive();
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
            },
            recent_usage: vec![UsageRow {
                id: "usage-1".into(),
                api_key_id: Some(1),
                created_at: "2026-06-05T08:10:00.000Z".into(),
                model: "gpt-4.1".into(),
                reasoning_effort: None,
                endpoint: Some("/responses".into()),
                upstream_endpoint: None,
                actual_cost: 0.31,
                total_cost: 0.34,
                input_tokens: 1200,
                output_tokens: 800,
                input_cost: None,
                output_cost: None,
                cache_creation_tokens: Some(0),
                cache_read_tokens: Some(0),
                cache_creation_cost: None,
                cache_read_cost: None,
                total_tokens: 2000,
                first_token_ms: None,
                duration_ms: None,
                billing_mode: None,
                request_type: None,
                stream: None,
                billing_type: None,
                rate_multiplier: None,
                user_agent: None,
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
}

