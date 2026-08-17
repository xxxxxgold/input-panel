use anyhow::{Context, Result};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
#[cfg(not(target_os = "windows"))]
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Notify;
use uuid::Uuid;

use crate::contracts::{
    DesktopUiPrefs, ServiceStatusMonitorNotificationEvent, ServiceStatusMonitorNotificationKind,
    ServiceStatusMonitorNotificationSeverity, ServiceStatusMonitorSnapshotEvent,
    ServiceStatusPayload, ServiceStatusServiceRecord,
};
use crate::infrastructure::sqlite::repositories;
use crate::infrastructure::upstream_http_client::upstream_http_client_builder;

use super::{desktop_ui_service, AppContext};

const STATUS_ENDPOINT: &str = "https://status.input.im/api/status";
const MONITOR_STATE_KEY: &str = "service_status_monitor_state";
const MONITOR_STATE_VERSION: i64 = 1;
const DISABLED_RECHECK_SECONDS: u64 = 60;
const SETTINGS_RETRY_SECONDS: u64 = 5;
const MAIN_SNAPSHOT_EVENT: &str = "service-status-monitor-snapshot";
const MAIN_NOTIFICATION_EVENT: &str = "service-status-monitor-notification";

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct MonitoredModelState {
    available: bool,
    last_probe_ts: i64,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct ServiceStatusMonitorState {
    version: i64,
    monitoring_enabled: bool,
    models: BTreeMap<String, MonitoredModelState>,
    request_failure_started_at_epoch_ms: Option<i64>,
    last_success_at_epoch_ms: Option<i64>,
}

impl Default for ServiceStatusMonitorState {
    fn default() -> Self {
        Self {
            version: MONITOR_STATE_VERSION,
            monitoring_enabled: false,
            models: BTreeMap::new(),
            request_failure_started_at_epoch_ms: None,
            last_success_at_epoch_ms: None,
        }
    }
}

/// 运行于 Tauri async runtime 的服务状态监控器，不依赖任何 WebView 可见性。
pub struct ServiceStatusMonitor {
    running: Arc<AtomicBool>,
    wake: Arc<Notify>,
}

impl ServiceStatusMonitor {
    /// 启动唯一的桌面服务状态监控循环。
    pub fn start(ctx: AppContext, app: AppHandle) -> Self {
        let running = Arc::new(AtomicBool::new(true));
        let wake = Arc::new(Notify::new());
        let running_for_task = Arc::clone(&running);
        let wake_for_task = Arc::clone(&wake);

        tauri::async_runtime::spawn(async move {
            run_monitor_loop(ctx, app, running_for_task, wake_for_task).await;
        });

        Self { running, wake }
    }

    /// 偏好开关或间隔变化后立即唤醒循环重新求值。
    pub fn wake(&self) {
        self.wake.notify_one();
    }
}

impl Drop for ServiceStatusMonitor {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Release);
        self.wake.notify_one();
    }
}

/// 读取一次上游公共服务状态，保留现有超时与单次重试语义。
pub async fn get_service_status(ctx: &AppContext) -> Result<ServiceStatusPayload> {
    let use_system_proxy = ctx
        .runtime_coordination
        .get_upstream_network_config()
        .await?
        .use_system_proxy;
    let client = upstream_http_client_builder(use_system_proxy)
        .timeout(Duration::from_secs(10))
        .build()
        .context("初始化服务状态请求客户端失败")?;

    let fetch = || async {
        let response = client
            .get(STATUS_ENDPOINT)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .context("请求 status.input.im 服务状态失败")?
            .error_for_status()
            .context("服务状态接口返回失败状态")?;

        let raw = response.text().await.context("读取服务状态响应正文失败")?;

        serde_json::from_str::<ServiceStatusPayload>(&raw)
            .map_err(|error| anyhow::anyhow!("解析服务状态返回失败: {error}"))
    };

    match fetch().await {
        Ok(payload) => Ok(payload),
        Err(error) => {
            tokio::time::sleep(Duration::from_secs(1)).await;
            fetch()
                .await
                .map_err(|retry_error| anyhow::anyhow!("{error}; 重试后: {retry_error}"))
        }
    }
}

