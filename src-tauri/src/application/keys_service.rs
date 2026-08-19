use anyhow::Result;
use serde_json::Value;

use crate::contracts::{
    GroupRecord, KeyMutationInput, KeyPatchInput, ManagedKeyRecord, PaginatedResult,
};
use crate::infrastructure::sub2api::normalizers::normalize_managed_key_record;

use super::{
    data_center_service,
    resource_coordinator::LiveResourceKind,
    upstream_service::{self, UpstreamRequestPolicy},
    AppContext,
};

pub async fn get_available_groups(ctx: &AppContext, account_id: &str) -> Result<Vec<GroupRecord>> {
    ctx.live_resources
        .get_or_fetch(account_id, LiveResourceKind::Groups, false, || async {
            data_center_service::fetch_groups(ctx, account_id, UpstreamRequestPolicy::ReadOnly)
                .await
        })
        .await
}

pub async fn list_managed_keys(
    ctx: &AppContext,
    account_id: &str,
    page: i64,
    page_size: i64,
    force: bool,
) -> Result<PaginatedResult<ManagedKeyRecord>> {
    let rows = load_managed_keys(ctx, account_id, force).await?;
    Ok(paginate_cached_keys(rows, page, page_size))
}

pub async fn get_managed_key(
    ctx: &AppContext,
    account_id: &str,
    key_id: &str,
) -> Result<ManagedKeyRecord> {
    load_managed_keys(ctx, account_id, false)
        .await?
        .into_iter()
        .find(|record| record.key.id == key_id)
        .ok_or_else(|| anyhow::anyhow!("Key 不存在。"))
}

pub async fn create_managed_key(
    ctx: &AppContext,
    account_id: &str,
    payload: KeyMutationInput,
) -> Result<ManagedKeyRecord> {
    let raw = upstream_service::account_upstream_request(
        ctx,
        account_id,
        "/api/v1/keys",
        "POST",
        Some(key_mutation_payload(&payload, false)),
        UpstreamRequestPolicy::RecoverableSyncOrWrite,
    )
    .await?;
    ctx.live_resources
        .invalidate(account_id, LiveResourceKind::Keys)
        .await;
    Ok(normalize_managed_key_record(&raw))
}

pub async fn update_managed_key(
    ctx: &AppContext,
    account_id: &str,
    key_id: &str,
    payload: KeyPatchInput,
) -> Result<ManagedKeyRecord> {
    let raw = update_managed_key_raw(ctx, account_id, key_id, payload).await?;
    Ok(normalize_managed_key_record(&raw))
}

pub async fn update_managed_key_raw(
    ctx: &AppContext,
    account_id: &str,
    key_id: &str,
    payload: KeyPatchInput,
) -> Result<Value> {
    let raw = upstream_service::account_upstream_request(
        ctx,
        account_id,
        &format!("/api/v1/keys/{key_id}"),
        "PUT",
        Some(key_patch_payload(&payload)),
        UpstreamRequestPolicy::RecoverableSyncOrWrite,
    )
    .await?;
    ctx.live_resources
        .invalidate(account_id, LiveResourceKind::Keys)
        .await;
    ctx.live_resources
        .invalidate(account_id, LiveResourceKind::Subscriptions)
        .await;
    ctx.live_resources
        .invalidate(account_id, LiveResourceKind::SubscriptionSummary)
        .await;
    Ok(raw)
}

pub async fn delete_managed_key(ctx: &AppContext, account_id: &str, key_id: &str) -> Result<bool> {
    upstream_service::account_upstream_request(
        ctx,
        account_id,
        &format!("/api/v1/keys/{key_id}"),
        "DELETE",
        None,
        UpstreamRequestPolicy::RecoverableSyncOrWrite,
    )
    .await?;
    ctx.live_resources
        .invalidate(account_id, LiveResourceKind::Keys)
        .await;
    ctx.live_resources
        .invalidate(account_id, LiveResourceKind::Subscriptions)
        .await;
    ctx.live_resources
        .invalidate(account_id, LiveResourceKind::SubscriptionSummary)
        .await;
    Ok(true)
}

