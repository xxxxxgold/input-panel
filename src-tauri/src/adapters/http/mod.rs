use std::net::SocketAddr;

use crate::application::{
    account_service, auth_service, codex_radar_service, dashboard_service, data_center_service,
    database_storage_service, desktop_ui_service, keys_service, maintenance_service,
    profile_service, public_endpoints_service, service_status_service, site_failover_service,
    site_service, subscription_quota_alert_service,
    subscription_snapshot_service::{
        self, SubscriptionProcessingCapabilities, SubscriptionSnapshotOrigin,
    },
    subscription_switch_service, usage_service, window_selection_service, AppContext,
};
use anyhow::Result;
use axum::{
    extract::{Path, Query, State},
    http::{header::RETRY_AFTER, HeaderValue, StatusCode},
    response::IntoResponse,
    routing::{get, patch, post, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

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
    origin_base_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistCredentialBody {
    password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshAccountBody {
    trigger_source: Option<crate::contracts::RefreshTriggerSource>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncAccountBody {
    scope: crate::contracts::DataSyncScope,
    trigger_source: Option<crate::contracts::DataSyncTrigger>,
}

#[derive(Debug, Deserialize)]
struct PaginationQuery {
    page: Option<i64>,
    page_size: Option<i64>,
    force: Option<bool>,
}

#[derive(Debug, Deserialize, Default)]
struct LiveResourceQuery {
    force: Option<bool>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SiteFailoverTransitionQuery {
    after_revision: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct DaysQuery {
    days: Option<i64>,
    start_date: Option<String>,
    end_date: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptionKeyUsageBody {
    key_ids: Vec<String>,
    start_date: Option<String>,
    end_date: Option<String>,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUiPrefsPatchBody {
    launch_mode: Option<crate::contracts::AppLaunchMode>,
    open_floating_in_main_mode: Option<bool>,
    keep_floating_panel_visible: Option<bool>,
    floating_panel_opacity: Option<f64>,
    floating_notification_duration_ms: Option<i64>,
    floating_notification_density: Option<crate::contracts::FloatingNotificationDensity>,
    floating_notification_max_visible: Option<i64>,
    floating_notification_sound_source: Option<crate::contracts::FloatingNotificationSoundSource>,
    floating_notification_sound_file_name: Option<String>,
    floating_notification_sound_storage_key: Option<String>,
    floating_notification_sound_volume: Option<i64>,
    close_behavior: Option<crate::contracts::CloseBehavior>,
    auto_refresh_enabled: Option<bool>,
    auto_refresh_interval_seconds: Option<i64>,
    auto_refresh_service_status_enabled: Option<bool>,
    auto_refresh_core_enabled: Option<bool>,
    auto_refresh_core_interval_seconds: Option<i64>,
    auto_refresh_keys_enabled: Option<bool>,
    auto_refresh_keys_interval_seconds: Option<i64>,
    auto_refresh_usage_enabled: Option<bool>,
    auto_refresh_usage_interval_seconds: Option<i64>,
    overview_account_runtime_timeout_ms: Option<i64>,
    completed_task_retention_minutes: Option<i64>,
    theme: Option<String>,
}

impl DesktopUiPrefsPatchBody {
    fn controls_native_window(&self) -> bool {
        self.launch_mode.is_some()
            || self.open_floating_in_main_mode.is_some()
            || self.keep_floating_panel_visible.is_some()
            || self.floating_panel_opacity.is_some()
            || self.floating_notification_duration_ms.is_some()
            || self.floating_notification_density.is_some()
            || self.floating_notification_max_visible.is_some()
            || self.floating_notification_sound_source.is_some()
            || self.floating_notification_sound_file_name.is_some()
            || self.floating_notification_sound_storage_key.is_some()
            || self.floating_notification_sound_volume.is_some()
            || self.close_behavior.is_some()
    }

    fn into_browser_debug_patch(self) -> crate::contracts::DesktopUiPrefsPatch {
        crate::contracts::DesktopUiPrefsPatch {
            auto_refresh_enabled: self.auto_refresh_enabled,
            auto_refresh_interval_seconds: self.auto_refresh_interval_seconds,
            auto_refresh_service_status_enabled: self.auto_refresh_service_status_enabled,
            auto_refresh_core_enabled: self.auto_refresh_core_enabled,
            auto_refresh_core_interval_seconds: self.auto_refresh_core_interval_seconds,
            auto_refresh_keys_enabled: self.auto_refresh_keys_enabled,
            auto_refresh_keys_interval_seconds: self.auto_refresh_keys_interval_seconds,
            auto_refresh_usage_enabled: self.auto_refresh_usage_enabled,
            auto_refresh_usage_interval_seconds: self.auto_refresh_usage_interval_seconds,
            overview_account_runtime_timeout_ms: self.overview_account_runtime_timeout_ms,
            completed_task_retention_minutes: self.completed_task_retention_minutes,
            theme: self.theme,
            ..crate::contracts::DesktopUiPrefsPatch::default()
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClearRuntimeDataBody {
    remove_sites_and_accounts: bool,
}

pub async fn serve(ctx: AppContext, addr: SocketAddr) -> Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router(ctx)).await?;
    Ok(())
}

pub fn router(ctx: AppContext) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/dashboard/overview-shell", get(get_overview_shell))
        .route(
            "/api/dashboard/overview-shell-lite",
            get(get_overview_shell_lite),
        )
        .route("/api/dashboard/overview", get(get_overview))
        .route("/api/service-status", get(get_service_status))
        .route(
            "/api/codex-radar/intelligence",
            get(get_codex_radar_intelligence),
        )
        .route("/api/codex-radar/insights", get(get_codex_radar_insights))
        .route("/api/codex-radar/fast", get(get_codex_radar_fast))
        .route("/api/codex-radar/model-iq", get(get_codex_radar_model_iq))
        .route(
            "/api/window-selection",
            get(get_window_selection).patch(update_window_selection),
        )
        .route(
            "/api/sites/:site_id/public-endpoints",
            get(get_site_public_endpoints).post(sync_site_public_endpoints),
        )
        .route(
            "/api/sites/:site_id/public-endpoints/ping",
            post(ping_site_public_endpoints),
        )
        .route(
            "/api/desktop-ui/preferences",
            get(get_desktop_ui_prefs).patch(update_desktop_ui_prefs),
        )
        .route("/api/desktop-ui/mode", post(switch_app_mode))
        .route(
            "/api/desktop-ui/floating/visibility",
            post(set_floating_window_visible),
        )
        .route(
            "/api/desktop-ui/floating/context-menu",
            post(show_floating_context_menu),
        )
        .route(
            "/api/desktop-ui/floating-panel/visibility",
            post(set_floating_panel_visible),
        )
        .route(
            "/api/desktop-ui/floating-panel/position",
            post(position_floating_panel),
        )
        .route(
            "/api/desktop-ui/floating-panel/toast",
            post(push_floating_panel_toast),
        )
        .route("/api/desktop-ui/open-main", post(open_main_window))
        .route("/api/desktop-ui/quit", post(quit_application))
        .route(
            "/api/maintenance/clear-runtime-data",
            post(clear_runtime_data),
        )
        .route("/api/sites", post(create_site))
        .route(
            "/api/sites/:site_id",
            patch(update_site).delete(remove_site),
        )
        .route(
            "/api/sites/:site_id/failover-status",
            get(get_site_failover_status),
        )
        .route(
            "/api/sites/:site_id/failover/test",
            post(test_site_endpoint),
        )
        .route(
            "/api/sites/:site_id/failover/clear-cooldown",
            post(clear_site_failover_cooldown),
        )
        .route(
            "/api/site-failover/transitions",
            get(list_site_failover_transitions),
        )
        .route("/api/accounts", post(create_account))
        .route(
            "/api/accounts/:account_id",
            patch(update_account).delete(remove_account),
        )
        .route(
            "/api/accounts/:account_id/alert-preferences/query",
            post(query_account_alert_preferences),
        )
        .route("/api/accounts/:account_id/login", post(login_account))
        .route(
            "/api/accounts/:account_id/login/2fa",
            post(login_account_2fa),
        )
        .route(
            "/api/accounts/:account_id/credential",
            post(persist_account_credential),
        )
        .route("/api/accounts/:account_id/refresh", post(refresh_account))
        .route("/api/accounts/:account_id/sync", post(sync_account_data))
        .route(
            "/api/accounts/:account_id/sync-status",
            get(get_account_sync_status),
        )
        .route("/api/accounts/refresh-all", post(refresh_all_accounts))
        .route("/api/accounts/sync-all", post(sync_all_accounts))
        .route(
            "/api/accounts/:account_id/groups",
            get(get_available_groups),
        )
        .route(
            "/api/accounts/:account_id/keys",
            get(list_managed_keys).post(create_managed_key),
        )
        .route(
            "/api/accounts/:account_id/keys/:key_id",
            get(get_managed_key)
                .put(update_managed_key)
                .delete(delete_managed_key),
        )
        .route(
            "/api/accounts/:account_id/subscription-switch-rules",
            get(list_subscription_switch_rules).post(evaluate_subscription_switch_rules),
        )
        .route(
            "/api/accounts/:account_id/subscription-switch-rules/:key_id",
            put(upsert_subscription_switch_rule).delete(delete_subscription_switch_rule),
        )
        .route(
            "/api/accounts/:account_id/subscription-quota-alerts/query",
            post(query_subscription_quota_alerts),
        )
        .route(
            "/api/accounts/:account_id/subscription-quota-alerts/upsert",
            post(upsert_subscription_quota_alert),
        )
        .route(
            "/api/accounts/:account_id/keys/:key_id/daily-usage",
            get(get_key_daily_usage),
        )
        .route(
            "/api/accounts/:account_id/keys/:key_id/usage-summary",
            get(get_key_usage_summary),
        )
        .route("/api/accounts/:account_id/usage", post(list_usage_records))
        .route(
            "/api/accounts/:account_id/usage/facets",
            post(list_usage_facets),
        )
        .route(
            "/api/accounts/:account_id/usage/stats",
            post(get_usage_stats),
        )
        .route(
            "/api/accounts/:account_id/usage/analytics",
            post(get_usage_analytics),
        )
        .route(
            "/api/accounts/:account_id/usage/extremes",
            post(get_usage_extremes),
        )
        .route(
            "/api/accounts/:account_id/usage/dashboard/stats",
            get(get_overview_dashboard_stats),
        )
        .route(
            "/api/accounts/:account_id/usage/trend",
            post(get_dashboard_trend),
        )
        .route(
            "/api/accounts/:account_id/usage/models",
            post(get_dashboard_models),
        )
        .route(
            "/api/accounts/:account_id/usage/insights",
            post(get_usage_insights),
        )
        .route(
            "/api/accounts/:account_id/usage/subscription-key-usage",
            post(get_subscription_key_usage),
        )
        .route(
            "/api/accounts/:account_id/profile",
            get(get_profile_record).put(update_profile_record),
        )
        .route(
            "/api/accounts/:account_id/profile/password",
            put(change_profile_password),
        )
        .route(
            "/api/accounts/:account_id/profile/platform-quotas",
            get(get_platform_quotas),
        )
        .route(
            "/api/accounts/:account_id/subscriptions",
            get(get_subscriptions),
        )
        .route(
            "/api/accounts/:account_id/subscriptions/summary",
            get(get_subscription_summary),
        )
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
        .route(
            "/api/accounts/:account_id/identity-bindings/email",
            post(bind_email_identity),
        )
        .route(
            "/api/accounts/:account_id/identity-bindings/:provider",
            axum::routing::delete(unbind_auth_identity),
        )
        .route(
            "/api/scheduler/config",
            get(get_scheduler_config).patch(update_scheduler_config),
        )
        .route(
            "/api/runtime-coordination/config",
            get(get_runtime_coordination_config).patch(update_runtime_coordination_config),
        )
        .route(
            "/api/upstream-network/config",
            get(get_upstream_network_config).patch(update_upstream_network_config),
        )
        .route("/api/database-storage", get(get_database_storage))
        .route(
            "/api/database-storage/migrate",
            post(migrate_database_storage),
        )
        .with_state(ctx)
}

async fn health() -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "now": chrono::Utc::now().to_rfc3339()
    }))
}

async fn get_overview(State(ctx): State<AppContext>) -> impl IntoResponse {
    map_json_result(dashboard_service::get_overview(&ctx).await)
}

async fn get_overview_shell(State(ctx): State<AppContext>) -> impl IntoResponse {
    map_json_result(dashboard_service::get_overview_shell(&ctx))
}

async fn get_overview_shell_lite(State(ctx): State<AppContext>) -> impl IntoResponse {
    map_json_result(dashboard_service::get_overview_shell_lite(&ctx))
}

async fn get_service_status(State(ctx): State<AppContext>) -> impl IntoResponse {
    map_async_json_result(service_status_service::get_service_status(&ctx).await)
}

async fn get_codex_radar_model_iq(State(ctx): State<AppContext>) -> impl IntoResponse {
    map_codex_radar_response(codex_radar_service::get_codex_radar_model_iq(&ctx).await)
}

async fn get_codex_radar_intelligence(State(ctx): State<AppContext>) -> impl IntoResponse {
    map_codex_radar_response(codex_radar_service::get_codex_radar_intelligence(&ctx).await)
}

async fn get_codex_radar_insights(
    State(ctx): State<AppContext>,
    Query(query): Query<LiveResourceQuery>,
) -> impl IntoResponse {
    map_codex_radar_response(
        codex_radar_service::get_codex_radar_insights(&ctx, query.force.unwrap_or(false)).await,
    )
}

async fn get_codex_radar_fast(State(ctx): State<AppContext>) -> impl IntoResponse {
    map_codex_radar_response(codex_radar_service::get_codex_radar_fast(&ctx).await)
}

async fn get_window_selection(State(ctx): State<AppContext>) -> impl IntoResponse {
    map_json_result(window_selection_service::get_window_selection(&ctx))
}

async fn update_window_selection(
    State(ctx): State<AppContext>,
    Json(payload): Json<window_selection_service::WindowSelectionState>,
) -> impl IntoResponse {
    map_json_result(window_selection_service::update_window_selection(
        &ctx, payload,
    ))
}

async fn get_site_public_endpoints(
    State(ctx): State<AppContext>,
    Path(site_id): Path<String>,
) -> impl IntoResponse {
    map_json_result(public_endpoints_service::get_site_public_endpoints(
        &ctx, &site_id,
    ))
}

async fn sync_site_public_endpoints(
    State(ctx): State<AppContext>,
    Path(site_id): Path<String>,
) -> impl IntoResponse {
    map_async_json_result(
        public_endpoints_service::sync_site_public_endpoints(&ctx, &site_id).await,
    )
}

async fn ping_site_public_endpoints(
    State(ctx): State<AppContext>,
    Path(site_id): Path<String>,
) -> impl IntoResponse {
    map_async_json_result(
        public_endpoints_service::ping_site_public_endpoints(&ctx, &site_id).await,
    )
}

async fn get_desktop_ui_prefs(State(ctx): State<AppContext>) -> impl IntoResponse {
    map_json_result(desktop_ui_service::get_desktop_ui_prefs(&ctx))
}

async fn update_desktop_ui_prefs(
    State(ctx): State<AppContext>,
    Json(payload): Json<DesktopUiPrefsPatchBody>,
) -> impl IntoResponse {
    if payload.controls_native_window() {
        return native_capability_unsupported_response();
    }

    // Browser HTTP owns only debug-visible preferences. Native window controls require Tauri.
    map_json_result(desktop_ui_service::update_desktop_ui_prefs(
        &ctx,
        payload.into_browser_debug_patch(),
    ))
}

async fn switch_app_mode() -> axum::response::Response {
    native_capability_unsupported_response()
}

async fn set_floating_window_visible() -> axum::response::Response {
    native_capability_unsupported_response()
}

async fn set_floating_panel_visible() -> axum::response::Response {
    native_capability_unsupported_response()
}

async fn show_floating_context_menu() -> axum::response::Response {
    native_capability_unsupported_response()
}

async fn position_floating_panel() -> axum::response::Response {
    native_capability_unsupported_response()
}

async fn push_floating_panel_toast() -> axum::response::Response {
    native_capability_unsupported_response()
}

async fn open_main_window() -> axum::response::Response {
    native_capability_unsupported_response()
}

async fn quit_application() -> axum::response::Response {
    native_capability_unsupported_response()
}

async fn clear_runtime_data(
    State(ctx): State<AppContext>,
    Json(payload): Json<ClearRuntimeDataBody>,
) -> impl IntoResponse {
    map_async_json_result(
        maintenance_service::clear_runtime_data(&ctx, payload.remove_sites_and_accounts).await,
    )
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
    Json(payload): Json<crate::contracts::SitePatchInput>,
) -> impl IntoResponse {
    map_json_result(site_service::update_site(&ctx, &site_id, payload))
}

async fn remove_site(
    State(ctx): State<AppContext>,
    Path(site_id): Path<String>,
) -> impl IntoResponse {
    map_async_json_result(site_service::remove_site(&ctx, &site_id).await)
}

async fn get_site_failover_status(
    State(ctx): State<AppContext>,
    Path(site_id): Path<String>,
) -> impl IntoResponse {
    map_async_json_result(site_failover_service::get_site_failover_status(&ctx, &site_id).await)
}

async fn test_site_endpoint(
    State(ctx): State<AppContext>,
    Path(site_id): Path<String>,
    Json(payload): Json<crate::contracts::SiteEndpointTestInput>,
) -> impl IntoResponse {
    map_async_json_result(site_failover_service::test_site_endpoint(&ctx, &site_id, payload).await)
}

async fn clear_site_failover_cooldown(
    State(ctx): State<AppContext>,
    Path(site_id): Path<String>,
    Json(payload): Json<crate::contracts::SiteCooldownClearInput>,
) -> impl IntoResponse {
    map_async_json_result(
        site_failover_service::clear_site_failover_cooldown(&ctx, &site_id, payload).await,
    )
}

async fn list_site_failover_transitions(
    State(ctx): State<AppContext>,
    Query(query): Query<SiteFailoverTransitionQuery>,
) -> impl IntoResponse {
    map_async_json_result(
        site_failover_service::list_site_failover_transitions(
            &ctx,
            query.after_revision.unwrap_or(0),
        )
        .await,
    )
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
    Json(payload): Json<crate::contracts::AccountUpdateInput>,
) -> impl IntoResponse {
    map_async_json_result(
        account_service::update_account(&ctx, &account_id, payload)
            .await
            .map(|outcome| outcome.account),
    )
}

async fn query_account_alert_preferences(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
) -> impl IntoResponse {
    map_json_result(account_service::query_account_alert_preferences(
        &ctx,
        &account_id,
    ))
}

async fn remove_account(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
) -> impl IntoResponse {
    map_async_json_result(account_service::remove_account(&ctx, &account_id).await)
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
            origin_base_url,
            email_masked,
            message,
        }) => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": message.unwrap_or_else(|| "当前站点要求 2FA 验证，请继续输入验证码。".to_string()),
                "tempToken": temp_token,
                "originBaseUrl": origin_base_url,
                "emailMasked": email_masked
            })),
        )
            .into_response(),
        Err(error) => map_error_response(error),
    }
}

