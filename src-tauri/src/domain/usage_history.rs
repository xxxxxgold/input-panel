use std::collections::{HashMap, HashSet};

use crate::contracts::{UsageHistoryRow, UsageRow};

pub fn merge_request_history(
    previous: &[UsageHistoryRow],
    latest: &[UsageRow],
    fetched_at: &str,
) -> Vec<UsageHistoryRow> {
    let latest_keys: HashSet<String> = latest.iter().map(usage_identity).collect();
    let mut merged: HashMap<String, UsageHistoryRow> = HashMap::new();

    for row in previous {
        let identity = usage_identity_history(row);
        merged.insert(
            identity.clone(),
            UsageHistoryRow {
                id: row.id.clone(),
                api_key_id: row.api_key_id,
                created_at: row.created_at.clone(),
                model: row.model.clone(),
                reasoning_effort: row.reasoning_effort.clone(),
                endpoint: row.endpoint.clone(),
                upstream_endpoint: row.upstream_endpoint.clone(),
                actual_cost: row.actual_cost,
                total_cost: row.total_cost,
                input_tokens: row.input_tokens,
                output_tokens: row.output_tokens,
                input_cost: row.input_cost,
                output_cost: row.output_cost,
                cache_creation_tokens: row.cache_creation_tokens,
                cache_read_tokens: row.cache_read_tokens,
                cache_creation_cost: row.cache_creation_cost,
                cache_read_cost: row.cache_read_cost,
                total_tokens: row.total_tokens,
                first_token_ms: row.first_token_ms,
                duration_ms: row.duration_ms,
                billing_mode: row.billing_mode.clone(),
                request_type: row.request_type.clone(),
                stream: row.stream,
                billing_type: row.billing_type,
                rate_multiplier: row.rate_multiplier,
                user_agent: row.user_agent.clone(),
                api_key_name: row.api_key_name.clone(),
                platform: row.platform.clone(),
                subscription_name: row.subscription_name.clone(),
                group_name: row.group_name.clone(),
                subscription_type: row.subscription_type.clone(),
                first_seen_at: row.first_seen_at.clone(),
                last_seen_at: if latest_keys.contains(&identity) {
                    fetched_at.to_string()
                } else {
                    row.last_seen_at.clone()
                },
                is_latest: latest_keys.contains(&identity),
            },
        );
    }

    for row in latest {
        let identity = usage_identity(row);
        if let Some(existing) = merged.get_mut(&identity) {
            existing.id = row.id.clone();
            existing.api_key_id = row.api_key_id;
            existing.created_at = row.created_at.clone();
            existing.model = row.model.clone();
            existing.reasoning_effort = row.reasoning_effort.clone();
            existing.endpoint = row.endpoint.clone();
            existing.upstream_endpoint = row.upstream_endpoint.clone();
            existing.actual_cost = row.actual_cost;
            existing.total_cost = row.total_cost;
            existing.input_tokens = row.input_tokens;
            existing.output_tokens = row.output_tokens;
            existing.input_cost = row.input_cost;
            existing.output_cost = row.output_cost;
            existing.cache_creation_tokens = row.cache_creation_tokens;
            existing.cache_read_tokens = row.cache_read_tokens;
            existing.cache_creation_cost = row.cache_creation_cost;
            existing.cache_read_cost = row.cache_read_cost;
            existing.total_tokens = row.total_tokens;
            existing.first_token_ms = row.first_token_ms;
            existing.duration_ms = row.duration_ms;
            existing.billing_mode = row.billing_mode.clone();
            existing.request_type = row.request_type.clone();
            existing.stream = row.stream;
            existing.billing_type = row.billing_type;
            existing.rate_multiplier = row.rate_multiplier;
            existing.user_agent = row.user_agent.clone();
            existing.api_key_name = row.api_key_name.clone();
            existing.platform = row.platform.clone();
            existing.subscription_name = row.subscription_name.clone();
            existing.group_name = row.group_name.clone();
            existing.subscription_type = row.subscription_type.clone();
            existing.last_seen_at = fetched_at.to_string();
            existing.is_latest = true;
            continue;
        }

        merged.insert(
            identity,
            UsageHistoryRow {
                id: row.id.clone(),
                api_key_id: row.api_key_id,
                created_at: row.created_at.clone(),
                model: row.model.clone(),
                reasoning_effort: row.reasoning_effort.clone(),
                endpoint: row.endpoint.clone(),
                upstream_endpoint: row.upstream_endpoint.clone(),
                actual_cost: row.actual_cost,
                total_cost: row.total_cost,
                input_tokens: row.input_tokens,
                output_tokens: row.output_tokens,
                input_cost: row.input_cost,
                output_cost: row.output_cost,
                cache_creation_tokens: row.cache_creation_tokens,
                cache_read_tokens: row.cache_read_tokens,
                cache_creation_cost: row.cache_creation_cost,
                cache_read_cost: row.cache_read_cost,
                total_tokens: row.total_tokens,
                first_token_ms: row.first_token_ms,
                duration_ms: row.duration_ms,
                billing_mode: row.billing_mode.clone(),
                request_type: row.request_type.clone(),
                stream: row.stream,
                billing_type: row.billing_type,
                rate_multiplier: row.rate_multiplier,
                user_agent: row.user_agent.clone(),
                api_key_name: row.api_key_name.clone(),
                platform: row.platform.clone(),
                subscription_name: row.subscription_name.clone(),
                group_name: row.group_name.clone(),
                subscription_type: row.subscription_type.clone(),
                first_seen_at: fetched_at.to_string(),
                last_seen_at: fetched_at.to_string(),
                is_latest: true,
            },
        );
    }

    let mut items: Vec<UsageHistoryRow> = merged.into_values().collect();
    items.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| right.last_seen_at.cmp(&left.last_seen_at))
    });
    items
}