async fn load_managed_keys(
    ctx: &AppContext,
    account_id: &str,
    force: bool,
) -> Result<Vec<ManagedKeyRecord>> {
    ctx.live_resources
        .get_or_fetch(account_id, LiveResourceKind::Keys, force, || async {
            data_center_service::fetch_keys(ctx, account_id, UpstreamRequestPolicy::ReadOnly).await
        })
        .await
}

fn key_mutation_payload(payload: &KeyMutationInput, include_resets: bool) -> Value {
    let mut body = serde_json::Map::new();
    body.insert("name".into(), Value::String(payload.name.clone()));
    if let Some(group_id) = payload.group_id {
        body.insert("group_id".into(), Value::from(group_id));
    }
    if let Some(custom_key) = &payload.custom_key {
        body.insert("custom_key".into(), Value::String(custom_key.clone()));
    }
    if let Some(ip_whitelist) = &payload.ip_whitelist {
        body.insert("ip_whitelist".into(), json_string_array(ip_whitelist));
    }
    if let Some(ip_blacklist) = &payload.ip_blacklist {
        body.insert("ip_blacklist".into(), json_string_array(ip_blacklist));
    }
    if let Some(quota) = payload.quota {
        body.insert("quota".into(), Value::from(quota));
    }
    if let Some(expires_in_days) = payload.expires_in_days {
        body.insert("expires_in_days".into(), Value::from(expires_in_days));
    }
    if let Some(status) = &payload.status {
        body.insert("status".into(), Value::String(status.clone()));
    }
    if let Some(rate_limit5h) = payload.rate_limit5h {
        body.insert("rate_limit_5h".into(), Value::from(rate_limit5h));
    }
    if let Some(rate_limit1d) = payload.rate_limit1d {
        body.insert("rate_limit_1d".into(), Value::from(rate_limit1d));
    }
    if let Some(rate_limit7d) = payload.rate_limit7d {
        body.insert("rate_limit_7d".into(), Value::from(rate_limit7d));
    }
    if include_resets {
        if let Some(reset_quota) = payload.reset_quota {
            body.insert("reset_quota".into(), Value::Bool(reset_quota));
        }
        if let Some(reset_rate_limit_usage) = payload.reset_rate_limit_usage {
            body.insert(
                "reset_rate_limit_usage".into(),
                Value::Bool(reset_rate_limit_usage),
            );
        }
    }
    Value::Object(body)
}

fn key_patch_payload(payload: &KeyPatchInput) -> Value {
    let mut body = serde_json::Map::new();
    if let Some(name) = &payload.name {
        body.insert("name".into(), Value::String(name.clone()));
    }
    if let Some(group_id) = payload.group_id {
        body.insert("group_id".into(), Value::from(group_id));
    }
    if let Some(custom_key) = &payload.custom_key {
        body.insert("custom_key".into(), Value::String(custom_key.clone()));
    }
    if let Some(ip_whitelist) = &payload.ip_whitelist {
        body.insert("ip_whitelist".into(), json_string_array(ip_whitelist));
    }
    if let Some(ip_blacklist) = &payload.ip_blacklist {
        body.insert("ip_blacklist".into(), json_string_array(ip_blacklist));
    }
    if let Some(quota) = payload.quota {
        body.insert("quota".into(), Value::from(quota));
    }
    if let Some(expires_in_days) = payload.expires_in_days {
        body.insert("expires_in_days".into(), Value::from(expires_in_days));
    }
    if let Some(status) = &payload.status {
        body.insert("status".into(), Value::String(status.clone()));
    }
    if let Some(rate_limit5h) = payload.rate_limit5h {
        body.insert("rate_limit_5h".into(), Value::from(rate_limit5h));
    }
    if let Some(rate_limit1d) = payload.rate_limit1d {
        body.insert("rate_limit_1d".into(), Value::from(rate_limit1d));
    }
    if let Some(rate_limit7d) = payload.rate_limit7d {
        body.insert("rate_limit_7d".into(), Value::from(rate_limit7d));
    }
    if let Some(reset_quota) = payload.reset_quota {
        body.insert("reset_quota".into(), Value::Bool(reset_quota));
    }
    if let Some(reset_rate_limit_usage) = payload.reset_rate_limit_usage {
        body.insert(
            "reset_rate_limit_usage".into(),
            Value::Bool(reset_rate_limit_usage),
        );
    }
    Value::Object(body)
}

