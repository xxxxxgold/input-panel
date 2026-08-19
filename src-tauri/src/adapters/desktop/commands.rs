use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(not(target_os = "windows"))]
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::application::{
    account_service, auth_service, codex_radar_service, dashboard_service, data_center_service,
    database_storage_service, desktop_ui_service, keys_service, maintenance_service,
    profile_service, public_endpoints_service, scheduler_service, service_status_service,
    site_failover_service, site_service, subscription_quota_alert_dispatcher,
    subscription_quota_alert_service,
    subscription_snapshot_service::{
        self, SubscriptionProcessingCapabilities, SubscriptionSnapshotOrigin,
    },
    subscription_switch_service, usage_service, window_selection_service, AppContext,
};
use crate::contracts::{
    AccountRuntime, AccountSyncStatusPayload, AppLaunchMode, CodexRadarFastRadarPayload,
    CodexRadarInsightsPayload, CodexRadarIntelligencePayload, CodexRadarModelIqPayload,
    DailyUsagePoint, DashboardModelsPayload, DatabaseStorageMigrationInput,
    DatabaseStorageMigrationResult, DatabaseStorageStatus, DesktopUiPrefs, DesktopUiPrefsPatch,
    EmailIdentityBindInput, GroupRecord, KeyMutationInput, KeyPatchInput, KeyUsageSummaryPayload,
    LoginFlowResult, ManagedKeyRecord, OpenMainWindowPayload, OverviewDashboardStatsPayload,
    OverviewPayload, PaginatedResult, PlatformQuotaPayload, ProfileUpdateInput,
    RefreshAccountTaskResponse, RefreshTriggerSource, RuntimeCoordinationConfigPayload,
    SchedulerConfigPayload, ServiceStatusPayload, SiteCooldownClearInput, SiteEndpointTestInput,
    SiteEndpointTestResult, SiteFailoverStatusPayload, SiteFailoverTransitionBatch,
    SitePublicEndpointsPayload, SiteRecord, SubscriptionKeyUsagePayload,
    SubscriptionQuotaAlertConfig, SubscriptionQuotaAlertSettingsPayload,
    SubscriptionQuotaAlertUpsertInput, SubscriptionRecord, SubscriptionSummaryPayload,
    SubscriptionSwitchEvaluationResult, SubscriptionSwitchRuleRecord,
    SubscriptionSwitchRuleUpsertInput, SyncAccountDataInput, SyncFailureResponse,
    TransportErrorPayload, UpstreamNetworkConfigPayload, UsageAnalyticsPayload, UsageCursorPage, UsageExtremesPayload,
    UsageFacetPage, UsageFacetRequest, UsageFilter, UsageInsightsPayload, UsageListRequest,
    UsageRow, UsageStatsRecord, UsageTrendPayload, UserProfileRecord,
};