async fn run_monitor_loop(
    ctx: AppContext,
    app: AppHandle,
    running: Arc<AtomicBool>,
    wake: Arc<Notify>,
) {
    let mut state = load_monitor_state(&ctx);
    let mut wait_duration = Duration::ZERO;

    loop {
        if !wait_duration.is_zero() {
            tokio::select! {
                _ = tokio::time::sleep(wait_duration) => {}
                _ = wake.notified() => {}
            }
        }
        if !running.load(Ordering::Acquire) {
            break;
        }
        if database_restart_stops_monitor(&ctx) {
            break;
        }

        let prefs = match desktop_ui_service::get_desktop_ui_prefs(&ctx) {
            Ok(prefs) => prefs,
            Err(error) => {
                log::warn!("[service-status-monitor] 读取桌面偏好失败，将重试: {error}");
                wait_duration = Duration::from_secs(SETTINGS_RETRY_SECONDS);
                continue;
            }
        };

        if !is_monitor_enabled(&prefs) {
            if state != ServiceStatusMonitorState::default() {
                state = ServiceStatusMonitorState::default();
                if let Err(error) = persist_monitor_state(&ctx, &state) {
                    log::warn!("[service-status-monitor] 保存禁用状态失败: {error}");
                }
            }
            wait_duration = Duration::from_secs(DISABLED_RECHECK_SECONDS);
            continue;
        }

        if !state.monitoring_enabled {
            state = ServiceStatusMonitorState {
                monitoring_enabled: true,
                ..ServiceStatusMonitorState::default()
            };
            log::info!("[service-status-monitor] 后台监控已启用");
        }

        let synced_at_epoch_ms = Utc::now().timestamp_millis();
        let created_at = current_event_timestamp();
        match get_service_status(&ctx).await {
            Ok(payload) => {
                let (next_state, events) =
                    reduce_successful_snapshot(&state, &payload, synced_at_epoch_ms, &created_at);
                state = next_state;
                if let Err(error) = persist_monitor_state(&ctx, &state) {
                    log::warn!("[service-status-monitor] 保存成功快照基线失败: {error}");
                }
                emit_snapshot(&app, payload, synced_at_epoch_ms);
                for event in events {
                    dispatch_monitor_event(&app, event);
                }
            }
            Err(error) => {
                let (next_state, event) =
                    reduce_request_failure(&state, synced_at_epoch_ms, &created_at);
                state = next_state;
                if let Err(persist_error) = persist_monitor_state(&ctx, &state) {
                    log::warn!("[service-status-monitor] 保存请求失败基线失败: {persist_error}");
                }
                log::warn!("[service-status-monitor] 服务状态同步失败: {error}");
                if let Some(event) = event {
                    dispatch_monitor_event(&app, event);
                }
            }
        }

        wait_duration = Duration::from_secs(monitor_interval_seconds(&prefs));
    }

    log::info!("[service-status-monitor] 后台监控已停止");
}

fn database_restart_stops_monitor(ctx: &AppContext) -> bool {
    match ctx.db.restart_required() {
        Ok(restart_required) => restart_required,
        Err(error) => {
            log::error!("[service-status-monitor] 无法读取数据库迁移状态，停止后续监控: {error}");
            true
        }
    }
}

fn is_monitor_enabled(prefs: &DesktopUiPrefs) -> bool {
    prefs.auto_refresh_enabled && prefs.auto_refresh_service_status_enabled
}

fn monitor_interval_seconds(prefs: &DesktopUiPrefs) -> u64 {
    u64::try_from(prefs.auto_refresh_interval_seconds)
        .unwrap_or(1)
        .max(1)
}

fn load_monitor_state(ctx: &AppContext) -> ServiceStatusMonitorState {
    let raw = match repositories::get_setting(&ctx.db, MONITOR_STATE_KEY) {
        Ok(Some(raw)) => raw,
        Ok(None) => return ServiceStatusMonitorState::default(),
        Err(error) => {
            log::warn!("[service-status-monitor] 读取持久基线失败，将从空基线启动: {error}");
            return ServiceStatusMonitorState::default();
        }
    };

    match serde_json::from_str::<ServiceStatusMonitorState>(&raw) {
        Ok(state) if state.version == MONITOR_STATE_VERSION => state,
        Ok(_) => {
            log::warn!("[service-status-monitor] 持久基线版本不兼容，将重新建立基线");
            ServiceStatusMonitorState::default()
        }
        Err(error) => {
            log::warn!("[service-status-monitor] 持久基线解析失败，将重新建立基线: {error}");
            ServiceStatusMonitorState::default()
        }
    }
}

