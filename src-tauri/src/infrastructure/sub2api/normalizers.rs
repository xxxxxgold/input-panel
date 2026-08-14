use serde_json::Value;
use std::collections::HashMap;

use crate::contracts::{
    AccountCacheStats, DailyUsagePoint, DashboardModelsPayload, GroupRecord, KeyRecord,
    KeyUsageSubscriptionSnapshot, KeyUsageSummaryPayload, KeyUsageTokenStats, ManagedKeyRecord,
    ModelUsagePoint, OverviewDashboardStatsPayload, OverviewModelPoint, PaginatedResult,
    PlatformPoint, PlatformQuotaPayload, PlatformQuotaRecord, ProfileUpdateInput,
    SubscriptionQuotaWindow, SubscriptionSummaryPayload, SubscriptionSummaryRecord, UsageRow,
    UsageStatsRecord, UsageTrendPayload, UserIdentityBinding, UserProfileRecord,
};

pub fn pick_value<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.')
        .try_fold(value, |current, segment| current.get(segment))
}

pub fn pick_string(value: &Value, keys: &[&str], fallback: Option<&str>) -> Option<String> {
    keys.iter()
        .find_map(|key| {
            let node = pick_value(value, key)?;
            node.as_str()
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToString::to_string)
                .or_else(|| node.as_i64().map(|item| item.to_string()))
                .or_else(|| node.as_u64().map(|item| item.to_string()))
        })
        .or_else(|| fallback.map(ToString::to_string))
}

pub fn pick_number(value: &Value, keys: &[&str], fallback: f64) -> f64 {
    pick_optional_number(value, keys).unwrap_or(fallback)
}

pub fn pick_optional_number(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| {
        let node = pick_value(value, key)?;
        node.as_f64()
            .or_else(|| node.as_i64().map(|item| item as f64))
            .or_else(|| {
                node.as_str()
                    .and_then(|item| item.trim().parse::<f64>().ok())
            })
    })
}

