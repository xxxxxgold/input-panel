use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_window_state::{AppHandleExt as _, StateFlags, WindowExt as _};

pub mod adapters;
pub mod application;
pub mod contracts;
pub mod domain;
pub mod infrastructure;

#[cfg(test)]
mod test_support;

const MAIN_WINDOW_LABEL: &str = "main";
const FLOATING_WINDOW_LABEL: &str = "floating";
const FLOATING_PANEL_WINDOW_LABEL: &str = "floating-panel";
const FLOATING_NOTIFICATION_WINDOW_LABEL: &str = "floating-notification";
const FLOATING_ORB_SIZE: f64 = 60.0;
// (y, left, right) runs exported from floating-orb-avatar.png after its 64-alpha cutoff.
const FLOATING_ORB_ALPHA_REGION_RUNS: &[(i32, i32, i32)] = &[
    (0, 18, 44),
    (1, 17, 46),
    (2, 15, 47),
    (3, 15, 47),
    (4, 14, 48),
    (5, 14, 48),
    (6, 13, 49),
    (7, 13, 49),
    (8, 12, 49),
    (9, 12, 49),
    (10, 12, 50),
    (11, 12, 50),
    (12, 11, 50),
    (13, 11, 50),
    (14, 12, 51),
    (15, 12, 52),
    (16, 12, 52),
    (17, 12, 52),
    (18, 12, 52),
    (19, 12, 52),
    (20, 13, 52),
    (21, 13, 52),
    (22, 13, 53),
    (23, 14, 52),
    (24, 15, 52),
    (25, 15, 52),
    (26, 16, 52),
    (27, 16, 52),
    (28, 16, 52),
    (29, 17, 52),
    (30, 17, 52),
    (31, 17, 52),
    (32, 17, 55),
    (33, 18, 57),
    (34, 18, 57),
    (35, 18, 58),
    (36, 19, 58),
    (37, 19, 59),
    (38, 20, 59),
    (39, 20, 60),
    (40, 20, 60),
    (41, 20, 60),
    (42, 20, 60),
    (43, 20, 60),
    (44, 20, 60),
    (45, 19, 60),
    (46, 19, 60),
    (47, 18, 60),
    (48, 18, 60),
    (49, 18, 60),
    (50, 18, 60),
    (51, 18, 60),
    (52, 18, 60),
    (53, 18, 60),
    (54, 18, 60),
    (55, 18, 60),
    (56, 17, 60),
    (57, 16, 60),
    (58, 15, 60),
    (59, 14, 60),
];
const FLOATING_PANEL_WIDTH: f64 = 392.0;
const FLOATING_PANEL_HEIGHT: f64 = 456.0;
const FLOATING_PANEL_SYNC_REPLAY_DELAY_MS: u64 = 220;
const FLOATING_NOTIFICATION_WIDTH: i32 = 232;
const FLOATING_NOTIFICATION_DETAIL_WIDTH: i32 = 344;
const FLOATING_NOTIFICATION_DETAIL_HEIGHT: i32 = 520;
const FLOATING_NOTIFICATION_GAP: i32 = 8;
const FLOATING_PANEL_GAP: i32 = 8;
const FLOATING_EDGE_HIDE: i32 = 0;
const FLOATING_SAFE_MARGIN: i32 = 12;
const FLOATING_EDGE_SNAP_THRESHOLD: i32 = 8;
const FLOATING_ORB_EDGE_INTERACTION_SLOP: i32 = 24;
const FLOATING_DRAG_THRESHOLD: i32 = 4;
const FLOATING_DEFAULT_BOTTOM_OFFSET: i32 = 32;
const TRAY_OPEN_MAIN_ID: &str = "open_main";
const TRAY_TOGGLE_FLOATING_ID: &str = "toggle_floating";
const TRAY_QUIT_ID: &str = "quit_app";
const FLOATING_CONTEXT_TOGGLE_PANEL_ID: &str = "floating_context_toggle_panel";
const FLOATING_CONTEXT_OPEN_MAIN_ID: &str = "floating_context_open_main";
const FLOATING_CONTEXT_QUIT_ID: &str = "floating_context_quit";
const FLOATING_NATIVE_DRAG_POLL_MS: u64 = 8;
const FLOATING_NATIVE_VISIBLE_POLL_MS: u64 = 16;
// 空闲档只负责发现"指针接近球体"这一个边沿（随后立刻升到 8ms 档），
// 150ms 的首次响应延迟无感知，却把常驻空转从 ~31Hz 压到 ~6.7Hz。
const FLOATING_NATIVE_IDLE_POLL_MS: u64 = 150;
const FLOATING_NATIVE_HIDDEN_POLL_MS: u64 = 250;
const FLOATING_NOTIFICATION_PREFS_SYNC_DEBOUNCE_MS: u64 = 120;
const FLOATING_NATIVE_IDLE_GEOMETRY_RECHECK_MS: u64 = 250;
#[cfg(target_os = "windows")]
const FLOATING_NATIVE_SUBCLASS_REFRESH_DELAYS_MS: [u64; 3] = [200, 600, 1_200];
#[cfg(target_os = "windows")]
const MAIN_WINDOW_CHROME_RECHECK_DELAYS_MS: [u64; 2] = [200, 600];
#[cfg(target_os = "windows")]
// `0` 与 `10` 毫秒复核用于覆盖 WebView2 在 show 返回后的首个消息循环样式重写;
// 后续三次继续覆盖较晚到达的框架刷新, 全部按 generation 合并且可失效.
const FLOATING_TASKBAR_STYLE_RECHECK_DELAYS_MS: [u64; 5] = [0, 10, 50, 200, 600];
const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
const WS_EX_APPWINDOW: isize = 0x0004_0000;

fn persisted_window_state_flags() -> StateFlags {
    StateFlags::all() & !StateFlags::DECORATIONS
}

#[derive(Clone, Serialize)]
struct FloatingContextActionPayload {
    action: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FloatingNativePanelVisibilityPayload {
    visible: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FloatingNotificationLifecyclePausePayload {
    reason: &'static str,
    paused: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FloatingPanelSyncPayload {
    dock: &'static str,
    x: i32,
    y: i32,
    menu_visible: bool,
    active_panel: &'static str,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatingNotificationReference {
    pub id: Option<String>,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatingUsageNotificationDetails {
    pub api_key_label: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_read_tokens: i64,
    pub actual_cost: f64,
    pub total_cost: f64,
    pub first_token_ms: Option<i64>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FloatingNotificationChannel {
    #[default]
    Business,
    Usage,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatingNotificationPayload {
    pub id: String,
    pub dedupe_key: String,
    #[serde(default)]
    pub channel: FloatingNotificationChannel,
    pub title: String,
    pub level: String,
    pub source: String,
    pub created_at: String,
    pub content: String,
    pub account: Option<FloatingNotificationReference>,
    pub site: Option<FloatingNotificationReference>,
    pub model: Option<FloatingNotificationReference>,
    pub usage: Option<FloatingUsageNotificationDetails>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FloatingNotificationDock {
    Left,
    #[default]
    Right,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatingNotificationSnapshot {
    pub revision: u64,
    pub items: Vec<FloatingNotificationPayload>,
    #[serde(default)]
    pub dock: FloatingNotificationDock,
}

#[derive(Default)]
pub(crate) struct FloatingNotificationMailbox {
    revision: u64,
    items: Vec<FloatingNotificationPayload>,
}

impl FloatingNotificationMailbox {
    pub(crate) fn snapshot(&self) -> FloatingNotificationSnapshot {
        FloatingNotificationSnapshot {
            revision: self.revision,
            items: self.items.clone(),
            dock: FloatingNotificationDock::default(),
        }
    }

    pub(crate) fn enqueue(
        &mut self,
        payload: FloatingNotificationPayload,
    ) -> FloatingNotificationSnapshot {
        self.enqueue_with_inserted(payload).0
    }

    /// 返回本次是否真正接纳新消息，供应用侧副作用避免被 snapshot 重放触发。
    fn enqueue_with_inserted(
        &mut self,
        payload: FloatingNotificationPayload,
    ) -> (FloatingNotificationSnapshot, bool) {
        let dedupe_key = payload.dedupe_key.trim();
        if !dedupe_key.is_empty()
            && self
                .items
                .iter()
                .any(|item| item.dedupe_key.trim() == dedupe_key)
        {
            return (self.snapshot(), false);
        }

        self.items.push(payload);
        self.revision = self.revision.wrapping_add(1);
        (self.snapshot(), true)
    }

    fn dismiss(&mut self, notification_id: &str) -> FloatingNotificationSnapshot {
        let previous_len = self.items.len();
        self.items.retain(|item| item.id != notification_id);
        if self.items.len() != previous_len {
            self.revision = self.revision.wrapping_add(1);
        }
        self.snapshot()
    }

    fn restore_usage_notifications(
        &mut self,
        payloads: impl IntoIterator<Item = FloatingNotificationPayload>,
    ) -> FloatingNotificationSnapshot {
        let mut restored = false;
        for payload in payloads {
            if payload.channel != FloatingNotificationChannel::Usage {
                continue;
            }
            let dedupe_key = payload.dedupe_key.trim();
            if self.items.iter().any(|item| {
                item.id == payload.id
                    || (!dedupe_key.is_empty() && item.dedupe_key.trim() == dedupe_key)
            }) {
                continue;
            }
            self.items.push(payload);
            restored = true;
        }
        if restored {
            self.revision = self.revision.wrapping_add(1);
        }
        self.snapshot()
    }
}

#[cfg(target_os = "windows")]
const FLOATING_SUBCLASS_ORB_ID: usize = 0xF10A7001;
#[cfg(target_os = "windows")]
const FLOATING_SUBCLASS_PANEL_ID: usize = 0xF10A7002;
#[cfg(target_os = "windows")]
const FLOATING_TASKBAR_STYLE_SUBCLASS_ORB_ID: usize = 0xF10A7101;
#[cfg(target_os = "windows")]
const FLOATING_TASKBAR_STYLE_SUBCLASS_PANEL_ID: usize = 0xF10A7102;
#[cfg(target_os = "windows")]
const FLOATING_TASKBAR_STYLE_SUBCLASS_NOTIFICATION_ID: usize = 0xF10A7103;
#[cfg(target_os = "windows")]
const MAIN_WINDOW_CHROME_SUBCLASS_ID: usize = 0xF10A7104;
#[cfg(target_os = "windows")]
const WM_SHOWWINDOW: u32 = 0x0018;

static FLOATING_NATIVE_STATE: OnceLock<Arc<Mutex<FloatingNativeState>>> = OnceLock::new();
/// 构建辅助 WebView 时串行化 label 查找与创建，避免并发路径重复注册同一窗口。
static FLOATING_AUXILIARY_WINDOW_BUILD_LOCK: Mutex<()> = Mutex::new(());
static FLOATING_AUXILIARY_VISIBILITY_STATE: OnceLock<Mutex<FloatingAuxiliaryVisibilityState>> =
    OnceLock::new();
/// 主窗口仅在真实 show 成功后才记录为已显示；HMR 重放 frontend_ready 时不能重复聚焦。
static MAIN_WINDOW_REVEALED: AtomicBool = AtomicBool::new(false);
/// 主窗口从 show 到 HWND 可见之间的短暂交接锁。失败或超时会释放它以允许后续重试。
static MAIN_WINDOW_REVEAL_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
/// 主窗口持久化状态仅在本进程第一次实际显示时恢复。它独立于
/// `MAIN_WINDOW_REVEALED`，因为悬浮启动收到 frontend_ready 时主窗口仍保持隐藏。
static MAIN_WINDOW_INITIAL_STATE_RESTORED: AtomicBool = AtomicBool::new(false);
/// 等待前端首帧的诊断阈值。到期不允许反向显示透明主窗口。
const FRONTEND_READY_TIMEOUT_MS: u64 = 3_000;
const MAIN_WINDOW_NATIVE_VISIBILITY_POLL_MS: u64 = 16;
static STARTUP_REVEAL_STAGE: AtomicU8 =
    AtomicU8::new(StartupRevealStage::NativeSplashUnavailable as u8);
/// 首个安全可见目标已完成交接。此后显式打开主窗口不再需要等前端首帧门禁。
static STARTUP_HANDOFF_COMPLETED: AtomicBool = AtomicBool::new(false);
static STARTUP_HANDOFF_STATE: OnceLock<Mutex<StartupHandoffState>> = OnceLock::new();
static FLOATING_NOTIFICATION_MAILBOX: OnceLock<Arc<Mutex<FloatingNotificationMailbox>>> =
    OnceLock::new();
static FLOATING_NOTIFICATION_SYNC_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static FLOATING_NOTIFICATION_MUTATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static FLOATING_NOTIFICATION_DETAIL_OPEN: AtomicBool = AtomicBool::new(false);
static FLOATING_NOTIFICATION_PREFS_SYNC_GENERATION: AtomicU64 = AtomicU64::new(0);

/// 只记录启动可见性交接，不承载业务状态或跨进程持久化。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum StartupRevealStage {
    NativeSplashUnavailable = 0,
    NativeSplashVisible = 1,
    MainWebviewCreated = 2,
    FrontendReady = 3,
    MainShowRequested = 4,
    FloatingWindowVisible = 5,
    MainHwndVisible = 6,
    NativeSplashDestroyed = 7,
    FrontendReadyTimeout = 8,
    MainShowFailed = 9,
}

fn record_startup_reveal_stage(stage: StartupRevealStage) {
    STARTUP_REVEAL_STAGE.store(stage as u8, Ordering::SeqCst);
    log::info!("[startup] stage={stage:?}");
}

/// 交接完成状态和待回放唤醒必须在同一把锁内变更，避免 completed/replay 与入队交错后丢失请求。
#[derive(Default)]
struct StartupHandoffState {
    completed: bool,
    pending_main_window_activation: bool,
    pending_main_window_navigation: Option<String>,
}

fn startup_handoff_state() -> &'static Mutex<StartupHandoffState> {
    STARTUP_HANDOFF_STATE.get_or_init(|| Mutex::new(StartupHandoffState::default()))
}

fn queue_startup_handoff_activation(
    state: &mut StartupHandoffState,
    navigation: Option<&str>,
) -> bool {
    if state.completed {
        return false;
    }

    state.pending_main_window_activation = true;
    if let Some(navigation) = navigation {
        state.pending_main_window_navigation = Some(navigation.to_string());
    }
    true
}

fn take_startup_handoff_activation(state: &mut StartupHandoffState) -> Option<Option<String>> {
    if !state.pending_main_window_activation {
        return None;
    }

    state.pending_main_window_activation = false;
    Some(state.pending_main_window_navigation.take())
}

fn restore_startup_handoff_activation(state: &mut StartupHandoffState, navigation: Option<String>) {
    state.pending_main_window_activation = true;
    if let Some(navigation) = navigation {
        state.pending_main_window_navigation = Some(navigation);
    }
}

/// 返回 true 表示请求已在首帧门禁内原子入队；false 表示 handoff 已经完成，可立即打开。
fn queue_main_window_activation_until_startup_handoff(navigation: Option<&str>) -> bool {
    let mut state = startup_handoff_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    queue_startup_handoff_activation(&mut state, navigation)
}

fn take_pending_startup_main_window_activation() -> Option<Option<String>> {
    let mut state = startup_handoff_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    take_startup_handoff_activation(&mut state)
}

fn restore_pending_startup_main_window_activation(navigation: Option<String>) {
    let mut state = startup_handoff_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    restore_startup_handoff_activation(&mut state, navigation);
}

fn startup_handoff_has_pending_main_window_activation() -> bool {
    startup_handoff_state()
        .lock()
        .map(|state| state.pending_main_window_activation)
        .unwrap_or(false)
}

#[derive(Default)]
struct FloatingAuxiliaryVisibilitySlot {
    generation: u64,
    requested_visible: bool,
}

#[derive(Default)]
struct FloatingAuxiliaryVisibilityState {
    floating: FloatingAuxiliaryVisibilitySlot,
    floating_panel: FloatingAuxiliaryVisibilitySlot,
    floating_notification: FloatingAuxiliaryVisibilitySlot,
}
#[cfg(target_os = "windows")]
static FLOATING_TASKBAR_STYLE_RECHECK_STATE: OnceLock<
    Arc<Mutex<FloatingTaskbarStyleRecheckState>>,
> = OnceLock::new();

#[cfg(target_os = "windows")]
#[derive(Default)]
struct FloatingTaskbarStyleRecheckSlot {
    generation: u64,
    scheduled_generation: Option<u64>,
    worker_active: bool,
}

#[cfg(target_os = "windows")]
#[derive(Default)]
struct FloatingTaskbarStyleRecheckState {
    floating: FloatingTaskbarStyleRecheckSlot,
    floating_panel: FloatingTaskbarStyleRecheckSlot,
    floating_notification: FloatingTaskbarStyleRecheckSlot,
}

#[cfg(target_os = "windows")]
struct FloatingTaskbarStyleRecheckNotifications {
    floating: Arc<tokio::sync::Notify>,
    floating_panel: Arc<tokio::sync::Notify>,
    floating_notification: Arc<tokio::sync::Notify>,
}

#[cfg(target_os = "windows")]
static FLOATING_TASKBAR_STYLE_RECHECK_NOTIFICATIONS: OnceLock<
    FloatingTaskbarStyleRecheckNotifications,
> = OnceLock::new();

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct FloatingDragSurfaceSnapshot {
    panel_visible: bool,
    notification_list_visible: bool,
    notification_detail_visible: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FloatingDragSurfaceRestore {
    None,
    Panel,
    NotificationList,
    NotificationDetail,
}

fn capture_floating_drag_surface_snapshot(
    panel_visible: bool,
    notification_visible: bool,
    notification_detail_open: bool,
) -> FloatingDragSurfaceSnapshot {
    if panel_visible {
        return FloatingDragSurfaceSnapshot {
            panel_visible: true,
            ..FloatingDragSurfaceSnapshot::default()
        };
    }

    if !notification_visible {
        return FloatingDragSurfaceSnapshot::default();
    }

    if notification_detail_open {
        FloatingDragSurfaceSnapshot {
            notification_detail_visible: true,
            ..FloatingDragSurfaceSnapshot::default()
        }
    } else {
        FloatingDragSurfaceSnapshot {
            notification_list_visible: true,
            ..FloatingDragSurfaceSnapshot::default()
        }
    }
}

fn resolve_floating_drag_surface_restore(
    snapshot: FloatingDragSurfaceSnapshot,
) -> FloatingDragSurfaceRestore {
    if snapshot.panel_visible {
        FloatingDragSurfaceRestore::Panel
    } else if snapshot.notification_detail_visible {
        FloatingDragSurfaceRestore::NotificationDetail
    } else if snapshot.notification_list_visible {
        FloatingDragSurfaceRestore::NotificationList
    } else {
        FloatingDragSurfaceRestore::None
    }
}

struct FloatingNativeState {
    app: AppHandle,
    orb_hwnd: usize,
    /// 悬浮面板按实际交互创建，冷启动时原生轮询器必须允许它尚不存在。
    panel_hwnd: Option<usize>,
    keep_panel_visible: bool,
    pointer_down: bool,
    drag_started: bool,
    down_x: i32,
    down_y: i32,
    orb_origin_x: i32,
    orb_origin_y: i32,
    drag_current_x: i32,
    drag_current_y: i32,
    last_applied_orb_position: Option<(i32, i32)>,
    drag_threshold: i32,
    panel_visible: bool,
    drag_surface_restore: Option<FloatingDragSurfaceSnapshot>,
    drag_surfaces_suppressed: bool,
    active_panel: &'static str,
    last_left_down: bool,
    pointer_near_orb: bool,
    last_geometry_cursor: Option<(i32, i32)>,
    last_orb_hit: bool,
    last_orb_drag_hit: bool,
    last_panel_hit: bool,
    last_geometry_sample_at: Option<Instant>,
    hover_since: Option<Instant>,
    hide_since: Option<Instant>,
    suppress_hover_until: Option<Instant>,
    hover_reentry_required: bool,
    /// 后台已投递、等待主线程处理的原生轮询 tick，避免事件队列累积。
    poll_tick_pending: bool,
    /// 悬浮原生运行时只允许启动一个轮询任务。
    poller_started: bool,
}

#[derive(Clone, Copy)]
struct FloatingGeometry {
    notification_gap: i32,
    panel_gap: i32,
    edge_hide: i32,
    safe_margin: i32,
    edge_snap_threshold: i32,
    orb_edge_interaction_slop: i32,
    drag_threshold: i32,
    default_bottom_offset: i32,
}

impl FloatingGeometry {
    fn for_scale(scale_factor: f64) -> Self {
        Self {
            notification_gap: logical_to_physical(FLOATING_NOTIFICATION_GAP, scale_factor),
            panel_gap: logical_to_physical(FLOATING_PANEL_GAP, scale_factor),
            edge_hide: if FLOATING_EDGE_HIDE == 0 {
                0
            } else {
                logical_to_physical(FLOATING_EDGE_HIDE, scale_factor)
            },
            safe_margin: logical_to_physical(FLOATING_SAFE_MARGIN, scale_factor),
            edge_snap_threshold: logical_to_physical(FLOATING_EDGE_SNAP_THRESHOLD, scale_factor),
            orb_edge_interaction_slop: logical_to_physical(
                FLOATING_ORB_EDGE_INTERACTION_SLOP,
                scale_factor,
            ),
            drag_threshold: logical_to_physical(FLOATING_DRAG_THRESHOLD, scale_factor),
            default_bottom_offset: logical_to_physical(
                FLOATING_DEFAULT_BOTTOM_OFFSET,
                scale_factor,
            ),
        }
    }
}

fn normalize_scale_factor(scale_factor: f64) -> f64 {
    if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    }
}

fn logical_to_physical(logical_pixels: i32, scale_factor: f64) -> i32 {
    ((logical_pixels as f64 * normalize_scale_factor(scale_factor)).round() as i32).max(1)
}

fn physical_to_logical(physical_pixels: i32, scale_factor: f64) -> i32 {
    ((physical_pixels as f64 / normalize_scale_factor(scale_factor)).floor() as i32).max(1)
}

fn resolve_floating_window_scale_factor(app: &AppHandle) -> f64 {
    app.get_webview_window(FLOATING_WINDOW_LABEL)
        .and_then(|window| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .map(|monitor| normalize_scale_factor(monitor.scale_factor()))
        .unwrap_or(1.0)
}

fn should_keep_floating_panel_visible(app: &AppHandle) -> bool {
    application::desktop_ui_service::get_desktop_ui_prefs(&app.state::<application::AppContext>())
        .map(|prefs| prefs.keep_floating_panel_visible)
        .unwrap_or(false)
}

fn resolve_floating_native_poll_ms(orb_visible: bool, panel_visible: bool, dragging: bool) -> u64 {
    if dragging {
        FLOATING_NATIVE_DRAG_POLL_MS
    } else if panel_visible {
        FLOATING_NATIVE_VISIBLE_POLL_MS
    } else if orb_visible {
        FLOATING_NATIVE_IDLE_POLL_MS
    } else {
        FLOATING_NATIVE_HIDDEN_POLL_MS
    }
}

fn resolve_floating_native_poll_ms_with_pointer_near_orb(
    orb_visible: bool,
    panel_visible: bool,
    dragging: bool,
    pointer_near_orb: bool,
) -> u64 {
    if orb_visible && pointer_near_orb {
        FLOATING_NATIVE_DRAG_POLL_MS
    } else {
        resolve_floating_native_poll_ms(orb_visible, panel_visible, dragging)
    }
}

#[cfg(target_os = "windows")]
fn should_schedule_floating_native_poll_tick(pending: bool) -> bool {
    !pending
}

fn should_sample_floating_native_geometry(
    pointer_near_orb: bool,
    left_down: bool,
    last_cursor: Option<(i32, i32)>,
    cursor: (i32, i32),
    elapsed_since_sample: Option<Duration>,
) -> bool {
    if pointer_near_orb || left_down || last_cursor != Some(cursor) {
        return true;
    }
    match elapsed_since_sample {
        Some(elapsed) => elapsed >= Duration::from_millis(FLOATING_NATIVE_IDLE_GEOMETRY_RECHECK_MS),
        None => true,
    }
}

fn resolve_floating_native_panel_visible(
    cached_visible: bool,
    native_visible: Option<bool>,
) -> bool {
    native_visible.unwrap_or(cached_visible)
}

fn should_apply_floating_native_position(
    last_applied: Option<(i32, i32)>,
    next: (i32, i32),
    force: bool,
) -> bool {
    force || last_applied != Some(next)
}

fn should_transition_floating_native_panel_visibility(current: bool, desired: bool) -> bool {
    current != desired
}

fn should_replay_floating_panel_sync(panel_visible: bool) -> bool {
    panel_visible
}

fn take_floating_native_drag_pause_release(drag_surfaces_suppressed: &mut bool) -> bool {
    std::mem::replace(drag_surfaces_suppressed, false)
}

fn should_auto_show_floating_panel_for_keep_visible(
    keep_panel_visible: bool,
    pointer_down: bool,
    drag_started: bool,
    panel_visible: bool,
    hover_suppressed: bool,
) -> bool {
    keep_panel_visible && !pointer_down && !drag_started && !panel_visible && !hover_suppressed
}

fn floating_drag_surfaces_suppressed() -> bool {
    FLOATING_NATIVE_STATE
        .get()
        .and_then(|shared| {
            shared
                .lock()
                .ok()
                .map(|state| state.drag_surfaces_suppressed)
        })
        .unwrap_or(false)
}

fn should_sync_floating_notification_window(
    drag_surfaces_suppressed: bool,
    allow_drag_restore: bool,
) -> bool {
    !drag_surfaces_suppressed || allow_drag_restore
}

fn read_cached_keep_panel_visible(shared: &Arc<Mutex<FloatingNativeState>>) -> bool {
    shared
        .lock()
        .map(|state| state.keep_panel_visible)
        .unwrap_or(false)
}

pub(crate) fn set_floating_native_keep_panel_visible(keep_panel_visible: bool) {
    if let Some(shared) = FLOATING_NATIVE_STATE.get() {
        if let Ok(mut state) = shared.lock() {
            state.keep_panel_visible = keep_panel_visible;
        }
    }
}

#[cfg(any(test, target_os = "windows"))]
fn should_begin_floating_native_webview_session(left_down: bool, cursor_on_orb: bool) -> bool {
    left_down && cursor_on_orb
}

pub(crate) fn begin_floating_native_pointer_session_from_webview() -> bool {
    #[cfg(target_os = "windows")]
    {
        let Some(shared) = FLOATING_NATIVE_STATE.get() else {
            return false;
        };
        let mut cursor = NativePoint { x: 0, y: 0 };
        unsafe {
            let _ = GetCursorPos(&mut cursor);
        }
        let left_down = unsafe { (GetAsyncKeyState(0x01) as u16 & 0x8000) != 0 };
        let cursor_on_orb = shared
            .lock()
            .map(|state| point_inside_orb_drag_zone(&state.app, state.orb_hwnd, cursor.x, cursor.y))
            .unwrap_or(false);
        if !should_begin_floating_native_webview_session(left_down, cursor_on_orb) {
            return false;
        }
        begin_floating_native_pointer_session(shared, &cursor);
        return true;
    }

    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

pub(crate) async fn reveal_main_window_on_frontend_ready(app: &AppHandle) -> Result<(), String> {
    // frontend_ready 从 WebView IPC 进入时不保证已在 Windows UI 线程；必须让
    // configure -> show -> configure 与 Tao 的 ShowWindow 样式回写串行执行，且只有
    // 完成后才回复 IPC，避免前端在原生窗口真正可见前撤掉静态 Loading。
    record_startup_reveal_stage(StartupRevealStage::FrontendReady);
    let (completion_tx, completion_rx) = tokio::sync::oneshot::channel();
    let app_for_main_thread = app.clone();
    app.run_on_main_thread(move || {
        let _ = completion_tx.send(reveal_main_window(&app_for_main_thread, "前端首帧就绪"));
    })
    .map_err(|error| {
        let message = format!("无法在主线程显示主窗口: {error}");
        log::warn!("[window] {message}");
        message
    })?;
    let target = completion_rx.await.map_err(|_| {
        let message = "主窗口首帧显示任务在完成前被取消".to_string();
        log::warn!("[window] {message}");
        message
    })??;
    match target {
        StartupRevealTarget::Main => finish_main_startup_handoff(app).await,
        StartupRevealTarget::Floating => finish_floating_startup_handoff(app).await,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StartupRevealTarget {
    Main,
    Floating,
}

/// 只有当前启动目标真正可见时，才允许进入销毁原生启动窗的最终交接阶段。
fn resolve_startup_handoff_stage(
    target: StartupRevealTarget,
    main_visible: bool,
    floating_visible: bool,
) -> Option<StartupRevealStage> {
    match target {
        StartupRevealTarget::Main if main_visible => Some(StartupRevealStage::MainHwndVisible),
        StartupRevealTarget::Floating if floating_visible => {
            Some(StartupRevealStage::FloatingWindowVisible)
        }
        _ => None,
    }
}

/// Windows 的 `show()` 返回后仍可能要等一个消息循环才真正提交到桌面，尤其是恢复最大化时。
fn main_window_native_visible(app: &AppHandle) -> bool {
    let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return false;
    };

    #[cfg(target_os = "windows")]
    {
        let Ok(hwnd) = main.hwnd() else {
            return false;
        };
        return native_window_visible(hwnd.0 as usize).unwrap_or(false);
    }

    #[cfg(not(target_os = "windows"))]
    {
        main.is_visible().unwrap_or(false)
    }
}

fn floating_window_native_visible(app: &AppHandle) -> bool {
    let Some(floating) = app.get_webview_window(FLOATING_WINDOW_LABEL) else {
        return false;
    };

    #[cfg(target_os = "windows")]
    {
        let Ok(hwnd) = floating.hwnd() else {
            return false;
        };
        return native_window_visible(hwnd.0 as usize).unwrap_or(false);
    }

    #[cfg(not(target_os = "windows"))]
    {
        floating.is_visible().unwrap_or(false)
    }
}

/// 让 IPC completion 对应真实原生可见性，超时保留启动窗而不是把透明宿主当作成功。
async fn wait_for_startup_window_native_visibility(
    app: &AppHandle,
    window_visible: fn(&AppHandle) -> bool,
    window_name: &'static str,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_millis(FRONTEND_READY_TIMEOUT_MS);
    loop {
        let (visible_tx, visible_rx) = tokio::sync::oneshot::channel();
        let app_for_main_thread = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            let _ = visible_tx.send(window_visible(&app_for_main_thread));
        }) {
            let message = format!("无法确认{window_name}原生可见状态: {error}");
            log::warn!("[startup] {message}");
            return Err(message);
        }

        if matches!(visible_rx.await, Ok(true)) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            record_startup_reveal_stage(StartupRevealStage::FrontendReadyTimeout);
            let message = format!("{window_name}显示后未在限定时间内确认原生可见状态");
            log::warn!("[startup] {message}");
            return Err(message);
        }
        tokio::time::sleep(Duration::from_millis(MAIN_WINDOW_NATIVE_VISIBILITY_POLL_MS)).await;
    }
}

async fn wait_for_main_window_native_visibility(app: &AppHandle) -> Result<(), String> {
    wait_for_startup_window_native_visibility(app, main_window_native_visible, "主窗口").await
}

async fn wait_for_floating_window_native_visibility(app: &AppHandle) -> Result<(), String> {
    wait_for_startup_window_native_visibility(app, floating_window_native_visible, "悬浮球").await
}

fn native_startup_splash_visible() -> bool {
    #[cfg(target_os = "windows")]
    {
        return infrastructure::windows_splash::startup_splash_visible();
    }

    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// 仅在创建启动窗的 Tauri UI 线程销毁 HWND，避免退出路径跨线程调用 DestroyWindow。
/// 销毁失败必须向启动交接传播，不能把仍可见的 HWND 标记为已完成。
fn dismiss_native_startup_splash_on_main_thread() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if native_startup_splash_visible() {
            infrastructure::windows_splash::dismiss_startup_splash()?;
            record_startup_reveal_stage(StartupRevealStage::NativeSplashDestroyed);
        }
    }

    Ok(())
}

/// 请求应用退出时尽早关闭原生启动窗。Windows 的 HWND 生命周期仍由主线程收口。
pub(crate) fn dismiss_native_startup_splash_for_exit(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        if !native_startup_splash_visible() {
            return;
        }
        if let Err(error) = app.run_on_main_thread(|| {
            if let Err(error) = dismiss_native_startup_splash_on_main_thread() {
                log::warn!("[startup] 原生启动窗退出清理失败: {error}");
            }
        }) {
            log::warn!("[startup] 调度启动窗退出清理失败: {error}");
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
    }
}

/// 只能在 Tauri 主线程调用，确保 DestroyWindow 与创建线程一致。
fn complete_startup_handoff_on_main_thread(
    app: &AppHandle,
    stage: StartupRevealStage,
) -> Result<(), String> {
    record_startup_reveal_stage(stage);
    let first_handoff = {
        let mut handoff = startup_handoff_state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if handoff.completed {
            false
        } else {
            // 持有 handoff 锁直到 HWND 销毁成功并提交 completed，避免其他线程在
            // replay 与入队之间插入一个永远不会回放的显式打开请求。
            if let Err(error) = dismiss_native_startup_splash_on_main_thread() {
                log::warn!("[startup] 原生启动窗销毁失败，保留 handoff 重试资格: {error}");
                return Err(error);
            }
            handoff.completed = true;
            STARTUP_HANDOFF_COMPLETED.store(true, Ordering::SeqCst);
            true
        }
    };
    if stage == StartupRevealStage::MainHwndVisible {
        MAIN_WINDOW_REVEALED.store(true, Ordering::SeqCst);
        if first_handoff {
            ensure_main_mode_auxiliary_windows_after_startup(app);
        }
    }
    MAIN_WINDOW_REVEAL_IN_FLIGHT.store(false, Ordering::SeqCst);
    if first_handoff {
        replay_pending_main_window_activation_after_startup_handoff(app);
    }
    Ok(())
}

async fn finish_main_startup_handoff(app: &AppHandle) -> Result<(), String> {
    if let Err(error) = wait_for_main_window_native_visibility(app).await {
        MAIN_WINDOW_REVEAL_IN_FLIGHT.store(false, Ordering::SeqCst);
        return Err(error);
    }
    let (completion_tx, completion_rx) = tokio::sync::oneshot::channel();
    let app_for_main_thread = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let completion = resolve_startup_handoff_stage(
            StartupRevealTarget::Main,
            main_window_native_visible(&app_for_main_thread),
            false,
        )
        .ok_or_else(|| "主窗口可见性交接在完成前被取消".to_string())
        .and_then(|stage| complete_startup_handoff_on_main_thread(&app_for_main_thread, stage));
        let _ = completion_tx.send(completion);
    }) {
        MAIN_WINDOW_REVEAL_IN_FLIGHT.store(false, Ordering::SeqCst);
        let message = format!("无法在主线程完成主窗口启动交接: {error}");
        log::warn!("[startup] {message}");
        return Err(message);
    }
    match completion_rx.await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => {
            MAIN_WINDOW_REVEAL_IN_FLIGHT.store(false, Ordering::SeqCst);
            Err(error)
        }
        Err(_) => {
            MAIN_WINDOW_REVEAL_IN_FLIGHT.store(false, Ordering::SeqCst);
            Err("主窗口可见性交接在完成前被取消".to_string())
        }
    }
}

async fn finish_floating_startup_handoff(app: &AppHandle) -> Result<(), String> {
    wait_for_floating_window_native_visibility(app).await?;
    let (completion_tx, completion_rx) = tokio::sync::oneshot::channel();
    let app_for_main_thread = app.clone();
    app.run_on_main_thread(move || {
        let completion = resolve_startup_handoff_stage(
            StartupRevealTarget::Floating,
            false,
            floating_window_native_visible(&app_for_main_thread),
        )
        .ok_or_else(|| "悬浮球可见性交接在完成前被取消".to_string())
        .and_then(|stage| complete_startup_handoff_on_main_thread(&app_for_main_thread, stage));
        let _ = completion_tx.send(completion);
    })
    .map_err(|error| format!("无法在主线程完成悬浮球启动交接: {error}"))?;
    match completion_rx.await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(error),
        Err(_) => Err("悬浮球可见性交接在完成前被取消".to_string()),
    }
}

fn mark_floating_native_panel_hidden() {
    let Some(shared) = FLOATING_NATIVE_STATE.get() else {
        return;
    };
    let Ok(mut state) = shared.lock() else {
        return;
    };
    let release_native_drag_pause =
        take_floating_native_drag_pause_release(&mut state.drag_surfaces_suppressed);
    state.panel_visible = false;
    state.pointer_down = false;
    state.drag_started = false;
    state.drag_surface_restore = None;
    state.last_left_down = false;
    state.pointer_near_orb = false;
    state.last_geometry_cursor = None;
    state.last_orb_hit = false;
    state.last_orb_drag_hit = false;
    state.last_panel_hit = false;
    state.last_geometry_sample_at = None;
    state.hover_since = None;
    state.hide_since = None;
    state.suppress_hover_until = None;
    state.hover_reentry_required = false;
    let app = state.app.clone();
    drop(state);

    let _ = app.emit_to(
        FLOATING_NOTIFICATION_WINDOW_LABEL,
        "floating-notification-panel-visibility",
        FloatingNativePanelVisibilityPayload { visible: false },
    );
    if release_native_drag_pause {
        emit_floating_notification_lifecycle_pause(&app, "floating-panel-drag", false);
    }
}

fn floating_drag_threshold_exceeded(delta_x: i32, delta_y: i32, threshold: i32) -> bool {
    delta_x.abs() >= threshold || delta_y.abs() >= threshold
}

#[cfg(test)]
fn should_hide_floating_panel_after_startup(
    panel_visible: bool,
    pointer_down: bool,
    drag_started: bool,
) -> bool {
    !panel_visible && !pointer_down && !drag_started
}

#[cfg(target_os = "windows")]
fn begin_floating_native_pointer_session(
    shared: &Arc<Mutex<FloatingNativeState>>,
    cursor: &NativePoint,
) {
    let Ok(mut state) = shared.lock() else {
        return;
    };
    if state.pointer_down {
        return;
    }

    state.pointer_down = true;
    state.drag_started = false;
    state.drag_surface_restore = None;
    state.drag_surfaces_suppressed = false;
    state.drag_threshold =
        FloatingGeometry::for_scale(resolve_floating_window_scale_factor(&state.app))
            .drag_threshold;
    state.down_x = cursor.x;
    state.down_y = cursor.y;
    state.hover_since = None;
    if let Some(rect) = get_window_rect(state.orb_hwnd) {
        state.orb_origin_x = rect.left;
        state.orb_origin_y = rect.top;
        state.drag_current_x = rect.left;
        state.drag_current_y = rect.top;
    } else if let Some(orb) = state.app.get_webview_window(FLOATING_WINDOW_LABEL) {
        if let Ok(position) = orb.outer_position() {
            state.orb_origin_x = position.x;
            state.orb_origin_y = position.y;
            state.drag_current_x = position.x;
            state.drag_current_y = position.y;
        }
    }
    state.last_applied_orb_position = Some((state.orb_origin_x, state.orb_origin_y));
}

#[cfg(target_os = "windows")]
unsafe extern "system" {
    fn SetWindowSubclass(
        hwnd: *mut std::ffi::c_void,
        pfn_subclass: Option<
            unsafe extern "system" fn(
                *mut std::ffi::c_void,
                u32,
                usize,
                isize,
                usize,
                usize,
            ) -> isize,
        >,
        uidsubclass: usize,
        dwrefdata: usize,
    ) -> i32;
    fn DefSubclassProc(
        hwnd: *mut std::ffi::c_void,
        msg: u32,
        wparam: usize,
        lparam: isize,
    ) -> isize;
    fn EnumChildWindows(
        hwnd: *mut std::ffi::c_void,
        callback: Option<unsafe extern "system" fn(*mut std::ffi::c_void, isize) -> i32>,
        lparam: isize,
    ) -> i32;
    fn GetCursorPos(point: *mut NativePoint) -> i32;
    fn GetWindowRect(hwnd: *mut std::ffi::c_void, rect: *mut NativeRect) -> i32;
    fn IsWindowVisible(hwnd: *mut std::ffi::c_void) -> i32;
    fn GetAncestor(hwnd: *mut std::ffi::c_void, flags: u32) -> *mut std::ffi::c_void;
    fn GetAsyncKeyState(v_key: i32) -> i16;
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy)]
#[repr(C)]
struct NativePoint {
    x: i32,
    y: i32,
}

