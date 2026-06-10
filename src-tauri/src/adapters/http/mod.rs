use std::net::SocketAddr;

use anyhow::Result;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::application::{
    account_service, auth_service, dashboard_service, proxy_service, site_service, AppContext,
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
