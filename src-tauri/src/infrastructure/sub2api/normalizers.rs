use serde_json::Value;
use std::collections::HashMap;

use crate::contracts::{
    DailyUsagePoint, DashboardModelsPayload, GroupRecord, KeyRecord, ManagedKeyRecord,
    ModelUsagePoint, OrderRecord, PaginatedResult, PaymentConfigRecord, PlatformQuotaPayload,
    PlatformQuotaRecord, ProfileUpdateInput, SubscriptionQuotaWindow, SubscriptionSummaryPayload,
    SubscriptionSummaryRecord, UsageRow, UsageStatsRecord, UsageTrendPayload, UserIdentityBinding,
    UserProfileRecord,
};

pub fn pick_value<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.').try_fold(value, |current, segment| current.get(segment))
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
            .or_else(|| node.as_str().and_then(|item| item.trim().parse::<f64>().ok()))
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
        name: pick_string(item, &["name"], Some("未命名分组")).unwrap_or_else(|| "未命名分组".into()),
        description: pick_string(item, &["description"], None),
        platform: pick_string(item, &["platform"], Some("unknown")).unwrap_or_else(|| "unknown".into()),
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
            name: pick_string(item, &["name"], Some("Unnamed Key")).unwrap_or_else(|| "Unnamed Key".into()),
            status: pick_string(item, &["status"], Some("unknown")).unwrap_or_else(|| "unknown".into()),
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
    let cache_read_tokens = pick_number(item, &["cache_read_tokens", "total_cache_tokens"], 0.0) as i64;
    let fallback_total = input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens;

    UsageRow {
        id: pick_string(item, &["id", "request_id"], Some("")).unwrap_or_default(),
        api_key_id: pick_optional_number(item, &["api_key_id"]).map(|item| item as i64),
        created_at: pick_string(item, &["created_at"], None).unwrap_or_default(),
        model: pick_string(item, &["model"], Some("unknown")).unwrap_or_else(|| "unknown".into()),
        reasoning_effort: pick_string(item, &["reasoning_effort"], None),
        endpoint: pick_string(item, &["inbound_endpoint", "endpoint"], None),
        upstream_endpoint: pick_string(item, &["upstream_endpoint"], None),
        actual_cost: pick_number(item, &["actual_cost", "total_actual_cost"], 0.0),
        total_cost: pick_number(item, &["total_cost", "cost"], 0.0),
        input_tokens,
        output_tokens,
        input_cost: pick_optional_number(item, &["input_cost"]),
        output_cost: pick_optional_number(item, &["output_cost"]),
        cache_creation_tokens: Some(cache_creation_tokens),
        cache_read_tokens: Some(cache_read_tokens),
        cache_creation_cost: pick_optional_number(item, &["cache_creation_cost"]),
        cache_read_cost: pick_optional_number(item, &["cache_read_cost"]),
        total_tokens: pick_number(item, &["total_tokens"], fallback_total as f64) as i64,
        first_token_ms: pick_optional_number(item, &["first_token_ms"]).map(|item| item as i64),
        duration_ms: pick_optional_number(item, &["duration_ms"]).map(|item| item as i64),
        billing_mode: pick_string(item, &["billing_mode"], None),
        request_type: pick_string(item, &["request_type"], None),
        stream: pick_value(item, "stream").and_then(Value::as_bool),
        billing_type: pick_optional_number(item, &["billing_type"]).map(|item| item as i64),
        rate_multiplier: pick_optional_number(item, &["rate_multiplier"]),
        user_agent: pick_string(item, &["user_agent"], None),
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

pub fn build_paginated<T>(raw: &Value, items: Vec<T>, page: i64, page_size: i64) -> PaginatedResult<T> {
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
        total_cache_tokens: pick_optional_number(raw, &["total_cache_tokens"]).map(|item| item as i64),
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
                cache_write_tokens: Some(
                    pick_number(&item, &["cache_creation_tokens", "cache_write_tokens"], 0.0) as i64,
                ),
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
                model: pick_string(&item, &["model"], Some("unknown")).unwrap_or_else(|| "unknown".into()),
                requests: pick_number(&item, &["requests"], 0.0) as i64,
                input_tokens: pick_number(&item, &["input_tokens"], 0.0) as i64,
                output_tokens: pick_number(&item, &["output_tokens"], 0.0) as i64,
                cache_creation_tokens: Some(pick_number(&item, &["cache_creation_tokens"], 0.0) as i64),
                cache_read_tokens: Some(pick_number(&item, &["cache_read_tokens"], 0.0) as i64),
                total_tokens: pick_number(&item, &["total_tokens"], 0.0) as i64,
                cost: Some(pick_number(&item, &["cost"], 0.0)),
                actual_cost: Some(pick_number(&item, &["actual_cost"], 0.0)),
            })
            .collect(),
    }
}