#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Clone, Copy)]
struct NativeRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FloatingNotificationHitRegion {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    corner_radius: i32,
}

/** Win32 圆角 Region 的物理像素边界。 */
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FloatingNotificationNativeRoundRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    radius_x: i32,
    radius_y: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FloatingNotificationLayout {
    compact_item_height: i32,
    usage_item_height: i32,
    item_gap: i32,
    vertical_padding: i32,
    max_visible: usize,
}

impl FloatingNotificationLayout {
    fn from_prefs(prefs: &crate::contracts::DesktopUiPrefs) -> Self {
        let density_layout = application::desktop_ui_service::floating_notification_density_layout(
            &prefs.floating_notification_density,
        );
        Self {
            compact_item_height: density_layout.compact_height,
            usage_item_height: density_layout.usage_height,
            item_gap: density_layout.gap,
            vertical_padding: density_layout.vertical_padding,
            max_visible:
                application::desktop_ui_service::normalize_floating_notification_max_visible(
                    prefs.floating_notification_max_visible,
                ) as usize,
        }
    }

    fn min_height(self) -> i32 {
        self.compact_item_height + self.vertical_padding
    }

    fn max_height(self) -> i32 {
        self.max_visible as i32 * self.usage_item_height
            + (self.max_visible.saturating_sub(1) as i32) * self.item_gap
            + self.vertical_padding
    }
}

#[cfg(target_os = "windows")]
unsafe fn apply_native_floating_window_style_to_hwnd(hwnd: *mut std::ffi::c_void) {
    use std::ffi::c_void;

    const GWL_STYLE: i32 = -16;
    const GWL_EXSTYLE: i32 = -20;
    const WS_BORDER: isize = 0x0080_0000;
    const WS_DLGFRAME: isize = 0x0040_0000;
    const WS_THICKFRAME: isize = 0x0004_0000;
    const WS_MINIMIZEBOX: isize = 0x0002_0000;
    const WS_MAXIMIZEBOX: isize = 0x0001_0000;
    const WS_SYSMENU: isize = 0x0008_0000;
    const WS_POPUP: isize = 0x8000_0000u32 as isize;
    const WS_CLIPSIBLINGS: isize = 0x0400_0000;
    const WS_CLIPCHILDREN: isize = 0x0200_0000;
    const WS_EX_LAYERED: isize = 0x0008_0000;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_FRAMECHANGED: u32 = 0x0020;
    const SWP_NOSIZE: u32 = 0x0001;

    unsafe extern "system" {
        fn GetWindowLongPtrW(hwnd: *mut c_void, n_index: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: *mut c_void, n_index: i32, new_long: isize) -> isize;
        fn SetWindowPos(
            hwnd: *mut c_void,
            hwnd_insert_after: *mut c_void,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
    }

    if hwnd.is_null() {
        return;
    }

    let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
    let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    let next_style = (style | WS_POPUP | WS_CLIPSIBLINGS | WS_CLIPCHILDREN)
        & !(WS_BORDER | WS_DLGFRAME | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU);
    let next_ex_style = normalize_floating_window_ex_style(ex_style) | WS_EX_LAYERED;
    let _ = SetWindowLongPtrW(hwnd, GWL_STYLE, next_style);
    let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next_ex_style);
    let _ = SetWindowPos(
        hwnd,
        std::ptr::null_mut(),
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
    );
}

#[cfg(target_os = "windows")]
fn configure_floating_orb_alpha_region(window: &WebviewWindow) {
    use std::ffi::c_void;

    const RGN_OR: i32 = 2;

    unsafe extern "system" {
        fn GetClientRect(hwnd: *mut c_void, rect: *mut NativeRect) -> i32;
        fn CreateRectRgn(left: i32, top: i32, right: i32, bottom: i32) -> *mut c_void;
        fn CombineRgn(
            destination: *mut c_void,
            source_one: *mut c_void,
            source_two: *mut c_void,
            mode: i32,
        ) -> i32;
        fn SetWindowRgn(hwnd: *mut c_void, region: *mut c_void, redraw: i32) -> i32;
        fn DeleteObject(object: *mut c_void) -> i32;
    }

    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    unsafe {
        let raw = hwnd.0 as *mut c_void;
        let mut client_rect = NativeRect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if GetClientRect(raw, &mut client_rect) == 0 {
            return;
        }

        let client_width = (client_rect.right - client_rect.left).max(1);
        let client_height = (client_rect.bottom - client_rect.top).max(1);
        let scale_x = client_width as f64 / FLOATING_ORB_SIZE;
        let scale_y = client_height as f64 / FLOATING_ORB_SIZE;
        let mut combined: *mut c_void = std::ptr::null_mut();

        for &(source_y, source_left, source_right) in FLOATING_ORB_ALPHA_REGION_RUNS {
            let left = (source_left as f64 * scale_x).round() as i32;
            let top = (source_y as f64 * scale_y).round() as i32;
            let right = (source_right as f64 * scale_x).round() as i32;
            let bottom = ((source_y + 1) as f64 * scale_y).round() as i32;
            if right <= left || bottom <= top {
                continue;
            }

            let next = CreateRectRgn(left, top, right, bottom);
            if next.is_null() {
                continue;
            }
            if combined.is_null() {
                combined = next;
                continue;
            }
            let _ = CombineRgn(combined, combined, next, RGN_OR);
            let _ = DeleteObject(next);
        }

        if !combined.is_null() && SetWindowRgn(raw, combined, 1) == 0 {
            let _ = DeleteObject(combined);
        }
    }
}

#[cfg(target_os = "windows")]
fn configure_native_floating_window(window: &WebviewWindow, _width: i32, _height: i32) {
    let _ = window.set_decorations(false);
    let _ = window.set_shadow(false);
    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));

    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            apply_native_floating_window_style_to_hwnd(hwnd.0 as *mut std::ffi::c_void);
        }
    }
    if window.label() == FLOATING_WINDOW_LABEL {
        configure_floating_orb_alpha_region(window);
    }
}

#[cfg(not(target_os = "windows"))]
fn configure_native_floating_window(_window: &WebviewWindow, _width: i32, _height: i32) {}

fn normalize_floating_window_ex_style(ex_style: isize) -> isize {
    (ex_style | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW
}

fn is_floating_auxiliary_window_label(label: &str) -> bool {
    matches!(
        label,
        FLOATING_WINDOW_LABEL | FLOATING_PANEL_WINDOW_LABEL | FLOATING_NOTIFICATION_WINDOW_LABEL
    )
}

fn floating_auxiliary_visibility_state() -> &'static Mutex<FloatingAuxiliaryVisibilityState> {
    FLOATING_AUXILIARY_VISIBILITY_STATE
        .get_or_init(|| Mutex::new(FloatingAuxiliaryVisibilityState::default()))
}

fn floating_auxiliary_visibility_slot_mut<'a>(
    state: &'a mut FloatingAuxiliaryVisibilityState,
    label: &str,
) -> Option<&'a mut FloatingAuxiliaryVisibilitySlot> {
    match label {
        FLOATING_WINDOW_LABEL => Some(&mut state.floating),
        FLOATING_PANEL_WINDOW_LABEL => Some(&mut state.floating_panel),
        FLOATING_NOTIFICATION_WINDOW_LABEL => Some(&mut state.floating_notification),
        _ => None,
    }
}

/// 记录最新显隐意图，使已经排队但过期的主线程 show 任务无法复活辅助窗口。
fn record_floating_auxiliary_visibility_intent(
    label: &str,
    requested_visible: bool,
) -> Option<u64> {
    let mut state = floating_auxiliary_visibility_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let slot = floating_auxiliary_visibility_slot_mut(&mut state, label)?;
    slot.generation = slot.generation.wrapping_add(1);
    slot.requested_visible = requested_visible;
    Some(slot.generation)
}

fn read_floating_auxiliary_visibility_intent(label: &str) -> Option<(u64, bool)> {
    let state = floating_auxiliary_visibility_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let slot = match label {
        FLOATING_WINDOW_LABEL => &state.floating,
        FLOATING_PANEL_WINDOW_LABEL => &state.floating_panel,
        FLOATING_NOTIFICATION_WINDOW_LABEL => &state.floating_notification,
        _ => return None,
    };
    Some((slot.generation, slot.requested_visible))
}

fn should_apply_floating_auxiliary_show(
    label: &str,
    current_generation: u64,
    captured_generation: u64,
    requested_visible: bool,
) -> bool {
    is_floating_auxiliary_window_label(label)
        && current_generation == captured_generation
        && requested_visible
}

#[cfg(target_os = "windows")]
fn floating_taskbar_style_subclass_id(label: &str) -> Option<usize> {
    match label {
        FLOATING_WINDOW_LABEL => Some(FLOATING_TASKBAR_STYLE_SUBCLASS_ORB_ID),
        FLOATING_PANEL_WINDOW_LABEL => Some(FLOATING_TASKBAR_STYLE_SUBCLASS_PANEL_ID),
        FLOATING_NOTIFICATION_WINDOW_LABEL => Some(FLOATING_TASKBAR_STYLE_SUBCLASS_NOTIFICATION_ID),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn is_floating_taskbar_style_subclass_id(subclass_id: usize) -> bool {
    matches!(
        subclass_id,
        FLOATING_TASKBAR_STYLE_SUBCLASS_ORB_ID
            | FLOATING_TASKBAR_STYLE_SUBCLASS_PANEL_ID
            | FLOATING_TASKBAR_STYLE_SUBCLASS_NOTIFICATION_ID
    )
}

#[cfg(target_os = "windows")]
fn should_apply_floating_taskbar_style_from_show_message(
    msg: u32,
    wparam: usize,
    subclass_id: usize,
    is_top_level: bool,
) -> bool {
    msg == WM_SHOWWINDOW
        && wparam != 0
        && is_top_level
        && is_floating_taskbar_style_subclass_id(subclass_id)
}

#[cfg(target_os = "windows")]
fn should_apply_main_window_chrome_from_show_message(
    msg: u32,
    wparam: usize,
    is_top_level: bool,
) -> bool {
    msg == WM_SHOWWINDOW && wparam != 0 && is_top_level
}

fn should_recheck_floating_taskbar_style(
    label: &str,
    current_generation: u64,
    captured_generation: u64,
    visible: bool,
) -> bool {
    is_floating_auxiliary_window_label(label)
        && current_generation == captured_generation
        && visible
}

#[cfg(target_os = "windows")]
/// 清除 WebView2 在显示阶段可能重新写入的主窗口系统 caption 样式。
unsafe fn apply_native_main_window_chrome_to_hwnd(hwnd: *mut std::ffi::c_void) {
    use std::ffi::c_void;

    const GWL_STYLE: i32 = -16;
    const GWL_EXSTYLE: i32 = -20;
    const WS_CAPTION: isize = 0x00C0_0000;
    const WS_BORDER: isize = 0x0080_0000;
    const WS_DLGFRAME: isize = 0x0040_0000;
    const WS_SYSMENU: isize = 0x0008_0000;
    const WS_MINIMIZEBOX: isize = 0x0002_0000;
    const WS_MAXIMIZEBOX: isize = 0x0001_0000;
    const WS_EX_DLGMODALFRAME: isize = 0x0000_0001;
    const WS_EX_CLIENTEDGE: isize = 0x0000_0200;
    const WS_EX_STATICEDGE: isize = 0x0002_0000;
    const WS_EX_WINDOWEDGE: isize = 0x0000_0100;
    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_ROUND: u32 = 2;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_FRAMECHANGED: u32 = 0x0020;

    #[link(name = "dwmapi")]
    unsafe extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: *mut c_void,
            dw_attribute: u32,
            pv_attribute: *const c_void,
            cb_attribute: u32,
        ) -> i32;
        fn GetWindowLongPtrW(hwnd: *mut c_void, n_index: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: *mut c_void, n_index: i32, new_long: isize) -> isize;
        fn SetWindowPos(
            hwnd: *mut c_void,
            hwnd_insert_after: *mut c_void,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
    }

    if hwnd.is_null() {
        return;
    }

    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let next_style = style
            & !(WS_CAPTION
                | WS_BORDER
                | WS_DLGFRAME
                | WS_SYSMENU
                | WS_MINIMIZEBOX
                | WS_MAXIMIZEBOX);
        let next_ex_style = ex_style
            & !(WS_EX_DLGMODALFRAME | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE | WS_EX_WINDOWEDGE);
        let _ = SetWindowLongPtrW(hwnd, GWL_STYLE, next_style);
        let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next_ex_style);
        let _ = SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
        let corner_pref = DWMWCP_ROUND;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &corner_pref as *const u32 as *const c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

#[cfg(target_os = "windows")]
fn configure_native_main_window(window: &WebviewWindow) {
    let _ = window.set_decorations(false);
    let _ = window.set_shadow(true);

    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            apply_native_main_window_chrome_to_hwnd(hwnd.0 as *mut std::ffi::c_void);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn configure_native_main_window(window: &WebviewWindow) {
    let _ = window.set_decorations(false);
}

#[cfg(target_os = "windows")]
fn schedule_native_main_window_chrome_normalization(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        for delay_ms in MAIN_WINDOW_CHROME_RECHECK_DELAYS_MS {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let app_for_main_thread = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(main) = app_for_main_thread.get_webview_window(MAIN_WINDOW_LABEL) {
                    configure_native_main_window(&main);
                }
            });
        }
    });
}

