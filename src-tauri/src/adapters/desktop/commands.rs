use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::application::{
    account_service, auth_service, dashboard_service, data_center_service, desktop_ui_service, keys_service,
    profile_service, scheduler_service, service_status_service, site_service, usage_service, AppContext,
};
use crate::contracts::{
    AccountRuntime, AppLaunchMode, DashboardModelsPayload, DailyUsagePoint, DesktopUiPrefs,
    DesktopUiPrefsPatch, GroupRecord, KeyMutationInput, KeyPatchInput, LoginFlowResult, ManagedKeyRecord,
    OpenMainWindowPayload, OverviewPayload, PaginatedResult,
    PlatformQuotaPayload, ProfileUpdateInput, ServiceStatusPayload, SiteRecord,
    SubscriptionSummaryPayload, SyncAccountDataInput, UsageRow, UsageStatsRecord, UsageTrendPayload, UserProfileRecord,
    AccountSyncStatusPayload, RefreshAccountTaskResponse, RefreshTriggerSource,
};

fn sync_keep_floating_panel_visible(app: &AppHandle, prefs: &DesktopUiPrefs) {
    let can_show_floating = prefs.launch_mode == AppLaunchMode::Floating || prefs.open_floating_in_main_mode;

    if prefs.keep_floating_panel_visible && can_show_floating {
        if let Some(window) = app.get_webview_window("floating-panel") {
            let _ = window.show();
        }
        let _ = app.emit_to(
            "floating",
            "floating-native-panel-visibility",
            serde_json::json!({ "visible": true }),
        );
        return;
    }

    if let Some(window) = app.get_webview_window("floating-panel") {
        let _ = window.hide();
    }
    let _ = app.emit_to(
        "floating",
        "floating-native-panel-visibility",
        serde_json::json!({ "visible": false }),
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
/// 幂等，HMR 重放安全；3 秒未收到时由 Rust 侧兜底强制显示。
#[tauri::command]
pub fn frontend_ready(app: AppHandle) {
    crate::reveal_main_window_on_frontend_ready(&app);
}

#[tauri::command]
pub fn get_overview(ctx: State<'_, AppContext>) -> Result<OverviewPayload, String> {
    dashboard_service::get_overview(&ctx).map_err(to_message)
}

#[tauri::command]
pub async fn get_service_status() -> Result<ServiceStatusPayload, String> {
    service_status_service::get_service_status()
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
    let prefs = desktop_ui_service::update_desktop_ui_prefs(&ctx, payload).map_err(to_message)?;
    sync_keep_floating_panel_visible(&app, &prefs);
    let _ = app.emit("desktop-ui-prefs-updated", &prefs);
    Ok(prefs)
}

#[tauri::command]
pub fn switch_app_mode(
    app: AppHandle,
    ctx: State<'_, AppContext>,
    launch_mode: AppLaunchMode,
) -> Result<DesktopUiPrefs, String> {
    let prefs = desktop_ui_service::set_launch_mode(&ctx, launch_mode.clone()).map_err(to_message)?;
    let main = app.get_webview_window("main");
    let floating = app.get_webview_window("floating");
    let floating_panel = app.get_webview_window("floating-panel");
    match launch_mode {
        AppLaunchMode::Main => {
            crate::mark_main_window_revealed();
            if let Some(window) = &main {
                let _ = window.show();
                let _ = window.set_focus();
            }
            if prefs.open_floating_in_main_mode {
                if let Some(window) = &floating {
                    let _ = window.show();
                }
            } else {
                if let Some(window) = &floating {
                    let _ = window.hide();
                }
                if let Some(window) = &floating_panel {
                    let _ = window.hide();
                }
            }
        }
        AppLaunchMode::Floating => {
            if let Some(window) = &main {
                let _ = window.hide();
            }
            if let Some(window) = &floating {
                let _ = window.show();
                let _ = window.set_focus();
            }
            if let Some(window) = &floating_panel {
                let _ = window.hide();
            }
        }
    }
    sync_keep_floating_panel_visible(&app, &prefs);
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

    if let Some(window) = app.get_webview_window("floating") {
        if visible {
            let _ = window.show();
            let _ = window.set_focus();
        } else {
            let _ = window.hide();
        }
    }
    if let Some(window) = app.get_webview_window("floating-panel") {
        let _ = window.hide();
    }

    sync_keep_floating_panel_visible(&app, &prefs);
    let _ = app.emit("desktop-ui-prefs-updated", &prefs);
    Ok(prefs)
}

#[tauri::command]
pub fn set_floating_panel_visible(app: AppHandle, visible: bool) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("floating-panel") {
        if visible {
            let _ = window.show();
        } else {
            let _ = window.hide();
        }
    }
    Ok(true)
}

#[tauri::command]
pub fn position_floating_panel(
    app: AppHandle,
    payload: FloatingPanelPositionPayload,
) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("floating-panel") {
        let _ = window.set_position(tauri::LogicalPosition::new(payload.x as f64, payload.y as f64));
    }
    Ok(true)
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
    let menu = Menu::with_items(&app, &[&toggle, &open_main, &quit]).map_err(|error| error.to_string())?;

    if let Some(position) = payload.and_then(|value| match (value.x, value.y) {
        (Some(x), Some(y)) => Some(LogicalPosition::new(x, y)),
        _ => None,
    }) {
        window.popup_menu_at(&menu, position).map_err(|error| error.to_string())?;
    } else {
        window.popup_menu(&menu).map_err(|error| error.to_string())?;
    }

    Ok(true)
}