async fn login_account_2fa(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(body): Json<Login2faBody>,
) -> impl IntoResponse {
    map_async_json_result(
        auth_service::login_account_2fa(
            &ctx,
            &account_id,
            &body.temp_token,
            &body.code,
            body.origin_base_url.as_deref(),
        )
        .await,
    )
}

async fn persist_account_credential(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(body): Json<PersistCredentialBody>,
) -> impl IntoResponse {
    match auth_service::persist_account_credential(&ctx, &account_id, &body.password) {
        Ok(_) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(error) => map_error_response(error),
    }
}

async fn sync_all_accounts(
    State(ctx): State<AppContext>,
    body: Option<Json<SyncAllAccountsBody>>,
) -> impl IntoResponse {
    let scope = body
        .as_ref()
        .and_then(|Json(payload)| payload.scope.clone())
        .unwrap_or(crate::contracts::DataSyncScope::Full);
    let trigger_source = body
        .and_then(|Json(payload)| payload.trigger_source)
        .unwrap_or(crate::contracts::DataSyncTrigger::Manual);
    map_async_json_result(
        async {
            data_center_service::sync_all_accounts(
                &ctx,
                crate::contracts::SyncAccountDataInput {
                    scope,
                    trigger_source,
                },
            )
            .await?;
            dashboard_service::get_overview(&ctx).await
        }
        .await,
    )
}