#[cfg(target_os = "windows")]
fn move_window_by_hwnd(hwnd: usize, x: i32, y: i32) {
    use std::ffi::c_void;

    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_NOSIZE: u32 = 0x0001;

    unsafe extern "system" {
        fn SetWindowPos(
            hwnd: *mut c_void,
            hwnd_insert_after: *mut c_void,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
    }

    unsafe {
        let _ = SetWindowPos(
            hwnd as *mut c_void,
            std::ptr::null_mut(),
            x,
            y,
            0,
            0,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSIZE,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn move_window_by_hwnd(_hwnd: usize, _x: i32, _y: i32) {}

fn show_window(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

#[cfg(target_os = "windows")]
fn floating_taskbar_style_recheck_state() -> &'static Arc<Mutex<FloatingTaskbarStyleRecheckState>> {
    FLOATING_TASKBAR_STYLE_RECHECK_STATE
        .get_or_init(|| Arc::new(Mutex::new(FloatingTaskbarStyleRecheckState::default())))
}

#[cfg(target_os = "windows")]
fn floating_taskbar_style_recheck_notifications(
) -> &'static FloatingTaskbarStyleRecheckNotifications {
    FLOATING_TASKBAR_STYLE_RECHECK_NOTIFICATIONS.get_or_init(|| {
        FloatingTaskbarStyleRecheckNotifications {
            floating: Arc::new(tokio::sync::Notify::new()),
            floating_panel: Arc::new(tokio::sync::Notify::new()),
            floating_notification: Arc::new(tokio::sync::Notify::new()),
        }
    })
}

#[cfg(target_os = "windows")]
fn floating_taskbar_style_recheck_notification(label: &str) -> Option<Arc<tokio::sync::Notify>> {
    let notifications = floating_taskbar_style_recheck_notifications();
    match label {
        FLOATING_WINDOW_LABEL => Some(notifications.floating.clone()),
        FLOATING_PANEL_WINDOW_LABEL => Some(notifications.floating_panel.clone()),
        FLOATING_NOTIFICATION_WINDOW_LABEL => Some(notifications.floating_notification.clone()),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn floating_taskbar_style_recheck_slot_mut<'a>(
    state: &'a mut FloatingTaskbarStyleRecheckState,
    label: &str,
) -> Option<&'a mut FloatingTaskbarStyleRecheckSlot> {
    match label {
        FLOATING_WINDOW_LABEL => Some(&mut state.floating),
        FLOATING_PANEL_WINDOW_LABEL => Some(&mut state.floating_panel),
        FLOATING_NOTIFICATION_WINDOW_LABEL => Some(&mut state.floating_notification),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn floating_taskbar_style_recheck_generation(label: &str) -> Option<u64> {
    let state = floating_taskbar_style_recheck_state().lock().ok()?;
    match label {
        FLOATING_WINDOW_LABEL => Some(state.floating.generation),
        FLOATING_PANEL_WINDOW_LABEL => Some(state.floating_panel.generation),
        FLOATING_NOTIFICATION_WINDOW_LABEL => Some(state.floating_notification.generation),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn scheduled_floating_taskbar_style_recheck_generation(label: &str) -> Option<u64> {
    let state = floating_taskbar_style_recheck_state().lock().ok()?;
    match label {
        FLOATING_WINDOW_LABEL => state.floating.scheduled_generation,
        FLOATING_PANEL_WINDOW_LABEL => state.floating_panel.scheduled_generation,
        FLOATING_NOTIFICATION_WINDOW_LABEL => state.floating_notification.scheduled_generation,
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn begin_floating_taskbar_style_recheck(label: &str) -> Option<(u64, bool)> {
    let mut state = floating_taskbar_style_recheck_state().lock().ok()?;
    let slot = floating_taskbar_style_recheck_slot_mut(&mut state, label)?;
    slot.generation = slot.generation.wrapping_add(1);
    slot.scheduled_generation = Some(slot.generation);
    let start_worker = !slot.worker_active;
    slot.worker_active = true;
    let generation = slot.generation;
    drop(state);
    if !start_worker {
        floating_taskbar_style_recheck_notification(label)?.notify_one();
    }
    Some((generation, start_worker))
}

#[cfg(target_os = "windows")]
fn invalidate_floating_taskbar_style_recheck(label: &str) {
    let Ok(mut state) = floating_taskbar_style_recheck_state().lock() else {
        return;
    };
    let Some(slot) = floating_taskbar_style_recheck_slot_mut(&mut state, label) else {
        return;
    };
    slot.generation = slot.generation.wrapping_add(1);
    slot.scheduled_generation = None;
    drop(state);
    if let Some(notification) = floating_taskbar_style_recheck_notification(label) {
        notification.notify_one();
    }
}

#[cfg(target_os = "windows")]
fn finish_floating_taskbar_style_recheck_worker(label: &str) -> bool {
    let Ok(mut state) = floating_taskbar_style_recheck_state().lock() else {
        return false;
    };
    let Some(slot) = floating_taskbar_style_recheck_slot_mut(&mut state, label) else {
        return false;
    };
    if slot.scheduled_generation.is_some() {
        true
    } else {
        slot.worker_active = false;
        false
    }
}

#[cfg(target_os = "windows")]
fn apply_floating_taskbar_hidden_style(window: &WebviewWindow) {
    let _ = window.set_skip_taskbar(true);
    configure_native_floating_window(window, 0, 0);
}

#[cfg(target_os = "windows")]
fn schedule_floating_taskbar_style_rechecks(app: AppHandle, label: &'static str) {
    tauri::async_runtime::spawn(async move {
        loop {
            let Some(captured_generation) =
                scheduled_floating_taskbar_style_recheck_generation(label)
            else {
                if !finish_floating_taskbar_style_recheck_worker(label) {
                    return;
                }
                continue;
            };
            let Some(notification) = floating_taskbar_style_recheck_notification(label) else {
                return;
            };
            let mut superseded = false;
            let mut previous_delay_ms = 0;

            for delay_ms in FLOATING_TASKBAR_STYLE_RECHECK_DELAYS_MS {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(delay_ms - previous_delay_ms)) => {}
                    _ = notification.notified() => {
                        superseded = true;
                    }
                }
                previous_delay_ms = delay_ms;
                if superseded {
                    break;
                }
                let app_for_main_thread = app.clone();
                let _ = app.run_on_main_thread(move || {
                    let Some(window) = app_for_main_thread.get_webview_window(label) else {
                        return;
                    };
                    let current_generation = floating_taskbar_style_recheck_generation(label);
                    let visible = window.is_visible().unwrap_or(false);
                    if current_generation
                        .map(|current| {
                            should_recheck_floating_taskbar_style(
                                label,
                                current,
                                captured_generation,
                                visible,
                            )
                        })
                        .unwrap_or(false)
                    {
                        apply_floating_taskbar_hidden_style(&window);
                    }
                });
            }

            if superseded {
                continue;
            }
            if let Ok(mut state) = floating_taskbar_style_recheck_state().lock() {
                if let Some(slot) = floating_taskbar_style_recheck_slot_mut(&mut state, label) {
                    if slot.scheduled_generation == Some(captured_generation) {
                        slot.scheduled_generation = None;
                    }
                }
            }
            if !finish_floating_taskbar_style_recheck_worker(label) {
                return;
            }
        }
    });
}

pub(crate) fn show_floating_window(window: &WebviewWindow, focus: bool) {
    let app = window.app_handle().clone();
    let app_for_main_thread = app.clone();
    let window_label = window.label().to_owned();
    let visibility_generation = record_floating_auxiliary_visibility_intent(&window_label, true);
    #[cfg(target_os = "windows")]
    let floating_label: Option<&'static str> = match window_label.as_str() {
        FLOATING_WINDOW_LABEL => Some(FLOATING_WINDOW_LABEL),
        FLOATING_PANEL_WINDOW_LABEL => Some(FLOATING_PANEL_WINDOW_LABEL),
        FLOATING_NOTIFICATION_WINDOW_LABEL => Some(FLOATING_NOTIFICATION_WINDOW_LABEL),
        _ => None,
    };

    // Tauri 会把 async worker 的窗口命令排入事件循环, 因此必须在主线程完成完整显示序列,
    // 才能保证 Win32 修复真实发生在 show/unminimize 之后.
    let _ = app.run_on_main_thread(move || {
        if let Some(captured_generation) = visibility_generation {
            let Some((current_generation, requested_visible)) =
                read_floating_auxiliary_visibility_intent(&window_label)
            else {
                return;
            };
            if !should_apply_floating_auxiliary_show(
                &window_label,
                current_generation,
                captured_generation,
                requested_visible,
            ) {
                return;
            }
        }
        let Some(window) = app_for_main_thread.get_webview_window(&window_label) else {
            return;
        };

        let _ = window.set_skip_taskbar(true);
        #[cfg(target_os = "windows")]
        if floating_label.is_some() {
            install_floating_taskbar_style_subclass(&window);
        }
        let _ = window.show();
        let _ = window.unminimize();
        #[cfg(target_os = "windows")]
        if let Some(label) = floating_label {
            apply_floating_taskbar_hidden_style(&window);
            if let Some((_generation, start_worker)) = begin_floating_taskbar_style_recheck(label) {
                if start_worker {
                    schedule_floating_taskbar_style_rechecks(app_for_main_thread.clone(), label);
                }
            }
        }
        if focus {
            let _ = window.set_focus();
        }
    });
}

fn show_floating_notification_window(window: &WebviewWindow) {
    show_floating_window(window, false);
}

fn emit_floating_notification_lifecycle_pause(app: &AppHandle, reason: &'static str, paused: bool) {
    let _ = app.emit_to(
        FLOATING_NOTIFICATION_WINDOW_LABEL,
        "floating-notification-lifecycle-pause",
        FloatingNotificationLifecyclePausePayload { reason, paused },
    );
}

/// 同步原生悬浮面板显隐状态到悬浮球和面板 WebView，避免两者状态分叉。
fn emit_floating_native_panel_visibility(app: &AppHandle, visible: bool) {
    let payload = FloatingNativePanelVisibilityPayload { visible };
    let _ = app.emit_to(
        FLOATING_WINDOW_LABEL,
        "floating-native-panel-visibility",
        payload.clone(),
    );
    let _ = app.emit_to(
        FLOATING_PANEL_WINDOW_LABEL,
        "floating-native-panel-visibility",
        payload,
    );
}

pub(crate) fn hide_floating_auxiliary_window(app: &AppHandle, label: &str) {
    if !is_floating_auxiliary_window_label(label) {
        return;
    }
    // 先使已入队的 show 失效，再隐藏窗口，避免旧任务在 hide 之后重新显示空壳窗口。
    let _ = record_floating_auxiliary_visibility_intent(label, false);
    #[cfg(target_os = "windows")]
    invalidate_floating_taskbar_style_recheck(label);
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.hide();
    }
}

fn hide_window(app: &AppHandle, label: &str) {
    if is_floating_auxiliary_window_label(label) {
        hide_floating_auxiliary_window(app, label);
        return;
    }
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.hide();
    }
}

pub(crate) fn hide_floating_notification_window(app: &AppHandle) {
    emit_floating_notification_lifecycle_pause(app, "notification-window-hidden", true);
    hide_window(app, FLOATING_NOTIFICATION_WINDOW_LABEL);
}

fn is_window_visible(app: &AppHandle, label: &str) -> bool {
    app.get_webview_window(label)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

/// 返回面板窗口的真实原生可见状态，供独立 WebView 在事件漏收后回读。
pub(crate) fn is_floating_panel_visible(app: &AppHandle) -> bool {
    is_window_visible(app, FLOATING_PANEL_WINDOW_LABEL)
}

fn clamp_i32(value: i32, min: i32, max: i32) -> i32 {
    value.max(min).min(max)
}

fn monitor_to_physical_work_area(monitor: tauri::Monitor) -> (i32, i32, i32, i32) {
    let work_area = monitor.work_area();
    (
        work_area.position.x,
        work_area.position.y,
        work_area.size.width as i32,
        work_area.size.height as i32,
    )
}

fn resolve_monitor_work_area(
    app: &AppHandle,
    point_x: i32,
    point_y: i32,
) -> Option<(i32, i32, i32, i32)> {
    let to_physical = |monitor: tauri::Monitor| monitor_to_physical_work_area(monitor);

    if let Ok(monitors) = app.available_monitors() {
        for monitor in monitors {
            let (x, y, width, height) = to_physical(monitor);
            if point_x >= x && point_x < x + width && point_y >= y && point_y < y + height {
                return Some((x, y, width, height));
            }
        }
    }

    app.primary_monitor().ok().flatten().map(to_physical)
}

fn resolve_floating_dock_for_size(
    work_area_x: i32,
    work_area_width: i32,
    orb_x: i32,
    orb_width: i32,
) -> &'static str {
    let center_x = orb_x + orb_width / 2;
    if center_x <= work_area_x + work_area_width / 2 {
        "left"
    } else {
        "right"
    }
}

fn resolve_floating_notification_dock_for_size(
    work_area_x: i32,
    work_area_width: i32,
    orb_x: i32,
    orb_width: i32,
) -> FloatingNotificationDock {
    match resolve_floating_dock_for_size(work_area_x, work_area_width, orb_x, orb_width) {
        "left" => FloatingNotificationDock::Left,
        _ => FloatingNotificationDock::Right,
    }
}

fn compute_snapped_orb_position_for_size(
    work_area_x: i32,
    work_area_y: i32,
    work_area_width: i32,
    work_area_height: i32,
    orb_x: i32,
    orb_y: i32,
    orb_width: i32,
    orb_height: i32,
    geometry: FloatingGeometry,
) -> (i32, i32, &'static str) {
    let dock = resolve_floating_dock_for_size(work_area_x, work_area_width, orb_x, orb_width);
    let min_y = work_area_y + geometry.safe_margin;
    let max_y = work_area_y + work_area_height - orb_height - geometry.safe_margin;
    let snapped_y = clamp_i32(orb_y, min_y, max_y.max(min_y));
    let snapped_x = if dock == "left" {
        work_area_x - geometry.edge_hide
    } else {
        work_area_x + work_area_width - orb_width + geometry.edge_hide
    };
    (snapped_x, snapped_y, dock)
}

fn compute_release_orb_position_for_size(
    work_area_x: i32,
    work_area_y: i32,
    work_area_width: i32,
    work_area_height: i32,
    orb_x: i32,
    orb_y: i32,
    orb_width: i32,
    orb_height: i32,
    geometry: FloatingGeometry,
) -> (i32, i32, &'static str) {
    let min_y = work_area_y + geometry.safe_margin;
    let max_y = work_area_y + work_area_height - orb_height - geometry.safe_margin;
    let next_y = clamp_i32(orb_y, min_y, max_y.max(min_y));
    let orb_right = orb_x + orb_width;
    let work_area_right = work_area_x + work_area_width;
    let distance_to_left = (orb_x - work_area_x).abs();
    let distance_to_right = (work_area_right - orb_right).abs();
    let should_snap_left = distance_to_left <= geometry.edge_snap_threshold;
    let should_snap_right = distance_to_right <= geometry.edge_snap_threshold;

    if should_snap_left || should_snap_right {
        return compute_snapped_orb_position_for_size(
            work_area_x,
            work_area_y,
            work_area_width,
            work_area_height,
            orb_x,
            orb_y,
            orb_width,
            orb_height,
            geometry,
        );
    }

    let min_x = work_area_x;
    let max_x = work_area_x + work_area_width - orb_width;
    let next_x = clamp_i32(orb_x, min_x, max_x.max(min_x));
    let dock = resolve_floating_dock_for_size(work_area_x, work_area_width, next_x, orb_width);
    (next_x, next_y, dock)
}

fn compute_panel_position_for_size(
    work_area_y: i32,
    work_area_height: i32,
    orb_x: i32,
    orb_y: i32,
    dock: &str,
    orb_width: i32,
    panel_width: i32,
    panel_height: i32,
    geometry: FloatingGeometry,
) -> (i32, i32) {
    let panel_y = clamp_i32(
        orb_y - panel_height,
        work_area_y + geometry.safe_margin,
        (work_area_y + work_area_height - panel_height - geometry.safe_margin)
            .max(work_area_y + geometry.safe_margin),
    );
    let panel_x = if dock == "left" {
        orb_x + orb_width + geometry.panel_gap
    } else {
        orb_x - panel_width - geometry.panel_gap
    };
    (panel_x, panel_y)
}

#[cfg(test)]
fn compute_panel_position(
    work_area_y: i32,
    work_area_height: i32,
    orb_x: i32,
    orb_y: i32,
    dock: &str,
) -> (i32, i32) {
    compute_panel_position_for_size(
        work_area_y,
        work_area_height,
        orb_x,
        orb_y,
        dock,
        FLOATING_ORB_SIZE as i32,
        FLOATING_PANEL_WIDTH as i32,
        FLOATING_PANEL_HEIGHT as i32,
        FloatingGeometry::for_scale(1.0),
    )
}

fn resolve_floating_notification_width(detail_open: bool) -> i32 {
    if detail_open {
        FLOATING_NOTIFICATION_DETAIL_WIDTH
    } else {
        FLOATING_NOTIFICATION_WIDTH
    }
}

fn resolve_floating_notification_item_height(
    item: &FloatingNotificationPayload,
    layout: FloatingNotificationLayout,
) -> i32 {
    if item.usage.is_some() {
        layout.usage_item_height
    } else {
        layout.compact_item_height
    }
}

fn resolve_floating_notification_item_heights(
    items: &[FloatingNotificationPayload],
    layout: FloatingNotificationLayout,
) -> Vec<i32> {
    resolve_floating_notification_visible_items(items, layout)
        .into_iter()
        .map(|item| resolve_floating_notification_item_height(item, layout))
        .collect()
}

fn resolve_floating_notification_visible_items(
    items: &[FloatingNotificationPayload],
    layout: FloatingNotificationLayout,
) -> Vec<&FloatingNotificationPayload> {
    items.iter().take(layout.max_visible).collect()
}

fn resolve_floating_notification_height_for_items(
    item_heights: &[i32],
    layout: FloatingNotificationLayout,
) -> i32 {
    let rows = item_heights.len().clamp(1, layout.max_visible) as i32;
    let content_height = item_heights
        .iter()
        .take(layout.max_visible)
        .copied()
        .sum::<i32>();
    (content_height + (rows - 1) * layout.item_gap + layout.vertical_padding)
        .clamp(layout.min_height(), layout.max_height())
}

fn resolve_floating_notification_detail_open(requested_open: bool, item_count: usize) -> bool {
    requested_open && item_count > 0
}

fn resolve_floating_notification_window_height(
    item_count: usize,
    detail_open: bool,
    work_area_height: i32,
    layout: FloatingNotificationLayout,
) -> i32 {
    if !detail_open {
        let item_heights = vec![layout.usage_item_height; item_count.clamp(1, layout.max_visible)];
        return resolve_floating_notification_height_for_items(&item_heights, layout);
    }

    let available_height = (work_area_height - FLOATING_SAFE_MARGIN * 2).max(layout.min_height());
    FLOATING_NOTIFICATION_DETAIL_HEIGHT.min(available_height)
}

fn resolve_floating_notification_physical_size(
    logical_width: i32,
    logical_height: i32,
    scale_factor: f64,
) -> (i32, i32) {
    (
        logical_to_physical(logical_width, scale_factor),
        logical_to_physical(logical_height, scale_factor),
    )
}

fn compute_floating_notification_position_for_geometry(
    work_area_x: i32,
    work_area_y: i32,
    work_area_width: i32,
    work_area_height: i32,
    anchor_left: i32,
    anchor_top: i32,
    anchor_right: i32,
    anchor_bottom: i32,
    notification_width: i32,
    notification_height: i32,
    geometry: FloatingGeometry,
) -> (i32, i32) {
    let min_x = work_area_x + geometry.safe_margin;
    let max_x =
        (work_area_x + work_area_width - notification_width - geometry.safe_margin).max(min_x);
    let anchor_width = (anchor_right - anchor_left).max(0);
    let x = clamp_i32(
        anchor_left + (anchor_width - notification_width) / 2,
        min_x,
        max_x,
    );

    let min_y = work_area_y + geometry.safe_margin;
    let max_y =
        (work_area_y + work_area_height - notification_height - geometry.safe_margin).max(min_y);
    let above_y = anchor_top - geometry.notification_gap - notification_height;
    let y = if above_y >= min_y {
        above_y
    } else {
        clamp_i32(anchor_bottom + geometry.notification_gap, min_y, max_y)
    };

    (x, y)
}

fn compute_floating_notification_position(
    work_area_x: i32,
    work_area_y: i32,
    work_area_width: i32,
    work_area_height: i32,
    anchor_left: i32,
    anchor_top: i32,
    anchor_right: i32,
    anchor_bottom: i32,
    notification_width: i32,
    notification_height: i32,
) -> (i32, i32) {
    compute_floating_notification_position_for_geometry(
        work_area_x,
        work_area_y,
        work_area_width,
        work_area_height,
        anchor_left,
        anchor_top,
        anchor_right,
        anchor_bottom,
        notification_width,
        notification_height,
        FloatingGeometry::for_scale(1.0),
    )
}

#[cfg(target_os = "windows")]
fn toggle_floating_panel_native(shared: &Arc<Mutex<FloatingNativeState>>) {
    let (panel_hwnd, cached_visible) = {
        let Ok(state) = shared.lock() else {
            return;
        };
        (state.panel_hwnd, state.panel_visible)
    };
    let is_visible = resolve_floating_native_panel_visible(
        cached_visible,
        panel_hwnd.and_then(native_window_visible),
    );

    if is_visible != cached_visible {
        if let Ok(mut state) = shared.lock() {
            state.panel_visible = is_visible;
            state.hide_since = None;
            state.hover_since = None;
        }
    }

    if is_visible {
        hide_floating_panel_native(shared);
    } else {
        show_floating_panel_native(shared);
    }
}

fn resolve_floating_notification_hit_regions_for_items(
    item_heights: &[i32],
    detail_open: bool,
    width: i32,
    height: i32,
    layout: FloatingNotificationLayout,
) -> Vec<FloatingNotificationHitRegion> {
    const HORIZONTAL_INSET: i32 = 4;
    const DETAIL_INSET: i32 = 4;
    const DETAIL_CORNER_RADIUS: i32 = 8;

    let surface_width = (width - HORIZONTAL_INSET * 2).max(1);
    if detail_open {
        return vec![FloatingNotificationHitRegion {
            x: HORIZONTAL_INSET,
            y: DETAIL_INSET,
            width: surface_width,
            height: (height - DETAIL_INSET * 2).max(1),
            corner_radius: DETAIL_CORNER_RADIUS,
        }];
    }

    let mut offset = layout.vertical_padding / 2;
    item_heights
        .iter()
        .rev()
        .take(layout.max_visible)
        .map(|item_height| {
            let region = FloatingNotificationHitRegion {
                x: HORIZONTAL_INSET,
                y: height - offset - *item_height,
                width: surface_width,
                height: *item_height,
                corner_radius: 8,
            };
            offset += *item_height + layout.item_gap;
            region
        })
        .collect()
}

/** 动效期间合并卡片间隙，避免 SetWindowRgn 裁断正在补位的卡片。 */
fn resolve_floating_notification_regions_for_motion(
    item_heights: &[i32],
    detail_open: bool,
    width: i32,
    height: i32,
    layout: FloatingNotificationLayout,
    motion_active: bool,
) -> Vec<FloatingNotificationHitRegion> {
    let regions = resolve_floating_notification_hit_regions_for_items(
        item_heights,
        detail_open,
        width,
        height,
        layout,
    );
    if detail_open || !motion_active || regions.len() < 2 {
        return regions;
    }

    let top = regions.iter().map(|region| region.y).min().unwrap_or(0);
    let bottom = regions
        .iter()
        .map(|region| region.y + region.height)
        .max()
        .unwrap_or(height);
    let first = regions[0];
    vec![FloatingNotificationHitRegion {
        x: first.x,
        y: top,
        width: first.width,
        height: (bottom - top).max(1),
        corner_radius: first.corner_radius,
    }]
}

/** 将逻辑卡片区域转换为 Win32 Region 边界，并保留最右列与最下行边框像素。 */
fn resolve_floating_notification_native_round_rect(
    region: FloatingNotificationHitRegion,
    logical_width: i32,
    logical_height: i32,
    client_width: i32,
    client_height: i32,
) -> FloatingNotificationNativeRoundRect {
    let client_width = client_width.max(1);
    let client_height = client_height.max(1);
    let scale_x = client_width as f64 / logical_width.max(1) as f64;
    let scale_y = client_height as f64 / logical_height.max(1) as f64;
    let scaled_right = ((region.x + region.width) as f64 * scale_x).round() as i32;
    let scaled_bottom = ((region.y + region.height) as f64 * scale_y).round() as i32;

    FloatingNotificationNativeRoundRect {
        left: (region.x as f64 * scale_x).round() as i32,
        top: (region.y as f64 * scale_y).round() as i32,
        right: scaled_right.saturating_add(1).min(client_width),
        bottom: scaled_bottom.saturating_add(1).min(client_height),
        radius_x: ((region.corner_radius * 2) as f64 * scale_x)
            .round()
            .max(1.0) as i32,
        radius_y: ((region.corner_radius * 2) as f64 * scale_y)
            .round()
            .max(1.0) as i32,
    }
}

/** 将通知窗口的位置和尺寸放在同一个 Win32 提交中，避免透明窗口暴露中间几何帧。 */
#[cfg(target_os = "windows")]
fn try_set_floating_notification_window_bounds(
    window: &WebviewWindow,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> bool {
    use std::ffi::c_void;

    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;

    unsafe extern "system" {
        fn GetWindowRect(hwnd: *mut c_void, rect: *mut NativeRect) -> i32;
        fn SetWindowPos(
            hwnd: *mut c_void,
            hwnd_insert_after: *mut c_void,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
    }

    let Ok(hwnd) = window.hwnd() else {
        return false;
    };
    let width = width.max(1);
    let height = height.max(1);

    unsafe {
        let raw = hwnd.0 as *mut c_void;
        let mut current = NativeRect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if GetWindowRect(raw, &mut current) == 0 {
            return false;
        }
        if current.left == x
            && current.top == y
            && current.right - current.left == width
            && current.bottom - current.top == height
        {
            return true;
        }

        SetWindowPos(
            raw,
            std::ptr::null_mut(),
            x,
            y,
            width,
            height,
            SWP_NOZORDER | SWP_NOACTIVATE,
        ) != 0
    }
}

#[cfg(not(target_os = "windows"))]
fn try_set_floating_notification_window_bounds(
    _window: &WebviewWindow,
    _x: i32,
    _y: i32,
    _width: i32,
    _height: i32,
) -> bool {
    false
}

fn set_floating_notification_window_bounds(
    window: &WebviewWindow,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) {
    if try_set_floating_notification_window_bounds(window, x, y, width, height) {
        return;
    }

    let width = width.max(1) as u32;
    let height = height.max(1) as u32;
    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
        width, height,
    )));
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

#[cfg(target_os = "windows")]
fn configure_floating_notification_hit_region(
    window: &WebviewWindow,
    item_heights: &[i32],
    detail_open: bool,
    logical_width: i32,
    logical_height: i32,
    layout: FloatingNotificationLayout,
    motion_active: bool,
) {
    use std::ffi::c_void;

    const RGN_OR: i32 = 2;

    unsafe extern "system" {
        fn GetClientRect(hwnd: *mut c_void, rect: *mut NativeRect) -> i32;
        fn CreateRoundRectRgn(
            left: i32,
            top: i32,
            right: i32,
            bottom: i32,
            width: i32,
            height: i32,
        ) -> *mut c_void;
        fn CombineRgn(
            destination: *mut c_void,
            source_one: *mut c_void,
            source_two: *mut c_void,
            mode: i32,
        ) -> i32;
        fn SetWindowRgn(hwnd: *mut c_void, region: *mut c_void, redraw: i32) -> i32;
        fn DeleteObject(object: *mut c_void) -> i32;
    }

    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    unsafe {
        let raw = hwnd.0 as *mut c_void;
        let mut client_rect = NativeRect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if GetClientRect(raw, &mut client_rect) == 0 {
            return;
        }

        let client_width = (client_rect.right - client_rect.left).max(1);
        let client_height = (client_rect.bottom - client_rect.top).max(1);
        let regions = resolve_floating_notification_regions_for_motion(
            item_heights,
            detail_open,
            logical_width,
            logical_height,
            layout,
            motion_active,
        );
        let Some(first) = regions.first() else {
            return;
        };

        let to_native_region = |region: FloatingNotificationHitRegion| {
            let bounds = resolve_floating_notification_native_round_rect(
                region,
                logical_width,
                logical_height,
                client_width,
                client_height,
            );
            CreateRoundRectRgn(
                bounds.left,
                bounds.top,
                bounds.right,
                bounds.bottom,
                bounds.radius_x,
                bounds.radius_y,
            )
        };

        let combined = to_native_region(*first);
        if combined.is_null() {
            return;
        }

        for region in regions.iter().skip(1) {
            let next = to_native_region(*region);
            if next.is_null() {
                continue;
            }
            let _ = CombineRgn(combined, combined, next, RGN_OR);
            let _ = DeleteObject(next);
        }

        if SetWindowRgn(raw, combined, 0) == 0 {
            let _ = DeleteObject(combined);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn configure_floating_notification_hit_region(
    _window: &WebviewWindow,
    _item_heights: &[i32],
    _detail_open: bool,
    _logical_width: i32,
    _logical_height: i32,
    _layout: FloatingNotificationLayout,
    _motion_active: bool,
) {
}

pub(crate) fn open_main_window_from_native(app: &AppHandle, navigation: &str) {
    let ctx = app.state::<application::AppContext>();
    if let Ok(prefs) = application::desktop_ui_service::set_launch_mode(
        &ctx,
        crate::contracts::AppLaunchMode::Main,
    ) {
        if let Err(error) = request_main_window_activation_after_startup_handoff(
            app,
            &prefs,
            Some(navigation),
            "原生通知打开主窗口",
        ) {
            log::warn!("[window] {error}");
            return;
        }
        let _ = app.emit("desktop-ui-prefs-updated", &prefs);
    }
}

#[cfg(target_os = "windows")]
fn poll_floating_native_tick(shared: Arc<Mutex<FloatingNativeState>>) {
    let (
        app,
        orb_hwnd,
        panel_hwnd,
        cached_panel_visible,
        cached_pointer_near_orb,
        last_geometry_cursor,
        last_orb_hit,
        last_orb_drag_hit,
        last_panel_hit,
        last_geometry_sample_at,
    ) = {
        let Ok(mut state) = shared.lock() else {
            return;
        };
        state.poll_tick_pending = false;
        (
            state.app.clone(),
            state.orb_hwnd,
            state.panel_hwnd,
            state.panel_visible,
            state.pointer_near_orb,
            state.last_geometry_cursor,
            state.last_orb_hit,
            state.last_orb_drag_hit,
            state.last_panel_hit,
            state.last_geometry_sample_at,
        )
    };
    let orb_visible = native_window_visible(orb_hwnd).unwrap_or(false);

    if orb_hwnd == 0 {
        return;
    }

    // Tauri 的窗口状态可能在外部 hide/show 后短暂滞后。轮询器以 HWND
    // 的真实可见性校正缓存，避免非固定菜单失去自动收起和点击切换能力。
    let panel_visible = resolve_floating_native_panel_visible(
        cached_panel_visible,
        panel_hwnd.and_then(native_window_visible),
    );
    let panel_visibility_drifted = panel_visible != cached_panel_visible;
    if panel_visibility_drifted {
        if let Ok(mut state) = shared.lock() {
            state.panel_visible = panel_visible;
            state.hide_since = None;
            state.hover_since = None;
            state.last_geometry_sample_at = None;
        }

        emit_floating_native_panel_visibility(&app, panel_visible);
        let _ = app.emit_to(
            FLOATING_NOTIFICATION_WINDOW_LABEL,
            "floating-notification-panel-visibility",
            FloatingNativePanelVisibilityPayload {
                visible: panel_visible,
            },
        );
        if panel_visible {
            hide_floating_notification_window(&app);
        } else if orb_visible {
            let _ = sync_floating_notification_window(&app);
        }
    }

    if !orb_visible && !panel_visible {
        if let Ok(mut state) = shared.lock() {
            state.pointer_near_orb = false;
        }
        return;
    }

    let mut cursor = NativePoint { x: 0, y: 0 };
    unsafe {
        let _ = GetCursorPos(&mut cursor);
    }
    let keep_panel_visible = read_cached_keep_panel_visible(&shared);
    let left_down = unsafe { (GetAsyncKeyState(0x01) as u16 & 0x8000) != 0 };
    let cursor_position = (cursor.x, cursor.y);
    let should_sample_geometry = should_sample_floating_native_geometry(
        cached_pointer_near_orb,
        left_down,
        last_geometry_cursor,
        cursor_position,
        last_geometry_sample_at.map(|sampled_at| sampled_at.elapsed()),
    );
    let (orb_hit, orb_drag_hit, panel_hit) = if should_sample_geometry {
        // Reuse one native geometry snapshot per window for all hit checks in this tick.
        let orb_rect = get_window_rect(orb_hwnd);
        let panel_rect = panel_hwnd.and_then(get_window_rect);
        let (orb_hit, orb_drag_hit) = orb_rect
            .as_ref()
            .map(|rect| resolve_floating_orb_hit_zones(&app, rect, cursor.x, cursor.y))
            .unwrap_or((false, false));
        let panel_hit = panel_rect
            .as_ref()
            .map(|rect| point_inside_native_rect(rect, cursor.x, cursor.y))
            .unwrap_or(false);
        (orb_hit, orb_drag_hit, panel_hit)
    } else {
        (last_orb_hit, last_orb_drag_hit, last_panel_hit)
    };

    let should_begin_pointer_session = shared
        .lock()
        .map(|state| left_down && !state.last_left_down && !state.pointer_down && orb_drag_hit)
        .unwrap_or(false);
    if should_begin_pointer_session {
        begin_floating_native_pointer_session(&shared, &cursor);
    }

    let mut hide_panel = false;
    let mut show_panel = false;
    let mut toggle_panel = false;
    let mut snap_orb = false;
    let mut move_to: Option<(i32, i32)> = None;
    let mut reposition_notification = false;
    let mut lifecycle_drag_started = false;
    let mut lifecycle_drag_finished = false;
    let mut restore_drag_surfaces: Option<FloatingDragSurfaceSnapshot> = None;

    {
        let Ok(mut state) = shared.lock() else {
            return;
        };

        state.pointer_near_orb = orb_hit;
        if should_sample_geometry {
            state.last_geometry_cursor = Some(cursor_position);
            state.last_orb_hit = orb_hit;
            state.last_orb_drag_hit = orb_drag_hit;
            state.last_panel_hit = panel_hit;
            state.last_geometry_sample_at = Some(Instant::now());
        }

        if keep_panel_visible {
            state.hide_since = None;
        } else if orb_hit || panel_hit {
            state.hide_since = None;
        } else if state.panel_visible && !state.pointer_down {
            match state.hide_since {
                Some(since) if since.elapsed() >= Duration::from_millis(260) => {
                    hide_panel = true;
                    state.hide_since = None;
                }
                Some(_) => {}
                None => {
                    state.hide_since = Some(Instant::now());
                }
            }
        }

        let hover_suppressed = state
            .suppress_hover_until
            .map(|until| until > Instant::now())
            .unwrap_or(false);

        if keep_panel_visible {
            state.hover_reentry_required = false;
            state.hover_since = None;
            if should_auto_show_floating_panel_for_keep_visible(
                keep_panel_visible,
                state.pointer_down,
                state.drag_started,
                state.panel_visible,
                hover_suppressed,
            ) {
                show_panel = true;
            }
        } else if orb_hit && !state.pointer_down {
            if hover_suppressed || state.hover_reentry_required {
                state.hover_since = None;
            } else {
                match state.hover_since {
                    Some(since)
                        if !state.panel_visible
                            && since.elapsed() >= Duration::from_millis(240) =>
                    {
                        show_panel = true;
                    }
                    Some(_) => {}
                    None => {
                        state.hover_since = Some(Instant::now());
                    }
                }
            }
        } else if !panel_hit {
            state.hover_reentry_required = false;
            state.hover_since = None;
        }

        if left_down && state.pointer_down {
            let delta_x = cursor.x - state.down_x;
            let delta_y = cursor.y - state.down_y;
            if !state.drag_started
                && floating_drag_threshold_exceeded(delta_x, delta_y, state.drag_threshold)
            {
                state.drag_started = true;
                state.drag_surfaces_suppressed = true;
                lifecycle_drag_started = true;
            }
            if state.drag_started {
                state.drag_current_x = state.orb_origin_x + delta_x;
                state.drag_current_y = state.orb_origin_y + delta_y;
                let next_position = (state.drag_current_x, state.drag_current_y);
                if should_apply_floating_native_position(
                    state.last_applied_orb_position,
                    next_position,
                    false,
                ) {
                    state.last_applied_orb_position = Some(next_position);
                    move_to = Some(next_position);
                }
            }
        } else if !left_down && state.pointer_down {
            let dragged = state.drag_started;
            state.pointer_down = false;
            state.drag_started = false;
            if dragged {
                lifecycle_drag_finished = true;
                restore_drag_surfaces = state.drag_surface_restore;
                state.suppress_hover_until = Some(Instant::now() + Duration::from_millis(400));
                snap_orb = true;
            } else if !keep_panel_visible {
                state.suppress_hover_until = Some(Instant::now() + Duration::from_millis(260));
                state.hover_reentry_required = state.panel_visible;
                toggle_panel = true;
            }
        }

        state.last_left_down = left_down;
    }

    if lifecycle_drag_started {
        let snapshot = capture_floating_drag_surface_snapshot(
            panel_visible,
            is_window_visible(&app, FLOATING_NOTIFICATION_WINDOW_LABEL),
            FLOATING_NOTIFICATION_DETAIL_OPEN.load(Ordering::Relaxed),
        );
        if let Ok(mut state) = shared.lock() {
            if state.drag_started && state.drag_surfaces_suppressed {
                state.drag_surface_restore = Some(snapshot);
            }
        }
        emit_floating_notification_lifecycle_pause(&app, "floating-panel-drag", true);
        hide_floating_panel_for_native_drag(&shared);
        hide_floating_notification_window(&app);
    }
    if hide_panel {
        hide_floating_panel_native(&shared);
    }
    if let Some((x, y)) = move_to {
        let orb_hwnd = {
            let Ok(state) = shared.lock() else {
                return;
            };
            state.orb_hwnd
        };
        if orb_hwnd != 0 {
            move_window_by_hwnd(orb_hwnd, x, y);
        }
    }
    if snap_orb {
        snap_orb_to_edge_native(&shared);
    }
    if toggle_panel {
        toggle_floating_panel_native(&shared);
        reposition_notification = true;
    } else if show_panel {
        show_floating_panel_native(&shared);
        reposition_notification = true;
    }
    if reposition_notification {
        reposition_floating_notification_window(&app);
    }
    if lifecycle_drag_finished {
        if let Some(snapshot) = restore_drag_surfaces {
            restore_floating_drag_surfaces(&shared, snapshot);
        }
        let release_native_drag_pause = if let Ok(mut state) = shared.lock() {
            state.drag_surface_restore = None;
            take_floating_native_drag_pause_release(&mut state.drag_surfaces_suppressed)
        } else {
            false
        };
        if release_native_drag_pause {
            emit_floating_notification_lifecycle_pause(&app, "floating-panel-drag", false);
        }
    }
}

#[cfg(target_os = "windows")]
fn schedule_floating_native_poll_tick(shared: &Arc<Mutex<FloatingNativeState>>) -> bool {
    let tick_shared = Arc::clone(shared);
    let dispatch_result = {
        let Ok(mut state) = shared.lock() else {
            return true;
        };
        if !should_schedule_floating_native_poll_tick(state.poll_tick_pending) {
            return true;
        }
        state.poll_tick_pending = true;
        // Wry 只允许后台线程经 event-loop proxy 投递任务，不能在这里 clone AppHandle。
        state
            .app
            .run_on_main_thread(move || poll_floating_native_tick(tick_shared))
    };

    if let Err(error) = dispatch_result {
        if let Ok(mut state) = shared.lock() {
            state.poll_tick_pending = false;
        }
        log::warn!("floating native poller stopped because main-thread dispatch failed: {error}");
        return false;
    }
    true
}

#[cfg(target_os = "windows")]
fn start_floating_native_poller(shared: Arc<Mutex<FloatingNativeState>>) {
    log::info!("floating native poller uses main-thread Tauri dispatch");
    tauri::async_runtime::spawn(async move {
        loop {
            let Some((orb_hwnd, panel_visible, dragging, pointer_near_orb)) =
                shared.lock().ok().map(|state| {
                    (
                        state.orb_hwnd,
                        state.panel_visible,
                        state.pointer_down || state.drag_started,
                        state.pointer_near_orb,
                    )
                })
            else {
                tokio::time::sleep(Duration::from_millis(FLOATING_NATIVE_HIDDEN_POLL_MS)).await;
                continue;
            };
            let orb_visible = native_window_visible(orb_hwnd).unwrap_or(false);
            let poll_delay_ms = resolve_floating_native_poll_ms_with_pointer_near_orb(
                orb_visible,
                panel_visible,
                dragging,
                pointer_near_orb,
            );
            tokio::time::sleep(Duration::from_millis(poll_delay_ms)).await;

            if !schedule_floating_native_poll_tick(&shared) {
                return;
            }
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn start_floating_native_poller(_shared: Arc<Mutex<FloatingNativeState>>) {}

#[cfg(target_os = "windows")]
fn show_floating_panel_native(shared: &Arc<Mutex<FloatingNativeState>>) {
    show_floating_panel_native_with_drag_restore(shared, false);
}

#[cfg(target_os = "windows")]
fn show_floating_panel_after_native_drag(shared: &Arc<Mutex<FloatingNativeState>>) {
    show_floating_panel_native_with_drag_restore(shared, true);
}

#[cfg(target_os = "windows")]
fn schedule_floating_panel_sync_replay(
    app: AppHandle,
    shared: Arc<Mutex<FloatingNativeState>>,
    dock: &'static str,
    x: i32,
    y: i32,
) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(FLOATING_PANEL_SYNC_REPLAY_DELAY_MS)).await;
        let active_panel = {
            let Ok(state) = shared.lock() else {
                return;
            };
            if !should_replay_floating_panel_sync(state.panel_visible) {
                return;
            }
            state.active_panel
        };
        let _ = app.emit_to(
            FLOATING_PANEL_WINDOW_LABEL,
            "floating-panel-sync",
            FloatingPanelSyncPayload {
                dock,
                x,
                y,
                menu_visible: true,
                active_panel,
            },
        );
    });
}

#[cfg(target_os = "windows")]
fn show_floating_panel_native_with_drag_restore(
    shared: &Arc<Mutex<FloatingNativeState>>,
    allow_drag_restore: bool,
) {
    let app = {
        let Ok(state) = shared.lock() else {
            return;
        };
        if state.drag_surfaces_suppressed && !allow_drag_restore {
            return;
        }
        if !should_transition_floating_native_panel_visibility(state.panel_visible, true) {
            return;
        }
        state.app.clone()
    };

    if let Err(error) = ensure_floating_panel_runtime(&app) {
        log::warn!("[floating] 悬浮面板按需初始化失败: {error}");
        return;
    }

    let Some(orb) = app.get_webview_window(FLOATING_WINDOW_LABEL) else {
        return;
    };
    let Some(panel) = app.get_webview_window(FLOATING_PANEL_WINDOW_LABEL) else {
        return;
    };
    let Ok(orb_pos) = orb.outer_position() else {
        return;
    };
    let geometry = FloatingGeometry::for_scale(resolve_floating_window_scale_factor(&app));
    let orb_size = orb.outer_size().ok();
    let panel_size = panel.outer_size().ok();
    let orb_width = orb_size
        .map(|size| size.width as i32)
        .unwrap_or(logical_to_physical(
            FLOATING_ORB_SIZE as i32,
            resolve_floating_window_scale_factor(&app),
        ));
    let orb_height = orb_size
        .map(|size| size.height as i32)
        .unwrap_or(logical_to_physical(
            FLOATING_ORB_SIZE as i32,
            resolve_floating_window_scale_factor(&app),
        ));
    let panel_width = panel_size
        .map(|size| size.width as i32)
        .unwrap_or(logical_to_physical(
            FLOATING_PANEL_WIDTH as i32,
            resolve_floating_window_scale_factor(&app),
        ));
    let panel_height = panel_size
        .map(|size| size.height as i32)
        .unwrap_or(logical_to_physical(
            FLOATING_PANEL_HEIGHT as i32,
            resolve_floating_window_scale_factor(&app),
        ));
    let (work_area_x, work_area_y, work_area_width, work_area_height) = orb
        .current_monitor()
        .ok()
        .flatten()
        .map(monitor_to_physical_work_area)
        .or_else(|| {
            resolve_monitor_work_area(&app, orb_pos.x + orb_width / 2, orb_pos.y + orb_height / 2)
        })
        .unwrap_or((0, 0, 2560, 1440));
    let dock = resolve_floating_dock_for_size(work_area_x, work_area_width, orb_pos.x, orb_width);
    let (panel_x, panel_y) = compute_panel_position_for_size(
        work_area_y,
        work_area_height,
        orb_pos.x,
        orb_pos.y,
        dock,
        orb_width,
        panel_width,
        panel_height,
        geometry,
    );

    let _ = panel.set_position(PhysicalPosition::new(panel_x, panel_y));
    show_floating_window(&panel, false);
    // 悬浮菜单打开时暂停消息气泡, 避免两个独立窗口争抢同一交互区域。
    hide_floating_notification_window(&app);
    emit_floating_notification_lifecycle_pause(&app, "floating-panel", true);
    let _ = app.emit_to(
        FLOATING_NOTIFICATION_WINDOW_LABEL,
        "floating-notification-panel-visibility",
        FloatingNativePanelVisibilityPayload { visible: true },
    );
    let _ = app.emit_to(
        FLOATING_PANEL_WINDOW_LABEL,
        "floating-panel-sync",
        FloatingPanelSyncPayload {
            dock,
            x: panel_x,
            y: panel_y,
            menu_visible: true,
            active_panel: match shared.lock() {
                Ok(state) => state.active_panel,
                Err(_) => "overview",
            },
        },
    );
    emit_floating_native_panel_visibility(&app, true);

    if let Ok(mut state) = shared.lock() {
        state.panel_visible = true;
    }
    // WebView 可能在首次事件后才完成监听注册；仅在窗口仍可见时重放最新状态。
    schedule_floating_panel_sync_replay(app, Arc::clone(shared), dock, panel_x, panel_y);
}

#[cfg(target_os = "windows")]
fn hide_floating_panel_native(shared: &Arc<Mutex<FloatingNativeState>>) {
    let app = {
        let Ok(state) = shared.lock() else {
            return;
        };
        if !should_transition_floating_native_panel_visibility(state.panel_visible, false) {
            return;
        }
        state.app.clone()
    };
    hide_floating_auxiliary_window(&app, FLOATING_PANEL_WINDOW_LABEL);
    let _ = app.emit_to(FLOATING_PANEL_WINDOW_LABEL, "floating-panel-hide", true);
    emit_floating_native_panel_visibility(&app, false);
    if let Ok(mut state) = shared.lock() {
        state.panel_visible = false;
    }
    emit_floating_notification_lifecycle_pause(&app, "floating-panel", false);
    let _ = app.emit_to(
        FLOATING_NOTIFICATION_WINDOW_LABEL,
        "floating-notification-panel-visibility",
        FloatingNativePanelVisibilityPayload { visible: false },
    );
    let _ = sync_floating_notification_window(&app);
}

#[cfg(target_os = "windows")]
fn hide_floating_panel_for_native_drag(shared: &Arc<Mutex<FloatingNativeState>>) {
    let app = {
        let Ok(mut state) = shared.lock() else {
            return;
        };
        state.panel_visible = false;
        state.hide_since = None;
        state.hover_since = None;
        state.app.clone()
    };

    hide_floating_auxiliary_window(&app, FLOATING_PANEL_WINDOW_LABEL);
    let _ = app.emit_to(FLOATING_PANEL_WINDOW_LABEL, "floating-panel-hide", true);
    emit_floating_native_panel_visibility(&app, false);
    emit_floating_notification_lifecycle_pause(&app, "floating-panel", false);
    let _ = app.emit_to(
        FLOATING_NOTIFICATION_WINDOW_LABEL,
        "floating-notification-panel-visibility",
        FloatingNativePanelVisibilityPayload { visible: false },
    );
}

#[cfg(target_os = "windows")]
fn restore_floating_drag_surfaces(
    shared: &Arc<Mutex<FloatingNativeState>>,
    snapshot: FloatingDragSurfaceSnapshot,
) {
    let app = match shared.lock() {
        Ok(state) => state.app.clone(),
        Err(_) => return,
    };

    match resolve_floating_drag_surface_restore(snapshot) {
        FloatingDragSurfaceRestore::Panel => show_floating_panel_after_native_drag(shared),
        FloatingDragSurfaceRestore::NotificationList => {
            FLOATING_NOTIFICATION_DETAIL_OPEN.store(false, Ordering::Relaxed);
            let _ = sync_floating_notification_window_after_native_drag(&app);
        }
        FloatingDragSurfaceRestore::NotificationDetail => {
            FLOATING_NOTIFICATION_DETAIL_OPEN.store(true, Ordering::Relaxed);
            let _ = sync_floating_notification_window_after_native_drag(&app);
        }
        FloatingDragSurfaceRestore::None => {}
    }
}

#[cfg(target_os = "windows")]
fn snap_orb_to_edge_native(shared: &Arc<Mutex<FloatingNativeState>>) {
    let (app, orb_hwnd, drag_current_x, drag_current_y) = {
        let Ok(state) = shared.lock() else {
            return;
        };
        (
            state.app.clone(),
            state.orb_hwnd,
            state.drag_current_x,
            state.drag_current_y,
        )
    };
    let Some(orb) = app.get_webview_window(FLOATING_WINDOW_LABEL) else {
        return;
    };
    let orb_pos_x = drag_current_x;
    let orb_pos_y = drag_current_y;
    let geometry = FloatingGeometry::for_scale(resolve_floating_window_scale_factor(&app));
    let orb_size = orb.outer_size().ok();
    let orb_width = orb_size
        .map(|size| size.width as i32)
        .unwrap_or(logical_to_physical(
            FLOATING_ORB_SIZE as i32,
            resolve_floating_window_scale_factor(&app),
        ));
    let orb_height = orb_size
        .map(|size| size.height as i32)
        .unwrap_or(logical_to_physical(
            FLOATING_ORB_SIZE as i32,
            resolve_floating_window_scale_factor(&app),
        ));
    let (work_area_x, work_area_y, work_area_width, work_area_height) = orb
        .current_monitor()
        .ok()
        .flatten()
        .map(monitor_to_physical_work_area)
        .or_else(|| {
            resolve_monitor_work_area(&app, orb_pos_x + orb_width / 2, orb_pos_y + orb_height / 2)
        })
        .unwrap_or((0, 0, 2560, 1440));
    let (next_x, next_y, _) = compute_release_orb_position_for_size(
        work_area_x,
        work_area_y,
        work_area_width,
        work_area_height,
        orb_pos_x,
        orb_pos_y,
        orb_width,
        orb_height,
        geometry,
    );
    move_window_by_hwnd(orb_hwnd, next_x, next_y);

    if let Ok(mut state) = shared.lock() {
        state.orb_origin_x = next_x;
        state.orb_origin_y = next_y;
        state.drag_current_x = next_x;
        state.drag_current_y = next_y;
        state.last_applied_orb_position = Some((next_x, next_y));
    }
}

pub(crate) fn set_floating_native_panel_visible(app: &AppHandle, visible: bool) {
    if visible {
        if let Err(error) = ensure_floating_panel_runtime(app) {
            log::warn!("[floating] 打开悬浮面板前初始化运行时失败: {error}");
            return;
        }
    }

    #[cfg(target_os = "windows")]
    if let Some(shared) = FLOATING_NATIVE_STATE.get() {
        if visible {
            show_floating_panel_native(shared);
        } else {
            hide_floating_panel_native(shared);
        }
        return;
    }

    if let Some(panel) = app.get_webview_window(FLOATING_PANEL_WINDOW_LABEL) {
        if visible {
            show_floating_window(&panel, false);
        } else {
            hide_floating_auxiliary_window(app, FLOATING_PANEL_WINDOW_LABEL);
        }
    }
    emit_floating_notification_lifecycle_pause(app, "floating-panel", visible);
    emit_floating_native_panel_visibility(app, visible);
}

#[cfg(target_os = "windows")]
fn show_floating_context_menu_native(shared: &Arc<Mutex<FloatingNativeState>>) {
    let app = {
        let Ok(state) = shared.lock() else {
            return;
        };
        state.app.clone()
    };
    let Some(window) = app.get_webview_window(FLOATING_WINDOW_LABEL) else {
        return;
    };
    let toggle =
        match MenuItemBuilder::with_id(FLOATING_CONTEXT_TOGGLE_PANEL_ID, "展开/收起快捷面板")
            .build(&app)
        {
            Ok(item) => item,
            Err(_) => return,
        };
    let open_main = match MenuItemBuilder::with_id(FLOATING_CONTEXT_OPEN_MAIN_ID, "打开主窗口")
        .build(&app)
    {
        Ok(item) => item,
        Err(_) => return,
    };
    let quit = match MenuItemBuilder::with_id(FLOATING_CONTEXT_QUIT_ID, "退出").build(&app) {
        Ok(item) => item,
        Err(_) => return,
    };
    let menu = match Menu::with_items(&app, &[&toggle, &open_main, &quit]) {
        Ok(value) => value,
        Err(_) => return,
    };
    let _ = window.popup_menu(&menu);
}

#[cfg(target_os = "windows")]
fn native_window_visible(hwnd: usize) -> Option<bool> {
    if hwnd == 0 {
        return None;
    }

    Some(unsafe { IsWindowVisible(hwnd as *mut std::ffi::c_void) != 0 })
}

#[cfg(target_os = "windows")]
fn get_window_rect(hwnd: usize) -> Option<NativeRect> {
    unsafe {
        let mut rect = NativeRect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if GetWindowRect(hwnd as *mut std::ffi::c_void, &mut rect).eq(&0) {
            return None;
        }
        Some(rect)
    }
}

#[cfg(target_os = "windows")]
fn point_inside_native_rect(rect: &NativeRect, x: i32, y: i32) -> bool {
    x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom
}

#[cfg(target_os = "windows")]
fn resolve_floating_orb_hit_zones(
    app: &AppHandle,
    rect: &NativeRect,
    x: i32,
    y: i32,
) -> (bool, bool) {
    if point_inside_native_rect(rect, x, y) {
        return (true, true);
    }
    if y < rect.top || y >= rect.bottom {
        return (false, false);
    }

    let center_x = rect.left + ((rect.right - rect.left) / 2);
    let center_y = rect.top + ((rect.bottom - rect.top) / 2);
    let Some((work_area_x, _, work_area_width, _)) =
        resolve_monitor_work_area(app, center_x, center_y)
    else {
        return (false, false);
    };
    let work_area_right = work_area_x + work_area_width;
    let interaction_slop = FloatingGeometry::for_scale(resolve_floating_window_scale_factor(app))
        .orb_edge_interaction_slop;

    if rect.left < work_area_x {
        let visible_width = (rect.right.min(work_area_right) - work_area_x).max(0);
        let interaction_width =
            (visible_width + interaction_slop).min((rect.right - rect.left).max(1));
        let drag_width = (rect.right - rect.left).max(1);
        return (
            x >= work_area_x && x < work_area_x + interaction_width,
            x >= work_area_x && x < work_area_x + drag_width,
        );
    }

    if rect.right > work_area_right {
        let visible_width = (work_area_right - rect.left.max(work_area_x)).max(0);
        let interaction_width =
            (visible_width + interaction_slop).min((rect.right - rect.left).max(1));
        let drag_width = (rect.right - rect.left).max(1);
        return (
            x >= work_area_right - interaction_width && x < work_area_right,
            x >= work_area_right - drag_width && x < work_area_right,
        );
    }

    (false, false)
}

#[cfg(target_os = "windows")]
fn point_inside_orb_drag_zone(app: &AppHandle, hwnd: usize, x: i32, y: i32) -> bool {
    get_window_rect(hwnd)
        .map(|rect| resolve_floating_orb_hit_zones(app, &rect, x, y).1)
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn point_inside_orb_drag_zone(_app: &AppHandle, _hwnd: usize, _x: i32, _y: i32) -> bool {
    false
}

#[cfg(target_os = "windows")]
fn is_floating_orb_pointer_down_message(msg: u32, wparam: usize, subclass_id: usize) -> bool {
    subclass_id == FLOATING_SUBCLASS_ORB_ID
        && (msg == 0x0201 || (msg == 0x0210 && (wparam & 0xFFFF) == 0x0201))
}

#[cfg(target_os = "windows")]
fn is_floating_child_create_message(msg: u32, wparam: usize) -> bool {
    msg == 0x0210 && (wparam & 0xFFFF) == 0x0001
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn floating_taskbar_style_subclass_proc(
    hwnd: *mut std::ffi::c_void,
    msg: u32,
    wparam: usize,
    lparam: isize,
    subclass_id: usize,
    _ref_data: usize,
) -> isize {
    const GA_ROOT: u32 = 2;

    let is_top_level = GetAncestor(hwnd, GA_ROOT) == hwnd;
    let should_apply = should_apply_floating_taskbar_style_from_show_message(
        msg,
        wparam,
        subclass_id,
        is_top_level,
    );
    let result = DefSubclassProc(hwnd, msg, wparam, lparam);
    if should_apply {
        apply_native_floating_window_style_to_hwnd(hwnd);
    }
    result
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn main_window_chrome_subclass_proc(
    hwnd: *mut std::ffi::c_void,
    msg: u32,
    wparam: usize,
    lparam: isize,
    _subclass_id: usize,
    _ref_data: usize,
) -> isize {
    const GA_ROOT: u32 = 2;

    let should_apply = should_apply_main_window_chrome_from_show_message(
        msg,
        wparam,
        GetAncestor(hwnd, GA_ROOT) == hwnd,
    );
    let result = DefSubclassProc(hwnd, msg, wparam, lparam);
    if should_apply {
        // WebView2 的 show 默认处理完成后、返回 compositor 前立即清除 caption。
        apply_native_main_window_chrome_to_hwnd(hwnd);
    }
    result
}

#[cfg(target_os = "windows")]
fn install_main_window_chrome_subclass(window: &WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let raw = hwnd.0 as *mut std::ffi::c_void;
    if raw.is_null() {
        return;
    }

    unsafe {
        let _ = SetWindowSubclass(
            raw,
            Some(main_window_chrome_subclass_proc),
            MAIN_WINDOW_CHROME_SUBCLASS_ID,
            0,
        );
    }
}

#[cfg(target_os = "windows")]
fn install_floating_taskbar_style_subclass(window: &WebviewWindow) {
    let Some(subclass_id) = floating_taskbar_style_subclass_id(window.label()) else {
        return;
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let raw = hwnd.0 as *mut std::ffi::c_void;
    if raw.is_null() {
        return;
    }

    unsafe {
        let _ = SetWindowSubclass(
            raw,
            Some(floating_taskbar_style_subclass_proc),
            subclass_id,
            0,
        );
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn floating_native_subclass_proc(
    hwnd: *mut std::ffi::c_void,
    msg: u32,
    wparam: usize,
    lparam: isize,
    subclass_id: usize,
    _ref_data: usize,
) -> isize {
    let Some(shared) = FLOATING_NATIVE_STATE.get().cloned() else {
        return DefSubclassProc(hwnd, msg, wparam, lparam);
    };

    if is_floating_child_create_message(msg, wparam) {
        let child = lparam as *mut std::ffi::c_void;
        if !child.is_null() {
            install_floating_native_subclass_tree(child, subclass_id);
        }
    } else if is_floating_orb_pointer_down_message(msg, wparam, subclass_id) {
        // 只在消息到达时记录 pointer down, 让轮询器即使鼠标很快离开球体也能
        // 接管后续的全局移动与释放; hover / visible state 仍只有轮询器一个所有者。
        // WebView2 子窗口会通过 WM_PARENTNOTIFY 转发该消息，避免 32ms 轮询漏掉短点击。
        let mut cursor = NativePoint { x: 0, y: 0 };
        let _ = GetCursorPos(&mut cursor);
        begin_floating_native_pointer_session(&shared, &cursor);
    } else {
        match msg {
            // 左键点击和拖动统一交给原生轮询状态机处理。这里再切换菜单会与
            // 轮询器争抢同一次抬起事件, 造成菜单展开时偶发无法拖动。
            0x0202 if subclass_id == FLOATING_SUBCLASS_ORB_ID => {}
            0x0205 if subclass_id == FLOATING_SUBCLASS_ORB_ID => {
                show_floating_context_menu_native(&shared);
            }
            _ => {}
        }
    }

    DefSubclassProc(hwnd, msg, wparam, lparam)
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn install_child_subclass_proc(
    child: *mut std::ffi::c_void,
    _lparam: isize,
) -> i32 {
    let _ = SetWindowSubclass(
        child,
        Some(floating_native_subclass_proc),
        FLOATING_SUBCLASS_ORB_ID,
        0,
    );
    1
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn install_panel_child_subclass_proc(
    child: *mut std::ffi::c_void,
    _lparam: isize,
) -> i32 {
    let _ = SetWindowSubclass(
        child,
        Some(floating_native_subclass_proc),
        FLOATING_SUBCLASS_PANEL_ID,
        0,
    );
    1
}

#[cfg(target_os = "windows")]
unsafe fn install_floating_native_subclass_tree(hwnd: *mut std::ffi::c_void, subclass_id: usize) {
    if hwnd.is_null() {
        return;
    }

    let _ = SetWindowSubclass(hwnd, Some(floating_native_subclass_proc), subclass_id, 0);
    if subclass_id == FLOATING_SUBCLASS_ORB_ID {
        let _ = EnumChildWindows(hwnd, Some(install_child_subclass_proc), 0);
    } else {
        let _ = EnumChildWindows(hwnd, Some(install_panel_child_subclass_proc), 0);
    }
}

#[cfg(target_os = "windows")]
fn install_floating_native_subclasses(shared: &Arc<Mutex<FloatingNativeState>>) {
    let (orb_hwnd, panel_hwnd) = {
        let Ok(state) = shared.lock() else {
            return;
        };
        (state.orb_hwnd, state.panel_hwnd)
    };

    unsafe {
        install_floating_native_subclass_tree(
            orb_hwnd as *mut std::ffi::c_void,
            FLOATING_SUBCLASS_ORB_ID,
        );
        if let Some(panel_hwnd) = panel_hwnd {
            install_floating_native_subclass_tree(
                panel_hwnd as *mut std::ffi::c_void,
                FLOATING_SUBCLASS_PANEL_ID,
            );
        }
    }
}

#[cfg(target_os = "windows")]
fn schedule_floating_native_subclass_refresh(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        for delay_ms in FLOATING_NATIVE_SUBCLASS_REFRESH_DELAYS_MS {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let _ = app.run_on_main_thread(|| {
                if let Some(shared) = FLOATING_NATIVE_STATE.get() {
                    install_floating_native_subclasses(shared);
                }
            });
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn install_floating_native_subclasses(_shared: &Arc<Mutex<FloatingNativeState>>) {}

#[cfg(not(target_os = "windows"))]
fn show_floating_panel_native(_shared: &Arc<Mutex<FloatingNativeState>>) {}
#[cfg(not(target_os = "windows"))]
fn hide_floating_panel_native(_shared: &Arc<Mutex<FloatingNativeState>>) {}
#[cfg(not(target_os = "windows"))]
fn snap_orb_to_edge_native(_shared: &Arc<Mutex<FloatingNativeState>>) {}
#[cfg(not(target_os = "windows"))]
fn show_floating_context_menu_native(_shared: &Arc<Mutex<FloatingNativeState>>) {}

#[cfg(not(target_os = "windows"))]
fn emit_orb_native_action(_app: &AppHandle, _action: &'static str) {}

fn restore_or_place_floating_window(window: &WebviewWindow, app: &AppHandle) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let work_area = monitor.work_area();
        let scale = normalize_scale_factor(monitor.scale_factor());
        let geometry = FloatingGeometry::for_scale(scale);
        let work_area_x = work_area.position.x;
        let work_area_y = work_area.position.y;
        let work_area_width = work_area.size.width as i32;
        let work_area_height = work_area.size.height as i32;
        let orb_width = logical_to_physical(FLOATING_ORB_SIZE as i32, scale);
        let orb_height = orb_width;
        let left_x = work_area_x - geometry.edge_hide;
        let right_x = work_area_x + work_area_width - orb_width + geometry.edge_hide;
        let default_x = work_area_x + work_area_width - orb_width + geometry.edge_hide;
        let default_y =
            work_area_y + work_area_height - orb_height - geometry.default_bottom_offset;

        if window.restore_state(StateFlags::POSITION).is_ok() {
            if let Ok(position) = window.outer_position() {
                let is_legacy_top_anchor =
                    (position.y - (work_area_y + logical_to_physical(140, scale))).abs()
                        <= geometry.drag_threshold
                        && ((position.x - left_x).abs() <= geometry.drag_threshold
                            || (position.x - right_x).abs() <= geometry.drag_threshold);
                if !is_legacy_top_anchor {
                    let (next_x, next_y, _) = compute_snapped_orb_position_for_size(
                        work_area_x,
                        work_area_y,
                        work_area_width,
                        work_area_height,
                        position.x,
                        position.y,
                        orb_width,
                        orb_height,
                        geometry,
                    );
                    let _ = window.set_position(PhysicalPosition::new(next_x, next_y));
                    let _ = window.set_size(tauri::Size::Logical(LogicalSize::new(
                        FLOATING_ORB_SIZE,
                        FLOATING_ORB_SIZE,
                    )));
                    configure_native_floating_window(
                        window,
                        FLOATING_ORB_SIZE as i32,
                        FLOATING_ORB_SIZE as i32,
                    );
                    return;
                }
            }
        }

        let _ = window.set_position(PhysicalPosition::new(default_x, default_y));
    }
    configure_native_floating_window(window, FLOATING_ORB_SIZE as i32, FLOATING_ORB_SIZE as i32);
}

#[cfg(target_os = "windows")]
fn install_floating_native_state(app: &AppHandle) {
    let Some(orb) = app.get_webview_window(FLOATING_WINDOW_LABEL) else {
        return;
    };

    let Ok(orb_hwnd) = orb.hwnd() else {
        return;
    };
    let panel_hwnd = app
        .get_webview_window(FLOATING_PANEL_WINDOW_LABEL)
        .and_then(|panel| panel.hwnd().ok())
        .map(|hwnd| hwnd.0 as usize);

    let shared = FLOATING_NATIVE_STATE
        .get_or_init(|| {
            Arc::new(Mutex::new(FloatingNativeState {
                app: app.clone(),
                orb_hwnd: orb_hwnd.0 as usize,
                panel_hwnd,
                keep_panel_visible: should_keep_floating_panel_visible(app),
                pointer_down: false,
                drag_started: false,
                down_x: 0,
                down_y: 0,
                orb_origin_x: 0,
                orb_origin_y: 0,
                drag_current_x: 0,
                drag_current_y: 0,
                last_applied_orb_position: None,
                drag_threshold: FloatingGeometry::for_scale(resolve_floating_window_scale_factor(
                    app,
                ))
                .drag_threshold,
                panel_visible: false,
                drag_surface_restore: None,
                drag_surfaces_suppressed: false,
                active_panel: "overview",
                last_left_down: false,
                pointer_near_orb: false,
                last_geometry_cursor: None,
                last_orb_hit: false,
                last_orb_drag_hit: false,
                last_panel_hit: false,
                last_geometry_sample_at: None,
                hover_since: None,
                hide_since: None,
                suppress_hover_until: None,
                hover_reentry_required: false,
                poll_tick_pending: false,
                poller_started: false,
            }))
        })
        .clone();

    let lock_result = shared.lock();
    if let Ok(mut state) = lock_result {
        state.app = app.clone();
        state.orb_hwnd = orb_hwnd.0 as usize;
        state.panel_hwnd = panel_hwnd;
        state.keep_panel_visible = should_keep_floating_panel_visible(app);
    }
}

#[cfg(not(target_os = "windows"))]
fn install_floating_native_state(_app: &AppHandle) {}

fn ensure_floating_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let _build_guard = FLOATING_AUXILIARY_WINDOW_BUILD_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(window) = app.get_webview_window(FLOATING_WINDOW_LABEL) {
        configure_native_floating_window(
            &window,
            FLOATING_ORB_SIZE as i32,
            FLOATING_ORB_SIZE as i32,
        );
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        FLOATING_WINDOW_LABEL,
        WebviewUrl::App("floating-orb.html".into()),
    )
    .title("Input面板悬浮窗")
    .inner_size(FLOATING_ORB_SIZE, FLOATING_ORB_SIZE)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .closable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .transparent(true)
    .background_color(tauri::window::Color(0, 0, 0, 0))
    .visible(false)
    .focused(false)
    .shadow(false)
    .build()?;
    restore_or_place_floating_window(&window, app);
    configure_native_floating_window(&window, FLOATING_ORB_SIZE as i32, FLOATING_ORB_SIZE as i32);
    Ok(window)
}

fn ensure_floating_panel_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let _build_guard = FLOATING_AUXILIARY_WINDOW_BUILD_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(window) = app.get_webview_window(FLOATING_PANEL_WINDOW_LABEL) {
        configure_native_floating_window(
            &window,
            FLOATING_PANEL_WIDTH as i32,
            FLOATING_PANEL_HEIGHT as i32,
        );
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        FLOATING_PANEL_WINDOW_LABEL,
        WebviewUrl::App("floating-panel.html".into()),
    )
    .title("Input面板悬浮面板")
    .inner_size(FLOATING_PANEL_WIDTH, FLOATING_PANEL_HEIGHT)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .closable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .transparent(true)
    .visible(false)
    .focused(false)
    .shadow(false)
    .build()?;
    configure_native_floating_window(
        &window,
        FLOATING_PANEL_WIDTH as i32,
        FLOATING_PANEL_HEIGHT as i32,
    );
    Ok(window)
}

/// 只有悬浮功能被实际请求时才创建悬浮球，并在首次创建后接通原生输入运行时。
pub(crate) fn ensure_floating_runtime(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let floating = ensure_floating_window(app)?;
    install_floating_native_state(app);

    #[cfg(target_os = "windows")]
    if let Some(shared) = FLOATING_NATIVE_STATE.get() {
        install_floating_native_subclasses(shared);
        let should_start_poller = shared
            .lock()
            .map(|mut state| {
                if state.poller_started {
                    false
                } else {
                    state.poller_started = true;
                    true
                }
            })
            .unwrap_or(false);
        if should_start_poller {
            start_floating_native_poller(shared.clone());
            schedule_floating_native_subclass_refresh(app.clone());
        }
    }

    Ok(floating)
}

/// 悬浮面板只在用户真实打开、hover 或保持展开的需求出现后才创建。
fn ensure_floating_panel_runtime(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let _ = ensure_floating_runtime(app)?;
    let panel = ensure_floating_panel_window(app)?;
    install_floating_native_state(app);

    #[cfg(target_os = "windows")]
    if let Some(shared) = FLOATING_NATIVE_STATE.get() {
        install_floating_native_subclasses(shared);
    }

    Ok(panel)
}

fn ensure_floating_notification_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let _build_guard = FLOATING_AUXILIARY_WINDOW_BUILD_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(window) = app.get_webview_window(FLOATING_NOTIFICATION_WINDOW_LABEL) {
        return Ok(window);
    }

    let ctx = app.state::<application::AppContext>();
    let layout = application::desktop_ui_service::get_desktop_ui_prefs(&ctx)
        .map(|prefs| FloatingNotificationLayout::from_prefs(&prefs))
        .unwrap_or_else(|_| {
            FloatingNotificationLayout::from_prefs(&crate::contracts::DesktopUiPrefs::default())
        });
    let window = WebviewWindowBuilder::new(
        app,
        FLOATING_NOTIFICATION_WINDOW_LABEL,
        WebviewUrl::App("floating-notification.html".into()),
    )
    .title("Input消息提醒")
    .inner_size(
        FLOATING_NOTIFICATION_WIDTH as f64,
        layout.min_height() as f64,
    )
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .closable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .transparent(true)
    .visible(false)
    .focused(false)
    .shadow(false)
    .build()?;
    configure_native_floating_window(&window, FLOATING_NOTIFICATION_WIDTH, layout.min_height());
    configure_floating_notification_hit_region(
        &window,
        &[layout.compact_item_height],
        false,
        FLOATING_NOTIFICATION_WIDTH,
        layout.min_height(),
        layout,
        false,
    );
    hide_floating_auxiliary_window(app, FLOATING_NOTIFICATION_WINDOW_LABEL);
    Ok(window)
}

fn resolve_floating_notification_dock(app: &AppHandle) -> FloatingNotificationDock {
    let Some(orb) = app.get_webview_window(FLOATING_WINDOW_LABEL) else {
        return FloatingNotificationDock::default();
    };
    let monitor = orb
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return FloatingNotificationDock::default();
    };

    let work_area = monitor.work_area();
    let scale = normalize_scale_factor(monitor.scale_factor());
    let work_area_x = work_area.position.x;
    let work_area_width = work_area.size.width as i32;
    let orb_width = orb
        .outer_size()
        .map(|size| size.width as i32)
        .unwrap_or(logical_to_physical(FLOATING_ORB_SIZE as i32, scale));
    let orb_x = orb
        .outer_position()
        .map(|position| position.x)
        .unwrap_or(work_area_x + work_area_width - orb_width);

    resolve_floating_notification_dock_for_size(work_area_x, work_area_width, orb_x, orb_width)
}

fn resolve_floating_notification_position(
    app: &AppHandle,
    notification_width: i32,
    notification_height: i32,
) -> (i32, i32) {
    let fallback = || {
        compute_floating_notification_position(
            0,
            0,
            1280,
            720,
            1220,
            628,
            1280,
            688,
            notification_width,
            notification_height,
        )
    };
    let Some(orb) = app.get_webview_window(FLOATING_WINDOW_LABEL) else {
        return fallback();
    };
    let monitor = orb
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return fallback();
    };

    let work_area = monitor.work_area();
    let scale = normalize_scale_factor(monitor.scale_factor());
    let geometry = FloatingGeometry::for_scale(scale);
    let work_area_x = work_area.position.x;
    let work_area_y = work_area.position.y;
    let work_area_width = work_area.size.width as i32;
    let work_area_height = work_area.size.height as i32;
    let orb_size = orb.outer_size().ok();
    let orb_width = orb_size
        .map(|size| size.width as i32)
        .unwrap_or(logical_to_physical(FLOATING_ORB_SIZE as i32, scale));
    let orb_height = orb_size
        .map(|size| size.height as i32)
        .unwrap_or(logical_to_physical(FLOATING_ORB_SIZE as i32, scale));
    let (orb_x, orb_y) = orb
        .outer_position()
        .map(|position| (position.x, position.y))
        .unwrap_or((
            work_area_x + work_area_width - orb_width,
            work_area_y + work_area_height - orb_height,
        ));

    let mut anchor_left = orb_x;
    let mut anchor_top = orb_y;
    let mut anchor_right = orb_x + orb_width;
    let mut anchor_bottom = orb_y + orb_height;
    if let Some(panel) = app.get_webview_window(FLOATING_PANEL_WINDOW_LABEL) {
        if panel.is_visible().unwrap_or(false) {
            if let Ok(position) = panel.outer_position() {
                let panel_x = position.x;
                let panel_y = position.y;
                anchor_left = anchor_left.min(panel_x);
                anchor_top = anchor_top.min(panel_y);
                if let Ok(size) = panel.outer_size() {
                    anchor_right = anchor_right.max(panel_x + size.width as i32);
                    anchor_bottom = anchor_bottom.max(panel_y + size.height as i32);
                }
            }
        }
    }

    compute_floating_notification_position_for_geometry(
        work_area_x,
        work_area_y,
        work_area_width,
        work_area_height,
        anchor_left,
        anchor_top,
        anchor_right,
        anchor_bottom,
        notification_width,
        notification_height,
        geometry,
    )
}

fn resolve_floating_notification_work_area_height(app: &AppHandle) -> i32 {
    app.get_webview_window(FLOATING_WINDOW_LABEL)
        .and_then(|orb| {
            orb.current_monitor()
                .ok()
                .flatten()
                .or_else(|| app.primary_monitor().ok().flatten())
        })
        .map(|monitor| {
            let work_area = monitor.work_area();
            physical_to_logical(work_area.size.height as i32, monitor.scale_factor())
        })
        .unwrap_or(720)
}

fn emit_floating_notification_snapshot(app: &AppHandle, snapshot: &FloatingNotificationSnapshot) {
    let _ = app.emit_to(
        FLOATING_NOTIFICATION_WINDOW_LABEL,
        "floating-notification-sync",
        snapshot,
    );
}

fn reposition_floating_notification_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(FLOATING_NOTIFICATION_WINDOW_LABEL) else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let Ok(size) = window.outer_size() else {
        return;
    };
    let (x, y) = resolve_floating_notification_position(app, size.width as i32, size.height as i32);
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

pub(crate) fn sync_floating_notification_window_with_prefs(
    app: &AppHandle,
    prefs: &crate::contracts::DesktopUiPrefs,
) -> Result<FloatingNotificationSnapshot, String> {
    sync_floating_notification_window_with_prefs_for_drag_restore(app, prefs, false)
}

pub(crate) fn queue_floating_notification_window_reconfigure(
    app: &AppHandle,
    prefs: crate::contracts::DesktopUiPrefs,
) {
    let generation =
        FLOATING_NOTIFICATION_PREFS_SYNC_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(
            FLOATING_NOTIFICATION_PREFS_SYNC_DEBOUNCE_MS,
        ))
        .await;
        if FLOATING_NOTIFICATION_PREFS_SYNC_GENERATION.load(Ordering::Relaxed) != generation {
            return;
        }
        let _ = sync_floating_notification_window_with_prefs(&app, &prefs);
    });
}

fn sync_floating_notification_window_with_prefs_for_drag_restore(
    app: &AppHandle,
    prefs: &crate::contracts::DesktopUiPrefs,
    allow_drag_restore: bool,
) -> Result<FloatingNotificationSnapshot, String> {
    let _sync_guard = floating_notification_sync_lock()
        .lock()
        .map_err(|_| "floating notification sync unavailable".to_string())?;
    let snapshot = get_floating_notification_snapshot_for_app(app)?;
    let layout = FloatingNotificationLayout::from_prefs(prefs);

    if !should_sync_floating_notification_window(
        floating_drag_surfaces_suppressed(),
        allow_drag_restore,
    ) {
        emit_floating_notification_snapshot(app, &snapshot);
        return Ok(snapshot);
    }

    if snapshot.items.is_empty() {
        FLOATING_NOTIFICATION_DETAIL_OPEN.store(false, Ordering::Relaxed);
        emit_floating_notification_snapshot(app, &snapshot);
        hide_floating_notification_window(app);
        return Ok(snapshot);
    }

    if !is_window_visible(app, FLOATING_WINDOW_LABEL) {
        hide_floating_notification_window(app);
        emit_floating_notification_snapshot(app, &snapshot);
        return Ok(snapshot);
    }

    if app
        .get_webview_window(FLOATING_PANEL_WINDOW_LABEL)
        .and_then(|panel| panel.is_visible().ok())
        .unwrap_or(false)
    {
        hide_floating_notification_window(app);
        emit_floating_notification_snapshot(app, &snapshot);
        return Ok(snapshot);
    }

    let detail_open = FLOATING_NOTIFICATION_DETAIL_OPEN.load(Ordering::Relaxed);
    let notification_width = resolve_floating_notification_width(detail_open);
    let item_heights = resolve_floating_notification_item_heights(&snapshot.items, layout);
    let notification_height = if detail_open {
        resolve_floating_notification_window_height(
            snapshot.items.len(),
            true,
            resolve_floating_notification_work_area_height(app),
            layout,
        )
    } else {
        resolve_floating_notification_height_for_items(&item_heights, layout)
    };
    let window = ensure_floating_notification_window(app).map_err(|error| error.to_string())?;
    let window_was_visible = window.is_visible().unwrap_or(false);
    let scale_factor = resolve_floating_window_scale_factor(app);
    let (physical_width, physical_height) = resolve_floating_notification_physical_size(
        notification_width,
        notification_height,
        scale_factor,
    );
    let (x, y) = resolve_floating_notification_position(app, physical_width, physical_height);
    set_floating_notification_window_bounds(&window, x, y, physical_width, physical_height);
    configure_floating_notification_hit_region(
        &window,
        &item_heights,
        detail_open,
        notification_width,
        notification_height,
        layout,
        !detail_open,
    );
    if !window_was_visible {
        show_floating_notification_window(&window);
    }
    emit_floating_notification_lifecycle_pause(app, "notification-window-hidden", false);
    emit_floating_notification_snapshot(app, &snapshot);
    Ok(snapshot)
}

fn sync_floating_notification_window(
    app: &AppHandle,
) -> Result<FloatingNotificationSnapshot, String> {
    let ctx = app.state::<application::AppContext>();
    let prefs = application::desktop_ui_service::get_desktop_ui_prefs(&ctx)
        .map_err(|error| error.to_string())?;
    sync_floating_notification_window_with_prefs(app, &prefs)
}

#[cfg(target_os = "windows")]
fn sync_floating_notification_window_after_native_drag(
    app: &AppHandle,
) -> Result<FloatingNotificationSnapshot, String> {
    let ctx = app.state::<application::AppContext>();
    let prefs = application::desktop_ui_service::get_desktop_ui_prefs(&ctx)
        .map_err(|error| error.to_string())?;
    sync_floating_notification_window_with_prefs_for_drag_restore(app, &prefs, true)
}

/** React 动效稳定后恢复离散卡片 region，保留卡片间隙的原生点击穿透。 */
pub(crate) fn settle_floating_notification_motion(app: &AppHandle) -> Result<bool, String> {
    let _sync_guard = floating_notification_sync_lock()
        .lock()
        .map_err(|_| "floating notification sync unavailable".to_string())?;
    let snapshot = get_floating_notification_snapshot_for_app(app)?;
    if snapshot.items.is_empty()
        || FLOATING_NOTIFICATION_DETAIL_OPEN.load(Ordering::Relaxed)
        || !is_window_visible(app, FLOATING_NOTIFICATION_WINDOW_LABEL)
    {
        return Ok(false);
    }

    let ctx = app.state::<application::AppContext>();
    let prefs = application::desktop_ui_service::get_desktop_ui_prefs(&ctx)
        .map_err(|error| error.to_string())?;
    let layout = FloatingNotificationLayout::from_prefs(&prefs);
    let item_heights = resolve_floating_notification_item_heights(&snapshot.items, layout);
    let notification_height = resolve_floating_notification_height_for_items(&item_heights, layout);
    let Some(window) = app.get_webview_window(FLOATING_NOTIFICATION_WINDOW_LABEL) else {
        return Ok(false);
    };
    configure_floating_notification_hit_region(
        &window,
        &item_heights,
        false,
        FLOATING_NOTIFICATION_WIDTH,
        notification_height,
        layout,
        false,
    );
    Ok(true)
}

fn floating_notification_mailbox() -> &'static Arc<Mutex<FloatingNotificationMailbox>> {
    FLOATING_NOTIFICATION_MAILBOX
        .get_or_init(|| Arc::new(Mutex::new(FloatingNotificationMailbox::default())))
}

fn floating_notification_sync_lock() -> &'static Mutex<()> {
    FLOATING_NOTIFICATION_SYNC_LOCK.get_or_init(|| Mutex::new(()))
}

fn floating_notification_mutation_lock() -> &'static Mutex<()> {
    FLOATING_NOTIFICATION_MUTATION_LOCK.get_or_init(|| Mutex::new(()))
}

fn usage_notification_account_id(payload: &FloatingNotificationPayload) -> Result<&str, String> {
    payload
        .account
        .as_ref()
        .and_then(|account| account.id.as_deref())
        .filter(|account_id| !account_id.trim().is_empty())
        .ok_or_else(|| "usage notification account id is required".to_string())
}

fn restore_pending_usage_notifications(
    ctx: &application::AppContext,
) -> Result<FloatingNotificationSnapshot, String> {
    let records = crate::infrastructure::sqlite::repositories::list_usage_notifications(&ctx.db)
        .map_err(|error| format!("load usage notification outbox failed: {error}"))?;
    let mut payloads = Vec::with_capacity(records.len());
    for record in records {
        let payload: FloatingNotificationPayload = serde_json::from_str(&record.payload_json)
            .map_err(|error| {
                format!(
                    "decode usage notification outbox item {} failed: {error}",
                    record.id
                )
            })?;
        if payload.channel != FloatingNotificationChannel::Usage
            || payload.id != record.id
            || payload.dedupe_key != record.dedupe_key
        {
            return Err(format!(
                "usage notification outbox item {} does not match its persisted identity",
                record.id
            ));
        }
        payloads.push(payload);
    }

    let _mutation_guard = floating_notification_mutation_lock()
        .lock()
        .map_err(|_| "floating notification mutation unavailable".to_string())?;
    let mut mailbox = floating_notification_mailbox()
        .lock()
        .map_err(|_| "floating notification mailbox unavailable".to_string())?;
    Ok(mailbox.restore_usage_notifications(payloads))
}

pub(crate) fn get_floating_notification_snapshot() -> Result<FloatingNotificationSnapshot, String> {
    let mailbox = floating_notification_mailbox()
        .lock()
        .map_err(|_| "floating notification mailbox unavailable".to_string())?;
    Ok(mailbox.snapshot())
}

pub(crate) fn get_floating_notification_snapshot_for_app(
    app: &AppHandle,
) -> Result<FloatingNotificationSnapshot, String> {
    let mut snapshot = get_floating_notification_snapshot()?;
    snapshot.dock = resolve_floating_notification_dock(app);
    Ok(snapshot)
}

pub(crate) fn enqueue_floating_notification(
    app: &AppHandle,
    payload: FloatingNotificationPayload,
) -> Result<FloatingNotificationSnapshot, String> {
    let inserted = {
        let _mutation_guard = floating_notification_mutation_lock()
            .lock()
            .map_err(|_| "floating notification mutation unavailable".to_string())?;
        if payload.channel == FloatingNotificationChannel::Usage {
            let ctx = app.state::<application::AppContext>();
            let account_id = usage_notification_account_id(&payload)?;
            let payload_json = serde_json::to_string(&payload)
                .map_err(|error| format!("serialize usage notification failed: {error}"))?;
            let inserted = crate::infrastructure::sqlite::repositories::enqueue_usage_notification(
                &ctx.db,
                account_id,
                &payload.id,
                &payload.dedupe_key,
                &payload_json,
                &payload.created_at,
            )
            .map_err(|error| format!("persist usage notification failed: {error}"))?;
            if !inserted {
                return sync_floating_notification_window(app);
            }
        }
        let mut mailbox = floating_notification_mailbox()
            .lock()
            .map_err(|_| "floating notification mailbox unavailable".to_string())?;
        mailbox.enqueue_with_inserted(payload).1
    };
    if inserted {
        if let Err(error) = application::desktop_ui_service::schedule_floating_notification_sound(app)
        {
            log::warn!("[notification-sound] 新悬浮消息提示音调度失败: {error}");
        }
    }
    sync_floating_notification_window(app)
}

pub(crate) fn dismiss_floating_notification(
    app: &AppHandle,
    notification_id: &str,
) -> Result<FloatingNotificationSnapshot, String> {
    {
        let _mutation_guard = floating_notification_mutation_lock()
            .lock()
            .map_err(|_| "floating notification mutation unavailable".to_string())?;
        let payload = {
            let mailbox = floating_notification_mailbox()
                .lock()
                .map_err(|_| "floating notification mailbox unavailable".to_string())?;
            mailbox
                .items
                .iter()
                .find(|item| item.id == notification_id)
                .cloned()
        };
        if payload
            .as_ref()
            .is_some_and(|item| item.channel == FloatingNotificationChannel::Usage)
        {
            let ctx = app.state::<application::AppContext>();
            crate::infrastructure::sqlite::repositories::remove_usage_notification(
                &ctx.db,
                notification_id,
            )
            .map_err(|error| format!("acknowledge usage notification failed: {error}"))?;
        }
        let mut mailbox = floating_notification_mailbox()
            .lock()
            .map_err(|_| "floating notification mailbox unavailable".to_string())?;
        mailbox.dismiss(notification_id);
    }
    sync_floating_notification_window(app)
}

pub(crate) fn set_floating_notification_detail_open(
    app: &AppHandle,
    open: bool,
) -> Result<FloatingNotificationSnapshot, String> {
    let snapshot = get_floating_notification_snapshot()?;
    FLOATING_NOTIFICATION_DETAIL_OPEN.store(
        resolve_floating_notification_detail_open(open, snapshot.items.len()),
        Ordering::Relaxed,
    );
    sync_floating_notification_window(app)
}

fn hide_floating_group(app: &AppHandle) {
    hide_window(app, FLOATING_WINDOW_LABEL);
    hide_window(app, FLOATING_PANEL_WINDOW_LABEL);
    hide_floating_notification_window(app);
    mark_floating_native_panel_hidden();
}

/// 保留主窗口几何记忆，但不让 window-state 在启动阶段自行显示窗口。
fn restore_main_window_geometry_before_reveal(main: &WebviewWindow) {
    if let Err(error) = main.restore_state(StateFlags::POSITION | StateFlags::SIZE) {
        log::warn!("[window] 恢复主窗口位置和尺寸失败: {error}");
    }
}

/// `VISIBLE` 会直接触发 `show()`，因此显示状态只能在受控 reveal 后恢复。
fn restore_main_window_display_state_after_reveal(main: &WebviewWindow) {
    if let Err(error) = main.restore_state(StateFlags::MAXIMIZED | StateFlags::FULLSCREEN) {
        log::warn!("[window] 恢复主窗口最大化或全屏状态失败: {error}");
    }
}

/// 主窗口首次实际显示统一走受控恢复，避免浮窗、托盘和原生通知路径绕过无标题栏处理。
pub(crate) fn show_main_window_with_controlled_state_restore(
    app: &AppHandle,
    reason: &str,
) -> Result<(), String> {
    let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        let message = format!("主窗口不存在，无法显示（{reason}）");
        log::warn!("[window] {message}");
        record_startup_reveal_stage(StartupRevealStage::MainShowFailed);
        return Err(message);
    };

    record_startup_reveal_stage(StartupRevealStage::MainShowRequested);
    let restore_persisted_state = !MAIN_WINDOW_INITIAL_STATE_RESTORED.load(Ordering::SeqCst);
    if restore_persisted_state {
        restore_main_window_geometry_before_reveal(&main);
    }
    configure_native_main_window(&main);
    if let Err(error) = main.show() {
        let message = format!("主窗口显示失败（{reason}）: {error}");
        record_startup_reveal_stage(StartupRevealStage::MainShowFailed);
        log::warn!("[window] {message}");
        return Err(message);
    }
    if let Err(error) = main.unminimize() {
        let message = format!("主窗口取消最小化失败（{reason}）: {error}");
        record_startup_reveal_stage(StartupRevealStage::MainShowFailed);
        log::warn!("[window] {message}");
        return Err(message);
    }
    let _ = main.set_focus();
    if restore_persisted_state {
        restore_main_window_display_state_after_reveal(&main);
        MAIN_WINDOW_INITIAL_STATE_RESTORED.store(true, Ordering::SeqCst);
    }
    configure_native_main_window(&main);
    #[cfg(target_os = "windows")]
    if restore_persisted_state {
        schedule_native_main_window_chrome_normalization(app.clone());
    }
    Ok(())
}

/// 前端首帧完成后按启动模式进入真实可见目标。失败时不提交 `MAIN_WINDOW_REVEALED`。
fn reveal_main_window(app: &AppHandle, reason: &str) -> Result<StartupRevealTarget, String> {
    let launch_floating = app
        .try_state::<application::AppContext>()
        .and_then(|ctx| application::desktop_ui_service::get_desktop_ui_prefs(&ctx).ok())
        .map(|prefs| prefs.launch_mode == crate::contracts::AppLaunchMode::Floating)
        .unwrap_or(false);
    if launch_floating {
        if floating_window_native_visible(app) {
            return Ok(StartupRevealTarget::Floating);
        }
        let floating = ensure_floating_runtime(app).map_err(|error| error.to_string())?;
        show_floating_window(&floating, true);
        return Ok(StartupRevealTarget::Floating);
    }
    if MAIN_WINDOW_REVEALED.load(Ordering::SeqCst) && main_window_native_visible(app) {
        return Ok(StartupRevealTarget::Main);
    }
    if MAIN_WINDOW_REVEAL_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return Ok(StartupRevealTarget::Main);
    }
    log::info!("[window] 主窗口显示（{reason}）");
    if let Err(error) = show_main_window_with_controlled_state_restore(app, reason) {
        MAIN_WINDOW_REVEAL_IN_FLIGHT.store(false, Ordering::SeqCst);
        return Err(error);
    }
    Ok(StartupRevealTarget::Main)
}

/// 仅记录前端首帧超时。绝不以时间驱动显示尚不能绘制的透明主窗口。
fn schedule_frontend_ready_timeout_diagnostic() {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(FRONTEND_READY_TIMEOUT_MS)).await;
        if STARTUP_HANDOFF_COMPLETED.load(Ordering::SeqCst)
            || MAIN_WINDOW_REVEALED.load(Ordering::SeqCst)
        {
            return;
        }
        record_startup_reveal_stage(StartupRevealStage::FrontendReadyTimeout);
        log::warn!("[startup] frontend_ready 超时，保留原生启动窗并等待后续恢复");
    });
}