pub fn pick_bool(value: &Value, path: &str) -> bool {
    pick_value(value, path)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

pub fn normalize_items(value: &Value) -> Vec<Value> {
    if let Some(items) = value.as_array() {
        return items.clone();
    }
    for key in [
        "items",
        "data",
        "list",
        "subscriptions",
        "models",
        "trend",
        "platform_quotas",
    ] {
        if let Some(items) = value.get(key).and_then(Value::as_array) {
            return items.clone();
        }
    }
    Vec::new()
}

pub fn normalize_group_record(item: &Value) -> GroupRecord {
    GroupRecord {
        id: pick_number(item, &["id"], 0.0) as i64,
        name: pick_string(item, &["name"], Some("未命名分组"))
            .unwrap_or_else(|| "未命名分组".into()),
        description: pick_string(item, &["description"], None),
        platform: pick_string(item, &["platform"], Some("unknown"))
            .unwrap_or_else(|| "unknown".into()),
        rate_multiplier: pick_number(item, &["rate_multiplier"], 1.0),
        subscription_type: pick_string(item, &["subscription_type"], None),
        daily_limit_usd: pick_optional_number(item, &["daily_limit_usd"]),
        weekly_limit_usd: pick_optional_number(item, &["weekly_limit_usd"]),
        monthly_limit_usd: pick_optional_number(item, &["monthly_limit_usd"]),
        allow_messages_dispatch: Some(pick_bool(item, "allow_messages_dispatch")),
    }
}

pub fn normalize_managed_key_record(item: &Value) -> ManagedKeyRecord {
    ManagedKeyRecord {
        key: KeyRecord {
            id: pick_string(item, &["id"], Some("")).unwrap_or_default(),
            group_id: pick_optional_number(item, &["group_id"]).map(|item| item as i64),
            name: pick_string(item, &["name"], Some("Unnamed Key"))
                .unwrap_or_else(|| "Unnamed Key".into()),
            status: pick_string(item, &["status"], Some("unknown"))
                .unwrap_or_else(|| "unknown".into()),
            platform: pick_string(item, &["group.platform", "platform"], None),
            group_name: pick_string(item, &["group.name", "group_name"], None),
            expires_at: pick_string(item, &["expires_at"], None),
            last_used_at: pick_string(item, &["last_used_at"], None),
            quota: pick_optional_number(item, &["quota"]),
            quota_used: pick_optional_number(item, &["quota_used"]),
            rate_limit5h: pick_optional_number(item, &["rate_limit_5h"]),
            rate_limit1d: pick_optional_number(item, &["rate_limit_1d"]),
            rate_limit7d: pick_optional_number(item, &["rate_limit_7d"]),
            usage5h: pick_optional_number(item, &["usage_5h"]),
            usage1d: pick_optional_number(item, &["usage_1d"]),
            usage7d: pick_optional_number(item, &["usage_7d"]),
            current_concurrency: pick_optional_number(item, &["current_concurrency"])
                .map(|item| item as i64),
        },
        api_key_id: pick_optional_number(item, &["api_key_id", "id"]).map(|item| item as i64),
        raw_key: pick_string(item, &["key"], None),
        user_id: pick_optional_number(item, &["user_id"]).map(|item| item as i64),
        ip_whitelist: pick_string(item, &["ip_whitelist"], None),
        ip_blacklist: pick_string(item, &["ip_blacklist"], None),
        window5h_start: pick_string(item, &["window_5h_start"], None),
        window1d_start: pick_string(item, &["window_1d_start"], None),
        window7d_start: pick_string(item, &["window_7d_start"], None),
    }
}

pub fn normalize_usage_row(item: &Value) -> UsageRow {
    let input_tokens = pick_number(item, &["input_tokens"], 0.0) as i64;
    let output_tokens = pick_number(item, &["output_tokens"], 0.0) as i64;
    let cache_creation_tokens = pick_number(item, &["cache_creation_tokens"], 0.0) as i64;
    let cache_read_tokens =
        pick_number(item, &["cache_read_tokens", "total_cache_tokens"], 0.0) as i64;
    let fallback_total = input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens;

    UsageRow {
        id: pick_string(item, &["id", "request_id"], Some("")).unwrap_or_default(),
        upstream_user_id: pick_optional_number(item, &["user_id"]).map(|item| item as i64),
        api_key_id: pick_optional_number(item, &["api_key_id"]).map(|item| item as i64),
        upstream_account_id: pick_optional_number(item, &["account_id"]).map(|item| item as i64),
        request_id: pick_string(item, &["request_id"], None),
        created_at: pick_string(item, &["created_at"], None).unwrap_or_default(),
        model: pick_string(item, &["model"], Some("unknown")).unwrap_or_else(|| "unknown".into()),
        reasoning_effort: pick_string(item, &["reasoning_effort"], None),
        endpoint: pick_string(item, &["inbound_endpoint", "endpoint"], None),
        upstream_endpoint: pick_string(item, &["upstream_endpoint"], None),
        group_id: pick_optional_number(item, &["group_id"]).map(|item| item as i64),
        subscription_id: pick_optional_number(item, &["subscription_id"]).map(|item| item as i64),
        actual_cost: pick_number(item, &["actual_cost", "total_actual_cost"], 0.0),
        total_cost: pick_number(item, &["total_cost", "cost"], 0.0),
        input_tokens,
        output_tokens,
        input_cost: pick_optional_number(item, &["input_cost"]),
        output_cost: pick_optional_number(item, &["output_cost"]),
        cache_creation_tokens: Some(cache_creation_tokens),
        cache_read_tokens: Some(cache_read_tokens),
        cache_creation_5m_tokens: pick_optional_number(item, &["cache_creation_5m_tokens"])
            .map(|item| item as i64),
        cache_creation_1h_tokens: pick_optional_number(item, &["cache_creation_1h_tokens"])
            .map(|item| item as i64),
        cache_creation_cost: pick_optional_number(item, &["cache_creation_cost"]),
        cache_read_cost: pick_optional_number(item, &["cache_read_cost"]),
        total_tokens: pick_number(item, &["total_tokens"], fallback_total as f64) as i64,
        first_token_ms: pick_optional_number(item, &["first_token_ms"]).map(|item| item as i64),
        duration_ms: pick_optional_number(item, &["duration_ms"]).map(|item| item as i64),
        billing_mode: pick_string(item, &["billing_mode"], None),
        request_type: pick_string(item, &["request_type"], None),
        stream: pick_value(item, "stream").and_then(Value::as_bool),
        openai_ws_mode: pick_value(item, "openai_ws_mode").and_then(Value::as_bool),
        billing_type: pick_optional_number(item, &["billing_type"]).map(|item| item as i64),
        service_tier: pick_string(item, &["service_tier"], None),
        long_context_billing_applied: pick_value(item, "long_context_billing_applied")
            .and_then(Value::as_bool),
        image_count: pick_optional_number(item, &["image_count"]).map(|item| item as i64),
        image_input_tokens: pick_optional_number(item, &["image_input_tokens"])
            .map(|item| item as i64),
        image_size: pick_string(item, &["image_size"], None),
        image_input_size: pick_string(item, &["image_input_size"], None),
        image_output_size: pick_string(item, &["image_output_size"], None),
        image_output_tokens: pick_optional_number(item, &["image_output_tokens"])
            .map(|item| item as i64),
        image_input_cost: pick_optional_number(item, &["image_input_cost"]),
        image_output_cost: pick_optional_number(item, &["image_output_cost"]),
        image_size_source: pick_string(item, &["image_size_source"], None),
        image_size_breakdown: pick_value(item, "image_size_breakdown")
            .map(|value| value.to_string()),
        media_type: pick_string(item, &["media_type"], None),
        rate_multiplier: pick_optional_number(item, &["rate_multiplier"]),
        user_agent: pick_string(item, &["user_agent"], None),
        ip_address: pick_string(item, &["ip_address"], None),
        cache_ttl_overridden: pick_value(item, "cache_ttl_overridden").and_then(Value::as_bool),
        api_key_name: pick_string(item, &["api_key.name", "api_key_name"], None),
        platform: pick_string(item, &["group.platform", "platform"], None),
        subscription_name: pick_string(
            item,
            &["subscription.group.name", "subscription_name", "group.name"],
            None,
        ),
        group_name: pick_string(item, &["group.name", "group_name"], None),
        subscription_type: pick_string(
            item,
            &["group.subscription_type", "subscription.subscription_type"],
            None,
        ),
    }
}

pub fn build_paginated<T>(
    raw: &Value,
    items: Vec<T>,
    page: i64,
    page_size: i64,
) -> PaginatedResult<T> {
    let total = pick_number(raw, &["total", "pagination.total"], items.len() as f64) as i64;
    let pages = pick_number(
        raw,
        &["pages", "pagination.pages"],
        ((total as f64) / (page_size.max(1) as f64)).ceil().max(1.0),
    ) as i64;
    PaginatedResult {
        items,
        page,
        page_size,
        total,
        pages,
    }
}

pub fn normalize_usage_stats(raw: &Value) -> UsageStatsRecord {
    UsageStatsRecord {
        total_requests: pick_number(raw, &["total_requests"], 0.0) as i64,
        total_input_tokens: pick_number(raw, &["total_input_tokens"], 0.0) as i64,
        total_output_tokens: pick_number(raw, &["total_output_tokens"], 0.0) as i64,
        total_cache_tokens: pick_optional_number(raw, &["total_cache_tokens"])
            .map(|item| item as i64),
        total_cache_creation_tokens: pick_optional_number(raw, &["total_cache_creation_tokens"])
            .map(|item| item as i64),
        total_cache_read_tokens: pick_optional_number(raw, &["total_cache_read_tokens"])
            .map(|item| item as i64),
        total_tokens: pick_number(raw, &["total_tokens"], 0.0) as i64,
        total_cost: pick_number(raw, &["total_cost"], 0.0),
        total_actual_cost: pick_number(raw, &["total_actual_cost"], 0.0),
        average_duration_ms: pick_number(raw, &["average_duration_ms"], 0.0),
        rpm: pick_optional_number(raw, &["rpm"]),
        tpm: pick_optional_number(raw, &["tpm"]),
    }
}

pub fn normalize_dashboard_cache_stats(raw: &Value) -> AccountCacheStats {
    AccountCacheStats {
        total_api_keys: pick_number(raw, &["total_api_keys"], 0.0) as i64,
        active_api_keys: pick_number(raw, &["active_api_keys"], 0.0) as i64,
        today_requests: pick_number(raw, &["today_requests"], 0.0) as i64,
        total_requests: pick_number(raw, &["total_requests"], 0.0) as i64,
        today_actual_cost: pick_number(raw, &["today_actual_cost", "actual_cost"], 0.0),
        total_actual_cost: pick_number(raw, &["total_actual_cost", "actual_cost"], 0.0),
        today_cost: pick_number(raw, &["today_cost"], 0.0),
        total_cost: pick_number(raw, &["total_cost"], 0.0),
        today_tokens: pick_number(raw, &["today_tokens"], 0.0) as i64,
        total_tokens: pick_number(raw, &["total_tokens"], 0.0) as i64,
        today_input_tokens: pick_number(raw, &["today_input_tokens", "input_tokens"], 0.0) as i64,
        today_output_tokens: pick_number(raw, &["today_output_tokens", "output_tokens"], 0.0)
            as i64,
        average_duration_ms: pick_number(raw, &["average_duration_ms", "avg_duration_ms"], 0.0),
        by_platform: normalize_dashboard_platform_series(raw),
        by_model: Vec::<OverviewModelPoint>::new(),
    }
}

pub fn normalize_overview_dashboard_stats(raw: &Value) -> OverviewDashboardStatsPayload {
    OverviewDashboardStatsPayload {
        today_stats: normalize_dashboard_usage_stats(raw, "today"),
        total_stats: normalize_dashboard_usage_stats(raw, "total"),
        total_api_keys: pick_number(raw, &["total_api_keys"], 0.0) as i64,
        active_api_keys: pick_number(raw, &["active_api_keys"], 0.0) as i64,
        platform_series: normalize_dashboard_platform_series(raw),
    }
}

fn normalize_dashboard_usage_stats(raw: &Value, scope: &str) -> UsageStatsRecord {
    let cache_creation_tokens_key = format!("{scope}_cache_creation_tokens");
    let cache_read_tokens_key = format!("{scope}_cache_read_tokens");
    let total_cache_creation_tokens =
        pick_optional_number(raw, &[cache_creation_tokens_key.as_str()]).map(|item| item as i64);
    let total_cache_read_tokens =
        pick_optional_number(raw, &[cache_read_tokens_key.as_str()]).map(|item| item as i64);

    UsageStatsRecord {
        total_requests: pick_scoped_i64(raw, scope, "requests"),
        total_input_tokens: pick_scoped_i64(raw, scope, "input_tokens"),
        total_output_tokens: pick_scoped_i64(raw, scope, "output_tokens"),
        total_cache_tokens: match (total_cache_creation_tokens, total_cache_read_tokens) {
            (Some(creation), Some(read)) => Some(creation + read),
            (Some(creation), None) => Some(creation),
            (None, Some(read)) => Some(read),
            (None, None) => None,
        },
        total_cache_creation_tokens,
        total_cache_read_tokens,
        total_tokens: pick_scoped_i64(raw, scope, "tokens"),
        total_cost: pick_scoped_f64(raw, scope, "cost"),
        total_actual_cost: pick_scoped_f64(raw, scope, "actual_cost"),
        average_duration_ms: pick_number(raw, &["average_duration_ms", "avg_duration_ms"], 0.0),
        rpm: pick_optional_number(raw, &["rpm"]),
        tpm: pick_optional_number(raw, &["tpm"]),
    }
}

fn normalize_dashboard_platform_series(raw: &Value) -> Vec<PlatformPoint> {
    normalize_items(raw.get("by_platform").unwrap_or(raw))
        .into_iter()
        .map(|item| PlatformPoint {
            platform: pick_string(&item, &["platform", "name"], Some("unknown"))
                .unwrap_or_else(|| "unknown".into()),
            total_actual_cost: pick_number(&item, &["total_actual_cost", "actual_cost"], 0.0),
            today_actual_cost: pick_number(&item, &["today_actual_cost"], 0.0),
            total_requests: pick_number(&item, &["total_requests", "requests"], 0.0) as i64,
            total_tokens: pick_number(&item, &["total_tokens", "tokens"], 0.0) as i64,
        })
        .collect()
}

fn pick_scoped_i64(raw: &Value, scope: &str, field: &str) -> i64 {
    pick_scoped_f64(raw, scope, field) as i64
}

fn pick_scoped_f64(raw: &Value, scope: &str, field: &str) -> f64 {
    let key = format!("{scope}_{field}");
    pick_number(raw, &[key.as_str()], 0.0)
}

pub fn normalize_trend_payload(raw: &Value) -> UsageTrendPayload {
    let trend_source = raw.get("trend").unwrap_or(raw);
    UsageTrendPayload {
        start_date: pick_string(raw, &["start_date"], Some("")).unwrap_or_default(),
        end_date: pick_string(raw, &["end_date"], Some("")).unwrap_or_default(),
        granularity: pick_string(raw, &["granularity"], None),
        trend: normalize_items(trend_source)
            .into_iter()
            .map(|item| DailyUsagePoint {
                date: pick_string(&item, &["date", "bucket", "day"], Some("")).unwrap_or_default(),
                requests: pick_number(&item, &["requests", "request_count"], 0.0) as i64,
                input_tokens: pick_number(&item, &["input_tokens"], 0.0) as i64,
                output_tokens: pick_number(&item, &["output_tokens"], 0.0) as i64,
                cache_read_tokens: Some(pick_number(&item, &["cache_read_tokens"], 0.0) as i64),
                cache_write_tokens: Some(pick_number(
                    &item,
                    &["cache_creation_tokens", "cache_write_tokens"],
                    0.0,
                ) as i64),
                total_tokens: Some(pick_number(&item, &["total_tokens"], 0.0) as i64),
                actual_cost: Some(pick_number(&item, &["actual_cost"], 0.0)),
                total_cost: Some(pick_number(&item, &["cost", "total_cost"], 0.0)),
            })
            .collect(),
    }
}

pub fn normalize_models_payload(raw: &Value) -> DashboardModelsPayload {
    let models_source = raw.get("models").unwrap_or(raw);
    DashboardModelsPayload {
        start_date: pick_string(raw, &["start_date"], Some("")).unwrap_or_default(),
        end_date: pick_string(raw, &["end_date"], Some("")).unwrap_or_default(),
        models: normalize_items(models_source)
            .into_iter()
            .map(|item| ModelUsagePoint {
                model: pick_string(&item, &["model"], Some("unknown"))
                    .unwrap_or_else(|| "unknown".into()),
                requests: pick_number(&item, &["requests"], 0.0) as i64,
                input_tokens: pick_number(&item, &["input_tokens"], 0.0) as i64,
                output_tokens: pick_number(&item, &["output_tokens"], 0.0) as i64,
                cache_creation_tokens: Some(
                    pick_number(&item, &["cache_creation_tokens"], 0.0) as i64
                ),
                cache_read_tokens: Some(pick_number(&item, &["cache_read_tokens"], 0.0) as i64),
                total_tokens: pick_number(&item, &["total_tokens"], 0.0) as i64,
                cost: Some(pick_number(&item, &["cost"], 0.0)),
                actual_cost: Some(pick_number(&item, &["actual_cost"], 0.0)),
            })
            .collect(),
    }
}

pub fn normalize_daily_usage_rows(items: &[Value]) -> Vec<DailyUsagePoint> {
    items
        .iter()
        .map(|item| DailyUsagePoint {
            date: pick_string(item, &["date", "bucket", "day"], Some("")).unwrap_or_default(),
            requests: pick_number(item, &["requests", "request_count"], 0.0) as i64,
            input_tokens: pick_number(item, &["input_tokens"], 0.0) as i64,
            output_tokens: pick_number(item, &["output_tokens"], 0.0) as i64,
            cache_read_tokens: Some(pick_number(item, &["cache_read_tokens"], 0.0) as i64),
            cache_write_tokens: Some(pick_number(
                item,
                &["cache_creation_tokens", "cache_write_tokens"],
                0.0,
            ) as i64),
            total_tokens: Some(pick_number(item, &["total_tokens", "tokens"], 0.0) as i64),
            actual_cost: Some(pick_number(
                item,
                &["actual_cost", "total_actual_cost"],
                0.0,
            )),
            total_cost: Some(pick_number(item, &["cost", "total_cost"], 0.0)),
        })
        .collect()
}

pub fn normalize_key_usage_summary(raw: &Value) -> KeyUsageSummaryPayload {
    let payload = raw.get("data").unwrap_or(raw);
    let daily_usage = payload
        .get("daily_usage")
        .and_then(Value::as_array)
        .map(|items| normalize_daily_usage_rows(items))
        .unwrap_or_default();
    let usage = payload.get("usage").unwrap_or(payload);
    let today = usage.get("today").unwrap_or(&Value::Null);
    let total = usage.get("total").unwrap_or(&Value::Null);
    let model_stats = payload
        .get("model_stats")
        .map(normalize_model_usage_points)
        .unwrap_or_default();

    KeyUsageSummaryPayload {
        daily_usage,
        today: normalize_key_usage_token_stats(today),
        total: normalize_key_usage_token_stats(total),
        average_duration_ms: pick_optional_number(usage, &["average_duration_ms"]),
        rpm: pick_optional_number(usage, &["rpm"]),
        tpm: pick_optional_number(usage, &["tpm"]),
        plan_name: pick_string(payload, &["planName", "plan_name"], None),
        remaining: pick_optional_number(payload, &["remaining"]),
        subscription: payload
            .get("subscription")
            .map(normalize_key_usage_subscription_snapshot),
        model_stats,
    }
}

fn normalize_key_usage_token_stats(raw: &Value) -> KeyUsageTokenStats {
    let input_tokens = pick_number(raw, &["input_tokens"], 0.0) as i64;
    let output_tokens = pick_number(raw, &["output_tokens"], 0.0) as i64;
    let cache_creation_tokens =
        pick_optional_number(raw, &["cache_creation_tokens", "cache_write_tokens"])
            .map(|value| value as i64);
    let cache_read_tokens =
        pick_optional_number(raw, &["cache_read_tokens"]).map(|value| value as i64);
    let total_tokens = pick_optional_number(raw, &["total_tokens"])
        .map(|value| value as i64)
        .unwrap_or(
            input_tokens
                + output_tokens
                + cache_creation_tokens.unwrap_or(0)
                + cache_read_tokens.unwrap_or(0),
        );

    KeyUsageTokenStats {
        requests: pick_number(raw, &["requests", "request_count"], 0.0) as i64,
        input_tokens,
        output_tokens,
        cache_creation_tokens,
        cache_read_tokens,
        total_tokens,
        cost: pick_optional_number(raw, &["cost", "total_cost"]),
        actual_cost: pick_optional_number(raw, &["actual_cost", "total_actual_cost"]),
    }
}

fn normalize_key_usage_subscription_snapshot(raw: &Value) -> KeyUsageSubscriptionSnapshot {
    KeyUsageSubscriptionSnapshot {
        daily_limit_usd: pick_optional_number(raw, &["daily_limit_usd"]),
        daily_usage_usd: pick_optional_number(raw, &["daily_usage_usd", "daily_used_usd"]),
        weekly_limit_usd: pick_optional_number(raw, &["weekly_limit_usd"]),
        weekly_usage_usd: pick_optional_number(raw, &["weekly_usage_usd", "weekly_used_usd"]),
        monthly_limit_usd: pick_optional_number(raw, &["monthly_limit_usd"]),
        monthly_usage_usd: pick_optional_number(raw, &["monthly_usage_usd", "monthly_used_usd"]),
        expires_at: pick_string(raw, &["expires_at"], None),
    }
}

fn normalize_model_usage_points(raw: &Value) -> Vec<ModelUsagePoint> {
    normalize_items(raw)
        .into_iter()
        .map(|item| ModelUsagePoint {
            model: pick_string(&item, &["model"], Some("unknown"))
                .unwrap_or_else(|| "unknown".into()),
            requests: pick_number(&item, &["requests"], 0.0) as i64,
            input_tokens: pick_number(&item, &["input_tokens"], 0.0) as i64,
            output_tokens: pick_number(&item, &["output_tokens"], 0.0) as i64,
            cache_creation_tokens: Some(pick_number(&item, &["cache_creation_tokens"], 0.0) as i64),
            cache_read_tokens: Some(pick_number(&item, &["cache_read_tokens"], 0.0) as i64),
            total_tokens: pick_number(&item, &["total_tokens"], 0.0) as i64,
            cost: pick_optional_number(&item, &["cost"]),
            actual_cost: pick_optional_number(&item, &["actual_cost"]),
        })
        .collect()
}

pub fn normalize_subscription_summary(raw: &Value) -> SubscriptionSummaryPayload {
    let subscription_source = raw.get("subscriptions").unwrap_or(raw);
    let subscriptions: Vec<SubscriptionSummaryRecord> = normalize_items(subscription_source)
        .into_iter()
        .map(|item| SubscriptionSummaryRecord {
            id: pick_number(&item, &["id"], 0.0) as i64,
            group_id: pick_number(&item, &["group_id"], 0.0) as i64,
            group_name: pick_string(&item, &["group_name", "group.name", "name"], Some(""))
                .unwrap_or_default(),
            status: pick_string(&item, &["status"], Some("unknown"))
                .unwrap_or_else(|| "unknown".into()),
            daily_used_usd: pick_number(
                &item,
                &["daily_used_usd", "daily.current", "daily_usage_usd"],
                0.0,
            ),
            daily_limit_usd: pick_number(
                &item,
                &["daily_limit_usd", "daily.limit", "group.daily_limit_usd"],
                0.0,
            ),
            weekly_used_usd: pick_number(&item, &["weekly_used_usd", "weekly.current"], 0.0),
            monthly_used_usd: pick_number(&item, &["monthly_used_usd", "monthly.current"], 0.0),
            expires_at: pick_string(&item, &["expires_at"], None),
        })
        .collect();

    let derived_active_count = subscriptions
        .iter()
        .filter(|item| item.status == "active")
        .count() as i64;
    let derived_total_used_usd = subscriptions
        .iter()
        .map(|item| item.daily_used_usd)
        .sum::<f64>();

    SubscriptionSummaryPayload {
        active_count: pick_number(raw, &["active_count"], derived_active_count as f64) as i64,
        total_used_usd: pick_number(raw, &["total_used_usd"], derived_total_used_usd),
        subscriptions,
    }
}

fn normalize_bindings(value: Option<&Value>) -> HashMap<String, UserIdentityBinding> {
    let mut bindings = HashMap::new();
    let Some(Value::Object(map)) = value else {
        return bindings;
    };

    for (key, item) in map {
        bindings.insert(
            key.clone(),
            UserIdentityBinding {
                provider: pick_string(item, &["provider"], Some("unknown"))
                    .unwrap_or_else(|| "unknown".into()),
                bound: pick_bool(item, "bound"),
                bound_count: pick_number(item, &["bound_count"], 0.0) as i64,
                display_name: pick_string(item, &["display_name"], None),
                subject_hint: pick_string(item, &["subject_hint"], None),
                provider_key: pick_string(item, &["provider_key"], None),
                verified_at: pick_string(item, &["verified_at"], None),
                can_bind: pick_bool(item, "can_bind"),
                can_unbind: pick_bool(item, "can_unbind"),
                note: pick_string(item, &["note"], None),
                note_key: pick_string(item, &["note_key"], None),
            },
        );
    }

    bindings
}

pub fn normalize_profile(raw: &Value) -> UserProfileRecord {
    UserProfileRecord {
        id: pick_number(raw, &["id"], 0.0) as i64,
        email: pick_string(raw, &["email"], Some("")).unwrap_or_default(),
        username: pick_string(raw, &["username"], None),
        avatar_url: pick_string(
            raw,
            &[
                "avatar_url",
                "avatarUrl",
                "avatar",
                "photo_url",
                "photo",
                "picture",
                "image",
                "icon",
                "headimgurl",
                "head_img_url",
                "profile.avatar",
                "user.avatar",
            ],
            None,
        ),
        role: pick_string(raw, &["role"], Some("user")).unwrap_or_else(|| "user".into()),
        balance: pick_number(raw, &["balance"], 0.0),
        concurrency: pick_number(raw, &["concurrency"], 0.0) as i64,
        status: pick_string(raw, &["status"], Some("unknown")).unwrap_or_else(|| "unknown".into()),
        last_active_at: pick_string(raw, &["last_active_at"], None),
        created_at: pick_string(raw, &["created_at"], None),
        updated_at: pick_string(raw, &["updated_at"], None),
        total_recharged: pick_optional_number(raw, &["total_recharged"]),
        rpm_limit: pick_optional_number(raw, &["rpm_limit"]),
        balance_notify_enabled: Some(pick_bool(raw, "balance_notify_enabled")),
        balance_notify_threshold_type: pick_string(raw, &["balance_notify_threshold_type"], None),
        balance_notify_threshold: pick_optional_number(raw, &["balance_notify_threshold"]),
        balance_notify_extra_emails: raw
            .get("balance_notify_extra_emails")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect()
            }),
        identities: normalize_bindings(raw.get("identities")),
        auth_bindings: normalize_bindings(raw.get("auth_bindings")),
        identity_bindings: normalize_bindings(raw.get("identity_bindings")),
    }
}