fn sync_keep_floating_panel_visible(app: &AppHandle, prefs: &DesktopUiPrefs) {
    let can_show_floating =
        prefs.launch_mode == AppLaunchMode::Floating || prefs.open_floating_in_main_mode;
    crate::set_floating_native_keep_panel_visible(prefs.keep_floating_panel_visible);
    crate::set_floating_native_panel_visible(
        app,
        prefs.keep_floating_panel_visible && can_show_floating,
    );
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatingPanelPositionPayload {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatingContextMenuPayload {
    pub x: Option<f64>,
    pub y: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatingPanelToastPayload {
    pub tone: String,
    pub message: String,
    pub duration_ms: Option<u64>,
}

#[tauri::command]
pub fn health() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 前端首帧就绪信号：主窗口据此显示（内联主题脚本已生效，避免 FOUC）。
/// 幂等，HMR 重放安全；超时只记录诊断，绝不提前显示尚未绘制的透明主窗口。
#[tauri::command]
pub async fn frontend_ready(app: AppHandle) -> Result<(), String> {
    crate::reveal_main_window_on_frontend_ready(&app).await
}

#[tauri::command]
pub async fn get_overview(ctx: State<'_, AppContext>) -> Result<OverviewPayload, String> {
    dashboard_service::get_overview(&ctx)
        .await
        .map_err(to_message)
}

fn desktop_ui_prefs_require_floating_notification_reconfigure(patch: &DesktopUiPrefsPatch) -> bool {
    patch.floating_notification_density.is_some()
        || patch.floating_notification_max_visible.is_some()
}

fn notify_usage_update(
    app: &AppHandle,
    account_id: &str,
    notification_owner: bool,
    usage_notification_eligible: bool,
    rows: &[crate::contracts::UsageRow],
) {
    if !scheduler_service::should_enqueue_usage_update_notifications(
        notification_owner,
        usage_notification_eligible,
        rows,
    ) {
        return;
    }
    if let Err(error) = scheduler_service::enqueue_usage_update_notifications(app, account_id, rows)
    {
        log::warn!("[desktop] 账号 {} 用量通知投递失败: {}", account_id, error);
    }
}

#[tauri::command]
pub async fn get_overview_shell(ctx: State<'_, AppContext>) -> Result<OverviewPayload, String> {
    let ctx = ctx.inner().clone();
    tokio::task::spawn_blocking(move || dashboard_service::get_overview_shell(&ctx))
        .await
        .map_err(|error| format!("总览缓存读取任务中断: {error}"))?
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_overview_shell_lite(
    ctx: State<'_, AppContext>,
) -> Result<OverviewPayload, String> {
    let ctx = ctx.inner().clone();
    tokio::task::spawn_blocking(move || dashboard_service::get_overview_shell_lite(&ctx))
        .await
        .map_err(|error| format!("精简总览缓存读取任务中断: {error}"))?
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_service_status(ctx: State<'_, AppContext>) -> Result<ServiceStatusPayload, String> {
    service_status_service::get_service_status(&ctx)
        .await
        .map_err(to_message)
}

/// 发送与后台监控一致的服务状态系统通知，供前端手动测试入口复用。
#[tauri::command]
pub fn send_service_status_system_notification(
    app: AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let result = crate::infrastructure::windows_notification::show_service_status_notification(
            &app, &title, &body,
        );
        if let Err(error) = &result {
            log::warn!("[service-status-notification] 手动系统通知投递失败: {error:#}");
        }
        result.map_err(to_message)
    }

    #[cfg(not(target_os = "windows"))]
    {
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub async fn get_codex_radar_model_iq(
    ctx: State<'_, AppContext>,
) -> Result<CodexRadarModelIqPayload, String> {
    map_codex_radar_command_result(codex_radar_service::get_codex_radar_model_iq(&ctx).await)
}

#[tauri::command]
pub async fn get_codex_radar_intelligence(
    ctx: State<'_, AppContext>,
) -> Result<CodexRadarIntelligencePayload, String> {
    map_codex_radar_command_result(codex_radar_service::get_codex_radar_intelligence(&ctx).await)
}

#[tauri::command]
pub async fn get_codex_radar_fast(
    ctx: State<'_, AppContext>,
) -> Result<CodexRadarFastRadarPayload, String> {
    map_codex_radar_command_result(codex_radar_service::get_codex_radar_fast(&ctx).await)
}

#[tauri::command]
pub async fn get_codex_radar_insights(
    ctx: State<'_, AppContext>,
    force: Option<bool>,
) -> Result<CodexRadarInsightsPayload, String> {
    map_codex_radar_command_result(
        codex_radar_service::get_codex_radar_insights(&ctx, force.unwrap_or(false)).await,
    )
}

#[tauri::command]
pub fn get_window_selection(
    ctx: State<'_, AppContext>,
) -> Result<window_selection_service::WindowSelectionState, String> {
    window_selection_service::get_window_selection(&ctx).map_err(to_message)
}

#[tauri::command]
pub fn update_window_selection(
    ctx: State<'_, AppContext>,
    selection: window_selection_service::WindowSelectionState,
) -> Result<window_selection_service::WindowSelectionState, String> {
    window_selection_service::update_window_selection(&ctx, selection).map_err(to_message)
}

#[tauri::command]
pub fn get_site_public_endpoints(
    ctx: State<'_, AppContext>,
    site_id: String,
) -> Result<Option<SitePublicEndpointsPayload>, String> {
    public_endpoints_service::get_site_public_endpoints(&ctx, &site_id).map_err(to_message)
}

#[tauri::command]
pub async fn sync_site_public_endpoints(
    ctx: State<'_, AppContext>,
    site_id: String,
) -> Result<SitePublicEndpointsPayload, String> {
    public_endpoints_service::sync_site_public_endpoints(&ctx, &site_id)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn ping_site_public_endpoints(
    ctx: State<'_, AppContext>,
    site_id: String,
) -> Result<SitePublicEndpointsPayload, String> {
    public_endpoints_service::ping_site_public_endpoints(&ctx, &site_id)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub fn get_desktop_ui_prefs(ctx: State<'_, AppContext>) -> Result<DesktopUiPrefs, String> {
    desktop_ui_service::get_desktop_ui_prefs(&ctx).map_err(to_message)
}

#[tauri::command]
pub fn update_desktop_ui_prefs(
    app: AppHandle,
    ctx: State<'_, AppContext>,
    payload: DesktopUiPrefsPatch,
) -> Result<DesktopUiPrefs, String> {
    let sync_floating_panel_visibility = payload.keep_floating_panel_visible.is_some();
    let reconfigure_floating_notifications =
        desktop_ui_prefs_require_floating_notification_reconfigure(&payload);
    let wake_service_status_monitor = payload.auto_refresh_enabled.is_some()
        || payload.auto_refresh_interval_seconds.is_some()
        || payload.auto_refresh_service_status_enabled.is_some();
    let prefs = desktop_ui_service::update_desktop_ui_prefs(&ctx, payload).map_err(to_message)?;
    if sync_floating_panel_visibility {
        sync_keep_floating_panel_visible(&app, &prefs);
    }
    if reconfigure_floating_notifications {
        crate::queue_floating_notification_window_reconfigure(&app, prefs.clone());
    }
    if wake_service_status_monitor {
        if let Some(monitor) = app.try_state::<service_status_service::ServiceStatusMonitor>() {
            monitor.wake();
        }
    }
    let _ = app.emit("desktop-ui-prefs-updated", &prefs);
    Ok(prefs)
}

/// 打开原生选择器并导入提示音，选择取消不会修改现有配置。
#[tauri::command]
pub async fn select_floating_notification_sound(
    app: AppHandle,
    ctx: State<'_, AppContext>,
) -> Result<Option<DesktopUiPrefs>, String> {
    let ctx = ctx.inner().clone();
    let (selected_tx, selected_rx) = tokio::sync::oneshot::channel::<Option<FilePath>>();
    app.dialog()
        .file()
        .set_title("选择提示音")
        .add_filter("音频文件", &["mp3", "wav"])
        .pick_file(move |selected| {
            let _ = selected_tx.send(selected);
        });

    let Some(selected) = selected_rx
        .await
        .map_err(|_| "选择提示音窗口已中断".to_string())?
    else {
        return Ok(None);
    };
    let source_path = selected
        .into_path()
        .map_err(|_| "无法读取选择的提示音文件".to_string())?;
    let prefs = tokio::task::spawn_blocking(move || {
        desktop_ui_service::import_floating_notification_custom_sound(&ctx, &source_path)
    })
    .await
    .map_err(|error| format!("提示音导入任务中断: {error}"))?
    .map_err(to_message)?;
    let _ = app.emit("desktop-ui-prefs-updated", &prefs);
    Ok(Some(prefs))
}

/// 使用当前来源和音量试听一次提示音。
#[tauri::command]
pub fn preview_floating_notification_sound(app: AppHandle) -> Result<bool, String> {
    desktop_ui_service::schedule_floating_notification_sound(&app).map_err(to_message)?;
    Ok(true)
}

/// 恢复内置提示音并向所有桌面窗口同步完整偏好。
#[tauri::command]
pub fn restore_default_floating_notification_sound(
    app: AppHandle,
    ctx: State<'_, AppContext>,
) -> Result<DesktopUiPrefs, String> {
    let prefs = desktop_ui_service::restore_default_floating_notification_sound(&ctx)
        .map_err(to_message)?;
    let _ = app.emit("desktop-ui-prefs-updated", &prefs);
    Ok(prefs)
}

#[tauri::command]
pub fn switch_app_mode(
    app: AppHandle,
    ctx: State<'_, AppContext>,
    launch_mode: AppLaunchMode,
) -> Result<DesktopUiPrefs, String> {
    let prefs =
        desktop_ui_service::set_launch_mode(&ctx, launch_mode.clone()).map_err(to_message)?;
    let main = app.get_webview_window("main");
    let main_mode_requested = matches!(&launch_mode, AppLaunchMode::Main);
    let mut main_window_activation_applied = false;
    match launch_mode {
        AppLaunchMode::Main => {
            main_window_activation_applied = crate::request_main_window_activation_after_startup_handoff(
                &app,
                &prefs,
                None,
                "切换到主窗口模式",
            )?;
        }
        AppLaunchMode::Floating => {
            if let Some(window) = &main {
                let _ = window.hide();
            }
            let floating =
                crate::ensure_floating_runtime(&app).map_err(|error| error.to_string())?;
            crate::show_floating_window(&floating, true);
            crate::hide_floating_auxiliary_window(&app, "floating-panel");
        }
    }
    if main_mode_requested && !main_window_activation_applied {
        let _ = app.emit("desktop-ui-prefs-updated", &prefs);
        return Ok(prefs);
    }
    crate::hide_floating_notification_window(&app);
    sync_keep_floating_panel_visible(&app, &prefs);
    let _ = crate::sync_floating_notification_window_with_prefs(&app, &prefs);
    let _ = app.emit("desktop-ui-prefs-updated", &prefs);
    Ok(prefs)
}

#[tauri::command]
pub fn set_floating_window_visible(
    app: AppHandle,
    ctx: State<'_, AppContext>,
    visible: bool,
) -> Result<DesktopUiPrefs, String> {
    let prefs = desktop_ui_service::update_desktop_ui_prefs(
        &ctx,
        DesktopUiPrefsPatch {
            open_floating_in_main_mode: Some(visible),
            ..DesktopUiPrefsPatch::default()
        },
    )
    .map_err(to_message)?;

    if visible {
        let floating = crate::ensure_floating_runtime(&app).map_err(|error| error.to_string())?;
        crate::show_floating_window(&floating, true);
    } else {
        crate::hide_floating_auxiliary_window(&app, "floating");
    }
    crate::hide_floating_auxiliary_window(&app, "floating-panel");
    crate::hide_floating_notification_window(&app);

    sync_keep_floating_panel_visible(&app, &prefs);
    let _ = crate::sync_floating_notification_window_with_prefs(&app, &prefs);
    let _ = app.emit("desktop-ui-prefs-updated", &prefs);
    Ok(prefs)
}

#[tauri::command]
pub fn set_floating_panel_visible(app: AppHandle, visible: bool) -> Result<bool, String> {
    if visible {
        crate::ensure_floating_runtime(&app).map_err(|error| error.to_string())?;
    }
    crate::set_floating_native_panel_visible(&app, visible);
    Ok(true)
}

#[tauri::command]
pub fn get_floating_panel_visible(app: AppHandle) -> Result<bool, String> {
    Ok(crate::is_floating_panel_visible(&app))
}

#[tauri::command]
pub fn begin_floating_native_pointer_session() -> Result<bool, String> {
    Ok(crate::begin_floating_native_pointer_session_from_webview())
}

#[tauri::command]
pub fn position_floating_panel(
    app: AppHandle,
    payload: FloatingPanelPositionPayload,
) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("floating-panel") {
        let _ = window.set_position(tauri::PhysicalPosition::new(payload.x, payload.y));
    }
    Ok(true)
}

#[tauri::command]
pub async fn enqueue_floating_notification(
    app: AppHandle,
    payload: crate::FloatingNotificationPayload,
) -> Result<crate::FloatingNotificationSnapshot, String> {
    crate::enqueue_floating_notification(&app, payload)
}

#[tauri::command]
pub fn get_floating_notification_snapshot(
    app: AppHandle,
) -> Result<crate::FloatingNotificationSnapshot, String> {
    crate::get_floating_notification_snapshot_for_app(&app)
}

#[tauri::command]
pub async fn dismiss_floating_notification(
    app: AppHandle,
    notification_id: String,
) -> Result<crate::FloatingNotificationSnapshot, String> {
    crate::dismiss_floating_notification(&app, &notification_id)
}

#[tauri::command]
pub async fn set_floating_notification_detail_open(
    app: AppHandle,
    open: bool,
) -> Result<crate::FloatingNotificationSnapshot, String> {
    crate::set_floating_notification_detail_open(&app, open)
}

/// 通知补位动效结束后恢复离散命中区域，保留卡片间隙的点击穿透。
#[tauri::command]
pub async fn settle_floating_notification_motion(app: AppHandle) -> Result<bool, String> {
    crate::settle_floating_notification_motion(&app)
}

#[tauri::command]
pub fn push_floating_panel_toast(
    app: AppHandle,
    payload: FloatingPanelToastPayload,
) -> Result<bool, String> {
    let event_payload = serde_json::json!({
        "tone": payload.tone,
        "message": payload.message,
        "durationMs": payload.duration_ms
    });
    let _ = app.emit_to("floating-panel", "floating-panel-toast", event_payload);
    Ok(true)
}

#[tauri::command]
pub fn show_floating_context_menu(
    app: AppHandle,
    payload: Option<FloatingContextMenuPayload>,
) -> Result<bool, String> {
    use tauri::{
        menu::{Menu, MenuItemBuilder},
        LogicalPosition,
    };

    const TOGGLE_ID: &str = "floating_context_toggle_panel";
    const OPEN_MAIN_ID: &str = "floating_context_open_main";
    const QUIT_ID: &str = "floating_context_quit";

    let window = app
        .get_webview_window("floating")
        .ok_or_else(|| "floating window not found".to_string())?;
    let toggle = MenuItemBuilder::with_id(TOGGLE_ID, "展开/收起快捷面板")
        .build(&app)
        .map_err(|error| error.to_string())?;
    let open_main = MenuItemBuilder::with_id(OPEN_MAIN_ID, "打开主窗口")
        .build(&app)
        .map_err(|error| error.to_string())?;
    let quit = MenuItemBuilder::with_id(QUIT_ID, "退出")
        .build(&app)
        .map_err(|error| error.to_string())?;
    let menu =
        Menu::with_items(&app, &[&toggle, &open_main, &quit]).map_err(|error| error.to_string())?;

    if let Some(position) = payload.and_then(|value| match (value.x, value.y) {
        (Some(x), Some(y)) => Some(LogicalPosition::new(x, y)),
        _ => None,
    }) {
        window
            .popup_menu_at(&menu, position)
            .map_err(|error| error.to_string())?;
    } else {
        window
            .popup_menu(&menu)
            .map_err(|error| error.to_string())?;
    }

    Ok(true)
}

#[tauri::command]
pub fn open_main_window(
    app: AppHandle,
    ctx: State<'_, AppContext>,
    payload: Option<OpenMainWindowPayload>,
) -> Result<DesktopUiPrefs, String> {
    let prefs =
        desktop_ui_service::set_launch_mode(&ctx, AppLaunchMode::Main).map_err(to_message)?;
    let navigation = payload.as_ref().and_then(|item| item.nav.as_deref());
    let main_window_activation_applied =
        crate::request_main_window_activation_after_startup_handoff(
            &app,
            &prefs,
            navigation,
            "打开主窗口",
        )?;
    if !main_window_activation_applied {
        let _ = app.emit("desktop-ui-prefs-updated", &prefs);
        return Ok(prefs);
    }
    sync_keep_floating_panel_visible(&app, &prefs);
    let _ = app.emit("desktop-ui-prefs-updated", &prefs);
    Ok(prefs)
}

#[tauri::command]
pub fn quit_application(app: AppHandle) -> Result<bool, String> {
    crate::dismiss_native_startup_splash_for_exit(&app);
    app.exit(0);
    Ok(true)
}

#[tauri::command]
pub fn create_site(
    ctx: State<'_, AppContext>,
    payload: crate::contracts::SiteInput,
) -> Result<SiteRecord, String> {
    site_service::create_site(&ctx, payload).map_err(to_message)
}

#[tauri::command]
pub fn update_site(
    ctx: State<'_, AppContext>,
    site_id: String,
    payload: crate::contracts::SitePatchInput,
) -> Result<SiteRecord, String> {
    site_service::update_site(&ctx, &site_id, payload).map_err(to_message)
}

#[tauri::command]
pub fn remove_site(ctx: State<'_, AppContext>, site_id: String) -> Result<bool, String> {
    site_service::remove_site(&ctx, &site_id).map_err(to_message)
}

/// 读取站点主备地址的共享运行状态。
#[tauri::command]
pub async fn get_site_failover_status(
    ctx: State<'_, AppContext>,
    site_id: String,
) -> Result<SiteFailoverStatusPayload, TransportErrorPayload> {
    site_failover_service::get_site_failover_status(&ctx, &site_id)
        .await
        .map_err(to_transport_error)
}

/// 执行单地址只读连接测试，不改变持久化配置或活动地址。
#[tauri::command]
pub async fn test_site_endpoint(
    ctx: State<'_, AppContext>,
    site_id: String,
    payload: SiteEndpointTestInput,
) -> Result<SiteEndpointTestResult, TransportErrorPayload> {
    site_failover_service::test_site_endpoint(&ctx, &site_id, payload)
        .await
        .map_err(to_transport_error)
}

/// 解除指定站点地址的冷却，并返回新的待检测状态。
#[tauri::command]
pub async fn clear_site_failover_cooldown(
    ctx: State<'_, AppContext>,
    site_id: String,
    payload: SiteCooldownClearInput,
) -> Result<SiteFailoverStatusPayload, TransportErrorPayload> {
    site_failover_service::clear_site_failover_cooldown(&ctx, &site_id, payload)
        .await
        .map_err(to_transport_error)
}

/// 读取跨 Web/Tauri 共享的站点切换事件。
#[tauri::command]
pub async fn list_site_failover_transitions(
    ctx: State<'_, AppContext>,
    after_revision: Option<i64>,
) -> Result<SiteFailoverTransitionBatch, TransportErrorPayload> {
    site_failover_service::list_site_failover_transitions(&ctx, after_revision.unwrap_or(0))
        .await
        .map_err(to_transport_error)
}

#[tauri::command]
pub fn create_account(
    ctx: State<'_, AppContext>,
    payload: crate::contracts::AccountInput,
) -> Result<AccountRuntime, String> {
    account_service::create_account(&ctx, payload).map_err(to_message)
}

#[tauri::command]
pub fn update_account(
    ctx: State<'_, AppContext>,
    account_id: String,
    label: Option<String>,
    email: Option<String>,
    balance_warning: Option<f64>,
) -> Result<AccountRuntime, String> {
    account_service::update_account(&ctx, &account_id, label, email, balance_warning)
        .map_err(to_message)
}

#[tauri::command]
pub fn remove_account(ctx: State<'_, AppContext>, account_id: String) -> Result<bool, String> {
    account_service::remove_account(&ctx, &account_id).map_err(to_message)
}

#[tauri::command]
pub fn clear_runtime_data(
    ctx: State<'_, AppContext>,
    remove_sites_and_accounts: bool,
) -> Result<bool, String> {
    maintenance_service::clear_runtime_data(&ctx, remove_sites_and_accounts).map_err(to_message)
}

#[tauri::command]
pub async fn login_account(
    ctx: State<'_, AppContext>,
    account_id: String,
    password: String,
) -> Result<LoginFlowResult, TransportErrorPayload> {
    auth_service::login_account(&ctx, &account_id, &password)
        .await
        .map_err(to_transport_error)
}

#[tauri::command]
pub fn persist_account_credential(
    ctx: State<'_, AppContext>,
    account_id: String,
    password: String,
) -> Result<bool, String> {
    auth_service::persist_account_credential(&ctx, &account_id, &password).map_err(to_message)
}

#[tauri::command]
pub async fn login_account_2fa(
    ctx: State<'_, AppContext>,
    account_id: String,
    temp_token: String,
    code: String,
    origin_base_url: Option<String>,
) -> Result<AccountRuntime, TransportErrorPayload> {
    auth_service::login_account_2fa(
        &ctx,
        &account_id,
        &temp_token,
        &code,
        origin_base_url.as_deref(),
    )
    .await
    .map_err(to_transport_error)
}

#[tauri::command]
pub async fn sync_all_accounts(
    ctx: State<'_, AppContext>,
    app: AppHandle,
    payload: SyncAccountDataInput,
) -> Result<OverviewPayload, String> {
    let results = data_center_service::sync_all_accounts(&ctx, payload)
        .await
        .map_err(to_message)?;
    for (_, result) in results {
        notify_usage_update(
            &app,
            &result.status.account_id,
            result.notification_owner,
            result.usage_notification_eligible,
            &result.changed_usage_rows,
        );
    }
    dashboard_service::get_overview(&ctx)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn refresh_account(
    ctx: State<'_, AppContext>,
    app: AppHandle,
    account_id: String,
    trigger_source: Option<RefreshTriggerSource>,
) -> Result<RefreshAccountTaskResponse, TransportErrorPayload> {
    let result = data_center_service::refresh_account(
        &ctx,
        &account_id,
        trigger_source.unwrap_or(RefreshTriggerSource::Manual),
    )
    .await
    .map_err(to_transport_error)?;
    notify_usage_update(
        &app,
        &result.status.account_id,
        result.notification_owner,
        result.usage_notification_eligible,
        &result.changed_usage_rows,
    );
    Ok(result)
}

#[tauri::command]
pub async fn refresh_all_accounts(
    ctx: State<'_, AppContext>,
    app: AppHandle,
) -> Result<OverviewPayload, String> {
    let results = data_center_service::refresh_all_accounts(&ctx)
        .await
        .map_err(to_message)?;
    for (_, result) in results {
        notify_usage_update(
            &app,
            &result.status.account_id,
            result.notification_owner,
            result.usage_notification_eligible,
            &result.changed_usage_rows,
        );
    }
    dashboard_service::get_overview(&ctx)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn sync_account_data(
    ctx: State<'_, AppContext>,
    app: AppHandle,
    account_id: String,
    payload: SyncAccountDataInput,
) -> Result<AccountSyncStatusPayload, SyncFailureResponse> {
    let result = data_center_service::sync_account_data(&ctx, &account_id, payload)
        .await
        .map_err(|error| data_center_service::sync_failure_response_from_error(&error))?;
    notify_usage_update(
        &app,
        &result.status.account_id,
        result.notification_owner,
        result.usage_notification_eligible,
        &result.changed_usage_rows,
    );
    Ok(result.status)
}

#[tauri::command]
pub async fn get_account_sync_status(
    ctx: State<'_, AppContext>,
    account_id: String,
) -> Result<AccountSyncStatusPayload, String> {
    data_center_service::get_account_sync_status(&ctx, &account_id)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_available_groups(
    ctx: State<'_, AppContext>,
    account_id: String,
) -> Result<Vec<GroupRecord>, String> {
    keys_service::get_available_groups(&ctx, &account_id)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn list_managed_keys(
    ctx: State<'_, AppContext>,
    account_id: String,
    page: Option<i64>,
    page_size: Option<i64>,
    force: Option<bool>,
) -> Result<PaginatedResult<ManagedKeyRecord>, String> {
    keys_service::list_managed_keys(
        &ctx,
        &account_id,
        page.unwrap_or(1),
        page_size.unwrap_or(20),
        force.unwrap_or(false),
    )
    .await
    .map_err(to_message)
}

#[tauri::command]
pub async fn get_managed_key(
    ctx: State<'_, AppContext>,
    account_id: String,
    key_id: String,
) -> Result<ManagedKeyRecord, String> {
    keys_service::get_managed_key(&ctx, &account_id, &key_id)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn create_managed_key(
    ctx: State<'_, AppContext>,
    account_id: String,
    payload: KeyMutationInput,
) -> Result<ManagedKeyRecord, String> {
    keys_service::create_managed_key(&ctx, &account_id, payload)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn update_managed_key(
    ctx: State<'_, AppContext>,
    account_id: String,
    key_id: String,
    payload: KeyPatchInput,
) -> Result<ManagedKeyRecord, String> {
    keys_service::update_managed_key(&ctx, &account_id, &key_id, payload)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn delete_managed_key(
    ctx: State<'_, AppContext>,
    account_id: String,
    key_id: String,
) -> Result<bool, String> {
    keys_service::delete_managed_key(&ctx, &account_id, &key_id)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn list_usage_records(
    ctx: State<'_, AppContext>,
    account_id: String,
    request: UsageListRequest,
) -> Result<UsageCursorPage<UsageRow>, String> {
    usage_service::list_usage_records(&ctx, &account_id, request)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn list_usage_facets(
    ctx: State<'_, AppContext>,
    account_id: String,
    request: UsageFacetRequest,
) -> Result<UsageFacetPage, String> {
    usage_service::list_usage_facets(&ctx, &account_id, request)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_usage_stats(
    ctx: State<'_, AppContext>,
    account_id: String,
    filter: UsageFilter,
) -> Result<UsageStatsRecord, String> {
    usage_service::get_usage_stats(&ctx, &account_id, filter)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_usage_analytics(
    ctx: State<'_, AppContext>,
    account_id: String,
    filter: UsageFilter,
) -> Result<UsageAnalyticsPayload, String> {
    usage_service::get_usage_analytics(&ctx, &account_id, filter)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_usage_extremes(
    ctx: State<'_, AppContext>,
    account_id: String,
    filter: UsageFilter,
) -> Result<UsageExtremesPayload, String> {
    usage_service::get_usage_extremes(&ctx, &account_id, filter)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_overview_dashboard_stats(
    ctx: State<'_, AppContext>,
    account_id: String,
    force: Option<bool>,
) -> Result<OverviewDashboardStatsPayload, String> {
    usage_service::get_overview_dashboard_stats(&ctx, &account_id, force.unwrap_or(false))
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_dashboard_models(
    ctx: State<'_, AppContext>,
    account_id: String,
    filter: UsageFilter,
) -> Result<DashboardModelsPayload, String> {
    usage_service::get_dashboard_models(&ctx, &account_id, filter)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_dashboard_trend(
    ctx: State<'_, AppContext>,
    account_id: String,
    filter: UsageFilter,
) -> Result<UsageTrendPayload, String> {
    usage_service::get_dashboard_trend(&ctx, &account_id, filter)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_key_daily_usage(
    ctx: State<'_, AppContext>,
    account_id: String,
    key_id: String,
    days: Option<i64>,
) -> Result<Vec<DailyUsagePoint>, String> {
    usage_service::get_key_daily_usage(&ctx, &account_id, &key_id, days.unwrap_or(30))
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_usage_insights(
    ctx: State<'_, AppContext>,
    account_id: String,
    filter: UsageFilter,
) -> Result<UsageInsightsPayload, String> {
    usage_service::get_usage_insights(&ctx, &account_id, filter)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_key_usage_summary(
    ctx: State<'_, AppContext>,
    account_id: String,
    key_id: String,
    days: Option<i64>,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<KeyUsageSummaryPayload, String> {
    usage_service::get_key_usage_summary(
        &ctx,
        &account_id,
        &key_id,
        days.unwrap_or(30),
        start_date,
        end_date,
    )
    .await
    .map_err(to_message)
}

#[tauri::command]
pub async fn get_subscription_key_usage(
    ctx: State<'_, AppContext>,
    account_id: String,
    key_ids: Vec<String>,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<SubscriptionKeyUsagePayload, String> {
    usage_service::get_subscription_key_usage(&ctx, &account_id, key_ids, start_date, end_date)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_profile_record(
    ctx: State<'_, AppContext>,
    account_id: String,
    force: Option<bool>,
) -> Result<UserProfileRecord, String> {
    profile_service::get_profile_record(&ctx, &account_id, force.unwrap_or(false))
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn update_profile_record(
    ctx: State<'_, AppContext>,
    account_id: String,
    payload: ProfileUpdateInput,
) -> Result<UserProfileRecord, String> {
    profile_service::update_profile_record(&ctx, &account_id, payload)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn change_profile_password(
    ctx: State<'_, AppContext>,
    account_id: String,
    old_password: String,
    new_password: String,
) -> Result<bool, String> {
    profile_service::change_profile_password(&ctx, &account_id, &old_password, &new_password)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_platform_quotas(
    ctx: State<'_, AppContext>,
    account_id: String,
) -> Result<PlatformQuotaPayload, String> {
    profile_service::get_platform_quotas(&ctx, &account_id)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_subscriptions(
    app: AppHandle,
    ctx: State<'_, AppContext>,
    account_id: String,
    force: Option<bool>,
) -> Result<Vec<SubscriptionRecord>, String> {
    let outcome = subscription_snapshot_service::refresh_and_process(
        &ctx,
        &account_id,
        force.unwrap_or(false),
        crate::application::upstream_service::UpstreamRequestPolicy::ReadOnly,
        SubscriptionSnapshotOrigin::PageRead,
        SubscriptionProcessingCapabilities::desktop(true),
    )
    .await
    .map_err(to_message)?;
    if let Err(error) =
        subscription_quota_alert_dispatcher::flush_due(&app, Some(&account_id)).await
    {
        log::warn!(
            "[desktop] 账号 {} 页面读取后的额度提醒投递失败，将在后续刷新重试: {}",
            account_id,
            error
        );
    }
    Ok(outcome.subscriptions)
}

#[tauri::command]
pub async fn get_subscription_summary(
    ctx: State<'_, AppContext>,
    account_id: String,
) -> Result<SubscriptionSummaryPayload, String> {
    profile_service::get_subscription_summary(&ctx, &account_id)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn send_notify_email_code(
    ctx: State<'_, AppContext>,
    account_id: String,
    email: String,
) -> Result<bool, String> {
    profile_service::send_notify_email_code(&ctx, &account_id, &email)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn verify_notify_email(
    ctx: State<'_, AppContext>,
    account_id: String,
    email: String,
    code: String,
) -> Result<bool, String> {
    profile_service::verify_notify_email(&ctx, &account_id, &email, &code)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn remove_notify_email(
    ctx: State<'_, AppContext>,
    account_id: String,
    email: String,
) -> Result<bool, String> {
    profile_service::remove_notify_email(&ctx, &account_id, &email)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn toggle_notify_email(
    ctx: State<'_, AppContext>,
    account_id: String,
    email: String,
    disabled: bool,
) -> Result<UserProfileRecord, String> {
    profile_service::toggle_notify_email(&ctx, &account_id, &email, disabled)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn send_email_binding_code(
    ctx: State<'_, AppContext>,
    account_id: String,
    email: String,
) -> Result<bool, String> {
    profile_service::send_email_binding_code(&ctx, &account_id, &email)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn bind_email_identity(
    ctx: State<'_, AppContext>,
    account_id: String,
    payload: EmailIdentityBindInput,
) -> Result<UserProfileRecord, String> {
    profile_service::bind_email_identity(&ctx, &account_id, payload)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn list_subscription_switch_rules(
    ctx: State<'_, AppContext>,
    account_id: String,
) -> Result<Vec<SubscriptionSwitchRuleRecord>, String> {
    subscription_switch_service::list_subscription_switch_rules(&ctx, &account_id)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn upsert_subscription_switch_rule(
    ctx: State<'_, AppContext>,
    account_id: String,
    key_id: String,
    payload: SubscriptionSwitchRuleUpsertInput,
) -> Result<SubscriptionSwitchRuleRecord, String> {
    subscription_switch_service::upsert_subscription_switch_rule(
        &ctx,
        &account_id,
        &key_id,
        payload,
    )
    .await
    .map_err(to_message)
}

#[tauri::command]
pub async fn delete_subscription_switch_rule(
    ctx: State<'_, AppContext>,
    account_id: String,
    key_id: String,
) -> Result<bool, String> {
    subscription_switch_service::delete_subscription_switch_rule(&ctx, &account_id, &key_id)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn evaluate_subscription_switch_rules(
    ctx: State<'_, AppContext>,
    account_id: String,
) -> Result<Vec<SubscriptionSwitchEvaluationResult>, String> {
    subscription_switch_service::evaluate_subscription_switch_rules(&ctx, &account_id)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn query_subscription_quota_alerts(
    ctx: State<'_, AppContext>,
    account_id: String,
) -> Result<SubscriptionQuotaAlertSettingsPayload, String> {
    subscription_quota_alert_service::query_subscription_quota_alerts(&ctx, &account_id)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn upsert_subscription_quota_alert(
    app: AppHandle,
    ctx: State<'_, AppContext>,
    account_id: String,
    payload: SubscriptionQuotaAlertUpsertInput,
) -> Result<SubscriptionQuotaAlertConfig, String> {
    let snapshot = subscription_snapshot_service::refresh_and_process(
        &ctx,
        &account_id,
        false,
        crate::application::upstream_service::UpstreamRequestPolicy::ReadOnly,
        SubscriptionSnapshotOrigin::ConfigSave,
        SubscriptionProcessingCapabilities::headless(false),
    )
    .await
    .map_err(to_message)?;
    let saved = subscription_quota_alert_service::upsert_subscription_quota_alert_with_snapshot(
        &ctx,
        &account_id,
        payload,
        &snapshot.subscriptions,
    )
    .await
    .map_err(to_message)?;
    subscription_snapshot_service::process_successful_snapshot(
        &ctx,
        &account_id,
        &snapshot.subscriptions,
        false,
        crate::application::upstream_service::UpstreamRequestPolicy::ReadOnly,
        SubscriptionSnapshotOrigin::ConfigSave,
        SubscriptionProcessingCapabilities::desktop(true),
    )
    .await;
    if let Err(error) =
        subscription_quota_alert_dispatcher::flush_due(&app, Some(&account_id)).await
    {
        log::warn!(
            "[desktop] 账号 {} 保存额度提醒后的投递失败，将在后续刷新重试: {}",
            account_id,
            error
        );
    }
    Ok(saved)
}

#[tauri::command]
pub async fn unbind_auth_identity(
    ctx: State<'_, AppContext>,
    account_id: String,
    provider: String,
) -> Result<bool, String> {
    profile_service::unbind_auth_identity(&ctx, &account_id, &provider)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub fn get_scheduler_config(ctx: State<'_, AppContext>) -> Result<SchedulerConfigPayload, String> {
    Ok(scheduler_service::get_scheduler_config(&ctx))
}

#[tauri::command]
pub fn update_scheduler_config(
    ctx: State<'_, AppContext>,
    payload: SchedulerConfigPayload,
) -> Result<SchedulerConfigPayload, String> {
    scheduler_service::update_scheduler_config(&ctx, payload).map_err(to_message)
}

#[tauri::command]
pub async fn get_runtime_coordination_config(
    ctx: State<'_, AppContext>,
) -> Result<RuntimeCoordinationConfigPayload, String> {
    ctx.runtime_coordination
        .get_config_payload()
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn update_runtime_coordination_config(
    ctx: State<'_, AppContext>,
    payload: RuntimeCoordinationConfigPayload,
) -> Result<RuntimeCoordinationConfigPayload, String> {
    ctx.runtime_coordination
        .update_config_payload(payload)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_upstream_network_config(
    ctx: State<'_, AppContext>,
) -> Result<UpstreamNetworkConfigPayload, String> {
    ctx.runtime_coordination
        .get_upstream_network_config_payload()
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn update_upstream_network_config(
    ctx: State<'_, AppContext>,
    payload: UpstreamNetworkConfigPayload,
) -> Result<UpstreamNetworkConfigPayload, String> {
    ctx.runtime_coordination
        .update_upstream_network_config_payload(payload)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub fn get_database_storage_status(
    ctx: State<'_, AppContext>,
) -> Result<DatabaseStorageStatus, String> {
    database_storage_service::get_database_storage_status(&ctx).map_err(to_message)
}

#[tauri::command]
pub fn migrate_database_storage(
    ctx: State<'_, AppContext>,
    payload: DatabaseStorageMigrationInput,
) -> Result<DatabaseStorageMigrationResult, String> {
    database_storage_service::migrate_database_storage(&ctx, payload).map_err(to_message)
}

fn to_message(error: anyhow::Error) -> String {
    error.to_string()
}

fn to_transport_error(error: anyhow::Error) -> TransportErrorPayload {
    site_failover_service::transport_error_payload(&error)
        .map(|(_, payload)| payload)
        .unwrap_or_else(|| TransportErrorPayload {
            error: error.to_string(),
            code: "internal_error".into(),
            http_status: None,
            retry_at: None,
            retry_after_ms: None,
        })
}

fn map_codex_radar_command_result<T>(result: anyhow::Result<T>) -> Result<T, String> {
    result.map_err(to_message)
}

#[cfg(test)]
mod tests {
    use super::{
        desktop_ui_prefs_require_floating_notification_reconfigure, map_codex_radar_command_result,
        to_transport_error,
    };
    use crate::application::site_failover_service::{SiteFailoverError, SiteFailoverErrorCode};
    use crate::contracts::{
        CodexRadarInsightsPayload, CodexRadarIntelligenceEfficiencyPoint,
        CodexRadarIntelligencePayload, CodexRadarModelIqEntry, CodexRadarModelIqPayload,
        DesktopUiPrefsPatch, FloatingNotificationDensity,
    };

    #[test]
    fn failover_error_maps_to_tauri_transport_payload() {
        let payload = to_transport_error(anyhow::Error::new(SiteFailoverError::for_test(
            SiteFailoverErrorCode::AllAddressesCooling,
            Some(1_700_000_000_000),
            Some(1_250),
        )));

        assert_eq!(payload.error, "所有站点地址都在冷却中。");
        assert_eq!(payload.code, "all_site_addresses_cooling");
        assert_eq!(payload.http_status, Some(503));
        assert_eq!(
            payload.retry_at.as_deref(),
            Some("2023-11-14T22:13:20.000Z")
        );
        assert_eq!(payload.retry_after_ms, Some(1_250));
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

    #[test]
    fn only_layout_fields_request_native_notification_reconfigure() {
        assert!(!desktop_ui_prefs_require_floating_notification_reconfigure(
            &DesktopUiPrefsPatch {
                theme: Some("arctic-relay".into()),
                floating_notification_duration_ms: Some(8_000),
                ..DesktopUiPrefsPatch::default()
            }
        ));
        assert!(desktop_ui_prefs_require_floating_notification_reconfigure(
            &DesktopUiPrefsPatch {
                floating_notification_density: Some(FloatingNotificationDensity::Compact),
                ..DesktopUiPrefsPatch::default()
            }
        ));
        assert!(desktop_ui_prefs_require_floating_notification_reconfigure(
            &DesktopUiPrefsPatch {
                floating_notification_max_visible: Some(4),
                ..DesktopUiPrefsPatch::default()
            }
        ));
    }

    #[test]
    fn codex_radar_commands_preserve_stale_payloads_and_first_failure_messages() {
        let model_payload = map_codex_radar_command_result(Ok(sample_model_iq_payload(
            true,
            Some("上游暂时不可用"),
        )))
        .expect("stale model IQ payload should remain a successful command result");
        assert_eq!(model_payload.items[0].reasoning_effort, "max");
        assert_eq!(model_payload.last_error.as_deref(), Some("上游暂时不可用"));
        assert!(model_payload.is_stale);

        let intelligence_payload = map_codex_radar_command_result(Ok(sample_intelligence_payload(
            true,
            Some("智力效率上游暂时不可用"),
        )))
        .expect("stale intelligence payload should remain a successful command result");
        assert_eq!(
            intelligence_payload.efficiency_points[0].average_minutes,
            Some(34.8)
        );
        assert_eq!(
            intelligence_payload.last_error.as_deref(),
            Some("智力效率上游暂时不可用")
        );
        assert!(intelligence_payload.is_stale);

        let insights_payload = map_codex_radar_command_result(Ok(CodexRadarInsightsPayload {
            recommendations: vec![],
            degradation_rule: "12 小时 IQ 下降达到上游门槛".into(),
            degradation_alerts: vec![],
            source_updated_at: "2026-07-29T20:38:00+08:00".into(),
            fetched_at: "2026-07-29 20:39:00".into(),
            last_error: Some("推荐预警上游暂时不可用".into()),
            is_stale: true,
        }))
        .expect("stale insights payload should remain a successful command result");
        assert_eq!(
            insights_payload.last_error.as_deref(),
            Some("推荐预警上游暂时不可用")
        );
        assert!(insights_payload.is_stale);

        let error = map_codex_radar_command_result::<CodexRadarModelIqPayload>(Err(
            anyhow::anyhow!("Codex Radar 暂时不可用"),
        ))
        .expect_err("first fetch failure must stay on the Tauri error channel");
        assert_eq!(error, "Codex Radar 暂时不可用");
    }
}