/// Floating 首启以悬浮球的真实 HWND 可见性作为完成条件，不能等待按设计隐藏的主 WebView。
fn schedule_floating_startup_handoff_after_orb_visible(app: &AppHandle) {
    if STARTUP_HANDOFF_COMPLETED.load(Ordering::SeqCst) {
        return;
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = finish_floating_startup_handoff(&app).await {
            log::warn!("[startup] 悬浮球启动交接失败，保留后续显式唤醒重试机会: {error}");
        }
    });
}

fn sync_mode_windows(app: &AppHandle, prefs: &crate::contracts::DesktopUiPrefs) {
    hide_floating_notification_window(app);
    if prefs.launch_mode == crate::contracts::AppLaunchMode::Floating {
        hide_window(app, MAIN_WINDOW_LABEL);
        hide_window(app, FLOATING_PANEL_WINDOW_LABEL);
        if let Ok(window) = ensure_floating_runtime(app) {
            show_floating_window(&window, true);
            schedule_floating_startup_handoff_after_orb_visible(app);
        }
        hide_floating_auxiliary_window(app, FLOATING_PANEL_WINDOW_LABEL);
        mark_floating_native_panel_hidden();
        let _ = sync_floating_notification_window_with_prefs(app, prefs);
        return;
    }

    // 首次主模式启动必须只保留 main WebView 与原生启动窗，不能在首帧前抢占 WebView2。
    if !MAIN_WINDOW_REVEALED.load(Ordering::SeqCst) || !main_window_native_visible(app) {
        return;
    }
    let _ = show_main_window_with_controlled_state_restore(app, "同步主窗口模式");
    ensure_main_mode_auxiliary_windows_after_startup(app);
}

