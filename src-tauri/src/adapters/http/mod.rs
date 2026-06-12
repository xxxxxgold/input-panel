use std::net::SocketAddr;

use anyhow::Result;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, patch, post, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::application::{
    account_service, auth_service, dashboard_service, keys_service, profile_service, proxy_service,
    site_service, usage_service, AppContext,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateSiteBody {
    name: Option<String>,
    base_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateAccountBody {
    label: Option<String>,
    email: Option<String>,
    balance_warning: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginBody {
    password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Login2faBody {
    temp_token: String,
    code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistCredentialBody {
    password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxyBody {
    path: String,
    method: Option<String>,
    payload: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct PaginationQuery {
    page: Option<i64>,
    page_size: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct UsageListQueryParams {
    page: Option<i64>,
    page_size: Option<i64>,
    api_key_id: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UsageStatsQueryParams {
    period: Option<String>,
    api_key_id: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DaysQuery {
    days: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasswordChangeBody {
    old_password: String,
    new_password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotifyEmailBody {
    email: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotifyEmailVerifyBody {
    email: String,
    code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToggleNotifyEmailBody {
    email: String,
    disabled: bool,
}

pub async fn serve(ctx: AppContext, addr: SocketAddr) -> Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router(ctx)).await?;
    Ok(())
}

pub fn router(ctx: AppContext) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/dashboard/overview", get(get_overview))
        .route("/api/sites", post(create_site))
        .route("/api/sites/:site_id", patch(update_site).delete(remove_site))
        .route("/api/accounts", post(create_account))
        .route("/api/accounts/:account_id", patch(update_account).delete(remove_account))
        .route("/api/accounts/:account_id/login", post(login_account))
        .route("/api/accounts/:account_id/login/2fa", post(login_account_2fa))
        .route("/api/accounts/:account_id/credential", post(persist_account_credential))
        .route("/api/accounts/:account_id/refresh", post(refresh_account))
        .route("/api/accounts/refresh-all", post(refresh_all_accounts))
        .route("/api/accounts/:account_id/groups", get(get_available_groups))
        .route("/api/accounts/:account_id/keys", get(list_managed_keys).post(create_managed_key))
        .route(
            "/api/accounts/:account_id/keys/:key_id",
            get(get_managed_key).put(update_managed_key).delete(delete_managed_key),
        )
        .route("/api/accounts/:account_id/keys/:key_id/daily-usage", get(get_key_daily_usage))
        .route("/api/accounts/:account_id/usage", get(list_usage_records))
        .route("/api/accounts/:account_id/usage/stats", get(get_usage_stats))
        .route("/api/accounts/:account_id/usage/trend", get(get_dashboard_trend))
        .route("/api/accounts/:account_id/usage/models", get(get_dashboard_models))
        .route(
            "/api/accounts/:account_id/profile",
            get(get_profile_record).put(update_profile_record),
        )
        .route("/api/accounts/:account_id/profile/password", put(change_profile_password))
        .route(
            "/api/accounts/:account_id/profile/platform-quotas",
            get(get_platform_quotas),
        )
        .route(
            "/api/accounts/:account_id/subscriptions/summary",
            get(get_subscription_summary),
        )
        .route("/api/accounts/:account_id/payment/config", get(get_payment_config))
        .route("/api/accounts/:account_id/orders", get(list_orders))
        .route(
            "/api/accounts/:account_id/notify-email/send-code",
            post(send_notify_email_code),
        )
        .route(
            "/api/accounts/:account_id/notify-email/verify",
            post(verify_notify_email),
        )
        .route(
            "/api/accounts/:account_id/notify-email",
            patch(toggle_notify_email).delete(remove_notify_email),
        )
        .route(
            "/api/accounts/:account_id/identity-bindings/email/send-code",
            post(send_email_binding_code),
        )
        .route("/api/accounts/:account_id/identity-bindings/email", post(bind_email_identity))
        .route(
            "/api/accounts/:account_id/identity-bindings/:provider",
            axum::routing::delete(unbind_auth_identity),
        )
        .route("/api/accounts/:account_id/proxy", post(account_proxy_request))
        .with_state(ctx)
}

async fn health() -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "now": chrono::Utc::now().to_rfc3339()
    }))
}

async fn get_overview(State(ctx): State<AppContext>) -> impl IntoResponse {
    map_json_result(dashboard_service::get_overview(&ctx))
}

async fn create_site(
    State(ctx): State<AppContext>,
    Json(payload): Json<crate::contracts::SiteInput>,
) -> impl IntoResponse {
    map_json_result(site_service::create_site(&ctx, payload))
}

async fn update_site(
    State(ctx): State<AppContext>,
    Path(site_id): Path<String>,
    Json(body): Json<UpdateSiteBody>,
) -> impl IntoResponse {
    map_json_result(site_service::update_site(&ctx, &site_id, body.name, body.base_url))
}

async fn remove_site(State(ctx): State<AppContext>, Path(site_id): Path<String>) -> impl IntoResponse {
    map_json_result(site_service::remove_site(&ctx, &site_id))
}

async fn create_account(
    State(ctx): State<AppContext>,
    Json(payload): Json<crate::contracts::AccountInput>,
) -> impl IntoResponse {
    map_json_result(account_service::create_account(&ctx, payload))
}

async fn update_account(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(body): Json<UpdateAccountBody>,
) -> impl IntoResponse {
    map_json_result(account_service::update_account(
        &ctx,
        &account_id,
        body.label,
        body.email,
        body.balance_warning,
    ))
}

async fn remove_account(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
) -> impl IntoResponse {
    map_json_result(account_service::remove_account(&ctx, &account_id))
}

async fn login_account(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(body): Json<LoginBody>,
) -> impl IntoResponse {
    match auth_service::login_account(&ctx, &account_id, &body.password).await {
        Ok(crate::contracts::LoginFlowResult::Success { account }) => {
            (StatusCode::OK, Json(serde_json::to_value(account).unwrap_or_else(|_| json!({}))))
                .into_response()
        }
        Ok(crate::contracts::LoginFlowResult::TwoFa {
            temp_token,
            email_masked,
            message,
        }) => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": message.unwrap_or_else(|| "当前站点要求 2FA 验证，请继续输入验证码。".to_string()),
                "tempToken": temp_token,
                "emailMasked": email_masked
            })),
        )
            .into_response(),
        Err(error) => map_error(error).into_response(),
    }
}

async fn login_account_2fa(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(body): Json<Login2faBody>,
) -> impl IntoResponse {
    map_async_json_result(
        auth_service::login_account_2fa(&ctx, &account_id, &body.temp_token, &body.code).await,
    )
}

async fn persist_account_credential(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(body): Json<PersistCredentialBody>,
) -> impl IntoResponse {
    match auth_service::persist_account_credential(&ctx, &account_id, &body.password) {
        Ok(_) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(error) => map_error(error).into_response(),
    }
}

async fn refresh_account(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
) -> impl IntoResponse {
    map_async_json_result(auth_service::refresh_account(&ctx, &account_id).await)
}

async fn refresh_all_accounts(State(ctx): State<AppContext>) -> impl IntoResponse {
    map_async_json_result(auth_service::refresh_all_accounts(&ctx).await)
}

async fn get_available_groups(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
) -> impl IntoResponse {
    map_async_json_result(keys_service::get_available_groups(&ctx, &account_id).await)
}

async fn list_managed_keys(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Query(query): Query<PaginationQuery>,
) -> impl IntoResponse {
    map_async_json_result(
        keys_service::list_managed_keys(
            &ctx,
            &account_id,
            query.page.unwrap_or(1),
            query.page_size.unwrap_or(20),
        )
        .await,
    )
}

async fn get_managed_key(
    State(ctx): State<AppContext>,
    Path((account_id, key_id)): Path<(String, String)>,
) -> impl IntoResponse {
    map_async_json_result(keys_service::get_managed_key(&ctx, &account_id, &key_id).await)
}

async fn create_managed_key(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(payload): Json<crate::contracts::KeyMutationInput>,
) -> impl IntoResponse {
    map_async_json_result(keys_service::create_managed_key(&ctx, &account_id, payload).await)
}

async fn update_managed_key(
    State(ctx): State<AppContext>,
    Path((account_id, key_id)): Path<(String, String)>,
    Json(payload): Json<crate::contracts::KeyMutationInput>,
) -> impl IntoResponse {
    map_async_json_result(
        keys_service::update_managed_key(&ctx, &account_id, &key_id, payload).await,
    )
}

async fn delete_managed_key(
    State(ctx): State<AppContext>,
    Path((account_id, key_id)): Path<(String, String)>,
) -> impl IntoResponse {
    map_async_json_result(keys_service::delete_managed_key(&ctx, &account_id, &key_id).await)
}

async fn list_usage_records(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Query(query): Query<UsageListQueryParams>,
) -> impl IntoResponse {
    map_async_json_result(
        usage_service::list_usage_records(
            &ctx,
            &account_id,
            usage_service::UsageListQuery {
                page: query.page.unwrap_or(1),
                page_size: query.page_size.unwrap_or(20),
                api_key_id: query.api_key_id,
                start_date: query.start_date,
                end_date: query.end_date,
            },
        )
        .await,
    )
}

async fn get_usage_stats(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Query(query): Query<UsageStatsQueryParams>,
) -> impl IntoResponse {
    map_async_json_result(
        usage_service::get_usage_stats(
            &ctx,
            &account_id,
            usage_service::UsageStatsQuery {
                period: query.period,
                api_key_id: query.api_key_id,
                start_date: query.start_date,
                end_date: query.end_date,
            },
        )
        .await,
    )
}

async fn get_dashboard_trend(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Query(query): Query<DaysQuery>,
) -> impl IntoResponse {
    map_async_json_result(
        usage_service::get_dashboard_trend(&ctx, &account_id, query.days.unwrap_or(7)).await,
    )
}

async fn get_dashboard_models(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Query(query): Query<DaysQuery>,
) -> impl IntoResponse {
    map_async_json_result(
        usage_service::get_dashboard_models(&ctx, &account_id, query.days.unwrap_or(7)).await,
    )
}

async fn get_key_daily_usage(
    State(ctx): State<AppContext>,
    Path((account_id, key_id)): Path<(String, String)>,
    Query(query): Query<DaysQuery>,
) -> impl IntoResponse {
    map_async_json_result(
        usage_service::get_key_daily_usage(&ctx, &account_id, &key_id, query.days.unwrap_or(30))
            .await,
    )
}

async fn get_profile_record(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
) -> impl IntoResponse {
    map_async_json_result(profile_service::get_profile_record(&ctx, &account_id).await)
}

async fn update_profile_record(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(payload): Json<crate::contracts::ProfileUpdateInput>,
) -> impl IntoResponse {
    map_async_json_result(profile_service::update_profile_record(&ctx, &account_id, payload).await)
}

async fn change_profile_password(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(payload): Json<PasswordChangeBody>,
) -> impl IntoResponse {
    map_async_json_result(
        profile_service::change_profile_password(
            &ctx,
            &account_id,
            &payload.old_password,
            &payload.new_password,
        )
        .await,
    )
}

async fn get_platform_quotas(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
) -> impl IntoResponse {
    map_async_json_result(profile_service::get_platform_quotas(&ctx, &account_id).await)
}

async fn get_subscription_summary(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
) -> impl IntoResponse {
    map_async_json_result(profile_service::get_subscription_summary(&ctx, &account_id).await)
}

async fn get_payment_config(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
) -> impl IntoResponse {
    map_async_json_result(profile_service::get_payment_config(&ctx, &account_id).await)
}

async fn list_orders(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Query(query): Query<PaginationQuery>,
) -> impl IntoResponse {
    map_async_json_result(
        profile_service::list_orders(
            &ctx,
            &account_id,
            query.page.unwrap_or(1),
            query.page_size.unwrap_or(20),
        )
        .await,
    )
}

async fn send_notify_email_code(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(payload): Json<NotifyEmailBody>,
) -> impl IntoResponse {
    map_async_json_result(profile_service::send_notify_email_code(&ctx, &account_id, &payload.email).await)
}

async fn verify_notify_email(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(payload): Json<NotifyEmailVerifyBody>,
) -> impl IntoResponse {
    map_async_json_result(
        profile_service::verify_notify_email(&ctx, &account_id, &payload.email, &payload.code)
            .await,
    )
}

async fn remove_notify_email(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(payload): Json<NotifyEmailBody>,
) -> impl IntoResponse {
    map_async_json_result(profile_service::remove_notify_email(&ctx, &account_id, &payload.email).await)
}

async fn toggle_notify_email(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(payload): Json<ToggleNotifyEmailBody>,
) -> impl IntoResponse {
    map_async_json_result(
        profile_service::toggle_notify_email(&ctx, &account_id, &payload.email, payload.disabled)
            .await,
    )
}

async fn send_email_binding_code(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(payload): Json<NotifyEmailBody>,
) -> impl IntoResponse {
    map_async_json_result(profile_service::send_email_binding_code(&ctx, &account_id, &payload.email).await)
}

async fn bind_email_identity(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(payload): Json<NotifyEmailVerifyBody>,
) -> impl IntoResponse {
    map_async_json_result(
        profile_service::bind_email_identity(&ctx, &account_id, &payload.email, &payload.code)
            .await,
    )
}

async fn unbind_auth_identity(
    State(ctx): State<AppContext>,
    Path((account_id, provider)): Path<(String, String)>,
) -> impl IntoResponse {
    map_async_json_result(profile_service::unbind_auth_identity(&ctx, &account_id, &provider).await)
}

async fn account_proxy_request(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(body): Json<ProxyBody>,
) -> impl IntoResponse {
    let method = body.method.unwrap_or_else(|| "GET".to_string());
    match proxy_service::account_proxy_request(&ctx, &account_id, &body.path, &method, body.payload).await {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(error) => map_error(error).into_response(),
    }
}

fn map_json_result<T>(result: anyhow::Result<T>) -> axum::response::Response
where
    T: serde::Serialize,
{
    match result {
        Ok(value) => (StatusCode::OK, Json(serde_json::to_value(value).unwrap_or_else(|_| json!({})))).into_response(),
        Err(error) => map_error(error).into_response(),
    }
}

fn map_async_json_result<T>(result: anyhow::Result<T>) -> axum::response::Response
where
    T: serde::Serialize,
{
    map_json_result(result)
}

fn map_error(error: anyhow::Error) -> (StatusCode, Json<Value>) {
    let message = error.to_string();
    let status = if message.contains("不能为空") || message.contains("不存在") || message.contains("仅允许") {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    (status, Json(json!({ "error": message })))
}