fn persist_monitor_state(ctx: &AppContext, state: &ServiceStatusMonitorState) -> Result<()> {
    let value = serde_json::to_string(state).context("序列化服务状态监控基线失败")?;
    repositories::set_setting(&ctx.db, MONITOR_STATE_KEY, &value)
        .context("写入服务状态监控基线失败")
}

fn reduce_successful_snapshot(
    previous: &ServiceStatusMonitorState,
    payload: &ServiceStatusPayload,
    synced_at_epoch_ms: i64,
    created_at: &str,
) -> (
    ServiceStatusMonitorState,
    Vec<ServiceStatusMonitorNotificationEvent>,
) {
    let current_models = collect_model_states(payload);
    let mut events = Vec::new();

    if previous.request_failure_started_at_epoch_ms.is_some() {
        events.push(build_monitor_recovered_event(
            synced_at_epoch_ms,
            created_at,
        ));
    }

    for (model, current) in &current_models {
        match previous.models.get(model) {
            None if !current.available => {
                events.push(build_model_down_event(model, current, created_at));
            }
            Some(prior) if prior.available && !current.available => {
                events.push(build_model_down_event(model, current, created_at));
            }
            Some(prior) if !prior.available && current.available => {
                events.push(build_model_recovered_event(model, current, created_at));
            }
            _ => {}
        }
    }

    if payload.all_ok {
        for (model, prior) in &previous.models {
            if !prior.available && !current_models.contains_key(model) {
                events.push(build_model_recovered_event(
                    model,
                    &MonitoredModelState {
                        available: true,
                        last_probe_ts: payload.generated_at,
                        last_error: None,
                    },
                    created_at,
                ));
            }
        }
    }

    (
        ServiceStatusMonitorState {
            version: MONITOR_STATE_VERSION,
            monitoring_enabled: true,
            models: current_models,
            request_failure_started_at_epoch_ms: None,
            last_success_at_epoch_ms: Some(synced_at_epoch_ms),
        },
        events,
    )
}

fn reduce_request_failure(
    previous: &ServiceStatusMonitorState,
    failed_at_epoch_ms: i64,
    created_at: &str,
) -> (
    ServiceStatusMonitorState,
    Option<ServiceStatusMonitorNotificationEvent>,
) {
    if previous.request_failure_started_at_epoch_ms.is_some() {
        return (previous.clone(), None);
    }

    let mut next = previous.clone();
    next.version = MONITOR_STATE_VERSION;
    next.monitoring_enabled = true;
    next.request_failure_started_at_epoch_ms = Some(failed_at_epoch_ms);
    (
        next,
        Some(build_monitor_unavailable_event(
            failed_at_epoch_ms,
            created_at,
        )),
    )
}

fn collect_model_states(payload: &ServiceStatusPayload) -> BTreeMap<String, MonitoredModelState> {
    payload
        .services
        .iter()
        .map(|service| {
            (
                service.model.clone(),
                model_state_from_service(service, payload.generated_at),
            )
        })
        .collect()
}

fn model_state_from_service(
    service: &ServiceStatusServiceRecord,
    generated_at: i64,
) -> MonitoredModelState {
    MonitoredModelState {
        available: service.last.as_ref().is_some_and(|probe| probe.ok),
        last_probe_ts: service.last.as_ref().map_or(generated_at, |probe| probe.ts),
        last_error: service
            .last
            .as_ref()
            .and_then(|probe| normalize_failure_reason(probe.error.as_deref())),
    }
}

