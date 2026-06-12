use anyhow::Result;
use serde_json::{json, Value};

use crate::contracts::{
    OrderRecord, PaginatedResult, PaymentConfigRecord, PlatformQuotaPayload,
    ProfileUpdateInput, SubscriptionSummaryPayload, UserProfileRecord,
};
use crate::infrastructure::sqlite::repositories;
use crate::infrastructure::sub2api::normalizers::{
    build_paginated, normalize_items, normalize_order_record, normalize_payment_config,
    normalize_platform_quotas, normalize_profile, normalize_subscription_summary,
    profile_update_payload,
};

use super::{proxy_service, AppContext};

pub async fn get_profile_record(ctx: &AppContext, account_id: &str) -> Result<UserProfileRecord> {
    let raw = proxy_service::account_proxy_request(
        ctx,
        account_id,
        "/api/v1/user/profile",
        "GET",
        None,
    )
    .await?;
    Ok(normalize_profile(&raw))
}

pub async fn update_profile_record(
    ctx: &AppContext,
    account_id: &str,
    payload: ProfileUpdateInput,
) -> Result<UserProfileRecord> {
    let raw = proxy_service::account_proxy_request(
        ctx,
        account_id,
        "/api/v1/user",
        "PUT",
        Some(profile_update_payload(&payload)),
    )
    .await?;
    Ok(normalize_profile(&raw))
}

pub async fn change_profile_password(
    ctx: &AppContext,
    account_id: &str,
    old_password: &str,
    new_password: &str,
) -> Result<bool> {
    proxy_service::account_proxy_request(
        ctx,
        account_id,
        "/api/v1/user/password",
        "PUT",
        Some(json!({
            "old_password": old_password,
            "new_password": new_password,
        })),
    )
    .await?;
    Ok(true)
}

pub async fn get_platform_quotas(
    ctx: &AppContext,
    account_id: &str,
) -> Result<PlatformQuotaPayload> {
    let raw = match proxy_service::account_proxy_request(
        ctx,
        account_id,
        "/api/v1/user/platform-quotas",
        "GET",
        None,
    )
    .await
    {
        Ok(raw) => raw,
        Err(error) if is_optional_endpoint_unavailable(&error) => {
            return Ok(PlatformQuotaPayload {
                platform_quotas: Vec::new(),
            })
        }
        Err(error) => return Err(error),
    };
    Ok(normalize_platform_quotas(&raw))
}

pub async fn get_subscription_summary(
    ctx: &AppContext,
    account_id: &str,
) -> Result<SubscriptionSummaryPayload> {
    let raw = match proxy_service::account_proxy_request(
        ctx,
        account_id,
        "/api/v1/subscriptions/summary",
        "GET",
        None,
    )
    .await
    {
        Ok(raw) => raw,
        Err(error) if is_optional_endpoint_unavailable(&error) => {
            return Ok(load_snapshot_subscription_summary(ctx, account_id)?)
        }
        Err(error) => return Err(error),
    };
    Ok(normalize_subscription_summary(&raw))
}

pub async fn get_payment_config(
    ctx: &AppContext,
    account_id: &str,
) -> Result<PaymentConfigRecord> {
    let raw = proxy_service::account_proxy_request(
        ctx,
        account_id,
        "/api/v1/payment/config",
        "GET",
        None,
    )
    .await?;
    Ok(normalize_payment_config(&raw))
}

pub async fn list_orders(
    ctx: &AppContext,
    account_id: &str,
    page: i64,
    page_size: i64,
) -> Result<PaginatedResult<OrderRecord>> {
    let raw = proxy_service::account_proxy_request(
        ctx,
        account_id,
        &format!("/api/v1/payment/orders/my?page={page}&page_size={page_size}"),
        "GET",
        None,
    )
    .await?;
    let items = normalize_items(&raw)
        .iter()
        .map(normalize_order_record)
        .collect();
    Ok(build_paginated(&raw, items, page, page_size))
}

pub async fn send_notify_email_code(
    ctx: &AppContext,
    account_id: &str,
    email: &str,
) -> Result<bool> {
    simple_bool_request(
        ctx,
        account_id,
        "/api/v1/user/notify-email/send-code",
        "POST",
        Some(json!({ "email": email })),
    )
    .await
}

