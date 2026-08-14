use anyhow::Result;
use serde_json::{json, Value};

use crate::contracts::{
    EmailIdentityBindInput, PlatformQuotaPayload, ProfileUpdateInput, SubscriptionRecord,
    SubscriptionSummaryPayload, UserProfileRecord,
};
use crate::infrastructure::sub2api::normalizers::{normalize_profile, profile_update_payload};

use super::{
    auth_service, data_center_service,
    resource_coordinator::LiveResourceKind,
    upstream_service::{self, UpstreamRequestPolicy},
    AppContext,
};

pub async fn get_profile_record(
    ctx: &AppContext,
    account_id: &str,
    force: bool,
) -> Result<UserProfileRecord> {
    ctx.live_resources
        .get_or_fetch(account_id, LiveResourceKind::Profile, force, || async {
            data_center_service::fetch_profile(ctx, account_id, UpstreamRequestPolicy::ReadOnly)
                .await
        })
        .await
}

pub async fn update_profile_record(
    ctx: &AppContext,
    account_id: &str,
    payload: ProfileUpdateInput,
) -> Result<UserProfileRecord> {
    let raw = upstream_service::account_upstream_request(
        ctx,
        account_id,
        "/api/v1/user",
        "PUT",
        Some(profile_update_payload(&payload)),
        UpstreamRequestPolicy::RecoverableSyncOrWrite,
    )
    .await?;
    invalidate_profile(ctx, account_id).await;
    Ok(normalize_profile(&raw))
}

pub async fn change_profile_password(
    ctx: &AppContext,
    account_id: &str,
    old_password: &str,
    new_password: &str,
) -> Result<bool> {
    upstream_service::account_upstream_request(
        ctx,
        account_id,
        "/api/v1/user/password",
        "PUT",
        Some(json!({
            "old_password": old_password,
            "new_password": new_password,
        })),
        UpstreamRequestPolicy::RecoverableSyncOrWrite,
    )
    .await?;
    invalidate_profile(ctx, account_id).await;
    Ok(true)
}

pub async fn get_platform_quotas(
    ctx: &AppContext,
    account_id: &str,
) -> Result<PlatformQuotaPayload> {
    ctx.live_resources
        .get_or_fetch(
            account_id,
            LiveResourceKind::PlatformQuotas,
            false,
            || async {
                data_center_service::fetch_platform_quotas(
                    ctx,
                    account_id,
                    UpstreamRequestPolicy::ReadOnly,
                )
                .await
            },
        )
        .await
}

pub async fn get_subscriptions(
    ctx: &AppContext,
    account_id: &str,
    force: bool,
) -> Result<Vec<SubscriptionRecord>> {
    ctx.live_resources
        .get_or_fetch(
            account_id,
            LiveResourceKind::Subscriptions,
            force,
            || async {
                data_center_service::fetch_subscriptions(
                    ctx,
                    account_id,
                    UpstreamRequestPolicy::ReadOnly,
                )
                .await
            },
        )
        .await
}

pub async fn get_subscription_summary(
    ctx: &AppContext,
    account_id: &str,
) -> Result<SubscriptionSummaryPayload> {
    ctx.live_resources
        .get_or_fetch(
            account_id,
            LiveResourceKind::SubscriptionSummary,
            false,
            || async {
                match data_center_service::fetch_subscription_summary(
                    ctx,
                    account_id,
                    UpstreamRequestPolicy::ReadOnly,
                )
                .await
                {
                    Ok(summary) => Ok(summary),
                    Err(error) if auth_service::is_auth_expired_error(&error) => Err(error),
                    Err(_) => {
                        let subscriptions = get_subscriptions(ctx, account_id, false)
                            .await
                            .unwrap_or_default();
                        Ok(data_center_service::derive_subscription_summary(
                            &subscriptions,
                        ))
                    }
                }
            },
        )
        .await
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
    let result = simple_bool_request(
        ctx,
        account_id,
        "/api/v1/user/notify-email/verify",
        "POST",
        Some(json!({ "email": email, "code": code })),
    )
    .await?;
    invalidate_profile(ctx, account_id).await;
    Ok(result)
}

pub async fn remove_notify_email(ctx: &AppContext, account_id: &str, email: &str) -> Result<bool> {
    let result = simple_bool_request(
        ctx,
        account_id,
        "/api/v1/user/notify-email",
        "DELETE",
        Some(json!({ "email": email })),
    )
    .await?;
    invalidate_profile(ctx, account_id).await;
    Ok(result)
}

pub async fn toggle_notify_email(
    ctx: &AppContext,
    account_id: &str,
    email: &str,
    disabled: bool,
) -> Result<UserProfileRecord> {
    let raw = upstream_service::account_upstream_request(
        ctx,
        account_id,
        "/api/v1/user/notify-email/toggle",
        "PUT",
        Some(json!({ "email": email, "disabled": disabled })),
        UpstreamRequestPolicy::RecoverableSyncOrWrite,
    )
    .await?;
    invalidate_profile(ctx, account_id).await;
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
    payload: EmailIdentityBindInput,
) -> Result<UserProfileRecord> {
    let raw = upstream_service::account_upstream_request(
        ctx,
        account_id,
        "/api/v1/user/account-bindings/email",
        "POST",
        Some(json!({
            "email": payload.email,
            "verify_code": payload.verify_code,
            "password": payload.password,
        })),
        UpstreamRequestPolicy::RecoverableSyncOrWrite,
    )
    .await?;
    invalidate_profile(ctx, account_id).await;
    Ok(normalize_profile(&raw))
}

pub async fn unbind_auth_identity(
    ctx: &AppContext,
    account_id: &str,
    provider: &str,
) -> Result<bool> {
    let result = simple_bool_request(
        ctx,
        account_id,
        &format!("/api/v1/user/account-bindings/{provider}"),
        "DELETE",
        None,
    )
    .await?;
    invalidate_profile(ctx, account_id).await;
    Ok(result)
}

async fn invalidate_profile(ctx: &AppContext, account_id: &str) {
    ctx.live_resources
        .invalidate(account_id, LiveResourceKind::Profile)
        .await;
}

async fn simple_bool_request(
    ctx: &AppContext,
    account_id: &str,
    path: &str,
    method: &str,
    payload: Option<Value>,
) -> Result<bool> {
    upstream_service::account_upstream_request(
        ctx,
        account_id,
        path,
        method,
        payload,
        UpstreamRequestPolicy::RecoverableSyncOrWrite,
    )
    .await?;
    Ok(true)
}