pub fn normalize_daily_usage_rows(items: &[Value]) -> Vec<DailyUsagePoint> {
    items.iter()
        .map(|item| DailyUsagePoint {
            date: pick_string(item, &["date", "bucket", "day"], Some("")).unwrap_or_default(),
            requests: pick_number(item, &["requests", "request_count"], 0.0) as i64,
            input_tokens: pick_number(item, &["input_tokens"], 0.0) as i64,
            output_tokens: pick_number(item, &["output_tokens"], 0.0) as i64,
            cache_read_tokens: Some(pick_number(item, &["cache_read_tokens"], 0.0) as i64),
            cache_write_tokens: Some(
                pick_number(item, &["cache_creation_tokens", "cache_write_tokens"], 0.0) as i64,
            ),
            total_tokens: Some(pick_number(item, &["total_tokens", "tokens"], 0.0) as i64),
            actual_cost: Some(pick_number(item, &["actual_cost", "total_actual_cost"], 0.0)),
            total_cost: Some(pick_number(item, &["cost", "total_cost"], 0.0)),
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
            status: pick_string(&item, &["status"], Some("unknown")).unwrap_or_else(|| "unknown".into()),
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
                items.iter()
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

pub fn normalize_payment_config(raw: &Value) -> PaymentConfigRecord {
    PaymentConfigRecord {
        enabled: pick_bool(raw, "enabled"),
        min_amount: pick_number(raw, &["min_amount"], 0.0),
        max_amount: pick_number(raw, &["max_amount"], 0.0),
        daily_limit: pick_number(raw, &["daily_limit"], 0.0),
        order_timeout_minutes: pick_number(raw, &["order_timeout_minutes"], 0.0) as i64,
        max_pending_orders: pick_number(raw, &["max_pending_orders"], 0.0) as i64,
        enabled_payment_types: raw
            .get("enabled_payment_types")
            .and_then(Value::as_array)
            .map(|items| {
                items.iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    }
}

pub fn normalize_order_record(item: &Value) -> OrderRecord {
    OrderRecord {
        id: pick_number(item, &["id"], 0.0) as i64,
        status: pick_string(item, &["status"], Some("unknown")).unwrap_or_else(|| "unknown".into()),
        amount: pick_number(item, &["amount"], 0.0),
        provider_instance_id: pick_optional_number(item, &["provider_instance_id"]).map(|item| item as i64),
        out_trade_no: pick_string(item, &["out_trade_no"], None),
        created_at: pick_string(item, &["created_at"], None),
        updated_at: pick_string(item, &["updated_at"], None),
        paid_at: pick_string(item, &["paid_at"], None),
        refunded_at: pick_string(item, &["refunded_at"], None),
        product_name: pick_string(item, &["product_name", "plan_name", "name"], None),
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
        body.insert("balance_notify_threshold_type".into(), Value::String(kind.clone()));
    }
    if let Some(threshold) = payload.balance_notify_threshold {
        body.insert("balance_notify_threshold".into(), Value::from(threshold));
    }
    Value::Object(body)
}

#[cfg(test)]
mod tests {
    use super::{normalize_managed_key_record, normalize_subscription_summary};
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
}