fn build_model_down_event(
    model: &str,
    state: &MonitoredModelState,
    created_at: &str,
) -> ServiceStatusMonitorNotificationEvent {
    let detail = state
        .last_error
        .as_deref()
        .map(|reason| format!("{model} 当前无法使用: {reason}"))
        .unwrap_or_else(|| format!("{model} 当前无法使用，请打开服务状态查看详情。"));
    ServiceStatusMonitorNotificationEvent {
        id: Uuid::new_v4().to_string(),
        kind: ServiceStatusMonitorNotificationKind::ModelDown,
        severity: ServiceStatusMonitorNotificationSeverity::Critical,
        title: format!("{model} 服务不可用"),
        detail,
        created_at: created_at.to_string(),
        dedupe_key: format!("service-status:model-down:{model}:{}", state.last_probe_ts),
        models: vec![model.to_string()],
    }
}

fn build_model_recovered_event(
    model: &str,
    state: &MonitoredModelState,
    created_at: &str,
) -> ServiceStatusMonitorNotificationEvent {
    ServiceStatusMonitorNotificationEvent {
        id: Uuid::new_v4().to_string(),
        kind: ServiceStatusMonitorNotificationKind::ModelRecovered,
        severity: ServiceStatusMonitorNotificationSeverity::Success,
        title: format!("{model} 服务已恢复"),
        detail: format!("{model} 当前已恢复正常。"),
        created_at: created_at.to_string(),
        dedupe_key: format!(
            "service-status:model-recovered:{model}:{}",
            state.last_probe_ts
        ),
        models: vec![model.to_string()],
    }
}

fn build_monitor_unavailable_event(
    failed_at_epoch_ms: i64,
    created_at: &str,
) -> ServiceStatusMonitorNotificationEvent {
    ServiceStatusMonitorNotificationEvent {
        id: Uuid::new_v4().to_string(),
        kind: ServiceStatusMonitorNotificationKind::MonitorUnavailable,
        severity: ServiceStatusMonitorNotificationSeverity::Critical,
        title: "模型状态监控暂时不可用".into(),
        detail: "无法读取 Input 服务状态，后台监控将按配置间隔继续重试。".into(),
        created_at: created_at.to_string(),
        dedupe_key: format!("service-status:monitor-unavailable:{failed_at_epoch_ms}"),
        models: Vec::new(),
    }
}

fn build_monitor_recovered_event(
    recovered_at_epoch_ms: i64,
    created_at: &str,
) -> ServiceStatusMonitorNotificationEvent {
    ServiceStatusMonitorNotificationEvent {
        id: Uuid::new_v4().to_string(),
        kind: ServiceStatusMonitorNotificationKind::MonitorRecovered,
        severity: ServiceStatusMonitorNotificationSeverity::Success,
        title: "模型状态监控已恢复".into(),
        detail: "Input 服务状态读取已恢复，后台监控正在正常运行。".into(),
        created_at: created_at.to_string(),
        dedupe_key: format!("service-status:monitor-recovered:{recovered_at_epoch_ms}"),
        models: Vec::new(),
    }
}

fn emit_snapshot(app: &AppHandle, status: ServiceStatusPayload, synced_at_epoch_ms: i64) {
    let event = ServiceStatusMonitorSnapshotEvent {
        status,
        synced_at_epoch_ms,
    };
    if let Err(error) = app.emit_to(crate::MAIN_WINDOW_LABEL, MAIN_SNAPSHOT_EVENT, event) {
        log::warn!("[service-status-monitor] 推送主窗口状态快照失败: {error}");
    }
}

