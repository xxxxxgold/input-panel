use anyhow::Result;
use serde_json::{json, Value};

use crate::contracts::{
    PlatformQuotaPayload,
    ProfileUpdateInput, SubscriptionSummaryPayload, UserProfileRecord,
};
use crate::infrastructure::sqlite::repositories;
use crate::infrastructure::sub2api::normalizers::{
    normalize_profile,
    profile_update_payload,
};

use super::{upstream_service, AppContext};

pub async fn get_profile_record(ctx: &AppContext, account_id: &str) -> Result<UserProfileRecord> {
    Ok(repositories::get_profile_cache(&ctx.db, account_id)?
        .map(|record| record.payload)
        .unwrap_or(UserProfileRecord {
            id: 0,
            email: String::new(),
            username: None,
            avatar_url: None,
            role: "user".into(),
            balance: 0.0,
            concurrency: 0,
            status: "unknown".into(),
            last_active_at: None,
            created_at: None,
            updated_at: None,
            total_recharged: None,
            rpm_limit: None,
            balance_notify_enabled: Some(false),
            balance_notify_threshold_type: None,
            balance_notify_threshold: None,
            balance_notify_extra_emails: Some(Vec::new()),
            identities: std::collections::HashMap::new(),
            auth_bindings: std::collections::HashMap::new(),
            identity_bindings: std::collections::HashMap::new(),
        }))
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
    )
    .await?;
    let profile = normalize_profile(&raw);
    let now = chrono::Utc::now().to_rfc3339();
    repositories::save_profile_cache(&ctx.db, account_id, &profile, &now)?;
    super::data_center_service::sync_core_scope(
        ctx,
        account_id,
        crate::contracts::DataSyncTrigger::PostWrite,
    )
    .await?;
    Ok(profile)
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
    )
    .await?;
    Ok(true)
}

pub async fn get_platform_quotas(
    ctx: &AppContext,
    account_id: &str,
) -> Result<PlatformQuotaPayload> {
    Ok(repositories::get_platform_quota_cache(&ctx.db, account_id)?
        .map(|record| record.payload)
        .unwrap_or(PlatformQuotaPayload {
            platform_quotas: Vec::new(),
        }))
}

pub async fn get_subscription_summary(
    ctx: &AppContext,
    account_id: &str,
) -> Result<SubscriptionSummaryPayload> {
    Ok(repositories::get_subscription_summary_cache(&ctx.db, account_id)?
        .map(|record| record.payload)
        .unwrap_or(SubscriptionSummaryPayload {
            active_count: 0,
            total_used_usd: 0.0,
            subscriptions: Vec::new(),
        }))
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
    let raw = upstream_service::account_upstream_request(
        ctx,
        account_id,
        "/api/v1/user/notify-email/toggle",
        "PUT",
        Some(json!({ "email": email, "disabled": disabled })),
    )
    .await?;
    let profile = normalize_profile(&raw);
    let now = chrono::Utc::now().to_rfc3339();
    repositories::save_profile_cache(&ctx.db, account_id, &profile, &now)?;
    super::data_center_service::sync_core_scope(
        ctx,
        account_id,
        crate::contracts::DataSyncTrigger::PostWrite,
    )
    .await?;
    Ok(profile)
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
    upstream_service::account_upstream_request(ctx, account_id, path, method, payload).await?;
    Ok(true)
}