/// 主工作台已经真实可见后，才根据偏好按需加载悬浮辅助窗口。
fn ensure_main_mode_auxiliary_windows_after_startup(app: &AppHandle) {
    let Ok(prefs) = application::desktop_ui_service::get_desktop_ui_prefs(
        &app.state::<application::AppContext>(),
    ) else {
        return;
    };
    if prefs.launch_mode != crate::contracts::AppLaunchMode::Main {
        return;
    }
    if !prefs.open_floating_in_main_mode {
        hide_floating_group(app);
        return;
    }
    if let Ok(window) = ensure_floating_runtime(app) {
        show_floating_window(&window, false);
        let _ = sync_floating_notification_window_with_prefs(app, &prefs);
    }
}

/// 显式打开主窗口必须先等待任一安全首帧交接完成，避免抢先暴露透明主 WebView。
pub(crate) fn request_main_window_activation_after_startup_handoff(
    app: &AppHandle,
    prefs: &crate::contracts::DesktopUiPrefs,
    navigation: Option<&str>,
    reason: &str,
) -> Result<bool, String> {
    if queue_main_window_activation_until_startup_handoff(navigation) {
        log::info!("[startup] {reason} 已排队，等待安全首帧交接");
        return Ok(false);
    }

    show_main_window_with_controlled_state_restore(app, reason)?;
    if let Some(navigation) = navigation {
        if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
            let _ = main.emit("open-nav", navigation);
        }
    }
    if prefs.open_floating_in_main_mode {
        match ensure_floating_runtime(app) {
            Ok(floating) => show_floating_window(&floating, false),
            Err(error) => log::warn!("[floating] 主窗口打开后初始化悬浮窗失败: {error}"),
        }
    } else {
        hide_floating_group(app);
    }
    hide_floating_auxiliary_window(app, FLOATING_PANEL_WINDOW_LABEL);
    mark_floating_native_panel_hidden();
    hide_floating_notification_window(app);
    Ok(true)
}