#[tauri::command]
pub fn open_main_window(
    app: AppHandle,
    ctx: State<'_, AppContext>,
    payload: Option<OpenMainWindowPayload>,
) -> Result<DesktopUiPrefs, String> {
    let prefs = desktop_ui_service::set_launch_mode(&ctx, AppLaunchMode::Main).map_err(to_message)?;
    crate::mark_main_window_revealed();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        if let Some(next) = payload.as_ref().and_then(|item| item.nav.clone()) {
            let _ = window.emit("open-nav", next);
        }
    }
    if prefs.open_floating_in_main_mode {
        if let Some(window) = app.get_webview_window("floating") {
            let _ = window.show();
        }
    }
    if let Some(window) = app.get_webview_window("floating-panel") {
        let _ = window.hide();
    }
    sync_keep_floating_panel_visible(&app, &prefs);
    let _ = app.emit("desktop-ui-prefs-updated", &prefs);
    Ok(prefs)
}

#[tauri::command]
pub fn quit_application(app: AppHandle) -> Result<bool, String> {
    app.exit(0);
    Ok(true)
}

#[tauri::command]
pub fn create_site(ctx: State<'_, AppContext>, payload: crate::contracts::SiteInput) -> Result<SiteRecord, String> {
    site_service::create_site(&ctx, payload).map_err(to_message)
}

#[tauri::command]
pub fn update_site(
    ctx: State<'_, AppContext>,
    site_id: String,
    name: Option<String>,
    base_url: Option<String>,
) -> Result<SiteRecord, String> {
    site_service::update_site(&ctx, &site_id, name, base_url).map_err(to_message)
}

#[tauri::command]
pub fn remove_site(ctx: State<'_, AppContext>, site_id: String) -> Result<bool, String> {
    site_service::remove_site(&ctx, &site_id).map_err(to_message)
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
    account_service::update_account(&ctx, &account_id, label, email, balance_warning).map_err(to_message)
}

#[tauri::command]
pub fn remove_account(ctx: State<'_, AppContext>, account_id: String) -> Result<bool, String> {
    account_service::remove_account(&ctx, &account_id).map_err(to_message)
}

