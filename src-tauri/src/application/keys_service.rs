use anyhow::Result;
use serde_json::Value;

use crate::contracts::{GroupRecord, KeyMutationInput, KeyPatchInput, ManagedKeyRecord, PaginatedResult};
use crate::infrastructure::sub2api::normalizers::{
    build_paginated, normalize_group_record, normalize_items, normalize_managed_key_record,
};

use super::{proxy_service, AppContext};

pub async fn get_available_groups(ctx: &AppContext, account_id: &str) -> Result<Vec<GroupRecord>> {
    let raw = match proxy_service::account_proxy_request(
        ctx,
        account_id,
        "/api/v1/groups/available",
        "GET",
        None,
    )
    .await
    {
        Ok(raw) => raw,
        Err(error) if is_optional_endpoint_unavailable(&error) => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    Ok(normalize_items(&raw)
        .iter()
        .map(normalize_group_record)
        .collect())
}

pub async fn list_managed_keys(
    ctx: &AppContext,
    account_id: &str,
    page: i64,
    page_size: i64,
) -> Result<PaginatedResult<ManagedKeyRecord>> {
    let raw = proxy_service::account_proxy_request(
        ctx,
        account_id,
        &format!("/api/v1/keys?page={page}&page_size={page_size}"),
        "GET",
        None,
    )
    .await?;
    let items = normalize_items(&raw)
        .iter()
        .map(normalize_managed_key_record)
        .collect();
    Ok(build_paginated(&raw, items, page, page_size))
}

pub async fn get_managed_key(
    ctx: &AppContext,
    account_id: &str,
    key_id: &str,
) -> Result<ManagedKeyRecord> {
    match proxy_service::account_proxy_request(
        ctx,
        account_id,
        &format!("/api/v1/keys/{key_id}"),
        "GET",
        None,
    )
    .await
    {
        Ok(raw) => Ok(normalize_managed_key_record(&raw)),
        Err(error) if is_optional_endpoint_unavailable(&error) => {
            if let Some(record) = load_managed_key_from_list(ctx, account_id, key_id).await? {
                return Ok(record);
            }
            Err(error)
        }
        Err(error) => Err(error),
    }
}

pub async fn create_managed_key(
    ctx: &AppContext,
    account_id: &str,
    payload: KeyMutationInput,
) -> Result<ManagedKeyRecord> {
    let raw = proxy_service::account_proxy_request(
        ctx,
        account_id,
        "/api/v1/keys",
        "POST",
        Some(key_mutation_payload(&payload, false)),
    )
    .await?;
    Ok(normalize_managed_key_record(&raw))
}

pub async fn update_managed_key(
    ctx: &AppContext,
    account_id: &str,
    key_id: &str,
    payload: KeyPatchInput,
) -> Result<ManagedKeyRecord> {
    let raw = proxy_service::account_proxy_request(
        ctx,
        account_id,
        &format!("/api/v1/keys/{key_id}"),
        "PUT",
        Some(key_patch_payload(&payload)),
    )
    .await?;
    Ok(normalize_managed_key_record(&raw))
}

pub async fn delete_managed_key(ctx: &AppContext, account_id: &str, key_id: &str) -> Result<bool> {
    proxy_service::account_proxy_request(
        ctx,
        account_id,
        &format!("/api/v1/keys/{key_id}"),
        "DELETE",
        None,
    )
    .await?;
    Ok(true)
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
        body.insert("ip_whitelist".into(), Value::String(ip_whitelist.clone()));
    }
    if let Some(ip_blacklist) = &payload.ip_blacklist {
        body.insert("ip_blacklist".into(), Value::String(ip_blacklist.clone()));
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
        body.insert("ip_whitelist".into(), Value::String(ip_whitelist.clone()));
    }
    if let Some(ip_blacklist) = &payload.ip_blacklist {
        body.insert("ip_blacklist".into(), Value::String(ip_blacklist.clone()));
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

fn is_optional_endpoint_unavailable(error: &anyhow::Error) -> bool {
    let message = error.to_string();
    message.contains("未找到可用的接口路径") || message.contains("404")
}

async fn load_managed_key_from_list(
    ctx: &AppContext,
    account_id: &str,
    key_id: &str,
) -> Result<Option<ManagedKeyRecord>> {
    let raw = proxy_service::account_proxy_request(
        ctx,
        account_id,
        "/api/v1/keys?page=1&page_size=100",
        "GET",
        None,
    )
    .await?;
    Ok(find_managed_key_in_list_payload(&raw, key_id))
}

fn find_managed_key_in_list_payload(raw: &Value, key_id: &str) -> Option<ManagedKeyRecord> {
    normalize_items(raw)
        .into_iter()
        .map(|item| normalize_managed_key_record(&item))
        .find(|record| record.key.id == key_id)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{find_managed_key_in_list_payload, key_patch_payload};
    use crate::contracts::KeyPatchInput;

    #[test]
    fn finds_matching_key_from_list_payload() {
        let raw = json!({
            "items": [
                {
                    "id": "key-1",
                    "name": "First Key",
                    "status": "active",
                    "group": { "name": "Annual", "platform": "openai" }
                },
                {
                    "id": "key-2",
                    "name": "Second Key",
                    "status": "inactive",
                    "group": { "name": "Monthly", "platform": "anthropic" }
                }
            ]
        });

        let record = find_managed_key_in_list_payload(&raw, "key-2").expect("expected key to be found");

        assert_eq!(record.key.id, "key-2");
        assert_eq!(record.key.name, "Second Key");
        assert_eq!(record.key.group_name.as_deref(), Some("Monthly"));
        assert_eq!(record.key.platform.as_deref(), Some("anthropic"));
    }

    #[test]
    fn returns_none_when_key_is_missing_from_list_payload() {
        let raw = json!({
            "items": [
                { "id": "key-1", "name": "First Key", "status": "active" }
            ]
        });

        assert!(find_managed_key_in_list_payload(&raw, "missing-key").is_none());
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
}