fn usage_identity(row: &UsageRow) -> String {
    if !row.id.trim().is_empty() {
        return format!("id:{}", row.id);
    }
    format!(
        "fallback:{}:{}:{}:{}",
        row.created_at, row.model, row.actual_cost, row.total_tokens
    )
}

fn usage_identity_history(row: &UsageHistoryRow) -> String {
    if !row.id.trim().is_empty() {
        return format!("id:{}", row.id);
    }
    format!(
        "fallback:{}:{}:{}:{}",
        row.created_at, row.model, row.actual_cost, row.total_tokens
    )
}

#[cfg(test)]
mod tests {
    use super::merge_request_history;
    use crate::contracts::{UsageHistoryRow, UsageRow};

    #[test]
    fn merges_rows_and_marks_latest() {
        let merged = merge_request_history(
            &[UsageHistoryRow {
                id: "usage-1".into(),
                api_key_id: Some(1),
                created_at: "2026-06-05T08:00:00.000Z".into(),
                model: "gpt-4.1".into(),
                reasoning_effort: None,
                endpoint: Some("/responses".into()),
                upstream_endpoint: None,
                actual_cost: 0.12,
                total_cost: 0.12,
                input_tokens: 10,
                output_tokens: 20,
                input_cost: None,
                output_cost: None,
                cache_creation_tokens: Some(0),
                cache_read_tokens: Some(0),
                cache_creation_cost: None,
                cache_read_cost: None,
                total_tokens: 30,
                first_token_ms: None,
                duration_ms: None,
                billing_mode: None,
                request_type: None,
                stream: None,
                billing_type: None,
                rate_multiplier: None,
                user_agent: None,
                api_key_name: Some("Main".into()),
                platform: Some("openai".into()),
                subscription_name: Some("Pro".into()),
                group_name: None,
                subscription_type: None,
                first_seen_at: "2026-06-05T09:00:00.000Z".into(),
                last_seen_at: "2026-06-05T09:00:00.000Z".into(),
                is_latest: true,
            }],
            &[UsageRow {
                id: "usage-2".into(),
                api_key_id: Some(1),
                created_at: "2026-06-05T10:00:00.000Z".into(),
                model: "gpt-4.1-mini".into(),
                reasoning_effort: None,
                endpoint: Some("/chat/completions".into()),
                upstream_endpoint: None,
                actual_cost: 0.2,
                total_cost: 0.2,
                input_tokens: 30,
                output_tokens: 40,
                input_cost: None,
                output_cost: None,
                cache_creation_tokens: Some(0),
                cache_read_tokens: Some(0),
                cache_creation_cost: None,
                cache_read_cost: None,
                total_tokens: 70,
                first_token_ms: None,
                duration_ms: None,
                billing_mode: None,
                request_type: None,
                stream: None,
                billing_type: None,
                rate_multiplier: None,
                user_agent: None,
                api_key_name: Some("Main".into()),
                platform: Some("openai".into()),
                subscription_name: Some("Pro".into()),
                group_name: None,
                subscription_type: None,
            }],
            "2026-06-05T11:00:00.000Z",
        );

        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].id, "usage-2");
        assert!(merged[0].is_latest);
        assert_eq!(merged[1].id, "usage-1");
        assert!(!merged[1].is_latest);
    }
}