pub async fn verify_notify_email(
    ctx: &AppContext,
    account_id: &str,
    email: &str,
    code: &str,
) -> Result<bool> {
    simple_bool_request(
        ctx,
        account_id,
        "/api/v1/user/notify-email/verify",
        "POST",
        Some(json!({ "email": email, "code": code })),
    )
    .await
}

pub async fn remove_notify_email(
    ctx: &AppContext,
    account_id: &str,
    email: &str,
) -> Result<bool> {
    simple_bool_request(
        ctx,
        account_id,
        "/api/v1/user/notify-email",
        "DELETE",
        Some(json!({ "email": email })),
    )
    .await
}

pub async fn toggle_notify_email(
    ctx: &AppContext,
    account_id: &str,
    email: &str,
    disabled: bool,
) -> Result<UserProfileRecord> {
    let raw = proxy_service::account_proxy_request(
        ctx,
        account_id,
        "/api/v1/user/notify-email/toggle",
        "PUT",
        Some(json!({ "email": email, "disabled": disabled })),
    )
    .await?;
    Ok(normalize_profile(&raw))
}

pub async fn send_email_binding_code(
    ctx: &AppContext,
    account_id: &str,
    email: &str,
) -> Result<bool> {
    simple_bool_request(
        ctx,
        account_id,
        "/api/v1/user/account-bindings/email/send-code",
        "POST",
        Some(json!({ "email": email })),
    )
    .await
}

pub async fn bind_email_identity(
    ctx: &AppContext,
    account_id: &str,
    email: &str,
    code: &str,
) -> Result<bool> {
    simple_bool_request(
        ctx,
        account_id,
        "/api/v1/user/account-bindings/email",
        "POST",
        Some(json!({ "email": email, "code": code })),
    )
    .await
}

pub async fn unbind_auth_identity(
    ctx: &AppContext,
    account_id: &str,
    provider: &str,
) -> Result<bool> {
    simple_bool_request(
        ctx,
        account_id,
        &format!("/api/v1/user/account-bindings/{provider}"),
        "DELETE",
        None,
    )
    .await
}

async fn simple_bool_request(
    ctx: &AppContext,
    account_id: &str,
    path: &str,
    method: &str,
    payload: Option<Value>,
) -> Result<bool> {
    proxy_service::account_proxy_request(ctx, account_id, path, method, payload).await?;
    Ok(true)
}

fn load_snapshot_subscription_summary(
    ctx: &AppContext,
    account_id: &str,
) -> Result<SubscriptionSummaryPayload> {
    let snapshot = repositories::read_state(&ctx.db)?
        .snapshots
        .get(account_id)
        .cloned();
    let Some(snapshot) = snapshot else {
        return Ok(SubscriptionSummaryPayload {
            active_count: 0,
            total_used_usd: 0.0,
            subscriptions: Vec::new(),
        });
    };

    let subscriptions = snapshot
        .subscriptions
        .iter()
        .map(|item| crate::contracts::SubscriptionSummaryRecord {
            id: item
                .id
                .parse::<i64>()
                .ok()
                .or(item.group_id)
                .unwrap_or(0),
            group_id: item.group_id.unwrap_or(0),
            group_name: item
                .group_name
                .clone()
                .unwrap_or_else(|| item.name.clone()),
            status: item.status.clone(),
            daily_used_usd: item.daily.as_ref().map(|window| window.current).unwrap_or(0.0),
            daily_limit_usd: item.daily.as_ref().map(|window| window.limit).unwrap_or(0.0),
            weekly_used_usd: item.weekly.as_ref().map(|window| window.current).unwrap_or(0.0),
            monthly_used_usd: item.monthly.as_ref().map(|window| window.current).unwrap_or(0.0),
            expires_at: item.expires_at.clone(),
        })
        .collect::<Vec<_>>();
    let active_count = subscriptions
        .iter()
        .filter(|item| item.status == "active")
        .count() as i64;
    let total_used_usd = subscriptions.iter().fold(0.0, |sum, item| {
        sum + if item.daily_used_usd > 0.0 {
            item.daily_used_usd
        } else if item.weekly_used_usd > 0.0 {
            item.weekly_used_usd
        } else {
            item.monthly_used_usd
        }
    });

    Ok(SubscriptionSummaryPayload {
        active_count,
        total_used_usd,
        subscriptions,
    })
}

fn is_optional_endpoint_unavailable(error: &anyhow::Error) -> bool {
    let message = error.to_string();
    message.contains("未找到可用的接口路径") || message.contains("404")
}