pub fn normalize_platform_quotas(raw: &Value) -> PlatformQuotaPayload {
    let source = raw.get("platform_quotas").unwrap_or(raw);
    PlatformQuotaPayload {
        platform_quotas: normalize_items(source)
            .into_iter()
            .map(|item| PlatformQuotaRecord {
                platform: pick_string(&item, &["platform"], None),
                quota: pick_optional_number(&item, &["quota"]),
                used: pick_optional_number(&item, &["used"]),
                remaining: pick_optional_number(&item, &["remaining"]),
            })
            .collect(),
    }
}

pub fn normalize_subscription_window(
    current: Option<f64>,
    limit: Option<f64>,
    window_start: Option<String>,
) -> Option<SubscriptionQuotaWindow> {
    let limit = limit?;
    if limit <= 0.0 {
        return None;
    }
    Some(SubscriptionQuotaWindow {
        current: current.unwrap_or(0.0),
        limit,
        window_start,
    })
}

pub fn profile_update_payload(payload: &ProfileUpdateInput) -> Value {
    let mut body = serde_json::Map::new();
    if let Some(email) = &payload.email {
        body.insert("email".into(), Value::String(email.clone()));
    }
    if let Some(username) = &payload.username {
        body.insert("username".into(), Value::String(username.clone()));
    }
    if let Some(enabled) = payload.balance_notify_enabled {
        body.insert("balance_notify_enabled".into(), Value::Bool(enabled));
    }
    if let Some(kind) = &payload.balance_notify_threshold_type {
        body.insert(
            "balance_notify_threshold_type".into(),
            Value::String(kind.clone()),
        );
    }
    if let Some(threshold) = payload.balance_notify_threshold {
        body.insert("balance_notify_threshold".into(), Value::from(threshold));
    }
    Value::Object(body)
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_key_usage_summary, normalize_managed_key_record, normalize_subscription_summary,
        normalize_usage_row,
    };
    use serde_json::json;

    #[test]
    fn normalizes_native_subscription_summary_payload() {
        let result = normalize_subscription_summary(&json!({
            "active_count": 2,
            "total_used_usd": 12.5,
            "subscriptions": [
                {
                    "id": 1,
                    "group_id": 10,
                    "group_name": "Pro",
                    "status": "active",
                    "daily_used_usd": 2.5,
                    "daily_limit_usd": 50
                }
            ]
        }));

        assert_eq!(result.active_count, 2);
        assert_eq!(result.total_used_usd, 12.5);
        assert_eq!(result.subscriptions.len(), 1);

        let subscription = &result.subscriptions[0];
        assert_eq!(subscription.group_name, "Pro");
        assert_eq!(subscription.daily_used_usd, 2.5);
        assert_eq!(subscription.daily_limit_usd, 50.0);
    }

    #[test]
    fn normalizes_subscription_list_fallback_payload() {
        let result = normalize_subscription_summary(&json!({
            "items": [
                {
                    "id": "mock-sub-1",
                    "status": "active",
                    "expires_at": "2027-06-06T00:00:00+08:00",
                    "group": {
                        "name": "Mock Annual",
                        "platform": "openai",
                        "daily_limit_usd": 50
                    },
                    "daily_usage_usd": 1.5
                }
            ]
        }));

        assert_eq!(result.active_count, 1);
        assert_eq!(result.total_used_usd, 1.5);
        assert_eq!(result.subscriptions.len(), 1);

        let subscription = &result.subscriptions[0];
        assert_eq!(subscription.group_name, "Mock Annual");
        assert_eq!(subscription.daily_used_usd, 1.5);
        assert_eq!(subscription.daily_limit_usd, 50.0);
    }

    #[test]
    fn normalizes_numeric_key_id_as_string() {
        let result = normalize_managed_key_record(&json!({
            "id": 3641,
            "name": "codex",
            "status": "active"
        }));

        assert_eq!(result.key.id, "3641");
        assert_eq!(result.api_key_id, Some(3641));
    }

    #[test]
    fn normalizes_key_current_concurrency_without_fabricating_missing_values() {
        let active = normalize_managed_key_record(&json!({
            "id": 3641,
            "name": "codex",
            "status": "active",
            "current_concurrency": 3
        }));
        let idle = normalize_managed_key_record(&json!({
            "id": 3642,
            "name": "idle",
            "status": "active",
            "current_concurrency": 0
        }));
        let unknown = normalize_managed_key_record(&json!({
            "id": 3643,
            "name": "unknown",
            "status": "active"
        }));

        assert_eq!(active.key.current_concurrency, Some(3));
        assert_eq!(idle.key.current_concurrency, Some(0));
        assert_eq!(unknown.key.current_concurrency, None);
    }

    #[test]
    fn normalizes_usage_billing_detail_fields_without_fabricating_missing_values() {
        let populated = normalize_usage_row(&json!({
            "id": "usage-billing-fields",
            "created_at": "2026-07-28T00:00:00+08:00",
            "model": "gpt-5.4",
            "service_tier": "priority",
            "image_input_tokens": 42,
            "image_input_cost": 0.125,
            "long_context_billing_applied": true
        }));
        let missing = normalize_usage_row(&json!({
            "id": "usage-billing-fields-missing",
            "created_at": "2026-07-28T00:01:00+08:00",
            "model": "gpt-5.4"
        }));
        let nulls = normalize_usage_row(&json!({
            "id": "usage-billing-fields-null",
            "created_at": "2026-07-28T00:02:00+08:00",
            "model": "gpt-5.4",
            "service_tier": null,
            "image_input_tokens": null,
            "image_input_cost": null,
            "long_context_billing_applied": null
        }));
        let explicitly_not_applied = normalize_usage_row(&json!({
            "id": "usage-billing-fields-false",
            "created_at": "2026-07-28T00:03:00+08:00",
            "model": "gpt-5.4",
            "long_context_billing_applied": false
        }));

        assert_eq!(populated.service_tier.as_deref(), Some("priority"));
        assert_eq!(populated.image_input_tokens, Some(42));
        assert_eq!(populated.image_input_cost, Some(0.125));
        assert_eq!(populated.long_context_billing_applied, Some(true));
        assert_eq!(
            explicitly_not_applied.long_context_billing_applied,
            Some(false)
        );
        for row in [missing, nulls] {
            assert_eq!(row.service_tier, None);
            assert_eq!(row.image_input_tokens, None);
            assert_eq!(row.image_input_cost, None);
            assert_eq!(row.long_context_billing_applied, None);
        }
    }

    #[test]
    fn normalizes_gateway_key_usage_summary_payload() {
        let result = normalize_key_usage_summary(&json!({
            "daily_usage": [
                {
                    "date": "2026-07-06",
                    "requests": 1933,
                    "input_tokens": 16445350,
                    "output_tokens": 1346004,
                    "cache_read_tokens": 214308864,
                    "cache_write_tokens": 0,
                    "total_tokens": 232100218,
                    "cost": 221.15564085,
                    "actual_cost": 221.15564085
                }
            ],
            "model_stats": [
                {
                    "model": "gpt-5.4",
                    "requests": 76586,
                    "input_tokens": 1321881721,
                    "output_tokens": 71450195,
                    "cache_creation_tokens": 0,
                    "cache_read_tokens": 16105789557_i64,
                    "total_tokens": 17499121473_i64,
                    "cost": 13749.67790325,
                    "actual_cost": 13749.67790325
                }
            ],
            "planName": "CodeX Plus 年度",
            "remaining": 278.84435915,
            "subscription": {
                "daily_limit_usd": 500,
                "daily_usage_usd": 221.15564085,
                "weekly_limit_usd": 0,
                "weekly_usage_usd": 1989.21202395,
                "monthly_limit_usd": 0,
                "monthly_usage_usd": 8733.7644274,
                "expires_at": "2027-05-21T22:42:23.926654+08:00"
            },
            "usage": {
                "average_duration_ms": 23949.84580428118,
                "rpm": 6,
                "tpm": 939063,
                "today": {
                    "actual_cost": 221.15564085,
                    "cache_creation_tokens": 0,
                    "cache_read_tokens": 214308864,
                    "cost": 221.15564085,
                    "input_tokens": 16445350,
                    "output_tokens": 1346004,
                    "requests": 1933,
                    "total_tokens": 232100218
                },
                "total": {
                    "actual_cost": 24031.8134679,
                    "cache_creation_tokens": 0,
                    "cache_read_tokens": 27732526860_i64,
                    "cost": 24031.8134679,
                    "input_tokens": 2592494882_i64,
                    "output_tokens": 129029619,
                    "requests": 147436,
                    "total_tokens": 30454051361_i64
                }
            }
        }));

        assert_eq!(result.daily_usage.len(), 1);
        assert_eq!(result.daily_usage[0].date, "2026-07-06");
        assert_eq!(result.daily_usage[0].cache_write_tokens, Some(0));
        assert_eq!(result.today.requests, 1933);
        assert_eq!(result.today.cache_read_tokens, Some(214308864));
        assert_eq!(result.total.requests, 147436);
        assert_eq!(result.average_duration_ms, Some(23949.84580428118));
        assert_eq!(result.rpm, Some(6.0));
        assert_eq!(result.tpm, Some(939063.0));
        assert_eq!(result.plan_name.as_deref(), Some("CodeX Plus 年度"));
        assert_eq!(result.remaining, Some(278.84435915));
        assert_eq!(
            result
                .subscription
                .as_ref()
                .and_then(|item| item.daily_limit_usd),
            Some(500.0)
        );
        assert_eq!(result.model_stats[0].model, "gpt-5.4");
    }
}