fn dispatch_monitor_event(app: &AppHandle, event: ServiceStatusMonitorNotificationEvent) {
    let floating_payload = crate::FloatingNotificationPayload {
        id: event.id.clone(),
        dedupe_key: event.dedupe_key.clone(),
        channel: crate::FloatingNotificationChannel::Business,
        title: event.title.clone(),
        level: notification_level(event.severity).into(),
        source: "service-status".into(),
        created_at: event.created_at.clone(),
        content: event.detail.clone(),
        account: None,
        site: None,
        model: (!event.models.is_empty()).then(|| crate::FloatingNotificationReference {
            id: None,
            label: event.models.join(", "),
        }),
        usage: None,
    };
    if let Err(error) = crate::enqueue_floating_notification(app, floating_payload) {
        log::warn!("[service-status-monitor] 投递悬浮通知失败: {error}");
    }

    #[cfg(target_os = "windows")]
    let system_notification_result =
        crate::application::desktop_ui_service::show_windows_notification_with_sound(
            app,
            &event.title,
            &event.detail,
            crate::infrastructure::windows_notification::NativeNotificationNavigation::ServiceStatus,
        );
    #[cfg(not(target_os = "windows"))]
    let system_notification_result = app
        .notification()
        .builder()
        .title(event.title.clone())
        .body(event.detail.clone())
        .show()
        .map_err(anyhow::Error::from);
    if let Err(error) = system_notification_result {
        log::warn!("[service-status-monitor] 投递系统通知失败: {error}");
    }

    if let Err(error) = app.emit_to(
        crate::MAIN_WINDOW_LABEL,
        MAIN_NOTIFICATION_EVENT,
        event.clone(),
    ) {
        log::warn!("[service-status-monitor] 推送主窗口通知事件失败: {error}");
    }

    let toast_payload = serde_json::json!({
        "tone": if event.severity == ServiceStatusMonitorNotificationSeverity::Critical {
            "error"
        } else {
            "success"
        },
        "message": event.detail,
        "durationMs": if event.severity == ServiceStatusMonitorNotificationSeverity::Critical {
            8_000
        } else {
            5_000
        }
    });
    let _ = app.emit_to(
        crate::FLOATING_PANEL_WINDOW_LABEL,
        "floating-panel-toast",
        toast_payload,
    );
}

fn notification_level(severity: ServiceStatusMonitorNotificationSeverity) -> &'static str {
    match severity {
        ServiceStatusMonitorNotificationSeverity::Critical => "critical",
        ServiceStatusMonitorNotificationSeverity::Success => "success",
    }
}