fn json_string_array(items: &[String]) -> Value {
    Value::Array(items.iter().cloned().map(Value::String).collect())
}

fn paginate_cached_keys(
    rows: Vec<ManagedKeyRecord>,
    page: i64,
    page_size: i64,
) -> PaginatedResult<ManagedKeyRecord> {
    let safe_page_size = page_size.max(1);
    let safe_page = page.max(1);
    let total = rows.len() as i64;
    let pages = ((total as f64) / safe_page_size as f64).ceil().max(1.0) as i64;
    let start = ((safe_page - 1) * safe_page_size) as usize;
    let items = rows
        .into_iter()
        .skip(start)
        .take(safe_page_size as usize)
        .collect::<Vec<_>>();
    PaginatedResult {
        items,
        page: safe_page,
        page_size: safe_page_size,
        total,
        pages,
    }
}

#[cfg(test)]
mod tests {
    use super::{key_patch_payload, paginate_cached_keys};
    use crate::contracts::{KeyPatchInput, KeyRecord, ManagedKeyRecord};
    use serde_json::json;

    #[test]
    fn paginates_cached_keys() {
        let rows = vec![
            build_key("key-1", "First Key"),
            build_key("key-2", "Second Key"),
            build_key("key-3", "Third Key"),
        ];

        let page = paginate_cached_keys(rows, 2, 2);

        assert_eq!(page.page, 2);
        assert_eq!(page.page_size, 2);
        assert_eq!(page.total, 3);
        assert_eq!(page.pages, 2);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].key.id, "key-3");
    }

    #[test]
    fn key_patch_payload_allows_status_only_updates() {
        let payload = KeyPatchInput {
            status: Some("inactive".into()),
            ..KeyPatchInput::default()
        };

        let body = key_patch_payload(&payload);

        assert_eq!(body, json!({ "status": "inactive" }));
    }

    #[test]
    fn key_patch_payload_sends_ip_lists_as_arrays() {
        let payload = KeyPatchInput {
            ip_whitelist: Some(vec!["192.168.1.100".into(), "10.0.0.0/8".into()]),
            ip_blacklist: Some(vec!["1.2.3.4".into()]),
            ..KeyPatchInput::default()
        };

        let body = key_patch_payload(&payload);

        assert_eq!(
            body,
            json!({
                "ip_whitelist": ["192.168.1.100", "10.0.0.0/8"],
                "ip_blacklist": ["1.2.3.4"]
            })
        );
    }

    fn build_key(id: &str, name: &str) -> ManagedKeyRecord {
        ManagedKeyRecord {
            key: KeyRecord {
                id: id.into(),
                group_id: None,
                name: name.into(),
                status: "active".into(),
                platform: Some("openai".into()),
                group_name: Some("Annual".into()),
                expires_at: None,
                last_used_at: None,
                quota: None,
                quota_used: None,
                rate_limit5h: None,
                rate_limit1d: None,
                rate_limit7d: None,
                usage5h: None,
                usage1d: None,
                usage7d: None,
                current_concurrency: None,
            },
            api_key_id: None,
            raw_key: None,
            user_id: None,
            ip_whitelist: None,
            ip_blacklist: None,
            window5h_start: None,
            window1d_start: None,
            window7d_start: None,
        }
    }
}