#[tauri::command]
pub async fn login_account(
    ctx: State<'_, AppContext>,
    account_id: String,
    password: String,
) -> Result<LoginFlowResult, String> {
    auth_service::login_account(&ctx, &account_id, &password)
        .await
        .map_err(to_message)
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
) -> Result<AccountRuntime, String> {
    auth_service::login_account_2fa(&ctx, &account_id, &temp_token, &code)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn sync_all_accounts(
    ctx: State<'_, AppContext>,
    payload: SyncAccountDataInput,
) -> Result<OverviewPayload, String> {
    data_center_service::sync_all_accounts(&ctx, payload)
        .await
        .and_then(|_| dashboard_service::get_overview(&ctx))
        .map_err(to_message)
}

#[tauri::command]
pub async fn refresh_account(
    ctx: State<'_, AppContext>,
    account_id: String,
    trigger_source: Option<RefreshTriggerSource>,
) -> Result<RefreshAccountTaskResponse, String> {
    data_center_service::refresh_account(
        &ctx,
        &account_id,
        trigger_source.unwrap_or(RefreshTriggerSource::Manual),
    )
    .await
    .map_err(to_message)
}

#[tauri::command]
pub async fn refresh_all_accounts(ctx: State<'_, AppContext>) -> Result<OverviewPayload, String> {
    data_center_service::refresh_all_accounts(&ctx)
        .await
        .and_then(|_| dashboard_service::get_overview(&ctx))
        .map_err(to_message)
}

#[tauri::command]
pub async fn sync_account_data(
    ctx: State<'_, AppContext>,
    account_id: String,
    payload: SyncAccountDataInput,
) -> Result<AccountSyncStatusPayload, String> {
    data_center_service::sync_account_data(&ctx, &account_id, payload)
        .await
        .map(|result| result.status)
        .map_err(to_message)
}

#[tauri::command]
pub fn get_account_sync_status(
    ctx: State<'_, AppContext>,
    account_id: String,
) -> Result<AccountSyncStatusPayload, String> {
    data_center_service::get_account_sync_status(&ctx, &account_id).map_err(to_message)
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
) -> Result<PaginatedResult<ManagedKeyRecord>, String> {
    keys_service::list_managed_keys(&ctx, &account_id, page.unwrap_or(1), page_size.unwrap_or(20))
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
    page: Option<i64>,
    page_size: Option<i64>,
    api_key_id: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<PaginatedResult<UsageRow>, String> {
    usage_service::list_usage_records(
        &ctx,
        &account_id,
        usage_service::UsageListQuery {
            page: page.unwrap_or(1),
            page_size: page_size.unwrap_or(20),
            api_key_id,
            start_date,
            end_date,
        },
    )
    .await
    .map_err(to_message)
}

#[tauri::command]
pub async fn get_usage_stats(
    ctx: State<'_, AppContext>,
    account_id: String,
    period: Option<String>,
    api_key_id: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<UsageStatsRecord, String> {
    usage_service::get_usage_stats(
        &ctx,
        &account_id,
        usage_service::UsageStatsQuery {
            period,
            api_key_id,
            start_date,
            end_date,
        },
    )
    .await
    .map_err(to_message)
}

#[tauri::command]
pub async fn get_dashboard_models(
    ctx: State<'_, AppContext>,
    account_id: String,
    days: Option<i64>,
    api_key_id: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<DashboardModelsPayload, String> {
    usage_service::get_dashboard_models(
        &ctx,
        &account_id,
        usage_service::UsageStatsQuery {
            period: Some(format!("days:{}", days.unwrap_or(7))),
            api_key_id,
            start_date,
            end_date,
        },
    )
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn get_dashboard_trend(
    ctx: State<'_, AppContext>,
    account_id: String,
    days: Option<i64>,
    api_key_id: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<UsageTrendPayload, String> {
    usage_service::get_dashboard_trend(
        &ctx,
        &account_id,
        usage_service::UsageStatsQuery {
            period: Some(format!("days:{}", days.unwrap_or(7))),
            api_key_id,
            start_date,
            end_date,
        },
    )
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
pub async fn get_profile_record(
    ctx: State<'_, AppContext>,
    account_id: String,
) -> Result<UserProfileRecord, String> {
    profile_service::get_profile_record(&ctx, &account_id)
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
    email: String,
    code: String,
) -> Result<bool, String> {
    profile_service::bind_email_identity(&ctx, &account_id, &email, &code)
        .await
        .map_err(to_message)
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

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerConfigPayload {
    pub enabled: bool,
    pub interval_seconds: u64,
}

#[tauri::command]
pub fn get_scheduler_config(ctx: State<'_, AppContext>) -> Result<SchedulerConfigPayload, String> {
    Ok(SchedulerConfigPayload {
        enabled: scheduler_service::is_scheduler_enabled(&ctx),
        interval_seconds: scheduler_service::get_scheduler_interval(&ctx),
    })
}

#[tauri::command]
pub fn update_scheduler_config(
    ctx: State<'_, AppContext>,
    payload: SchedulerConfigPayload,
) -> Result<SchedulerConfigPayload, String> {
    scheduler_service::set_scheduler_enabled(&ctx, payload.enabled).map_err(to_message)?;
    scheduler_service::set_scheduler_interval(&ctx, payload.interval_seconds).map_err(to_message)?;
    get_scheduler_config(ctx)
}

fn to_message(error: anyhow::Error) -> String {
    error.to_string()
}