fn normalize_failure_reason(reason: Option<&str>) -> Option<String> {
    reason
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn current_event_timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::{
        is_monitor_enabled, reduce_request_failure, reduce_successful_snapshot,
        ServiceStatusMonitorState,
    };
    use crate::contracts::{
        DesktopUiPrefs, ServiceStatusMonitorNotificationKind, ServiceStatusPayload,
        ServiceStatusProbeRecord, ServiceStatusServiceRecord,
    };

    fn service(model: &str, ok: bool, ts: i64, error: Option<&str>) -> ServiceStatusServiceRecord {
        ServiceStatusServiceRecord {
            model: model.into(),
            uptime_pct: if ok { 100.0 } else { 99.0 },
            last: Some(ServiceStatusProbeRecord {
                ts,
                ok,
                latency_ms: ok.then_some(1200),
                error: error.map(str::to_string),
            }),
            history: Vec::new(),
        }
    }

    fn payload(services: Vec<ServiceStatusServiceRecord>) -> ServiceStatusPayload {
        ServiceStatusPayload {
            all_ok: services
                .iter()
                .all(|service| service.last.as_ref().is_some_and(|probe| probe.ok)),
            generated_at: services
                .iter()
                .filter_map(|service| service.last.as_ref().map(|probe| probe.ts))
                .max()
                .unwrap_or_default(),
            services,
        }
    }

    #[test]
    fn initial_unavailable_model_notifies_once_and_survives_restart() {
        let initial = payload(vec![service("gpt-5.6-sol", false, 100, Some("timeout"))]);
        let (state, events) = reduce_successful_snapshot(
            &ServiceStatusMonitorState::default(),
            &initial,
            1_000,
            "2026-08-01T00:00:00.000Z",
        );

        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].kind,
            ServiceStatusMonitorNotificationKind::ModelDown
        );
        assert_eq!(events[0].models, ["gpt-5.6-sol"]);

        let persisted = serde_json::to_string(&state).expect("serialize monitor state");
        let restored = serde_json::from_str(&persisted).expect("restore monitor state");
        let (_, repeated) =
            reduce_successful_snapshot(&restored, &initial, 2_000, "2026-08-01T00:00:01.000Z");
        assert!(repeated.is_empty());
    }

    #[test]
    fn tracks_each_model_while_the_overall_status_stays_degraded() {
        let first = payload(vec![
            service("model-a", false, 100, Some("timeout")),
            service("model-b", true, 100, None),
        ]);
        let (first_state, first_events) = reduce_successful_snapshot(
            &ServiceStatusMonitorState::default(),
            &first,
            1_000,
            "2026-08-01T00:00:00.000Z",
        );
        assert_eq!(first_events.len(), 1);

        let second = payload(vec![
            service("model-a", false, 100, Some("timeout")),
            service("model-b", false, 200, Some("502")),
        ]);
        let (second_state, second_events) =
            reduce_successful_snapshot(&first_state, &second, 2_000, "2026-08-01T00:00:01.000Z");
        assert_eq!(second_events.len(), 1);
        assert_eq!(
            second_events[0].kind,
            ServiceStatusMonitorNotificationKind::ModelDown
        );
        assert_eq!(second_events[0].models, ["model-b"]);

        let third = payload(vec![
            service("model-a", true, 300, None),
            service("model-b", false, 200, Some("502")),
        ]);
        let (_, third_events) =
            reduce_successful_snapshot(&second_state, &third, 3_000, "2026-08-01T00:00:02.000Z");
        assert_eq!(third_events.len(), 1);
        assert_eq!(
            third_events[0].kind,
            ServiceStatusMonitorNotificationKind::ModelRecovered
        );
        assert_eq!(third_events[0].models, ["model-a"]);
    }

    #[test]
    fn all_ok_snapshot_recovers_a_previously_failed_model_that_disappears() {
        let failed = payload(vec![service("model-a", false, 100, Some("timeout"))]);
        let (failed_state, _) = reduce_successful_snapshot(
            &ServiceStatusMonitorState::default(),
            &failed,
            1_000,
            "2026-08-01T00:00:00.000Z",
        );
        let healthy_without_models = ServiceStatusPayload {
            all_ok: true,
            generated_at: 200,
            services: Vec::new(),
        };

        let (_, events) = reduce_successful_snapshot(
            &failed_state,
            &healthy_without_models,
            2_000,
            "2026-08-01T00:00:01.000Z",
        );

        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].kind,
            ServiceStatusMonitorNotificationKind::ModelRecovered
        );
        assert_eq!(events[0].models, ["model-a"]);
    }

    #[test]
    fn request_failure_and_recovery_are_each_notified_once() {
        let (failed_state, first_failure) = reduce_request_failure(
            &ServiceStatusMonitorState::default(),
            1_000,
            "2026-08-01T00:00:00.000Z",
        );
        let first_failure = first_failure.expect("first failure event");
        assert_eq!(
            first_failure.kind,
            ServiceStatusMonitorNotificationKind::MonitorUnavailable
        );
        assert_eq!(
            first_failure.detail,
            "无法读取 Input 服务状态，后台监控将按配置间隔继续重试。"
        );

        let (still_failed, repeated_failure) =
            reduce_request_failure(&failed_state, 2_000, "2026-08-01T00:00:01.000Z");
        assert!(repeated_failure.is_none());

        let healthy = payload(vec![service("model-a", true, 300, None)]);
        let (recovered_state, recovery_events) =
            reduce_successful_snapshot(&still_failed, &healthy, 3_000, "2026-08-01T00:00:02.000Z");
        assert_eq!(recovery_events.len(), 1);
        assert_eq!(
            recovery_events[0].kind,
            ServiceStatusMonitorNotificationKind::MonitorRecovered
        );
        assert_eq!(
            recovery_events[0].detail,
            "Input 服务状态读取已恢复，后台监控正在正常运行。"
        );

        let (_, stable_events) = reduce_successful_snapshot(
            &recovered_state,
            &healthy,
            4_000,
            "2026-08-01T00:00:03.000Z",
        );
        assert!(stable_events.is_empty());
    }

    #[test]
    fn both_refresh_switches_control_native_monitoring() {
        let defaults = DesktopUiPrefs::default();
        assert!(is_monitor_enabled(&defaults));
        assert!(!is_monitor_enabled(&DesktopUiPrefs {
            auto_refresh_enabled: false,
            ..defaults.clone()
        }));
        assert!(!is_monitor_enabled(&DesktopUiPrefs {
            auto_refresh_service_status_enabled: false,
            ..defaults
        }));
    }
}