/// 只有 startup handoff 提交后才回放启动期间抵达的单实例/原生唤醒请求。
fn replay_pending_main_window_activation_after_startup_handoff(app: &AppHandle) {
    let Some(navigation) = take_pending_startup_main_window_activation() else {
        return;
    };

    let Some(ctx) = app.try_state::<application::AppContext>() else {
        restore_pending_startup_main_window_activation(navigation);
        log::warn!("[startup] 主窗口唤醒回放时应用上下文仍未就绪");
        return;
    };
    let prefs = match application::desktop_ui_service::get_desktop_ui_prefs(&ctx) {
        Ok(prefs) => prefs,
        Err(error) => {
            restore_pending_startup_main_window_activation(navigation);
            log::warn!("[startup] 读取待回放主窗口偏好失败: {error}");
            return;
        }
    };
    match request_main_window_activation_after_startup_handoff(
        app,
        &prefs,
        navigation.as_deref(),
        "启动期间主窗口唤醒",
    ) {
        Ok(true) => {
            let _ = app.emit("desktop-ui-prefs-updated", &prefs);
        }
        Ok(false) => {
            restore_pending_startup_main_window_activation(navigation);
        }
        Err(error) => {
            restore_pending_startup_main_window_activation(navigation);
            log::warn!("[startup] 待回放主窗口唤醒失败: {error}");
        }
    }
}

fn handle_tray_toggle(app: &AppHandle, ctx: &application::AppContext) {
    let prefs = match application::desktop_ui_service::get_desktop_ui_prefs(ctx) {
        Ok(value) => value,
        Err(_) => return,
    };
    let floating = match ensure_floating_runtime(app) {
        Ok(window) => window,
        Err(_) => return,
    };
    let visible = floating.is_visible().unwrap_or(false);
    if prefs.launch_mode == crate::contracts::AppLaunchMode::Floating {
        if visible {
            hide_floating_group(app);
        } else {
            show_floating_window(&floating, true);
            let _ = sync_floating_notification_window_with_prefs(app, &prefs);
        }
        return;
    }

    if application::desktop_ui_service::update_desktop_ui_prefs(
        ctx,
        crate::contracts::DesktopUiPrefsPatch {
            open_floating_in_main_mode: Some(!visible),
            ..crate::contracts::DesktopUiPrefsPatch::default()
        },
    )
    .is_ok()
    {
        if visible {
            hide_floating_group(app);
        } else {
            show_floating_window(&floating, true);
            let _ = sync_floating_notification_window_with_prefs(app, &prefs);
        }
    }
}