async fn refresh_account(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    body: Option<Json<RefreshAccountBody>>,
) -> impl IntoResponse {
    map_async_json_result(
        data_center_service::refresh_account(
            &ctx,
            &account_id,
            body.and_then(|Json(payload)| payload.trigger_source)
                .unwrap_or(crate::contracts::RefreshTriggerSource::Manual),
        )
        .await,
    )
}

async fn refresh_all_accounts(State(ctx): State<AppContext>) -> impl IntoResponse {
    map_async_json_result(
        async {
            data_center_service::refresh_all_accounts(&ctx).await?;
            dashboard_service::get_overview(&ctx).await
        }
        .await,
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncAllAccountsBody {
    scope: Option<crate::contracts::DataSyncScope>,
    trigger_source: Option<crate::contracts::DataSyncTrigger>,
}

async fn sync_account_data(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(payload): Json<SyncAccountBody>,
) -> impl IntoResponse {
    match data_center_service::sync_account_data(
        &ctx,
        &account_id,
        crate::contracts::SyncAccountDataInput {
            scope: payload.scope,
            trigger_source: payload
                .trigger_source
                .unwrap_or(crate::contracts::DataSyncTrigger::Manual),
        },
    )
    .await
    {
        Ok(result) => (
            StatusCode::OK,
            Json(serde_json::to_value(result.status).unwrap_or_else(|_| json!({}))),
        )
            .into_response(),
        Err(error) => {
            let response = data_center_service::sync_failure_response_from_error(&error);
            let retry_after_ms = response.failure.retry_after_ms;
            let status = match response.failure.category {
                crate::contracts::SyncFailureCategory::Unauthorized => StatusCode::UNAUTHORIZED,
                crate::contracts::SyncFailureCategory::RateLimited => StatusCode::TOO_MANY_REQUESTS,
                crate::contracts::SyncFailureCategory::Internal => {
                    StatusCode::INTERNAL_SERVER_ERROR
                }
                _ => StatusCode::BAD_GATEWAY,
            };
            with_retry_after(
                (
                    status,
                    Json(serde_json::to_value(response).unwrap_or_else(|_| json!({}))),
                )
                    .into_response(),
                retry_after_ms,
            )
        }
    }
}

async fn get_account_sync_status(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
) -> impl IntoResponse {
    map_async_json_result(data_center_service::get_account_sync_status(&ctx, &account_id).await)
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
            query.force.unwrap_or(false),
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
    Json(payload): Json<crate::contracts::KeyPatchInput>,
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

async fn list_subscription_switch_rules(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
) -> impl IntoResponse {
    map_async_json_result(
        subscription_switch_service::list_subscription_switch_rules(&ctx, &account_id).await,
    )
}

async fn upsert_subscription_switch_rule(
    State(ctx): State<AppContext>,
    Path((account_id, key_id)): Path<(String, String)>,
    Json(payload): Json<crate::contracts::SubscriptionSwitchRuleUpsertInput>,
) -> impl IntoResponse {
    map_async_json_result(
        subscription_switch_service::upsert_subscription_switch_rule(
            &ctx,
            &account_id,
            &key_id,
            payload,
        )
        .await,
    )
}

async fn delete_subscription_switch_rule(
    State(ctx): State<AppContext>,
    Path((account_id, key_id)): Path<(String, String)>,
) -> impl IntoResponse {
    map_async_json_result(
        subscription_switch_service::delete_subscription_switch_rule(&ctx, &account_id, &key_id)
            .await,
    )
}

async fn evaluate_subscription_switch_rules(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
) -> impl IntoResponse {
    map_async_json_result(
        subscription_switch_service::evaluate_subscription_switch_rules(&ctx, &account_id).await,
    )
}

async fn query_subscription_quota_alerts(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
) -> impl IntoResponse {
    map_async_json_result(
        subscription_quota_alert_service::query_subscription_quota_alerts(&ctx, &account_id).await,
    )
}

async fn upsert_subscription_quota_alert(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(payload): Json<crate::contracts::SubscriptionQuotaAlertUpsertInput>,
) -> impl IntoResponse {
    let result = async {
        let snapshot = subscription_snapshot_service::refresh_and_process(
            &ctx,
            &account_id,
            false,
            crate::application::upstream_service::UpstreamRequestPolicy::ReadOnly,
            SubscriptionSnapshotOrigin::ConfigSave,
            SubscriptionProcessingCapabilities::headless(false),
        )
        .await?;
        subscription_quota_alert_service::upsert_subscription_quota_alert_with_snapshot(
            &ctx,
            &account_id,
            payload,
            &snapshot.subscriptions,
        )
        .await
    }
    .await;
    map_async_json_result(result)
}

async fn list_usage_records(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(request): Json<crate::contracts::UsageListRequest>,
) -> impl IntoResponse {
    map_async_json_result(usage_service::list_usage_records(&ctx, &account_id, request).await)
}

async fn list_usage_facets(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(request): Json<crate::contracts::UsageFacetRequest>,
) -> impl IntoResponse {
    map_async_json_result(usage_service::list_usage_facets(&ctx, &account_id, request).await)
}

async fn get_usage_stats(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(filter): Json<crate::contracts::UsageFilter>,
) -> impl IntoResponse {
    map_async_json_result(usage_service::get_usage_stats(&ctx, &account_id, filter).await)
}

async fn get_usage_analytics(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(filter): Json<crate::contracts::UsageFilter>,
) -> impl IntoResponse {
    map_async_json_result(usage_service::get_usage_analytics(&ctx, &account_id, filter).await)
}

async fn get_usage_extremes(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(filter): Json<crate::contracts::UsageFilter>,
) -> impl IntoResponse {
    map_async_json_result(usage_service::get_usage_extremes(&ctx, &account_id, filter).await)
}

async fn get_overview_dashboard_stats(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Query(query): Query<LiveResourceQuery>,
) -> impl IntoResponse {
    map_async_json_result(
        usage_service::get_overview_dashboard_stats(
            &ctx,
            &account_id,
            query.force.unwrap_or(false),
        )
        .await,
    )
}

async fn get_dashboard_trend(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(filter): Json<crate::contracts::UsageFilter>,
) -> impl IntoResponse {
    map_async_json_result(usage_service::get_dashboard_trend(&ctx, &account_id, filter).await)
}

async fn get_dashboard_models(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(filter): Json<crate::contracts::UsageFilter>,
) -> impl IntoResponse {
    map_async_json_result(usage_service::get_dashboard_models(&ctx, &account_id, filter).await)
}

async fn get_usage_insights(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(filter): Json<crate::contracts::UsageFilter>,
) -> impl IntoResponse {
    map_async_json_result(usage_service::get_usage_insights(&ctx, &account_id, filter).await)
}

async fn get_subscription_key_usage(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(payload): Json<SubscriptionKeyUsageBody>,
) -> impl IntoResponse {
    map_async_json_result(
        usage_service::get_subscription_key_usage(
            &ctx,
            &account_id,
            payload.key_ids,
            payload.start_date,
            payload.end_date,
        )
        .await,
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

async fn get_key_usage_summary(
    State(ctx): State<AppContext>,
    Path((account_id, key_id)): Path<(String, String)>,
    Query(query): Query<DaysQuery>,
) -> impl IntoResponse {
    map_async_json_result(
        usage_service::get_key_usage_summary(
            &ctx,
            &account_id,
            &key_id,
            query.days.unwrap_or(30),
            query.start_date,
            query.end_date,
        )
        .await,
    )
}

async fn get_profile_record(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Query(query): Query<LiveResourceQuery>,
) -> impl IntoResponse {
    map_async_json_result(
        profile_service::get_profile_record(&ctx, &account_id, query.force.unwrap_or(false)).await,
    )
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

async fn get_subscriptions(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Query(query): Query<LiveResourceQuery>,
) -> impl IntoResponse {
    map_async_json_result(
        subscription_snapshot_service::refresh_and_process(
            &ctx,
            &account_id,
            query.force.unwrap_or(false),
            crate::application::upstream_service::UpstreamRequestPolicy::ReadOnly,
            SubscriptionSnapshotOrigin::PageRead,
            SubscriptionProcessingCapabilities::headless(true),
        )
        .await
        .map(|outcome| outcome.subscriptions),
    )
}

async fn get_subscription_summary(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
) -> impl IntoResponse {
    map_async_json_result(profile_service::get_subscription_summary(&ctx, &account_id).await)
}

async fn send_notify_email_code(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(payload): Json<NotifyEmailBody>,
) -> impl IntoResponse {
    map_async_json_result(
        profile_service::send_notify_email_code(&ctx, &account_id, &payload.email).await,
    )
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
    map_async_json_result(
        profile_service::remove_notify_email(&ctx, &account_id, &payload.email).await,
    )
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
    map_async_json_result(
        profile_service::send_email_binding_code(&ctx, &account_id, &payload.email).await,
    )
}

async fn bind_email_identity(
    State(ctx): State<AppContext>,
    Path(account_id): Path<String>,
    Json(payload): Json<crate::contracts::EmailIdentityBindInput>,
) -> impl IntoResponse {
    map_async_json_result(profile_service::bind_email_identity(&ctx, &account_id, payload).await)
}

async fn unbind_auth_identity(
    State(ctx): State<AppContext>,
    Path((account_id, provider)): Path<(String, String)>,
) -> impl IntoResponse {
    map_async_json_result(profile_service::unbind_auth_identity(&ctx, &account_id, &provider).await)
}

async fn get_scheduler_config(State(ctx): State<AppContext>) -> impl IntoResponse {
    let config = crate::application::scheduler_service::get_scheduler_config(&ctx);
    (
        StatusCode::OK,
        Json(serde_json::to_value(config).unwrap_or_else(|_| json!({}))),
    )
        .into_response()
}

async fn update_scheduler_config(
    State(ctx): State<AppContext>,
    Json(payload): Json<crate::contracts::SchedulerConfigPayload>,
) -> impl IntoResponse {
    match crate::application::scheduler_service::update_scheduler_config(&ctx, payload) {
        Ok(config) => (
            StatusCode::OK,
            Json(serde_json::to_value(config).unwrap_or_else(|_| json!({}))),
        )
            .into_response(),
        Err(error) => map_error_response(error),
    }
}

async fn get_runtime_coordination_config(State(ctx): State<AppContext>) -> impl IntoResponse {
    map_async_json_result(ctx.runtime_coordination.get_config_payload().await)
}

async fn update_runtime_coordination_config(
    State(ctx): State<AppContext>,
    Json(payload): Json<crate::contracts::RuntimeCoordinationConfigPayload>,
) -> impl IntoResponse {
    map_async_json_result(
        ctx.runtime_coordination
            .update_config_payload(payload)
            .await,
    )
}

async fn get_upstream_network_config(State(ctx): State<AppContext>) -> impl IntoResponse {
    map_async_json_result(
        ctx.runtime_coordination
            .get_upstream_network_config_payload()
            .await,
    )
}

async fn update_upstream_network_config(
    State(ctx): State<AppContext>,
    Json(payload): Json<crate::contracts::UpstreamNetworkConfigPayload>,
) -> impl IntoResponse {
    map_async_json_result(
        ctx.runtime_coordination
            .update_upstream_network_config_payload(payload)
            .await,
    )
}

async fn get_database_storage(State(ctx): State<AppContext>) -> impl IntoResponse {
    map_json_result(database_storage_service::get_database_storage_status(&ctx))
}

async fn migrate_database_storage(
    State(ctx): State<AppContext>,
    Json(payload): Json<crate::contracts::DatabaseStorageMigrationInput>,
) -> impl IntoResponse {
    map_json_result(database_storage_service::migrate_database_storage(
        &ctx, payload,
    ))
}

fn map_json_result<T>(result: anyhow::Result<T>) -> axum::response::Response
where
    T: serde::Serialize,
{
    match result {
        Ok(value) => (
            StatusCode::OK,
            Json(serde_json::to_value(value).unwrap_or_else(|_| json!({}))),
        )
            .into_response(),
        Err(error) => map_error_response(error),
    }
}

fn map_async_json_result<T>(result: anyhow::Result<T>) -> axum::response::Response
where
    T: serde::Serialize,
{
    map_json_result(result)
}

fn map_codex_radar_response<T>(result: anyhow::Result<T>) -> axum::response::Response
where
    T: serde::Serialize,
{
    map_async_json_result(result)
}

fn map_error_response(error: anyhow::Error) -> axum::response::Response {
    let retry_after_ms = site_failover_service::transport_error_payload(&error)
        .and_then(|(_, payload)| payload.retry_after_ms);
    with_retry_after(map_error(error).into_response(), retry_after_ms)
}

fn with_retry_after(
    mut response: axum::response::Response,
    retry_after_ms: Option<u64>,
) -> axum::response::Response {
    let Some(retry_after_ms) = retry_after_ms else {
        return response;
    };
    let retry_after_seconds = retry_after_ms.saturating_add(999) / 1_000;
    if let Ok(value) = HeaderValue::from_str(&retry_after_seconds.max(1).to_string()) {
        response.headers_mut().insert(RETRY_AFTER, value);
    }
    response
}

fn map_error(error: anyhow::Error) -> (StatusCode, Json<Value>) {
    if let Some((status, payload)) = site_failover_service::transport_error_payload(&error) {
        let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        return (
            status,
            Json(serde_json::to_value(payload).unwrap_or_else(|_| {
                json!({
                    "error": "站点故障转移请求失败。",
                    "code": "site_failover_error"
                })
            })),
        );
    }
    let message = error.to_string();
    let status = if message.contains("不能为空")
        || message.contains("不存在")
        || message.contains("仅允许")
        || message.starts_with("USAGE_")
        || is_database_storage_validation_error(&message)
        || is_runtime_coordination_validation_error(&message)
        || message.contains("低余额提醒阈值必须是")
        || is_subscription_quota_alert_validation_error(&message)
        || is_subscription_switch_validation_error(&message)
    {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    (status, Json(json!({ "error": message })))
}

fn is_runtime_coordination_validation_error(message: &str) -> bool {
    [
        "站点每秒请求数必须在",
        "站点并发请求数必须在",
        "Usage 分页并发数必须在",
    ]
    .iter()
    .any(|marker| message.contains(marker))
}

/// 额度提醒配置错误由客户端输入或当前订阅身份触发，应返回 400。
fn is_subscription_quota_alert_validation_error(message: &str) -> bool {
    [
        "订阅额度提醒阈值必须是大于 0 的有限数字",
        "订阅额度百分比提醒阈值不能超过 100%",
        "当前订阅缺少可唯一识别的稳定身份",
    ]
    .iter()
    .any(|marker| message.contains(marker))
}

fn is_database_storage_validation_error(message: &str) -> bool {
    [
        "数据库存储目录不能为空",
        "数据库存储目录必须是绝对路径",
        "无法创建数据库存储目录",
        "无法解析数据库存储目录",
        "目标目录与当前数据库目录相同",
        "目标目录存在数据库冲突文件",
        "数据库存储目录不可写",
        "当前运行实例不允许修改数据库目录",
        "数据库迁移正在进行",
    ]
    .iter()
    .any(|marker| message.contains(marker))
}

/// 订阅链规则保存的校验由客户端输入触发，不能伪装成服务端故障。
fn is_subscription_switch_validation_error(message: &str) -> bool {
    [
        "当前只允许给源订阅下的密钥配置订阅链。",
        "存在未知密钥，无法保存规则。",
        "当前密钥没有所属分组，无法保存订阅链。",
        "当前密钥所在订阅必须保留在订阅链中。",
        "已切换规则不能修改源订阅。",
        "已切换规则不能移除当前生效订阅。",
        "订阅链至少需要包含源订阅和 1 个候补订阅。",
        "订阅链首节点必须是源订阅。",
        "订阅链里不能出现重复订阅。",
        "切换阈值必须是大于 0 的数字。",
        "百分比阈值不能超过 100%。",
        "必须是 subscription 分组。",
    ]
    .iter()
    .any(|marker| message.contains(marker))
}

fn native_capability_unsupported_response() -> axum::response::Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "error": "当前运行模式不支持原生窗口操作。",
            "code": "native_capability_unsupported"
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        fs,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
    };

    use axum::{
        body::to_bytes,
        extract::Query,
        http::{StatusCode, Uri},
        routing::get,
        Json, Router,
    };
    use serde_json::{json, Value};
    use tokio::{
        sync::{oneshot, Mutex},
        task::JoinHandle,
    };

    use super::{
        map_codex_radar_response, map_error, map_error_response, router,
        SiteFailoverTransitionQuery,
    };
    use crate::{
        application::{
            context::SyncTaskHandle,
            desktop_ui_service,
            resource_coordinator::ResourceCoordinator,
            site_failover_service::{SiteFailoverError, SiteFailoverErrorCode},
            AppContext,
        },
        contracts::{
            AccountRecord, AppLaunchMode, CloseBehavior, CodexRadarInsightsPayload,
            CodexRadarIntelligenceEfficiencyPoint, CodexRadarIntelligencePayload,
            CodexRadarModelIqEntry, CodexRadarModelIqPayload, SiteRecord, StoredSession, UsageRow,
        },
        infrastructure::{
            files::AppPaths,
            sqlite::{repositories, Database},
        },
    };

    const DESKTOP_UI_PREFS_KEY: &str = "desktop_ui_prefs";
    const NATIVE_CAPABILITY_UNSUPPORTED_ERROR: &str = "当前运行模式不支持原生窗口操作。";
    const NATIVE_CAPABILITY_UNSUPPORTED_CODE: &str = "native_capability_unsupported";

    #[test]
    fn site_failover_transition_query_accepts_camel_case_cursor() {
        let uri: Uri = "/api/site-failover/transitions?afterRevision=7"
            .parse()
            .expect("parse site failover transition URI");
        let Query(query) = Query::<SiteFailoverTransitionQuery>::try_from_uri(&uri)
            .expect("deserialize site failover transition cursor");

        assert_eq!(query.after_revision, Some(7));
    }

    #[tokio::test]
    async fn failover_error_response_preserves_payload_and_retry_after_header() {
        let error = anyhow::Error::new(SiteFailoverError::for_test(
            SiteFailoverErrorCode::AllAddressesCooling,
            Some(1_700_000_000_000),
            Some(1_250),
        ));

        let response = map_error_response(error);
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            response
                .headers()
                .get(axum::http::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok()),
            Some("2")
        );

        let (_, body) = decode_json_response(response).await;
        assert_eq!(body["error"], "所有站点地址都在冷却中。");
        assert_eq!(body["code"], "all_site_addresses_cooling");
        assert_eq!(body["httpStatus"], 503);
        assert_eq!(body["retryAt"], "2023-11-14T22:13:20.000Z");
        assert_eq!(body["retryAfterMs"], 1_250);
    }

    #[test]
    fn subscription_switch_validation_errors_map_to_bad_request() {
        let validation_errors = [
            "源订阅分组不存在。",
            "候补订阅分组不存在。",
            "源订阅必须是 subscription 分组。",
            "当前只允许给源订阅下的密钥配置订阅链。",
            "存在未知密钥，无法保存规则。",
            "当前密钥没有所属分组，无法保存订阅链。",
            "当前密钥所在订阅必须保留在订阅链中。",
            "已切换规则不能修改源订阅。",
            "已切换规则不能移除当前生效订阅。",
            "订阅链至少需要包含源订阅和 1 个候补订阅。",
            "订阅链首节点必须是源订阅。",
            "订阅链里不能出现重复订阅。",
            "切换阈值必须是大于 0 的数字。",
            "百分比阈值不能超过 100%。",
            "候补订阅必须是 subscription 分组。",
        ];

        for message in validation_errors {
            let (status, body) = map_error(anyhow::anyhow!(message));
            assert_eq!(status, StatusCode::BAD_REQUEST, "message: {message}");
            assert_eq!(body.0, json!({ "error": message }));
        }

        let (status, body) = map_error(anyhow::anyhow!("上游服务暂时不可用"));
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body.0, json!({ "error": "上游服务暂时不可用" }));
    }

    fn sample_model_iq_payload(
        is_stale: bool,
        last_error: Option<&str>,
    ) -> CodexRadarModelIqPayload {
        CodexRadarModelIqPayload {
            items: vec![CodexRadarModelIqEntry {
                id: "gpt-5.6-sol:max".into(),
                label: "GPT-5.6 Sol max".into(),
                model: "gpt-5.6-sol".into(),
                reasoning_effort: "max".into(),
                score: 104.5,
                passed: 80,
                average_cost_usd: 8.93,
                status: Some("green".into()),
                observed_at: "2026-07-22T12:27:35+08:00".into(),
            }],
            source_updated_at: "2026-07-22T12:27:35+08:00".into(),
            fetched_at: "2026-07-22T12:30:00+08:00".into(),
            last_error: last_error.map(str::to_owned),
            is_stale,
        }
    }

    fn sample_intelligence_payload(
        is_stale: bool,
        last_error: Option<&str>,
    ) -> CodexRadarIntelligencePayload {
        CodexRadarIntelligencePayload {
            efficiency_points: vec![CodexRadarIntelligenceEfficiencyPoint {
                id: "gpt-5.6-sol:max".into(),
                label: "GPT-5.6 Sol max".into(),
                model: "gpt-5.6-sol".into(),
                reasoning_effort: "max".into(),
                score: 104.5,
                passed: 80,
                valid_tasks: 112,
                average_cost_usd: Some(8.93),
                average_minutes: Some(34.8),
                combined_cost_index: Some(8.74),
                total_runs: 328,
                observed_at: "2026-07-22T12:27:35+08:00".into(),
            }],
            detail_items: vec![],
            source_updated_at: "2026-07-22T12:27:35+08:00".into(),
            fetched_at: "2026-07-22T12:30:00+08:00".into(),
            last_error: last_error.map(str::to_owned),
            is_stale,
        }
    }

    async fn decode_json_response(response: axum::response::Response) -> (StatusCode, Value) {
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read HTTP adapter response body");
        let value = serde_json::from_slice(&body).expect("decode HTTP adapter JSON response");
        (status, value)
    }

    fn build_test_context(label: &str) -> AppContext {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("resolve project root from Cargo manifest")
            .join("tmp")
            .join(format!(
                "input-panel-http-native-capability-{label}-{}",
                uuid::Uuid::new_v4()
            ));
        let paths = AppPaths::from_root(root);
        paths.ensure().expect("ensure temporary test app paths");
        let db = Database::new(paths.db_path.clone());
        let _ = db.connect().expect("initialize temporary test sqlite");

        AppContext {
            runtime_coordination: crate::application::runtime_coordination_service::RuntimeCoordinationService::from_paths_for_test(&paths)
                .expect("initialize test runtime coordination"),
            paths,
            db,
            sync_tasks: Arc::new(Mutex::new(HashMap::<String, Arc<SyncTaskHandle>>::new())),
            live_resources: ResourceCoordinator::default(),
            native_notifications_enabled: false,
        }
    }

    fn seed_usage_http_account(ctx: &AppContext) {
        repositories::insert_site(
            &ctx.db,
            &SiteRecord {
                id: "usage-http-site".into(),
                name: "Usage HTTP Test Site".into(),
                base_url: "http://127.0.0.1:1".into(),
                created_at: "2026-08-11T00:00:00+08:00".into(),
                updated_at: "2026-08-11T00:00:00+08:00".into(),
                ..SiteRecord::default()
            },
        )
        .expect("insert usage HTTP test site");
        repositories::insert_account(
            &ctx.db,
            &AccountRecord {
                id: "usage-http-account".into(),
                site_id: "usage-http-site".into(),
                label: "Usage HTTP Test Account".into(),
                email: "usage-http@example.com".into(),
                balance_warning: -1.0,
                last_login_at: None,
                created_at: "2026-08-11T00:00:00+08:00".into(),
                updated_at: "2026-08-11T00:00:00+08:00".into(),
            },
        )
        .expect("insert usage HTTP test account");
        let row: UsageRow = serde_json::from_value(json!({
            "id": "usage-http-row",
            "requestId": "http-request-001",
            "createdAt": "2026-08-11T10:00:00+08:00",
            "model": "gpt-5.4",
            "actualCost": 1.25,
            "totalCost": 1.5,
            "inputTokens": 100,
            "outputTokens": 50,
            "totalTokens": 150,
            "stream": false,
            "openaiWsMode": null,
            "durationMs": 900,
            "userAgent": "Codex Desktop"
        }))
        .expect("deserialize usage HTTP fixture");
        repositories::merge_usage_row_cache(
            &ctx.db,
            "usage-http-account",
            &[row],
            "2026-08-11T10:01:00+08:00",
        )
        .expect("seed usage HTTP row");
    }

    async fn start_test_http_server(
        ctx: AppContext,
    ) -> (String, oneshot::Sender<()>, JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test HTTP listener");
        let address = listener
            .local_addr()
            .expect("read test HTTP listener address");
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            axum::serve(listener, router(ctx))
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await
                .expect("serve test HTTP adapter");
        });

        (format!("http://{address}"), shutdown_tx, server)
    }

    fn seed_subscription_quota_alert_accounts(ctx: &AppContext, upstream_base_url: &str) {
        repositories::insert_site(
            &ctx.db,
            &SiteRecord {
                id: "quota-site".into(),
                name: "Quota Test Site".into(),
                base_url: upstream_base_url.into(),
                created_at: "2026-08-04T00:00:00Z".into(),
                updated_at: "2026-08-04T00:00:00Z".into(),
                ..SiteRecord::default()
            },
        )
        .expect("insert quota test site");

        for (account_id, label, email) in [
            ("quota-a", "额度账号 A", "quota-a@example.com"),
            ("quota-b", "额度账号 B", "quota-b@example.com"),
        ] {
            repositories::insert_account(
                &ctx.db,
                &AccountRecord {
                    id: account_id.into(),
                    site_id: "quota-site".into(),
                    label: label.into(),
                    email: email.into(),
                    balance_warning: -1.0,
                    last_login_at: None,
                    created_at: "2026-08-04T00:00:00Z".into(),
                    updated_at: "2026-08-04T00:00:00Z".into(),
                },
            )
            .expect("insert quota test account");
            repositories::save_session(
                &ctx.db,
                account_id,
                &StoredSession {
                    saved_at: "2026-08-04T00:00:00Z".into(),
                    access_token: Some("quota-test-token".into()),
                    refresh_token: None,
                    token_type: Some("bearer".into()),
                    cookie_jar_json: None,
                },
            )
            .expect("save quota test session");
        }
    }

    async fn start_subscription_quota_alert_upstream() -> (
        String,
        Arc<AtomicUsize>,
        oneshot::Sender<()>,
        JoinHandle<()>,
    ) {
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_for_route = Arc::clone(&hits);
        let app = Router::new().route(
            "/api/v1/subscriptions",
            get(move || {
                let hits = Arc::clone(&hits_for_route);
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    Json(json!({
                        "items": [{
                            "id": "subscription-42",
                            "group_id": 42,
                            "name": "Quota Plan",
                            "group_name": "Quota Plan",
                            "status": "active",
                            "platform": "openai",
                            "daily": {
                                "current": 100.0,
                                "limit": 100.0,
                                "window_start": "2026-08-04"
                            }
                        }]
                    }))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind quota alert upstream listener");
        let address = listener
            .local_addr()
            .expect("read quota alert upstream address");
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await
                .expect("serve quota alert upstream");
        });

        (format!("http://{address}"), hits, shutdown_tx, server)
    }

    async fn assert_native_capability_unsupported(response: reqwest::Response) {
        assert_eq!(
            response.status().as_u16(),
            StatusCode::NOT_IMPLEMENTED.as_u16()
        );
        let body: Value = response.json().await.expect("decode unsupported response");
        assert_eq!(
            body,
            json!({
                "error": NATIVE_CAPABILITY_UNSUPPORTED_ERROR,
                "code": NATIVE_CAPABILITY_UNSUPPORTED_CODE,
            })
        );
    }

    async fn stop_test_http_server(shutdown_tx: oneshot::Sender<()>, server: JoinHandle<()>) {
        let _ = shutdown_tx.send(());
        server.await.expect("join test HTTP server");
    }

    #[test]
    fn database_storage_target_path_failures_are_bad_requests() {
        for message in [
            "无法创建数据库存储目录 Z:\\blocked",
            "无法解析数据库存储目录 Z:\\blocked",
        ] {
            let (status, body) = map_error(anyhow::anyhow!(message));

            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(body.0, json!({ "error": message }));
        }
    }

    #[tokio::test]
    async fn account_http_rejects_legacy_balance_warning_without_persisting() {
        let ctx = build_test_context("account-alert-contract");
        let cleanup_root = ctx.paths.root.clone();
        let (base_url, shutdown_tx, server) = start_test_http_server(ctx.clone()).await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("build direct test client");

        let response = client
            .post(format!("{base_url}/api/accounts"))
            .json(&json!({
                "siteId": "site-1",
                "label": "测试账号",
                "email": "account@example.test",
                "balanceWarning": -1
            }))
            .send()
            .await
            .expect("submit legacy account payload");

        let status = response.status();
        let body = response.text().await.expect("read rejected input response");
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "unexpected rejected input response: {body}"
        );
        assert!(repositories::list_accounts(&ctx.db)
            .expect("list accounts after rejected input")
            .is_empty());

        stop_test_http_server(shutdown_tx, server).await;
        drop(ctx);
        let _ = fs::remove_dir_all(cleanup_root);
    }

    #[tokio::test]
    async fn database_storage_http_status_and_validation_keep_camel_case_contract() {
        let ctx = build_test_context("database-storage-status");
        let cleanup_root = ctx.paths.root.clone();
        let (base_url, shutdown_tx, server) = start_test_http_server(ctx.clone()).await;
        let client = reqwest::Client::new();

        let status_response = client
            .get(format!("{base_url}/api/database-storage"))
            .send()
            .await
            .expect("get database storage status");
        assert_eq!(status_response.status(), StatusCode::OK);
        let status: Value = status_response.json().await.expect("decode storage status");
        assert_eq!(status["runtimeScope"], "isolated");
        assert!(status["currentDatabasePath"]
            .as_str()
            .is_some_and(|path| path.ends_with("config.sqlite")));
        assert_eq!(status["overrideActive"], true);
        assert_eq!(status["migrationSupported"], false);
        assert_eq!(status["migrationPhase"], "idle");
        assert_eq!(status["restartRequired"], false);

        let validation_response = client
            .post(format!("{base_url}/api/database-storage/migrate"))
            .json(&json!({ "targetDirectory": "" }))
            .send()
            .await
            .expect("submit empty database storage directory");
        assert_eq!(validation_response.status(), StatusCode::BAD_REQUEST);
        let validation: Value = validation_response
            .json()
            .await
            .expect("decode storage validation error");
        assert_eq!(validation, json!({ "error": "数据库存储目录不能为空。" }));

        stop_test_http_server(shutdown_tx, server).await;
        drop(ctx);
        let _ = fs::remove_dir_all(cleanup_root);
    }

    #[tokio::test]
    async fn upstream_network_config_http_uses_an_independent_camel_case_contract() {
        let ctx = build_test_context("upstream-network-config");
        let cleanup_root = ctx.paths.root.clone();
        let (base_url, shutdown_tx, server) = start_test_http_server(ctx.clone()).await;
        let client = reqwest::Client::new();

        let initial = client
            .get(format!("{base_url}/api/upstream-network/config"))
            .send()
            .await
            .expect("get direct upstream network default");
        assert_eq!(initial.status(), StatusCode::OK);
        assert_eq!(
            initial
                .json::<Value>()
                .await
                .expect("decode direct upstream network default"),
            json!({ "useSystemProxy": false })
        );

        let updated = client
            .patch(format!("{base_url}/api/upstream-network/config"))
            .json(&json!({ "useSystemProxy": true }))
            .send()
            .await
            .expect("enable system proxy");
        assert_eq!(updated.status(), StatusCode::OK);
        assert_eq!(
            updated
                .json::<Value>()
                .await
                .expect("decode updated upstream network config"),
            json!({ "useSystemProxy": true })
        );

        let reread = client
            .get(format!("{base_url}/api/upstream-network/config"))
            .send()
            .await
            .expect("re-read persisted system proxy mode");
        assert_eq!(reread.status(), StatusCode::OK);
        assert_eq!(
            reread
                .json::<Value>()
                .await
                .expect("decode persisted upstream network config"),
            json!({ "useSystemProxy": true })
        );

        stop_test_http_server(shutdown_tx, server).await;
        drop(ctx);
        let _ = fs::remove_dir_all(cleanup_root);
    }

    #[tokio::test]
    async fn database_storage_http_internal_failure_keeps_error_only_and_unfreezes_source() {
        let mut ctx = build_test_context("database-storage-bootstrap-failure");
        ctx.paths.override_active = false;
        let cleanup_root = ctx.paths.root.clone();
        let blocked_parent = cleanup_root.join("blocked-bootstrap-parent");
        fs::write(&blocked_parent, b"not-a-directory").expect("create bootstrap blocker");
        ctx.paths.storage_config_path = blocked_parent.join("storage.json");
        let target_directory = cleanup_root.join("migrated-data");
        let (base_url, shutdown_tx, server) = start_test_http_server(ctx.clone()).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("{base_url}/api/database-storage/migrate"))
            .json(&json!({
                "targetDirectory": target_directory.to_string_lossy()
            }))
            .send()
            .await
            .expect("submit database migration with blocked bootstrap");
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body: Value = response
            .json()
            .await
            .expect("decode storage migration failure");
        let object = body.as_object().expect("storage error should be an object");
        assert_eq!(object.len(), 1);
        assert!(body["error"]
            .as_str()
            .is_some_and(|message| message.starts_with("原子更新数据库引导配置失败:")));

        stop_test_http_server(shutdown_tx, server).await;
        let source = ctx
            .db
            .connect()
            .expect("source database should be unfrozen");
        drop(source);
        drop(ctx);
        let _ = fs::remove_dir_all(cleanup_root);
    }

    #[tokio::test]
    async fn subscription_quota_alert_http_keeps_configs_isolated_cached_and_headless() {
        let ctx = build_test_context("subscription-quota-alerts");
        let cleanup_root = ctx.paths.root.clone();
        let (upstream_base_url, upstream_hits, upstream_shutdown_tx, upstream_server) =
            start_subscription_quota_alert_upstream().await;
        seed_subscription_quota_alert_accounts(&ctx, &upstream_base_url);
        let (base_url, shutdown_tx, server) = start_test_http_server(ctx.clone()).await;
        let client = reqwest::Client::new();

        let default_response = client
            .post(format!(
                "{base_url}/api/accounts/quota-a/subscription-quota-alerts/query"
            ))
            .send()
            .await
            .expect("query default quota alert settings");
        assert_eq!(default_response.status(), StatusCode::OK);
        let default_body: Value = default_response
            .json()
            .await
            .expect("decode default quota alert settings");
        assert_eq!(
            default_body["defaultRule"],
            json!({
                "enabled": true,
                "thresholdMode": "usage_percent",
                "thresholdValue": 98.0,
                "revision": 0
            })
        );
        assert_eq!(default_body["overrides"], json!([]));
        assert_eq!(upstream_hits.load(Ordering::SeqCst), 0);

        let account_a_payload = json!({
            "subscriptionKey": "group:42",
            "enabled": true,
            "thresholdMode": "usage_percent",
            "thresholdValue": 50.0
        });
        let account_a_response = client
            .post(format!(
                "{base_url}/api/accounts/quota-a/subscription-quota-alerts/upsert"
            ))
            .json(&account_a_payload)
            .send()
            .await
            .expect("save account A quota alert");
        assert_eq!(account_a_response.status(), StatusCode::OK);
        let account_a_body: Value = account_a_response
            .json()
            .await
            .expect("decode account A quota alert");
        assert_eq!(account_a_body["subscriptionKey"], "group:42");
        assert_eq!(account_a_body["rule"]["thresholdMode"], "usage_percent");
        assert_eq!(account_a_body["rule"]["thresholdValue"], 50.0);
        assert_eq!(account_a_body["rule"]["revision"], 1);
        assert_eq!(upstream_hits.load(Ordering::SeqCst), 1);

        let unchanged_response = client
            .post(format!(
                "{base_url}/api/accounts/quota-a/subscription-quota-alerts/upsert"
            ))
            .json(&account_a_payload)
            .send()
            .await
            .expect("save unchanged account A quota alert");
        assert_eq!(unchanged_response.status(), StatusCode::OK);
        let unchanged_body: Value = unchanged_response
            .json()
            .await
            .expect("decode unchanged account A quota alert");
        assert_eq!(unchanged_body["rule"]["revision"], 1);
        assert_eq!(
            upstream_hits.load(Ordering::SeqCst),
            1,
            "same-account config saves should reuse the subscription snapshot"
        );

        for (threshold_value, expected_error) in [
            (0.0, "订阅额度提醒阈值必须是大于 0 的有限数字。"),
            (100.1, "订阅额度百分比提醒阈值不能超过 100%。"),
        ] {
            let response = client
                .post(format!(
                    "{base_url}/api/accounts/quota-a/subscription-quota-alerts/upsert"
                ))
                .json(&json!({
                    "subscriptionKey": "group:42",
                    "enabled": true,
                    "thresholdMode": "usage_percent",
                    "thresholdValue": threshold_value
                }))
                .send()
                .await
                .expect("submit invalid quota alert threshold");
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let body: Value = response
                .json()
                .await
                .expect("decode invalid quota alert threshold");
            assert_eq!(body, json!({ "error": expected_error }));
        }
        assert_eq!(upstream_hits.load(Ordering::SeqCst), 1);

        let account_b_response = client
            .post(format!(
                "{base_url}/api/accounts/quota-b/subscription-quota-alerts/upsert"
            ))
            .json(&json!({
                "subscriptionKey": "group:42",
                "enabled": true,
                "thresholdMode": "amount_usd",
                "thresholdValue": 3.5
            }))
            .send()
            .await
            .expect("save account B quota alert");
        assert_eq!(account_b_response.status(), StatusCode::OK);
        let account_b_body: Value = account_b_response
            .json()
            .await
            .expect("decode account B quota alert");
        assert_eq!(account_b_body["subscriptionKey"], "group:42");
        assert_eq!(account_b_body["rule"]["thresholdMode"], "amount_usd");
        assert_eq!(account_b_body["rule"]["thresholdValue"], 3.5);
        assert_eq!(account_b_body["rule"]["revision"], 1);
        assert_eq!(upstream_hits.load(Ordering::SeqCst), 2);

        let account_a_query: Value = client
            .post(format!(
                "{base_url}/api/accounts/quota-a/subscription-quota-alerts/query"
            ))
            .send()
            .await
            .expect("query account A quota alert settings")
            .json()
            .await
            .expect("decode account A quota alert settings");
        let account_b_query: Value = client
            .post(format!(
                "{base_url}/api/accounts/quota-b/subscription-quota-alerts/query"
            ))
            .send()
            .await
            .expect("query account B quota alert settings")
            .json()
            .await
            .expect("decode account B quota alert settings");
        assert_eq!(
            account_a_query["overrides"].as_array().map(Vec::len),
            Some(1)
        );
        assert_eq!(
            account_a_query["overrides"][0]["subscriptionKey"],
            "group:42"
        );
        assert_eq!(
            account_a_query["overrides"][0]["rule"]["thresholdMode"],
            "usage_percent"
        );
        assert_eq!(
            account_a_query["overrides"][0]["rule"]["thresholdValue"],
            50.0
        );
        assert_eq!(account_a_query["overrides"][0]["rule"]["revision"], 1);
        assert_eq!(
            account_b_query["overrides"].as_array().map(Vec::len),
            Some(1)
        );
        assert_eq!(
            account_b_query["overrides"][0]["subscriptionKey"],
            "group:42"
        );
        assert_eq!(
            account_b_query["overrides"][0]["rule"]["thresholdMode"],
            "amount_usd"
        );
        assert_eq!(
            account_b_query["overrides"][0]["rule"]["thresholdValue"],
            3.5
        );
        assert_eq!(account_b_query["overrides"][0]["rule"]["revision"], 1);

        let account_a_subject = repositories::find_subscription_quota_alert_subject_by_key(
            &ctx.db, "quota-a", "group:42",
        )
        .expect("query account A quota alert subject")
        .expect("account A quota alert subject should exist");
        let account_b_subject = repositories::find_subscription_quota_alert_subject_by_key(
            &ctx.db, "quota-b", "group:42",
        )
        .expect("query account B quota alert subject")
        .expect("account B quota alert subject should exist");
        assert_ne!(account_a_subject.subject_id, account_b_subject.subject_id);
        assert!(repositories::list_subscription_quota_alert_window_states(
            &ctx.db,
            &account_a_subject.subject_id,
        )
        .expect("query account A quota alert window states")
        .is_empty());
        assert!(repositories::list_subscription_quota_alert_window_states(
            &ctx.db,
            &account_b_subject.subject_id,
        )
        .expect("query account B quota alert window states")
        .is_empty());
        let conn = ctx.db.connect().expect("open quota alert test database");
        let event_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM subscription_quota_alert_events",
                [],
                |row| row.get(0),
            )
            .expect("count quota alert events");
        assert_eq!(
            event_count, 0,
            "HTTP config saves must not evaluate desktop alerts"
        );
        drop(conn);

        stop_test_http_server(shutdown_tx, server).await;
        stop_test_http_server(upstream_shutdown_tx, upstream_server).await;
        drop(ctx);
        let _ = fs::remove_dir_all(cleanup_root);
    }

    #[tokio::test]
    async fn codex_radar_http_contract_keeps_camel_case_stale_payloads_and_first_failure() {
        let (model_status, model_body) = decode_json_response(map_codex_radar_response(Ok(
            sample_model_iq_payload(true, Some("上游暂时不可用")),
        )))
        .await;
        assert_eq!(model_status, StatusCode::OK);
        assert_eq!(model_body["items"][0]["reasoningEffort"], "max");
        assert_eq!(model_body["sourceUpdatedAt"], "2026-07-22T12:27:35+08:00");
        assert_eq!(model_body["lastError"], "上游暂时不可用");
        assert_eq!(model_body["isStale"], true);

        let (intelligence_status, intelligence_body) =
            decode_json_response(map_codex_radar_response(Ok(sample_intelligence_payload(
                true,
                Some("智力效率上游暂时不可用"),
            ))))
            .await;
        assert_eq!(intelligence_status, StatusCode::OK);
        assert_eq!(
            intelligence_body["efficiencyPoints"][0]["averageCostUsd"],
            8.93
        );
        assert_eq!(
            intelligence_body["efficiencyPoints"][0]["reasoningEffort"],
            "max"
        );
        assert_eq!(intelligence_body["lastError"], "智力效率上游暂时不可用");
        assert_eq!(intelligence_body["isStale"], true);

        let (insights_status, insights_body) =
            decode_json_response(map_codex_radar_response(Ok(CodexRadarInsightsPayload {
                recommendations: vec![],
                degradation_rule: "12 小时 IQ 下降达到上游门槛".into(),
                degradation_alerts: vec![],
                source_updated_at: "2026-07-29T20:38:00+08:00".into(),
                fetched_at: "2026-07-29 20:39:00".into(),
                last_error: Some("推荐预警上游暂时不可用".into()),
                is_stale: true,
            })))
            .await;
        assert_eq!(insights_status, StatusCode::OK);
        assert_eq!(
            insights_body["degradationRule"],
            "12 小时 IQ 下降达到上游门槛"
        );
        assert_eq!(insights_body["degradationAlerts"], json!([]));
        assert_eq!(insights_body["lastError"], "推荐预警上游暂时不可用");
        assert_eq!(insights_body["isStale"], true);

        let (error_status, error_body) =
            decode_json_response(map_codex_radar_response::<CodexRadarModelIqPayload>(Err(
                anyhow::anyhow!("Codex Radar 暂时不可用"),
            )))
            .await;
        assert_eq!(error_status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(error_body, json!({ "error": "Codex Radar 暂时不可用" }));
    }

    #[tokio::test]
    async fn native_desktop_routes_return_a_consistent_unsupported_contract() {
        let ctx = build_test_context("native-routes");
        let (base_url, shutdown_tx, server) = start_test_http_server(ctx.clone()).await;
        let client = reqwest::Client::new();
        let native_only_routes = [
            "/api/desktop-ui/mode",
            "/api/desktop-ui/floating/visibility",
            "/api/desktop-ui/floating/context-menu",
            "/api/desktop-ui/floating-panel/visibility",
            "/api/desktop-ui/floating-panel/position",
            "/api/desktop-ui/floating-panel/toast",
            "/api/desktop-ui/open-main",
            "/api/desktop-ui/quit",
        ];

        for route in native_only_routes {
            let response = client
                .post(format!("{base_url}{route}"))
                .send()
                .await
                .expect("call native-only HTTP route");
            assert_native_capability_unsupported(response).await;
        }

        assert!(
            repositories::get_setting(&ctx.db, DESKTOP_UI_PREFS_KEY)
                .expect("read temporary desktop preferences")
                .is_none(),
            "native-only HTTP routes must not mutate desktop preferences"
        );
        stop_test_http_server(shutdown_tx, server).await;
    }

    #[tokio::test]
    async fn usage_aggregate_routes_share_post_filter_and_bad_request_contracts() {
        let ctx = build_test_context("usage-aggregate-routes");
        seed_usage_http_account(&ctx);
        let (base_url, shutdown_tx, server) = start_test_http_server(ctx).await;
        let client = reqwest::Client::new();
        let routes = [
            "stats",
            "analytics",
            "extremes",
            "models",
            "trend",
            "insights",
        ];
        let filter = json!({
            "startDate": "2026-08-11",
            "endDate": "2026-08-11",
            "requestId": { "value": "http-request", "mode": "prefix" },
            "model": { "value": "gpt-5", "mode": "prefix" },
            "stream": false,
            "openaiWsMode": false,
            "inputTokens": { "min": 100, "max": 100 },
            "durationMs": { "min": 800, "max": 1000 },
            "userAgentQuery": "codex*"
        });

        for route in routes {
            let response = client
                .post(format!(
                    "{base_url}/api/accounts/usage-http-account/usage/{route}"
                ))
                .json(&filter)
                .send()
                .await
                .expect("post usage aggregate filter");
            assert_eq!(response.status(), StatusCode::OK, "route: {route}");

            let invalid_response = client
                .post(format!(
                    "{base_url}/api/accounts/usage-http-account/usage/{route}"
                ))
                .json(&json!({
                    "inputTokens": { "min": 200, "max": 100 }
                }))
                .send()
                .await
                .expect("post invalid usage aggregate filter");
            assert_eq!(
                invalid_response.status(),
                StatusCode::BAD_REQUEST,
                "route: {route}"
            );
            let body: Value = invalid_response
                .json()
                .await
                .expect("decode invalid usage aggregate response");
            assert!(
                body["error"]
                    .as_str()
                    .is_some_and(|message| message.starts_with("USAGE_INVALID_FILTER")),
                "route: {route}, body: {body}"
            );
        }

        let get_response = client
            .get(format!(
                "{base_url}/api/accounts/usage-http-account/usage/stats"
            ))
            .send()
            .await
            .expect("call legacy usage aggregate GET");
        assert_eq!(get_response.status(), StatusCode::METHOD_NOT_ALLOWED);

        stop_test_http_server(shutdown_tx, server).await;
    }

    #[tokio::test]
    async fn native_preference_fields_are_rejected_without_persisting() {
        let ctx = build_test_context("native-preferences");
        let (base_url, shutdown_tx, server) = start_test_http_server(ctx.clone()).await;
        let client = reqwest::Client::new();
        let endpoint = format!("{base_url}/api/desktop-ui/preferences");
        let native_control_patches = [
            json!({ "launchMode": "floating" }),
            json!({ "openFloatingInMainMode": false }),
            json!({ "keepFloatingPanelVisible": true }),
            json!({ "floatingPanelOpacity": 0.73 }),
            json!({ "floatingNotificationDurationMs": 8_000 }),
            json!({ "floatingNotificationDensity": "compact" }),
            json!({ "floatingNotificationMaxVisible": 4 }),
            json!({ "floatingNotificationSoundSource": "custom" }),
            json!({ "floatingNotificationSoundSource": "system" }),
            json!({ "floatingNotificationSoundSource": "muted" }),
            json!({ "floatingNotificationSoundFileName": "custom-tone.mp3" }),
            json!({ "floatingNotificationSoundStorageKey": "notification-sound-550e8400-e29b-41d4-a716-446655440000.mp3" }),
            json!({ "floatingNotificationSoundVolume": 36 }),
            json!({ "closeBehavior": "exit_app" }),
            json!({
                "theme": "arctic-relay",
                "keepFloatingPanelVisible": true,
            }),
        ];

        for payload in native_control_patches {
            let response = client
                .patch(&endpoint)
                .json(&payload)
                .send()
                .await
                .expect("patch browser preferences with native control");
            assert_native_capability_unsupported(response).await;
            assert!(
                repositories::get_setting(&ctx.db, DESKTOP_UI_PREFS_KEY)
                    .expect("read temporary desktop preferences")
                    .is_none(),
                "native preference field must not write browser debug preferences: {payload}"
            );
        }

        stop_test_http_server(shutdown_tx, server).await;
    }

    #[tokio::test]
    async fn browser_debug_preferences_persist_without_native_window_fields() {
        let ctx = build_test_context("browser-preferences");
        let (base_url, shutdown_tx, server) = start_test_http_server(ctx.clone()).await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("build direct test client");
        let patch = json!({
            "theme": "arctic-relay",
            "autoRefreshEnabled": false,
            "autoRefreshIntervalSeconds": 11,
            "autoRefreshServiceStatusEnabled": false,
            "autoRefreshCoreEnabled": false,
            "autoRefreshCoreIntervalSeconds": 12,
            "autoRefreshKeysEnabled": false,
            "autoRefreshKeysIntervalSeconds": 13,
            "autoRefreshUsageEnabled": false,
            "autoRefreshUsageIntervalSeconds": 14,
            "overviewAccountRuntimeTimeoutMs": 6_000,
            "completedTaskRetentionMinutes": 22,
        });

        let response = client
            .patch(format!("{base_url}/api/desktop-ui/preferences"))
            .json(&patch)
            .send()
            .await
            .expect("patch browser-debuggable preferences");
        assert_eq!(response.status().as_u16(), StatusCode::OK.as_u16());
        let response_body: Value = response
            .json()
            .await
            .expect("decode updated browser preferences");
        assert_eq!(response_body["theme"], "arctic-relay");
        assert_eq!(response_body["autoRefreshServiceStatusEnabled"], false);
        assert_eq!(response_body["autoRefreshCoreEnabled"], false);
        assert_eq!(response_body["autoRefreshKeysIntervalSeconds"], 13);
        assert_eq!(response_body["autoRefreshUsageEnabled"], false);
        assert_eq!(response_body["completedTaskRetentionMinutes"], 22);

        let persisted = desktop_ui_service::get_desktop_ui_prefs(&ctx)
            .expect("read persisted browser-debuggable preferences");
        assert_eq!(persisted.theme, "arctic-relay");
        assert!(!persisted.auto_refresh_enabled);
        assert_eq!(persisted.auto_refresh_interval_seconds, 11);
        assert!(!persisted.auto_refresh_service_status_enabled);
        assert!(!persisted.auto_refresh_core_enabled);
        assert_eq!(persisted.auto_refresh_core_interval_seconds, 12);
        assert!(!persisted.auto_refresh_keys_enabled);
        assert_eq!(persisted.auto_refresh_keys_interval_seconds, 13);
        assert!(!persisted.auto_refresh_usage_enabled);
        assert_eq!(persisted.auto_refresh_usage_interval_seconds, 14);
        assert_eq!(persisted.overview_account_runtime_timeout_ms, 6_000);
        assert_eq!(persisted.completed_task_retention_minutes, 22);
        assert_eq!(persisted.launch_mode, AppLaunchMode::Main);
        assert_eq!(persisted.close_behavior, CloseBehavior::Ask);
        assert!(repositories::get_setting(&ctx.db, DESKTOP_UI_PREFS_KEY)
            .expect("read persisted browser-debuggable preferences")
            .is_some());

        stop_test_http_server(shutdown_tx, server).await;
    }
}
