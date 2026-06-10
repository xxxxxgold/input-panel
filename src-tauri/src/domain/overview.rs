use std::collections::HashMap;

use chrono::Utc;

use crate::contracts::{
    AccountRuntime, OverviewKeyRecord, OverviewPayload, OverviewSubscriptionRecord,
    OverviewTotals, OverviewUsageRow, PlatformPoint, SnapshotAlert, StoredState, TrendPoint,
};

pub fn build_overview(state: &StoredState) -> OverviewPayload {
    let accounts: Vec<AccountRuntime> = state
        .accounts
        .iter()
        .cloned()
        .map(|account| {
            let site = state.sites.iter().find(|item| item.id == account.site_id).cloned();
            let snapshot = state.snapshots.get(&account.id).cloned();
            let last_error = state.errors.get(&account.id).cloned().flatten();
            let session_state = if snapshot.is_some() {
                "ready".to_string()
            } else if last_error.is_some() {
                "expired".to_string()
            } else {
                "missing".to_string()
            };
            AccountRuntime {
                account,
                site,
                snapshot,
                session_state,
                last_error,
            }
        })
        .collect();

    let mut totals = OverviewTotals {
        balance: 0.0,
        total_sites: state.sites.len() as i64,
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

    let mut alerts: Vec<SnapshotAlert> = Vec::new();
    let mut trend_map: HashMap<String, TrendPoint> = HashMap::new();
    let mut recent_usage: Vec<OverviewUsageRow> = Vec::new();
    let mut subscriptions: Vec<OverviewSubscriptionRecord> = Vec::new();
    let mut keys: Vec<OverviewKeyRecord> = Vec::new();
    let mut platform_map: HashMap<String, PlatformPoint> = HashMap::new();

    for account in &accounts {
        if let Some(snapshot) = &account.snapshot {
            totals.balance += snapshot.balance;
            totals.total_api_keys += snapshot.stats.total_api_keys;
            totals.active_api_keys += snapshot.stats.active_api_keys;
            totals.today_requests += snapshot.stats.today_requests;
            totals.total_requests += snapshot.stats.total_requests;
            totals.today_actual_cost += snapshot.stats.today_actual_cost;
            totals.total_actual_cost += snapshot.stats.total_actual_cost;
            totals.today_tokens += snapshot.stats.today_tokens;
            totals.total_tokens += snapshot.stats.total_tokens;

            alerts.extend(snapshot.alerts.clone());
            recent_usage.extend(snapshot.recent_usage.iter().cloned().map(|row| OverviewUsageRow {
                row,
                account_id: account.account.id.clone(),
                account_label: account.account.label.clone(),
                site_id: account.account.site_id.clone(),
                site_name: account
                    .site
                    .as_ref()
                    .map(|item| item.name.clone())
                    .unwrap_or_else(|| snapshot.site_name.clone()),
            }));

            subscriptions.extend(
                snapshot
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
                            .unwrap_or_else(|| snapshot.site_name.clone()),
                    }),
            );

            keys.extend(snapshot.keys.iter().cloned().map(|key| OverviewKeyRecord {
                key,
                account_id: account.account.id.clone(),
                account_label: account.account.label.clone(),
                site_id: account.account.site_id.clone(),
                site_name: account
                    .site
                    .as_ref()
                    .map(|item| item.name.clone())
                    .unwrap_or_else(|| snapshot.site_name.clone()),
            }));

            for point in &snapshot.trend {
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

            for point in &snapshot.stats.by_platform {
                let entry = platform_map
                    .entry(point.platform.clone())
                    .or_insert(PlatformPoint {
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
            alerts.push(SnapshotAlert {
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

    let mut trend: Vec<TrendPoint> = trend_map.into_values().collect();
    trend.sort_by(|a, b| a.bucket.cmp(&b.bucket));

    let mut platform_series: Vec<PlatformPoint> = platform_map.into_values().collect();
    platform_series.sort_by(|a, b| {
        b.total_actual_cost
            .partial_cmp(&a.total_actual_cost)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    OverviewPayload {
        sites: state.sites.clone(),
        accounts,
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

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::build_overview;
    use crate::contracts::{
        AccountRecord, AccountSnapshot, KeyRecord, PlatformPoint, SiteRecord, SnapshotAlert,
        SnapshotStats, StoredState, SubscriptionRecord, TrendPoint, UsageSummary, UsageRow,
    };

    #[test]
    fn aggregates_totals_and_collections() {
        let mut snapshots = HashMap::new();
        snapshots.insert(
            "account-1".to_string(),
            AccountSnapshot {
                fetched_at: "2026-06-05T08:00:00.000Z".into(),
                online: true,
                site_name: "AI INPUT".into(),
                site_url: "https://ai.input.im".into(),
                account_label: "主账号".into(),
                email_masked: Some("demo@example.com".into()),
                balance: 8.0,
                currency: "USD".into(),
                stats: SnapshotStats {
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
                usage_summary: UsageSummary {
                    total_requests: 120,
                    total_tokens: 22000,
                    total_input_tokens: 4000,
                    total_output_tokens: 5000,
                    total_actual_cost: 11.8,
                    total_cost: 13.0,
                    average_duration_ms: 520.0,
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
                request_history: vec![],
                trend: vec![TrendPoint {
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
                alerts: vec![SnapshotAlert {
                    id: "alert-1".into(),
                    severity: "high".into(),
                    title: "余额偏低".into(),
                    detail: "快要见底了".into(),
                    site_id: "site-1".into(),
                    account_id: "account-1".into(),
                    created_at: "2026-06-05T08:00:00.000Z".into(),
                }],
            },
        );

        let overview = build_overview(&StoredState {
            sites: vec![SiteRecord {
                id: "site-1".into(),
                name: "AI INPUT".into(),
                base_url: "https://ai.input.im".into(),
                created_at: "2026-06-05T00:00:00.000Z".into(),
                updated_at: "2026-06-05T00:00:00.000Z".into(),
            }],
            accounts: vec![AccountRecord {
                id: "account-1".into(),
                site_id: "site-1".into(),
                label: "主账号".into(),
                email: "demo@example.com".into(),
                balance_warning: 5.0,
                last_login_at: Some("2026-06-05T00:00:00.000Z".into()),
                created_at: "2026-06-05T00:00:00.000Z".into(),
                updated_at: "2026-06-05T00:00:00.000Z".into(),
            }],
            snapshots,
            errors: HashMap::new(),
        });

        assert_eq!(overview.totals.balance, 8.0);
        assert_eq!(overview.totals.total_api_keys, 2);
        assert_eq!(overview.alerts.len(), 1);
        assert_eq!(overview.recent_usage.len(), 1);
        assert_eq!(overview.keys.len(), 1);
        assert_eq!(overview.subscriptions.len(), 1);
    }
}