fn open_main_window_from_tray(app: &AppHandle, ctx: &application::AppContext) {
    if let Ok(prefs) =
        application::desktop_ui_service::set_launch_mode(ctx, crate::contracts::AppLaunchMode::Main)
    {
        if let Err(error) = request_main_window_activation_after_startup_handoff(
            app,
            &prefs,
            None,
            "托盘打开主窗口",
        ) {
            log::warn!("[window] {error}");
        }
        let _ = app.emit("desktop-ui-prefs-updated", &prefs);
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open_main = MenuItemBuilder::with_id(TRAY_OPEN_MAIN_ID, "打开主窗口").build(app)?;
    let toggle_floating =
        MenuItemBuilder::with_id(TRAY_TOGGLE_FLOATING_ID, "切换悬浮窗").build(app)?;
    let quit = MenuItemBuilder::with_id(TRAY_QUIT_ID, "退出").build(app)?;
    let menu = Menu::with_items(app, &[&open_main, &toggle_floating, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip("Input面板")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let ctx = app.state::<application::AppContext>();
            match event.id.as_ref() {
                TRAY_OPEN_MAIN_ID => open_main_window_from_tray(app, &ctx),
                TRAY_TOGGLE_FLOATING_ID => handle_tray_toggle(app, &ctx),
                TRAY_QUIT_ID => {
                    dismiss_native_startup_splash_for_exit(app);
                    let _ = app.save_window_state(persisted_window_state_flags());
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            let app = tray.app_handle();
            match event {
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => {
                    let ctx = app.state::<application::AppContext>();
                    open_main_window_from_tray(app, &ctx);
                }
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
                    let ctx = app.state::<application::AppContext>();
                    if let Ok(prefs) = application::desktop_ui_service::get_desktop_ui_prefs(&ctx) {
                        sync_mode_windows(app, &prefs);
                    }
                }
                _ => {}
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    match infrastructure::windows_splash::create_startup_splash() {
        Ok(()) => record_startup_reveal_stage(StartupRevealStage::NativeSplashVisible),
        Err(error) => log::warn!("[startup] 原生启动窗创建失败: {error}"),
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let app_handle = app.clone();
            let app_for_activation = app_handle.clone();
            if let Err(error) = app_handle.run_on_main_thread(move || {
                let Some(ctx) = app_for_activation.try_state::<application::AppContext>() else {
                    queue_main_window_activation_until_startup_handoff(None);
                    log::info!("[startup] single-instance activation arrived before app context was ready");
                    return;
                };
                let prefs = match application::desktop_ui_service::set_launch_mode(
                    ctx.inner(),
                    crate::contracts::AppLaunchMode::Main,
                ) {
                    Ok(prefs) => prefs,
                    Err(error) => {
                        log::warn!("[window] single-instance activation could not persist main mode: {error}");
                        return;
                    }
                };
                if let Err(error) = request_main_window_activation_after_startup_handoff(
                    &app_for_activation,
                    &prefs,
                    None,
                    "单实例唤醒主窗口",
                ) {
                    log::warn!("[window] {error}");
                }
                let _ = app_for_activation.emit("desktop-ui-prefs-updated", &prefs);
            }) {
                log::warn!("failed to schedule single-instance activation: {error}");
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(persisted_window_state_flags())
                .skip_initial_state(MAIN_WINDOW_LABEL)
                .skip_initial_state(FLOATING_WINDOW_LABEL)
                .skip_initial_state(FLOATING_PANEL_WINDOW_LABEL)
                .skip_initial_state(FLOATING_NOTIFICATION_WINDOW_LABEL)
                .build(),
        )
        .setup(|app| {
            // Tauri 已按配置创建 main WebView；原生启动窗在 run() 内已先显示。
            record_startup_reveal_stage(StartupRevealStage::MainWebviewCreated);
            let ctx = tauri::async_runtime::block_on(application::AppContext::resolve_desktop())?;
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let app_handle = app.handle().clone();
            app.manage(ctx.clone());
            if let Err(error) = restore_pending_usage_notifications(&ctx) {
                log::error!("failed to restore pending usage notifications: {error}");
            }
            let service_status_monitor =
                application::service_status_service::ServiceStatusMonitor::start(
                    ctx.clone(),
                    app_handle.clone(),
                );
            app.manage(service_status_monitor);
            application::scheduler_service::DataSyncScheduler::start(ctx, app_handle.clone());
            {
                let startup_ctx = app.state::<application::AppContext>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = application::subscription_switch_service::evaluate_saved_subscription_switch_rules_at_startup(&startup_ctx).await {
                        log::warn!("startup subscription-switch evaluation setup failed: {error}");
                    }
                });
            }
            build_tray(&app_handle)?;
            app_handle.on_menu_event(|app, event| match event.id().as_ref() {
                FLOATING_CONTEXT_TOGGLE_PANEL_ID => {
                    if let Some(shared) = FLOATING_NATIVE_STATE.get() {
                        toggle_floating_panel_native(shared);
                    } else {
                        let _ = app.emit_to(
                            FLOATING_WINDOW_LABEL,
                            "floating-orb-context-action",
                            FloatingContextActionPayload {
                                action: "toggle-panel",
                            },
                        );
                    }
                }
                FLOATING_CONTEXT_OPEN_MAIN_ID => {
                    open_main_window_from_native(app, "overview");
                }
                FLOATING_CONTEXT_QUIT_ID => {
                    dismiss_native_startup_splash_for_exit(app);
                    let _ = app.save_window_state(persisted_window_state_flags());
                    app.exit(0);
                }
                _ => {}
            });
            let mut prefs = application::desktop_ui_service::get_desktop_ui_prefs(
                &app.state::<application::AppContext>(),
            )?;
            if startup_handoff_has_pending_main_window_activation() {
                prefs = application::desktop_ui_service::set_launch_mode(
                    &app.state::<application::AppContext>(),
                    crate::contracts::AppLaunchMode::Main,
                )?;
                let _ = app_handle.emit("desktop-ui-prefs-updated", &prefs);
            }
            if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                configure_native_main_window(&main);
                #[cfg(target_os = "windows")]
                install_main_window_chrome_subclass(&main);
            }
            sync_mode_windows(&app_handle, &prefs);
            #[cfg(target_os = "windows")]
            schedule_native_main_window_chrome_normalization(app_handle.clone());
            if prefs.launch_mode == crate::contracts::AppLaunchMode::Floating {
                if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ = main.hide();
                }
            } else {
                // 前端超时仅用于诊断；透明主窗口必须继续隐藏，直到真实首帧交接成立。
                schedule_frontend_ready_timeout_diagnostic();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let label = window.label();
                if label == FLOATING_WINDOW_LABEL
                    || label == FLOATING_PANEL_WINDOW_LABEL
                    || label == FLOATING_NOTIFICATION_WINDOW_LABEL
                {
                    api.prevent_close();
                    hide_floating_group(&window.app_handle());
                    return;
                }
                if label == MAIN_WINDOW_LABEL {
                    api.prevent_close();
                    let app = window.app_handle();
                    let ctx = app.state::<application::AppContext>();
                    if let Ok(prefs) = application::desktop_ui_service::get_desktop_ui_prefs(&ctx) {
                        match prefs.close_behavior {
                            crate::contracts::CloseBehavior::Ask => {
                                let _ = window.emit("desktop-close-requested", true);
                            }
                            crate::contracts::CloseBehavior::SwitchToFloating => {
                                if let Ok(next) = application::desktop_ui_service::set_launch_mode(
                                    &ctx,
                                    crate::contracts::AppLaunchMode::Floating,
                                ) {
                                    sync_mode_windows(&app, &next);
                                    let _ = app.emit("desktop-ui-prefs-updated", &next);
                                }
                            }
                            crate::contracts::CloseBehavior::ExitApp => {
                                dismiss_native_startup_splash_for_exit(&app);
                                let _ = app.save_window_state(persisted_window_state_flags());
                                app.exit(0);
                            }
                        }
                    } else {
                        dismiss_native_startup_splash_for_exit(&app);
                        let _ = app.save_window_state(persisted_window_state_flags());
                        app.exit(0);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            adapters::desktop::commands::health,
            adapters::desktop::commands::frontend_ready,
            adapters::desktop::commands::get_overview_shell,
            adapters::desktop::commands::get_overview_shell_lite,
            adapters::desktop::commands::get_overview,
            adapters::desktop::commands::get_service_status,
            adapters::desktop::commands::send_service_status_system_notification,
            adapters::desktop::commands::get_codex_radar_intelligence,
            adapters::desktop::commands::get_codex_radar_insights,
            adapters::desktop::commands::get_codex_radar_fast,
            adapters::desktop::commands::get_codex_radar_model_iq,
            adapters::desktop::commands::get_window_selection,
            adapters::desktop::commands::update_window_selection,
            adapters::desktop::commands::get_site_public_endpoints,
            adapters::desktop::commands::sync_site_public_endpoints,
            adapters::desktop::commands::ping_site_public_endpoints,
            adapters::desktop::commands::get_desktop_ui_prefs,
            adapters::desktop::commands::update_desktop_ui_prefs,
            adapters::desktop::commands::select_floating_notification_sound,
            adapters::desktop::commands::preview_floating_notification_sound,
            adapters::desktop::commands::restore_default_floating_notification_sound,
            adapters::desktop::commands::switch_app_mode,
            adapters::desktop::commands::set_floating_window_visible,
            adapters::desktop::commands::show_floating_context_menu,
            adapters::desktop::commands::set_floating_panel_visible,
            adapters::desktop::commands::get_floating_panel_visible,
            adapters::desktop::commands::begin_floating_native_pointer_session,
            adapters::desktop::commands::position_floating_panel,
            adapters::desktop::commands::enqueue_floating_notification,
            adapters::desktop::commands::get_floating_notification_snapshot,
            adapters::desktop::commands::dismiss_floating_notification,
            adapters::desktop::commands::set_floating_notification_detail_open,
            adapters::desktop::commands::settle_floating_notification_motion,
            adapters::desktop::commands::open_main_window,
            adapters::desktop::commands::quit_application,
            adapters::desktop::commands::clear_runtime_data,
            adapters::desktop::commands::create_site,
            adapters::desktop::commands::update_site,
            adapters::desktop::commands::remove_site,
            adapters::desktop::commands::get_site_failover_status,
            adapters::desktop::commands::test_site_endpoint,
            adapters::desktop::commands::clear_site_failover_cooldown,
            adapters::desktop::commands::list_site_failover_transitions,
            adapters::desktop::commands::create_account,
            adapters::desktop::commands::update_account,
            adapters::desktop::commands::remove_account,
            adapters::desktop::commands::login_account,
            adapters::desktop::commands::persist_account_credential,
            adapters::desktop::commands::login_account_2fa,
            adapters::desktop::commands::refresh_account,
            adapters::desktop::commands::refresh_all_accounts,
            adapters::desktop::commands::sync_all_accounts,
            adapters::desktop::commands::sync_account_data,
            adapters::desktop::commands::get_account_sync_status,
            adapters::desktop::commands::get_available_groups,
            adapters::desktop::commands::list_managed_keys,
            adapters::desktop::commands::get_managed_key,
            adapters::desktop::commands::create_managed_key,
            adapters::desktop::commands::update_managed_key,
            adapters::desktop::commands::delete_managed_key,
            adapters::desktop::commands::list_subscription_switch_rules,
            adapters::desktop::commands::upsert_subscription_switch_rule,
            adapters::desktop::commands::delete_subscription_switch_rule,
            adapters::desktop::commands::evaluate_subscription_switch_rules,
            adapters::desktop::commands::query_subscription_quota_alerts,
            adapters::desktop::commands::upsert_subscription_quota_alert,
            adapters::desktop::commands::list_usage_records,
            adapters::desktop::commands::list_usage_facets,
            adapters::desktop::commands::get_usage_stats,
            adapters::desktop::commands::get_usage_analytics,
            adapters::desktop::commands::get_usage_extremes,
            adapters::desktop::commands::get_overview_dashboard_stats,
            adapters::desktop::commands::get_dashboard_models,
            adapters::desktop::commands::get_dashboard_trend,
            adapters::desktop::commands::get_usage_insights,
            adapters::desktop::commands::get_key_daily_usage,
            adapters::desktop::commands::get_key_usage_summary,
            adapters::desktop::commands::get_subscription_key_usage,
            adapters::desktop::commands::get_profile_record,
            adapters::desktop::commands::update_profile_record,
            adapters::desktop::commands::change_profile_password,
            adapters::desktop::commands::get_platform_quotas,
            adapters::desktop::commands::get_subscriptions,
            adapters::desktop::commands::get_subscription_summary,
            adapters::desktop::commands::send_notify_email_code,
            adapters::desktop::commands::verify_notify_email,
            adapters::desktop::commands::remove_notify_email,
            adapters::desktop::commands::toggle_notify_email,
            adapters::desktop::commands::send_email_binding_code,
            adapters::desktop::commands::bind_email_identity,
            adapters::desktop::commands::unbind_auth_identity,
            adapters::desktop::commands::get_scheduler_config,
            adapters::desktop::commands::update_scheduler_config,
            adapters::desktop::commands::get_runtime_coordination_config,
            adapters::desktop::commands::update_runtime_coordination_config,
            adapters::desktop::commands::get_upstream_network_config,
            adapters::desktop::commands::update_upstream_network_config,
            adapters::desktop::commands::get_database_storage_status,
            adapters::desktop::commands::migrate_database_storage
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        compute_floating_notification_position, compute_panel_position,
        compute_panel_position_for_size, compute_release_orb_position_for_size,
        floating_drag_threshold_exceeded, is_floating_auxiliary_window_label, logical_to_physical,
        normalize_floating_window_ex_style, physical_to_logical, queue_startup_handoff_activation,
        resolve_floating_native_panel_visible, resolve_floating_native_poll_ms,
        resolve_floating_native_poll_ms_with_pointer_near_orb,
        resolve_floating_notification_detail_open, resolve_floating_notification_dock_for_size,
        resolve_floating_notification_height_for_items,
        resolve_floating_notification_hit_regions_for_items,
        resolve_floating_notification_native_round_rect,
        resolve_floating_notification_physical_size,
        resolve_floating_notification_regions_for_motion,
        resolve_floating_notification_visible_items, resolve_floating_notification_window_height,
        resolve_startup_handoff_stage, restore_startup_handoff_activation,
        should_apply_floating_auxiliary_show, should_begin_floating_native_webview_session,
        should_hide_floating_panel_after_startup, should_recheck_floating_taskbar_style,
        take_startup_handoff_activation, FloatingGeometry, FloatingNotificationChannel,
        FloatingNotificationDock, FloatingNotificationHitRegion, FloatingNotificationLayout,
        FloatingNotificationMailbox, FloatingNotificationPayload, FloatingNotificationReference,
        StartupHandoffState, StartupRevealStage, StartupRevealTarget, FLOATING_NATIVE_DRAG_POLL_MS,
        FLOATING_NATIVE_HIDDEN_POLL_MS, FLOATING_NATIVE_IDLE_POLL_MS,
        FLOATING_NATIVE_VISIBLE_POLL_MS, FLOATING_NOTIFICATION_DETAIL_WIDTH,
        FLOATING_NOTIFICATION_WIDTH, FLOATING_ORB_ALPHA_REGION_RUNS, FLOATING_ORB_SIZE,
        FLOATING_PANEL_GAP, FLOATING_PANEL_WIDTH,
    };

    fn floating_notification_payload(id: &str, dedupe_key: &str) -> FloatingNotificationPayload {
        FloatingNotificationPayload {
            id: id.into(),
            dedupe_key: dedupe_key.into(),
            channel: super::FloatingNotificationChannel::Business,
            title: "模型不可用".into(),
            level: "critical".into(),
            source: "service-status".into(),
            created_at: "2026-07-11T00:00:00Z".into(),
            content: "模型探测失败".into(),
            account: Some(FloatingNotificationReference {
                id: Some("account-1".into()),
                label: "主账号".into(),
            }),
            site: None,
            model: Some(FloatingNotificationReference {
                id: None,
                label: "gpt-5".into(),
            }),
            usage: None,
        }
    }

    fn usage_notification_payload(id: &str, dedupe_key: &str) -> FloatingNotificationPayload {
        let mut payload = floating_notification_payload(id, dedupe_key);
        payload.channel = FloatingNotificationChannel::Usage;
        payload.usage = Some(super::FloatingUsageNotificationDetails {
            api_key_label: "usage-key".into(),
            model: "gpt-5".into(),
            reasoning_effort: None,
            service_tier: None,
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            actual_cost: 0.01,
            total_cost: 0.01,
            first_token_ms: Some(10),
        });
        payload
    }

    #[test]
    fn persisted_window_state_does_not_restore_decorations() {
        let flags = super::persisted_window_state_flags();

        assert!(!flags.contains(super::StateFlags::DECORATIONS));
        assert!(flags.contains(super::StateFlags::POSITION));
        assert!(flags.contains(super::StateFlags::SIZE));
        assert!(flags.contains(super::StateFlags::MAXIMIZED));
    }

    #[test]
    fn floating_native_poller_stays_fast_while_dragging() {
        assert_eq!(
            resolve_floating_native_poll_ms(true, false, true),
            FLOATING_NATIVE_DRAG_POLL_MS
        );
    }

    #[test]
    fn floating_native_poller_skips_duplicate_drag_positions_but_keeps_release_snap_forced() {
        assert!(!super::should_apply_floating_native_position(
            Some((120, 240)),
            (120, 240),
            false,
        ));
        assert!(super::should_apply_floating_native_position(
            Some((120, 240)),
            (121, 240),
            false,
        ));
        assert!(super::should_apply_floating_native_position(
            Some((120, 240)),
            (120, 240),
            true,
        ));
    }

    #[test]
    fn floating_native_poller_reuses_idle_geometry_without_changing_its_poll_interval() {
        assert!(!super::should_sample_floating_native_geometry(
            false,
            false,
            Some((120, 240)),
            (120, 240),
            Some(std::time::Duration::from_millis(
                super::FLOATING_NATIVE_IDLE_GEOMETRY_RECHECK_MS - 1,
            )),
        ));
        assert!(super::should_sample_floating_native_geometry(
            false,
            false,
            Some((120, 240)),
            (120, 240),
            Some(std::time::Duration::from_millis(
                super::FLOATING_NATIVE_IDLE_GEOMETRY_RECHECK_MS,
            )),
        ));
        assert!(super::should_sample_floating_native_geometry(
            false,
            false,
            Some((120, 240)),
            (121, 240),
            Some(std::time::Duration::from_millis(1)),
        ));
        // A stationary open menu can reuse its cached hit zones. Visibility
        // transitions clear the cache, while cursor movement and the periodic
        // recheck still force a fresh native snapshot.
        assert!(!super::should_sample_floating_native_geometry(
            false,
            false,
            Some((120, 240)),
            (120, 240),
            Some(std::time::Duration::from_millis(1)),
        ));
        assert!(super::should_sample_floating_native_geometry(
            true,
            false,
            Some((120, 240)),
            (120, 240),
            Some(std::time::Duration::from_millis(1)),
        ));
        assert!(super::should_sample_floating_native_geometry(
            false,
            true,
            Some((120, 240)),
            (120, 240),
            Some(std::time::Duration::from_millis(1)),
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn floating_native_geometry_hit_test_uses_the_sampled_rect_bounds() {
        let rect = super::NativeRect {
            left: 100,
            top: 200,
            right: 160,
            bottom: 260,
        };

        assert!(super::point_inside_native_rect(&rect, 100, 200));
        assert!(super::point_inside_native_rect(&rect, 159, 259));
        assert!(!super::point_inside_native_rect(&rect, 160, 259));
        assert!(!super::point_inside_native_rect(&rect, 159, 260));
    }

    #[test]
    fn floating_native_panel_visibility_effects_are_idempotent() {
        assert!(!super::should_transition_floating_native_panel_visibility(
            true, true
        ));
        assert!(!super::should_transition_floating_native_panel_visibility(
            false, false
        ));
        assert!(super::should_transition_floating_native_panel_visibility(
            false, true
        ));
        assert!(super::should_transition_floating_native_panel_visibility(
            true, false
        ));
    }

    #[test]
    fn floating_panel_sync_replay_never_reopens_a_panel_that_has_been_hidden() {
        assert!(super::should_replay_floating_panel_sync(true));
        assert!(!super::should_replay_floating_panel_sync(false));
    }

    #[test]
    fn floating_drag_cleanup_releases_the_native_lifecycle_pause_once() {
        let mut drag_surfaces_suppressed = true;

        assert!(super::take_floating_native_drag_pause_release(
            &mut drag_surfaces_suppressed
        ));
        assert!(!drag_surfaces_suppressed);
        assert!(!super::take_floating_native_drag_pause_release(
            &mut drag_surfaces_suppressed
        ));
    }

    #[test]
    fn floating_keep_panel_auto_show_waits_for_drag_hover_suppression_to_end() {
        assert!(!super::should_auto_show_floating_panel_for_keep_visible(
            true, false, false, false, true
        ));
        assert!(super::should_auto_show_floating_panel_for_keep_visible(
            true, false, false, false, false
        ));
        assert!(!super::should_auto_show_floating_panel_for_keep_visible(
            false, false, false, false, false
        ));
    }

    #[test]
    fn floating_drag_surface_snapshot_restores_only_the_actual_pre_drag_surface() {
        let none = super::capture_floating_drag_surface_snapshot(false, false, false);
        assert_eq!(
            super::resolve_floating_drag_surface_restore(none),
            super::FloatingDragSurfaceRestore::None
        );

        let panel = super::capture_floating_drag_surface_snapshot(true, false, false);
        assert_eq!(
            super::resolve_floating_drag_surface_restore(panel),
            super::FloatingDragSurfaceRestore::Panel
        );

        let list = super::capture_floating_drag_surface_snapshot(false, true, false);
        assert_eq!(
            super::resolve_floating_drag_surface_restore(list),
            super::FloatingDragSurfaceRestore::NotificationList
        );

        let detail = super::capture_floating_drag_surface_snapshot(false, true, true);
        assert_eq!(
            super::resolve_floating_drag_surface_restore(detail),
            super::FloatingDragSurfaceRestore::NotificationDetail
        );
    }

    #[test]
    fn floating_drag_surface_snapshot_keeps_menu_precedence_over_a_visibility_drift() {
        let snapshot = super::capture_floating_drag_surface_snapshot(true, true, true);

        assert_eq!(
            super::resolve_floating_drag_surface_restore(snapshot),
            super::FloatingDragSurfaceRestore::Panel
        );
        assert!(!snapshot.notification_list_visible);
        assert!(!snapshot.notification_detail_visible);
    }

    #[test]
    fn floating_notification_sync_is_suppressed_until_native_drag_restore() {
        assert!(super::should_sync_floating_notification_window(
            false, false
        ));
        assert!(!super::should_sync_floating_notification_window(
            true, false
        ));
        assert!(super::should_sync_floating_notification_window(true, true));
    }

    #[test]
    fn floating_taskbar_style_normalization_replaces_appwindow_with_toolwindow() {
        const OTHER_VALID_EX_STYLE: isize = 0x0008_0000;
        let incorrect = super::WS_EX_APPWINDOW | OTHER_VALID_EX_STYLE;

        let normalized = normalize_floating_window_ex_style(incorrect);

        assert_ne!(normalized & super::WS_EX_TOOLWINDOW, 0);
        assert_eq!(normalized & super::WS_EX_APPWINDOW, 0);
        assert_ne!(normalized & OTHER_VALID_EX_STYLE, 0);
    }

    #[test]
    fn floating_taskbar_style_normalization_is_idempotent_and_preserves_other_bits() {
        const OTHER_VALID_EX_STYLE: isize = 0x0008_0000 | 0x0000_0008;
        let expected = super::WS_EX_TOOLWINDOW | OTHER_VALID_EX_STYLE;

        assert_eq!(normalize_floating_window_ex_style(expected), expected);
        assert_eq!(
            normalize_floating_window_ex_style(normalize_floating_window_ex_style(expected)),
            expected
        );
    }

    #[test]
    fn floating_orb_alpha_region_runs_cover_the_avatar_shape() {
        assert_eq!(FLOATING_ORB_ALPHA_REGION_RUNS.len(), 60);
        assert_eq!(FLOATING_ORB_ALPHA_REGION_RUNS[0], (0, 18, 44));
        assert_eq!(FLOATING_ORB_ALPHA_REGION_RUNS[1], (1, 17, 46));
        assert_eq!(FLOATING_ORB_ALPHA_REGION_RUNS.last(), Some(&(59, 14, 60)));
        assert_eq!(
            FLOATING_ORB_ALPHA_REGION_RUNS
                .iter()
                .map(|(_, left, right)| right - left)
                .sum::<i32>(),
            2_321
        );
        assert!(FLOATING_ORB_ALPHA_REGION_RUNS
            .iter()
            .all(|(y, left, right)| {
                *y >= 0
                    && *y < FLOATING_ORB_SIZE as i32
                    && *left >= 0
                    && *left < *right
                    && *right <= FLOATING_ORB_SIZE as i32
            }));
    }

    #[test]
    fn floating_taskbar_style_recheck_requires_current_visible_auxiliary_window_generation() {
        assert!(should_recheck_floating_taskbar_style(
            "floating", 7, 7, true
        ));
        assert!(should_recheck_floating_taskbar_style(
            "floating-panel",
            9,
            9,
            true
        ));
        assert!(should_recheck_floating_taskbar_style(
            "floating-notification",
            11,
            11,
            true
        ));
        assert!(!should_recheck_floating_taskbar_style(
            "floating", 8, 7, true
        ));
        assert!(!should_recheck_floating_taskbar_style(
            "floating", 7, 7, false
        ));
        assert!(!should_recheck_floating_taskbar_style("main", 7, 7, true));
        assert!(!should_recheck_floating_taskbar_style(
            "unknown", 7, 7, true
        ));
    }

    #[test]
    fn floating_auxiliary_show_requires_the_latest_visible_intent() {
        assert!(should_apply_floating_auxiliary_show("floating", 3, 3, true));
        assert!(should_apply_floating_auxiliary_show(
            "floating-panel",
            8,
            8,
            true
        ));
        assert!(should_apply_floating_auxiliary_show(
            "floating-notification",
            12,
            12,
            true
        ));

        // show -> hide 后，旧 show 的 generation 不再是当前意图，不能复活窗口。
        assert!(!should_apply_floating_auxiliary_show(
            "floating", 4, 3, false
        ));
        // hide -> show 后，早于最新 show 的任务同样必须失效。
        assert!(!should_apply_floating_auxiliary_show(
            "floating-panel",
            10,
            9,
            true
        ));
        assert!(!should_apply_floating_auxiliary_show(
            "floating-notification",
            12,
            12,
            false
        ));
        assert!(!should_apply_floating_auxiliary_show("main", 1, 1, true));
    }

    #[test]
    fn only_three_auxiliary_labels_participate_in_taskbar_style_rechecks() {
        assert!(is_floating_auxiliary_window_label("floating"));
        assert!(is_floating_auxiliary_window_label("floating-panel"));
        assert!(is_floating_auxiliary_window_label("floating-notification"));
        assert!(!is_floating_auxiliary_window_label("main"));
        assert!(!is_floating_auxiliary_window_label("other"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn floating_taskbar_style_show_message_requires_visible_top_level_auxiliary_hwnd() {
        assert!(
            super::should_apply_floating_taskbar_style_from_show_message(
                super::WM_SHOWWINDOW,
                1,
                super::FLOATING_TASKBAR_STYLE_SUBCLASS_PANEL_ID,
                true,
            )
        );
        assert!(
            !super::should_apply_floating_taskbar_style_from_show_message(
                super::WM_SHOWWINDOW,
                0,
                super::FLOATING_TASKBAR_STYLE_SUBCLASS_PANEL_ID,
                true,
            )
        );
        assert!(
            !super::should_apply_floating_taskbar_style_from_show_message(
                0x000F,
                1,
                super::FLOATING_TASKBAR_STYLE_SUBCLASS_PANEL_ID,
                true,
            )
        );
        assert!(
            !super::should_apply_floating_taskbar_style_from_show_message(
                super::WM_SHOWWINDOW,
                1,
                super::FLOATING_TASKBAR_STYLE_SUBCLASS_PANEL_ID,
                false,
            )
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn main_window_chrome_show_message_requires_visible_top_level_hwnd() {
        assert!(super::should_apply_main_window_chrome_from_show_message(
            super::WM_SHOWWINDOW,
            1,
            true,
        ));
        assert!(!super::should_apply_main_window_chrome_from_show_message(
            super::WM_SHOWWINDOW,
            0,
            true,
        ));
        assert!(!super::should_apply_main_window_chrome_from_show_message(
            0x000F, 1, true,
        ));
        assert!(!super::should_apply_main_window_chrome_from_show_message(
            super::WM_SHOWWINDOW,
            1,
            false,
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn floating_taskbar_style_only_auxiliary_window_labels_receive_subclass_ids() {
        assert_eq!(
            super::floating_taskbar_style_subclass_id("floating"),
            Some(super::FLOATING_TASKBAR_STYLE_SUBCLASS_ORB_ID),
        );
        assert_eq!(
            super::floating_taskbar_style_subclass_id("floating-panel"),
            Some(super::FLOATING_TASKBAR_STYLE_SUBCLASS_PANEL_ID),
        );
        assert_eq!(
            super::floating_taskbar_style_subclass_id("floating-notification"),
            Some(super::FLOATING_TASKBAR_STYLE_SUBCLASS_NOTIFICATION_ID),
        );
        assert_eq!(super::floating_taskbar_style_subclass_id("main"), None);
        assert_eq!(super::floating_taskbar_style_subclass_id("unknown"), None);
        assert!(
            !super::should_apply_floating_taskbar_style_from_show_message(
                super::WM_SHOWWINDOW,
                1,
                0xF10A71FF,
                true,
            )
        );
    }

    #[test]
    fn floating_native_poller_tracks_short_clicks_while_cursor_is_inside_orb() {
        assert_eq!(
            resolve_floating_native_poll_ms_with_pointer_near_orb(true, false, false, true),
            FLOATING_NATIVE_DRAG_POLL_MS
        );
        assert_eq!(
            resolve_floating_native_poll_ms_with_pointer_near_orb(true, false, false, false),
            FLOATING_NATIVE_IDLE_POLL_MS
        );
        assert_eq!(
            resolve_floating_native_poll_ms_with_pointer_near_orb(false, false, false, true),
            FLOATING_NATIVE_HIDDEN_POLL_MS
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn floating_native_poller_coalesces_pending_main_thread_ticks() {
        assert!(super::should_schedule_floating_native_poll_tick(false));
        assert!(!super::should_schedule_floating_native_poll_tick(true));
    }

    #[test]
    fn floating_native_panel_visibility_prefers_the_observed_hwnd_state() {
        assert!(resolve_floating_native_panel_visible(false, Some(true)));
        assert!(!resolve_floating_native_panel_visible(true, Some(false)));
        assert!(resolve_floating_native_panel_visible(true, None));
        assert!(!resolve_floating_native_panel_visible(false, None));
    }

    #[test]
    fn floating_native_webview_pointer_bridge_ignores_a_released_pointer() {
        assert!(should_begin_floating_native_webview_session(true, true));
        assert!(!should_begin_floating_native_webview_session(false, true));
        assert!(!should_begin_floating_native_webview_session(true, false));
    }

    #[test]
    fn floating_geometry_preserves_logical_interaction_distances_at_high_dpi() {
        let geometry_100 = FloatingGeometry::for_scale(1.0);
        assert_eq!(geometry_100.safe_margin, 12);
        assert_eq!(geometry_100.drag_threshold, 4);

        let geometry_125 = FloatingGeometry::for_scale(1.25);
        assert_eq!(geometry_125.safe_margin, 15);
        assert_eq!(geometry_125.panel_gap, 10);
        assert_eq!(geometry_125.drag_threshold, 5);

        let geometry_150 = FloatingGeometry::for_scale(1.5);
        assert_eq!(geometry_150.notification_gap, 12);
        assert_eq!(geometry_150.panel_gap, 12);
        assert_eq!(geometry_150.edge_hide, 0);
        assert_eq!(geometry_150.safe_margin, 18);
        assert_eq!(geometry_150.edge_snap_threshold, 12);
        assert_eq!(geometry_150.orb_edge_interaction_slop, 36);
        assert_eq!(geometry_150.drag_threshold, 6);
        assert_eq!(geometry_150.default_bottom_offset, 48);
        assert_eq!(logical_to_physical(4, 1.5), 6);
        assert!(!floating_drag_threshold_exceeded(
            5,
            0,
            geometry_150.drag_threshold
        ));
        assert!(floating_drag_threshold_exceeded(
            6,
            0,
            geometry_150.drag_threshold
        ));

        let panel =
            compute_panel_position_for_size(0, 1350, 0, 450, "left", 90, 540, 396, geometry_150);
        assert_eq!(panel, (102, 54));

        let snapped =
            compute_release_orb_position_for_size(0, 0, 1920, 1080, 11, 200, 90, 90, geometry_150);
        assert_eq!(snapped, (0, 200, "left"));

        let secondary_monitor_snapped = compute_release_orb_position_for_size(
            -1920,
            -300,
            1920,
            1080,
            -1917,
            -160,
            90,
            90,
            geometry_150,
        );
        assert_eq!(secondary_monitor_snapped, (-1920, -160, "left"));

        let logical_work_area_height = physical_to_logical(600, 1.5);
        assert_eq!(logical_work_area_height, 400);
        assert_eq!(
            resolve_floating_notification_window_height(
                1,
                true,
                logical_work_area_height,
                FloatingNotificationLayout::from_prefs(&crate::contracts::DesktopUiPrefs::default()),
            ),
            376
        );
    }

    #[test]
    fn startup_panel_cleanup_never_interrupts_active_interaction() {
        assert!(should_hide_floating_panel_after_startup(
            false, false, false
        ));
        assert!(!should_hide_floating_panel_after_startup(
            true, false, false
        ));
        assert!(!should_hide_floating_panel_after_startup(
            false, true, false
        ));
        assert!(!should_hide_floating_panel_after_startup(
            false, false, true
        ));
    }

    #[test]
    fn startup_handoff_requires_its_visible_target() {
        assert_eq!(
            resolve_startup_handoff_stage(StartupRevealTarget::Main, true, false),
            Some(StartupRevealStage::MainHwndVisible)
        );
        assert_eq!(
            resolve_startup_handoff_stage(StartupRevealTarget::Main, false, true),
            None
        );
        assert_eq!(
            resolve_startup_handoff_stage(StartupRevealTarget::Floating, false, true),
            Some(StartupRevealStage::FloatingWindowVisible)
        );
        assert_eq!(
            resolve_startup_handoff_stage(StartupRevealTarget::Floating, true, false),
            None
        );
    }

    #[test]
    fn startup_handoff_activation_state_keeps_navigation_across_replay_and_rejects_late_queueing() {
        let mut state = StartupHandoffState::default();

        assert!(queue_startup_handoff_activation(
            &mut state,
            Some("service-status")
        ));
        assert_eq!(
            take_startup_handoff_activation(&mut state),
            Some(Some("service-status".to_string()))
        );

        restore_startup_handoff_activation(&mut state, Some("service-status".to_string()));
        state.completed = true;

        assert!(!queue_startup_handoff_activation(
            &mut state,
            Some("overview")
        ));
        assert_eq!(
            take_startup_handoff_activation(&mut state),
            Some(Some("service-status".to_string()))
        );
        assert_eq!(take_startup_handoff_activation(&mut state), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn floating_orb_pointer_down_message_accepts_webview_parent_notify_only_for_the_orb() {
        assert!(super::is_floating_orb_pointer_down_message(
            0x0201,
            0,
            super::FLOATING_SUBCLASS_ORB_ID,
        ));
        assert!(super::is_floating_orb_pointer_down_message(
            0x0210,
            0xABCD_0201,
            super::FLOATING_SUBCLASS_ORB_ID,
        ));
        assert!(!super::is_floating_orb_pointer_down_message(
            0x0210,
            0xABCD_0201,
            super::FLOATING_SUBCLASS_PANEL_ID,
        ));
        assert!(!super::is_floating_orb_pointer_down_message(
            0x0204,
            0,
            super::FLOATING_SUBCLASS_ORB_ID,
        ));
        assert!(!super::is_floating_orb_pointer_down_message(
            0x0202,
            0,
            super::FLOATING_SUBCLASS_ORB_ID,
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn floating_native_subclass_refresh_recognizes_dynamic_webview_children() {
        assert!(super::is_floating_child_create_message(0x0210, 0xABCD_0001));
        assert!(!super::is_floating_child_create_message(
            0x0210,
            0xABCD_0201
        ));
        assert!(!super::is_floating_child_create_message(0x0201, 0x0001));
    }

    #[test]
    fn floating_native_poller_keeps_panel_visible_updates_fast() {
        assert_eq!(
            resolve_floating_native_poll_ms(false, true, false),
            FLOATING_NATIVE_VISIBLE_POLL_MS
        );
    }

    #[test]
    fn floating_native_poller_uses_idle_interval_for_visible_orb() {
        assert_eq!(
            resolve_floating_native_poll_ms(true, false, false),
            FLOATING_NATIVE_IDLE_POLL_MS
        );
    }

    #[test]
    fn floating_native_poller_backs_off_when_windows_are_hidden() {
        assert_eq!(
            resolve_floating_native_poll_ms(false, false, false),
            FLOATING_NATIVE_HIDDEN_POLL_MS
        );
    }

    #[test]
    fn floating_panel_native_position_expands_inward_from_left_and_right_orb() {
        let left = compute_panel_position(0, 900, 0, 300, "left");
        let right_orb_x = 1440 - FLOATING_ORB_SIZE as i32;
        let right = compute_panel_position(0, 900, right_orb_x, 300, "right");

        assert_eq!(left.0, FLOATING_ORB_SIZE as i32 + FLOATING_PANEL_GAP);
        assert_eq!(
            right.0,
            right_orb_x - FLOATING_PANEL_WIDTH as i32 - FLOATING_PANEL_GAP
        );
        let expected_y = FloatingGeometry::for_scale(1.0).safe_margin;
        assert_eq!(left.1, expected_y);
        assert_eq!(right.1, expected_y);
    }

    #[test]
    fn floating_panel_native_position_stays_inside_top_safe_margin() {
        let left = compute_panel_position(0, 900, 0, 220, "left");
        let right = compute_panel_position(0, 900, 1380, 220, "right");

        assert_eq!(left.1, 12);
        assert_eq!(right.1, 12);
    }

    #[test]
    fn floating_notification_dock_uses_the_orb_center_on_each_monitor() {
        assert_eq!(
            resolve_floating_notification_dock_for_size(0, 1_000, 100, 64),
            FloatingNotificationDock::Left
        );
        assert_eq!(
            resolve_floating_notification_dock_for_size(0, 1_000, 900, 64),
            FloatingNotificationDock::Right
        );
        assert_eq!(
            resolve_floating_notification_dock_for_size(0, 1_000, 468, 64),
            FloatingNotificationDock::Left
        );
        assert_eq!(
            resolve_floating_notification_dock_for_size(-1_920, 1_920, -1_900, 64),
            FloatingNotificationDock::Left
        );
        assert_eq!(
            resolve_floating_notification_dock_for_size(-1_920, 1_920, -200, 64),
            FloatingNotificationDock::Right
        );
    }

    #[test]
    fn floating_notification_mailbox_preserves_payloads_until_hydration_and_dismissal() {
        let mut mailbox = FloatingNotificationMailbox::default();
        let empty = mailbox.snapshot();
        assert_eq!(empty.dock, FloatingNotificationDock::Right);
        assert_eq!(
            serde_json::to_value(&empty).expect("serialize default notification snapshot")["dock"],
            "right"
        );
        let first = mailbox.enqueue(floating_notification_payload(
            "notification-1",
            "service:down:model-a",
        ));

        assert_eq!(first.revision, 1);
        assert_eq!(first.items.len(), 1);
        assert_eq!(mailbox.snapshot(), first);

        let dismissed = mailbox.dismiss("notification-1");
        assert_eq!(dismissed.revision, 2);
        assert!(dismissed.items.is_empty());
    }

    #[test]
    fn floating_notification_mailbox_keeps_the_last_item_until_the_frontend_confirms_dismissal() {
        let mut mailbox = FloatingNotificationMailbox::default();
        mailbox.enqueue(floating_notification_payload(
            "notification-1",
            "service:down:model-a",
        ));

        let before_exit_confirmation = mailbox.snapshot();
        assert_eq!(before_exit_confirmation.items.len(), 1);
        assert_eq!(before_exit_confirmation.items[0].id, "notification-1");

        let after_exit_confirmation = mailbox.dismiss("notification-1");
        assert!(after_exit_confirmation.items.is_empty());
        assert_eq!(
            after_exit_confirmation.revision,
            before_exit_confirmation.revision + 1
        );
    }

    #[test]
    fn floating_notification_mailbox_deduplicates_active_incidents_and_rearms_after_dismissal() {
        let mut mailbox = FloatingNotificationMailbox::default();
        let first = mailbox.enqueue(floating_notification_payload(
            "notification-1",
            "service:down:model-a",
        ));
        let duplicate = mailbox.enqueue(floating_notification_payload(
            "notification-2",
            "service:down:model-a",
        ));

        assert_eq!(duplicate.revision, first.revision);
        assert_eq!(duplicate.items.len(), 1);
        assert_eq!(duplicate.items[0].id, "notification-1");

        let dismissed = mailbox.dismiss("notification-1");
        assert_eq!(dismissed.revision, 2);

        let rearmed = mailbox.enqueue(floating_notification_payload(
            "notification-3",
            "service:down:model-a",
        ));
        assert_eq!(rearmed.revision, 3);
        assert_eq!(rearmed.items[0].id, "notification-3");
    }

    #[test]
    fn floating_notification_usage_mailbox_restores_unacknowledged_items_in_persisted_fifo_order() {
        let first = usage_notification_payload("usage-1", "usage-sync:account-1:row-1");
        let second = usage_notification_payload("usage-2", "usage-sync:account-1:row-2");
        let mut restarted_mailbox = FloatingNotificationMailbox::default();

        let snapshot = restarted_mailbox.restore_usage_notifications([first, second]);

        assert_eq!(snapshot.revision, 1);
        assert_eq!(
            snapshot
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["usage-1", "usage-2"]
        );
        let acknowledged = restarted_mailbox.dismiss("usage-1");
        assert_eq!(
            acknowledged
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["usage-2"]
        );
    }

    #[test]
    fn floating_notification_native_geometry_projects_the_mailbox_prefix_for_every_channel() {
        let items = vec![
            usage_notification_payload("usage-1", "usage-sync:account-1:row-1"),
            usage_notification_payload("usage-2", "usage-sync:account-1:row-2"),
            floating_notification_payload("business-1", "service:one"),
            floating_notification_payload("business-2", "service:two"),
            usage_notification_payload("usage-3", "usage-sync:account-1:row-3"),
        ];

        for max_visible in [1_i64, 3, 5] {
            let layout =
                FloatingNotificationLayout::from_prefs(&crate::contracts::DesktopUiPrefs {
                    floating_notification_max_visible: max_visible,
                    ..crate::contracts::DesktopUiPrefs::default()
                });
            let visible = resolve_floating_notification_visible_items(&items, layout);
            let expected = items
                .iter()
                .take(usize::try_from(max_visible).expect("supported visible count"))
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>();

            assert_eq!(
                visible
                    .iter()
                    .map(|item| item.id.as_str())
                    .collect::<Vec<_>>(),
                expected
            );
        }
    }

    #[test]
    fn floating_notification_bounds_prefer_space_above_and_fall_back_below() {
        let above = compute_floating_notification_position(
            0,
            0,
            1440,
            900,
            300,
            500,
            360,
            560,
            FLOATING_NOTIFICATION_WIDTH,
            FloatingNotificationLayout::from_prefs(&crate::contracts::DesktopUiPrefs::default())
                .min_height(),
        );
        let below = compute_floating_notification_position(
            0,
            0,
            1440,
            900,
            300,
            30,
            360,
            90,
            FLOATING_NOTIFICATION_WIDTH,
            FloatingNotificationLayout::from_prefs(&crate::contracts::DesktopUiPrefs::default())
                .min_height(),
        );

        assert_eq!(above, (214, 420));
        assert_eq!(below, (214, 98));
    }

    #[test]
    fn floating_notification_height_matches_compact_and_usage_card_mix() {
        assert_eq!(
            resolve_floating_notification_height_for_items(
                &[64],
                FloatingNotificationLayout::from_prefs(&crate::contracts::DesktopUiPrefs::default()),
            ),
            72
        );
        assert_eq!(
            resolve_floating_notification_height_for_items(
                &[105],
                FloatingNotificationLayout::from_prefs(&crate::contracts::DesktopUiPrefs::default()),
            ),
            113
        );
        assert_eq!(
            resolve_floating_notification_height_for_items(
                &[64, 105],
                FloatingNotificationLayout::from_prefs(&crate::contracts::DesktopUiPrefs::default()),
            ),
            183
        );
        assert_eq!(
            resolve_floating_notification_height_for_items(
                &[105, 105, 105, 105],
                FloatingNotificationLayout::from_prefs(&crate::contracts::DesktopUiPrefs::default()),
            ),
            335
        );
    }

    #[test]
    fn floating_notification_physical_size_is_resolved_before_the_atomic_bounds_commit() {
        assert_eq!(
            resolve_floating_notification_physical_size(FLOATING_NOTIFICATION_WIDTH, 113, 1.0),
            (232, 113)
        );
        assert_eq!(
            resolve_floating_notification_physical_size(FLOATING_NOTIFICATION_WIDTH, 224, 1.25),
            (290, 280)
        );
        assert_eq!(
            resolve_floating_notification_physical_size(FLOATING_NOTIFICATION_WIDTH, 335, 1.5),
            (348, 503)
        );
    }

    #[test]
    fn floating_notification_native_round_rect_keeps_border_pixels_at_common_dpi_scales() {
        let region = FloatingNotificationHitRegion {
            x: 4,
            y: 4,
            width: 224,
            height: 192,
            corner_radius: 8,
        };

        for (client_width, client_height, expected) in [
            (232, 200, (4, 4, 229, 197, 16, 16)),
            (290, 250, (5, 5, 286, 246, 20, 20)),
            (348, 300, (6, 6, 343, 295, 24, 24)),
        ] {
            let bounds = resolve_floating_notification_native_round_rect(
                region,
                232,
                200,
                client_width,
                client_height,
            );

            assert_eq!(
                (
                    bounds.left,
                    bounds.top,
                    bounds.right,
                    bounds.bottom,
                    bounds.radius_x,
                    bounds.radius_y,
                ),
                expected
            );
        }
    }

    #[test]
    fn floating_notification_native_round_rect_clamps_compensation_to_client_bounds() {
        let bounds = resolve_floating_notification_native_round_rect(
            FloatingNotificationHitRegion {
                x: 4,
                y: 4,
                width: 228,
                height: 196,
                corner_radius: 8,
            },
            232,
            200,
            290,
            250,
        );

        assert_eq!((bounds.left, bounds.top), (5, 5));
        assert_eq!((bounds.right, bounds.bottom), (290, 250));
    }

    #[test]
    fn floating_notification_hit_regions_only_cover_visible_pills_or_detail_surface() {
        let pills = resolve_floating_notification_hit_regions_for_items(
            &[64, 105],
            false,
            FLOATING_NOTIFICATION_WIDTH,
            183,
            FloatingNotificationLayout::from_prefs(&crate::contracts::DesktopUiPrefs::default()),
        );

        assert_eq!(pills.len(), 2);
        assert_eq!(pills[0].x, 4);
        assert_eq!(pills[0].y, 74);
        assert_eq!(pills[0].width, 224);
        assert_eq!(pills[0].height, 105);
        assert_eq!(pills[0].corner_radius, 8);
        assert_eq!(pills[1].y, 4);

        let detail = resolve_floating_notification_hit_regions_for_items(
            &[105],
            true,
            FLOATING_NOTIFICATION_DETAIL_WIDTH,
            360,
            FloatingNotificationLayout::from_prefs(&crate::contracts::DesktopUiPrefs::default()),
        );
        assert_eq!(detail.len(), 1);
        assert_eq!(detail[0].x, 4);
        assert_eq!(detail[0].y, 4);
        assert_eq!(detail[0].width, 336);
        assert_eq!(detail[0].height, 352);
        assert_eq!(detail[0].corner_radius, 8);
    }

    #[test]
    fn floating_notification_motion_region_covers_the_gaps_between_moving_pills() {
        let layout =
            FloatingNotificationLayout::from_prefs(&crate::contracts::DesktopUiPrefs::default());
        let regions = resolve_floating_notification_regions_for_motion(
            &[64, 105],
            false,
            FLOATING_NOTIFICATION_WIDTH,
            183,
            layout,
            true,
        );

        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].x, 4);
        assert_eq!(regions[0].y, 4);
        assert_eq!(regions[0].width, 224);
        assert_eq!(regions[0].height, 175);
        let motion_bounds = resolve_floating_notification_native_round_rect(
            regions[0],
            FLOATING_NOTIFICATION_WIDTH,
            183,
            FLOATING_NOTIFICATION_WIDTH,
            183,
        );
        assert_eq!((motion_bounds.right, motion_bounds.bottom), (229, 180));

        let settled = resolve_floating_notification_regions_for_motion(
            &[64, 105],
            false,
            FLOATING_NOTIFICATION_WIDTH,
            183,
            layout,
            false,
        );
        assert_eq!(settled.len(), 2);
        assert_eq!(
            settled[0].y - (settled[1].y + settled[1].height),
            layout.item_gap
        );
        let newest_bounds = resolve_floating_notification_native_round_rect(
            settled[0],
            FLOATING_NOTIFICATION_WIDTH,
            183,
            FLOATING_NOTIFICATION_WIDTH,
            183,
        );
        let oldest_bounds = resolve_floating_notification_native_round_rect(
            settled[1],
            FLOATING_NOTIFICATION_WIDTH,
            183,
            FLOATING_NOTIFICATION_WIDTH,
            183,
        );
        assert_eq!((newest_bounds.right, newest_bounds.bottom), (229, 180));
        assert_eq!((oldest_bounds.right, oldest_bounds.bottom), (229, 69));
    }

    #[test]
    fn floating_notification_layout_keeps_window_height_and_hit_regions_in_sync_for_each_visible_limit(
    ) {
        for (max_visible, expected_height) in [(1_i64, 113), (3, 335), (5, 557)] {
            let layout =
                FloatingNotificationLayout::from_prefs(&crate::contracts::DesktopUiPrefs {
                    floating_notification_max_visible: max_visible,
                    ..crate::contracts::DesktopUiPrefs::default()
                });
            let visible_count = usize::try_from(max_visible).expect("supported visible count");
            let item_heights = vec![layout.usage_item_height; visible_count];
            let height = resolve_floating_notification_height_for_items(&item_heights, layout);
            let hit_regions = resolve_floating_notification_hit_regions_for_items(
                &item_heights,
                false,
                FLOATING_NOTIFICATION_WIDTH,
                height,
                layout,
            );

            assert_eq!(height, expected_height);
            assert_eq!(
                resolve_floating_notification_window_height(visible_count, false, 900, layout),
                expected_height
            );
            assert_eq!(hit_regions.len(), visible_count);
            assert_eq!(
                hit_regions[0].y + hit_regions[0].height,
                height - layout.vertical_padding / 2
            );
            assert_eq!(
                hit_regions.last().expect("oldest card region").y,
                layout.vertical_padding / 2
            );
            assert!(hit_regions.windows(2).all(|regions| {
                regions[0].y - (regions[1].y + regions[1].height) == layout.item_gap
            }));
            assert!(hit_regions
                .iter()
                .all(|region| region.width == FLOATING_NOTIFICATION_WIDTH - 8));
        }
    }

    #[test]
    fn floating_notification_hit_regions_follow_each_density_vertical_padding() {
        for (density, expected_vertical_inset) in [
            (crate::contracts::FloatingNotificationDensity::Compact, 4),
            (crate::contracts::FloatingNotificationDensity::Standard, 4),
            (crate::contracts::FloatingNotificationDensity::Relaxed, 5),
        ] {
            let layout =
                FloatingNotificationLayout::from_prefs(&crate::contracts::DesktopUiPrefs {
                    floating_notification_density: density,
                    floating_notification_max_visible: 2,
                    ..crate::contracts::DesktopUiPrefs::default()
                });
            let item_heights = vec![layout.usage_item_height; 2];
            let height = resolve_floating_notification_height_for_items(&item_heights, layout);
            let hit_regions = resolve_floating_notification_hit_regions_for_items(
                &item_heights,
                false,
                FLOATING_NOTIFICATION_WIDTH,
                height,
                layout,
            );

            assert_eq!(hit_regions.len(), 2);
            assert_eq!(
                hit_regions[0].y + hit_regions[0].height,
                height - expected_vertical_inset
            );
            assert_eq!(hit_regions[1].y, expected_vertical_inset);
        }
    }

    #[test]
    fn floating_notification_detail_height_uses_available_work_area_and_restores_list_height() {
        let layout =
            FloatingNotificationLayout::from_prefs(&crate::contracts::DesktopUiPrefs::default());
        assert_eq!(
            resolve_floating_notification_window_height(1, true, 900, layout),
            520
        );
        assert_eq!(
            resolve_floating_notification_window_height(1, true, 300, layout),
            276
        );
        assert_eq!(
            resolve_floating_notification_window_height(1, false, 900, layout),
            113
        );
        assert_eq!(
            resolve_floating_notification_window_height(3, false, 900, layout),
            335
        );
    }

    #[test]
    fn floating_notification_detail_cannot_remain_open_for_an_empty_mailbox() {
        assert!(!resolve_floating_notification_detail_open(true, 0));
        assert!(!resolve_floating_notification_detail_open(false, 1));
        assert!(resolve_floating_notification_detail_open(true, 1));
    }

    #[test]
    fn floating_notification_detail_position_stays_inside_the_work_area() {
        let detail_height = resolve_floating_notification_window_height(
            1,
            true,
            360,
            FloatingNotificationLayout::from_prefs(&crate::contracts::DesktopUiPrefs::default()),
        );
        let (_, y) = compute_floating_notification_position(
            0,
            0,
            1440,
            360,
            300,
            20,
            360,
            80,
            FLOATING_NOTIFICATION_WIDTH,
            detail_height,
        );

        assert!(y >= 12);
        assert!(y + detail_height <= 348);
    }

    #[test]
    fn floating_notification_layout_clamps_visible_count_and_matches_density_heights() {
        let compact = FloatingNotificationLayout::from_prefs(&crate::contracts::DesktopUiPrefs {
            floating_notification_density: crate::contracts::FloatingNotificationDensity::Compact,
            floating_notification_max_visible: 0,
            ..crate::contracts::DesktopUiPrefs::default()
        });
        let relaxed = FloatingNotificationLayout::from_prefs(&crate::contracts::DesktopUiPrefs {
            floating_notification_density: crate::contracts::FloatingNotificationDensity::Relaxed,
            floating_notification_max_visible: 9,
            ..crate::contracts::DesktopUiPrefs::default()
        });

        assert_eq!(compact.max_visible, 1);
        assert_eq!(compact.min_height(), 66);
        assert_eq!(relaxed.max_visible, 5);
        assert_eq!(relaxed.max_height(), 627);
        assert_eq!(
            resolve_floating_notification_height_for_items(&[117, 117, 117, 117, 117], relaxed),
            627
        );
    }
}
