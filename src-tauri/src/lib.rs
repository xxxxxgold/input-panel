use tauri::{
    menu::{Menu, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_window_state::{AppHandleExt as _, StateFlags, WindowExt as _};
use serde::Serialize;
use std::{
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

pub mod adapters;
pub mod application;
pub mod contracts;
pub mod domain;
pub mod infrastructure;

const MAIN_WINDOW_LABEL: &str = "main";
const FLOATING_WINDOW_LABEL: &str = "floating";
const FLOATING_PANEL_WINDOW_LABEL: &str = "floating-panel";
const FLOATING_ORB_SIZE: f64 = 68.0;
const FLOATING_PANEL_WIDTH: f64 = 458.0;
const FLOATING_PANEL_HEIGHT: f64 = 292.0;
const FLOATING_MENU_HEIGHT: i32 = 276;
const FLOATING_PREVIEW_HEIGHT: i32 = 276;
const FLOATING_PANEL_GAP: i32 = 4;
const FLOATING_EDGE_HIDE: i32 = 18;
const FLOATING_SAFE_MARGIN: i32 = 14;
const FLOATING_EDGE_SNAP_THRESHOLD: i32 = 8;
const TRAY_OPEN_MAIN_ID: &str = "open_main";
const TRAY_TOGGLE_FLOATING_ID: &str = "toggle_floating";
const TRAY_QUIT_ID: &str = "quit_app";
const FLOATING_CONTEXT_TOGGLE_PANEL_ID: &str = "floating_context_toggle_panel";
const FLOATING_CONTEXT_OPEN_MAIN_ID: &str = "floating_context_open_main";
const FLOATING_CONTEXT_QUIT_ID: &str = "floating_context_quit";

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
struct FloatingPanelSyncPayload {
    dock: &'static str,
    x: i32,
    y: i32,
    menu_visible: bool,
    active_panel: &'static str,
}

#[cfg(target_os = "windows")]
const FLOATING_SUBCLASS_ORB_ID: usize = 0xF10A7001;
#[cfg(target_os = "windows")]
const FLOATING_SUBCLASS_PANEL_ID: usize = 0xF10A7002;
#[cfg(target_os = "windows")]
const FLOATING_HOVER_TIMER_ID: usize = 0xF10A7010;
#[cfg(target_os = "windows")]
const FLOATING_HIDE_TIMER_ID: usize = 0xF10A7011;

static FLOATING_NATIVE_STATE: OnceLock<Arc<Mutex<FloatingNativeState>>> = OnceLock::new();

struct FloatingNativeState {
    app: AppHandle,
    orb_hwnd: usize,
    panel_hwnd: usize,
    orb_hovered: bool,
    panel_hovered: bool,
    pointer_down: bool,
    drag_started: bool,
    down_x: i32,
    down_y: i32,
    orb_origin_x: i32,
    orb_origin_y: i32,
    drag_current_x: i32,
    drag_current_y: i32,
    panel_visible: bool,
    active_panel: &'static str,
    last_left_down: bool,
    last_right_down: bool,
    hover_since: Option<Instant>,
    hide_since: Option<Instant>,
    suppress_hover_until: Option<Instant>,
    hover_reentry_required: bool,
}

fn should_keep_floating_panel_visible(app: &AppHandle) -> bool {
    application::desktop_ui_service::get_desktop_ui_prefs(&app.state::<application::AppContext>())
        .map(|prefs| prefs.keep_floating_panel_visible)
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
unsafe extern "system" {
    fn SetWindowSubclass(
        hwnd: *mut std::ffi::c_void,
        pfn_subclass: Option<unsafe extern "system" fn(*mut std::ffi::c_void, u32, usize, isize, usize, usize) -> isize>,
        uidsubclass: usize,
        dwrefdata: usize,
    ) -> i32;
    fn DefSubclassProc(
        hwnd: *mut std::ffi::c_void,
        msg: u32,
        wparam: usize,
        lparam: isize,
    ) -> isize;
    fn RemoveWindowSubclass(
        hwnd: *mut std::ffi::c_void,
        pfn_subclass: Option<unsafe extern "system" fn(*mut std::ffi::c_void, u32, usize, isize, usize, usize) -> isize>,
        uidsubclass: usize,
    ) -> i32;
    fn SetTimer(hwnd: *mut std::ffi::c_void, n_id_event: usize, u_elapse: u32, lp_timer_func: *mut std::ffi::c_void) -> usize;
    fn KillTimer(hwnd: *mut std::ffi::c_void, u_id_event: usize) -> i32;
    fn EnumChildWindows(
        hwnd: *mut std::ffi::c_void,
        callback: Option<unsafe extern "system" fn(*mut std::ffi::c_void, isize) -> i32>,
        lparam: isize,
    ) -> i32;
    fn GetCursorPos(point: *mut NativePoint) -> i32;
    fn GetWindowRect(hwnd: *mut std::ffi::c_void, rect: *mut NativeRect) -> i32;
    fn TrackMouseEvent(event_track: *mut NativeTrackMouseEvent) -> i32;
    fn SetCapture(hwnd: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    fn ReleaseCapture() -> i32;
    fn GetAsyncKeyState(v_key: i32) -> i16;
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct NativePoint {
    x: i32,
    y: i32,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct NativeRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct NativeTrackMouseEvent {
    cb_size: u32,
    dw_flags: u32,
    hwnd_track: *mut std::ffi::c_void,
    dw_hover_time: u32,
}

#[cfg(target_os = "windows")]
const TME_LEAVE: u32 = 0x00000002;
#[cfg(target_os = "windows")]
const WM_MOUSELEAVE_NATIVE: u32 = 0x02A3;

#[cfg(target_os = "windows")]
fn configure_native_floating_window(window: &WebviewWindow, width: i32, height: i32) {
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
    const WS_EX_APPWINDOW: isize = 0x0004_0000;
    const WS_EX_DLGMODALFRAME: isize = 0x0000_0001;
    const WS_EX_CLIENTEDGE: isize = 0x0000_0200;
    const WS_EX_STATICEDGE: isize = 0x0002_0000;
    const WS_EX_WINDOWEDGE: isize = 0x0000_0100;
    const WS_EX_LAYERED: isize = 0x0008_0000;
    const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_FRAMECHANGED: u32 = 0x0020;

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

    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let raw = hwnd.0 as *mut c_void;
            let style = GetWindowLongPtrW(raw, GWL_STYLE);
            let ex_style = GetWindowLongPtrW(raw, GWL_EXSTYLE);
            let next_style =
                (style | WS_POPUP | WS_CLIPSIBLINGS | WS_CLIPCHILDREN)
                    & !(WS_BORDER | WS_DLGFRAME | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU);
            let next_ex_style =
                (ex_style | WS_EX_LAYERED | WS_EX_TOOLWINDOW)
                    & !(WS_EX_APPWINDOW | WS_EX_DLGMODALFRAME | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE | WS_EX_WINDOWEDGE);
            let _ = SetWindowLongPtrW(raw, GWL_STYLE, next_style);
            let _ = SetWindowLongPtrW(raw, GWL_EXSTYLE, next_ex_style);
            let _ = SetWindowPos(
                raw,
                std::ptr::null_mut(),
                0,
                0,
                width,
                height,
                SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn configure_native_floating_window(_window: &WebviewWindow, _width: i32, _height: i32) {}

#[cfg(target_os = "windows")]
fn move_window_by_hwnd(hwnd: usize, x: i32, y: i32, width: i32, height: i32) {
    use std::ffi::c_void;

    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;

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
            width,
            height,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn move_window_by_hwnd(_hwnd: usize, _x: i32, _y: i32, _width: i32, _height: i32) {}

fn show_window(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn hide_window(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.hide();
    }
}

fn clamp_i32(value: i32, min: i32, max: i32) -> i32 {
    value.max(min).min(max)
}

fn monitor_to_logical_work_area(monitor: tauri::Monitor) -> (i32, i32, i32, i32) {
    let work_area = monitor.work_area();
    let scale = monitor.scale_factor();
    (
        (work_area.position.x as f64 / scale).round() as i32,
        (work_area.position.y as f64 / scale).round() as i32,
        (work_area.size.width as f64 / scale).round() as i32,
        (work_area.size.height as f64 / scale).round() as i32,
    )
}

fn resolve_monitor_work_area(
    app: &AppHandle,
    point_x: i32,
    point_y: i32,
) -> Option<(i32, i32, i32, i32)> {
    let to_logical = |monitor: tauri::Monitor| {
        monitor_to_logical_work_area(monitor)
    };

    if let Ok(monitors) = app.available_monitors() {
        for monitor in monitors {
            let (x, y, width, height) = to_logical(monitor);
            if point_x >= x && point_x < x + width && point_y >= y && point_y < y + height {
                return Some((x, y, width, height));
            }
        }
    }

    app.primary_monitor()
        .ok()
        .flatten()
        .map(to_logical)
}

fn resolve_floating_dock(work_area_x: i32, work_area_width: i32, orb_x: i32) -> &'static str {
    let center_x = orb_x + (FLOATING_ORB_SIZE as i32 / 2);
    if center_x <= work_area_x + work_area_width / 2 {
        "left"
    } else {
        "right"
    }
}

fn compute_snapped_orb_position(work_area_x: i32, work_area_y: i32, work_area_width: i32, work_area_height: i32, orb_x: i32, orb_y: i32) -> (i32, i32, &'static str) {
    let dock = resolve_floating_dock(work_area_x, work_area_width, orb_x);
    let min_y = work_area_y + FLOATING_SAFE_MARGIN;
    let max_y = work_area_y + work_area_height - FLOATING_ORB_SIZE as i32 - FLOATING_SAFE_MARGIN;
    let snapped_y = clamp_i32(orb_y, min_y, max_y.max(min_y));
    let snapped_x = if dock == "left" {
        work_area_x - FLOATING_EDGE_HIDE
    } else {
        work_area_x + work_area_width - FLOATING_ORB_SIZE as i32 + FLOATING_EDGE_HIDE
    };
    (snapped_x, snapped_y, dock)
}

fn compute_release_orb_position(
    work_area_x: i32,
    work_area_y: i32,
    work_area_width: i32,
    work_area_height: i32,
    orb_x: i32,
    orb_y: i32,
) -> (i32, i32, &'static str) {
    let min_y = work_area_y + FLOATING_SAFE_MARGIN;
    let max_y = work_area_y + work_area_height - FLOATING_ORB_SIZE as i32 - FLOATING_SAFE_MARGIN;
    let next_y = clamp_i32(orb_y, min_y, max_y.max(min_y));
    let orb_right = orb_x + FLOATING_ORB_SIZE as i32;
    let work_area_right = work_area_x + work_area_width;
    let distance_to_left = (orb_x - work_area_x).abs();
    let distance_to_right = (work_area_right - orb_right).abs();
    let should_snap_left = distance_to_left <= FLOATING_EDGE_SNAP_THRESHOLD;
    let should_snap_right = distance_to_right <= FLOATING_EDGE_SNAP_THRESHOLD;

    if should_snap_left || should_snap_right {
        return compute_snapped_orb_position(
            work_area_x,
            work_area_y,
            work_area_width,
            work_area_height,
            orb_x,
            orb_y,
        );
    }

    let min_x = work_area_x;
    let max_x = work_area_x + work_area_width - FLOATING_ORB_SIZE as i32;
    let next_x = clamp_i32(orb_x, min_x, max_x.max(min_x));
    let dock = resolve_floating_dock(work_area_x, work_area_width, next_x);
    (next_x, next_y, dock)
}

fn compute_panel_position(orb_x: i32, orb_y: i32, dock: &str) -> (i32, i32) {
    let panel_y = orb_y - FLOATING_MENU_HEIGHT.max(FLOATING_PREVIEW_HEIGHT);
    let panel_x = if dock == "left" {
        orb_x + FLOATING_ORB_SIZE as i32 + FLOATING_PANEL_GAP
    } else {
        orb_x - FLOATING_PANEL_WIDTH as i32 - FLOATING_PANEL_GAP
    };
    (panel_x, panel_y)
}

#[cfg(target_os = "windows")]
fn toggle_floating_panel_native(shared: &Arc<Mutex<FloatingNativeState>>) {
    let is_visible = {
        let Ok(state) = shared.lock() else {
            return;
        };
        state.panel_visible
    };
    if is_visible {
        hide_floating_panel_native(shared);
    } else {
        show_floating_panel_native(shared);
    }
}

fn open_main_window_from_native(app: &AppHandle) {
    let ctx = app.state::<application::AppContext>();
    if let Ok(prefs) =
        application::desktop_ui_service::set_launch_mode(&ctx, crate::contracts::AppLaunchMode::Main)
    {
        if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
            let _ = window.emit("open-nav", "overview");
        }
        if prefs.open_floating_in_main_mode {
            if let Some(window) = app.get_webview_window(FLOATING_WINDOW_LABEL) {
                let _ = window.show();
            }
        } else {
            hide_floating_group(app);
        }
        if let Some(window) = app.get_webview_window(FLOATING_PANEL_WINDOW_LABEL) {
            let _ = window.hide();
        }
        let _ = app.emit("desktop-ui-prefs-updated", &prefs);
    }
}

#[cfg(target_os = "windows")]
fn start_floating_native_poller(shared: Arc<Mutex<FloatingNativeState>>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(8)).await;

            let (orb_hwnd, panel_hwnd) = {
                let Ok(state) = shared.lock() else {
                    continue;
                };
                (state.orb_hwnd, state.panel_hwnd)
            };

            if orb_hwnd == 0 {
                continue;
            }

            let mut cursor = NativePoint { x: 0, y: 0 };
            unsafe {
                let _ = GetCursorPos(&mut cursor);
            }
            let app = {
                let Ok(state) = shared.lock() else {
                    continue;
                };
                state.app.clone()
            };
            let keep_panel_visible = should_keep_floating_panel_visible(&app);
            let orb_hit = point_inside_orb_interaction_zone(&app, orb_hwnd, cursor.x, cursor.y);
            let orb_drag_hit = point_inside_orb_drag_zone(&app, orb_hwnd, cursor.x, cursor.y);
            let panel_hit = point_inside_window(panel_hwnd, cursor.x, cursor.y);
            let left_down = unsafe { (GetAsyncKeyState(0x01) as u16 & 0x8000) != 0 };
            let right_down = unsafe { (GetAsyncKeyState(0x02) as u16 & 0x8000) != 0 };

            let mut hide_panel = false;
            let mut show_panel = false;
            let mut toggle_panel = false;
            let mut show_menu = false;
            let mut snap_orb = false;
            let mut move_to: Option<(i32, i32)> = None;

            {
                let Ok(mut state) = shared.lock() else {
                    continue;
                };

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

                if keep_panel_visible {
                    state.hover_reentry_required = false;
                    state.hover_since = None;
                    if !state.panel_visible {
                        show_panel = true;
                    }
                } else if orb_hit && !state.pointer_down {
                    let hover_suppressed = state
                        .suppress_hover_until
                        .map(|until| until > Instant::now())
                        .unwrap_or(false);
                    if hover_suppressed || state.hover_reentry_required {
                        state.hover_since = None;
                    } else {
                        match state.hover_since {
                        Some(since)
                            if !state.panel_visible && since.elapsed() >= Duration::from_millis(240) =>
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

                if left_down && !state.last_left_down && orb_drag_hit {
                    state.pointer_down = true;
                    state.drag_started = false;
                    state.down_x = cursor.x;
                    state.down_y = cursor.y;
                    state.hover_since = None;
                    if let Some(orb) = state.app.get_webview_window(FLOATING_WINDOW_LABEL) {
                        if let Ok(position) = orb.outer_position() {
                            state.orb_origin_x = position.x;
                            state.orb_origin_y = position.y;
                            state.drag_current_x = position.x;
                            state.drag_current_y = position.y;
                        }
                    }
                } else if left_down && state.pointer_down {
                    let delta_x = cursor.x - state.down_x;
                    let delta_y = cursor.y - state.down_y;
                    if !state.drag_started && (delta_x.abs() >= 4 || delta_y.abs() >= 4) {
                        state.drag_started = true;
                        hide_panel = true;
                    }
                    if state.drag_started {
                        state.drag_current_x = state.orb_origin_x + delta_x;
                        state.drag_current_y = state.orb_origin_y + delta_y;
                        move_to = Some((state.drag_current_x, state.drag_current_y));
                    }
                } else if !left_down && state.last_left_down && state.pointer_down {
                    let dragged = state.drag_started;
                    state.pointer_down = false;
                    state.drag_started = false;
                    if dragged {
                        state.suppress_hover_until = Some(Instant::now() + Duration::from_millis(400));
                        snap_orb = true;
                    } else if orb_hit && !keep_panel_visible {
                        state.suppress_hover_until = Some(Instant::now() + Duration::from_millis(260));
                        state.hover_reentry_required = state.panel_visible;
                        toggle_panel = true;
                    }
                }

                if !right_down && state.last_right_down && orb_hit {
                    show_menu = true;
                }

                state.last_left_down = left_down;
                state.last_right_down = right_down;
            }

            if hide_panel {
                hide_floating_panel_native(&shared);
            }
            if let Some((x, y)) = move_to {
                let (app, orb_hwnd) = {
                    let Ok(state) = shared.lock() else {
                        continue;
                    };
                    (state.app.clone(), state.orb_hwnd)
                };
                if let Some(orb) = app.get_webview_window(FLOATING_WINDOW_LABEL) {
                    move_window_by_hwnd(
                        orb_hwnd,
                        x,
                        y,
                        FLOATING_ORB_SIZE as i32,
                        FLOATING_ORB_SIZE as i32,
                    );
                    let _ = orb.set_position(LogicalPosition::new(x as f64, y as f64));
                }
            }
            if snap_orb {
                snap_orb_to_edge_native(&shared);
            }
            if toggle_panel {
                toggle_floating_panel_native(&shared);
            } else if show_panel {
                show_floating_panel_native(&shared);
            }
            if show_menu {
                show_floating_context_menu_native(&shared);
            }
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn start_floating_native_poller(_shared: Arc<Mutex<FloatingNativeState>>) {}

#[cfg(target_os = "windows")]
fn show_floating_panel_native(shared: &Arc<Mutex<FloatingNativeState>>) {
    let app = {
        let Ok(state) = shared.lock() else {
            return;
        };
        state.app.clone()
    };

    let Some(orb) = app.get_webview_window(FLOATING_WINDOW_LABEL) else {
        return;
    };
    let Some(panel) = app.get_webview_window(FLOATING_PANEL_WINDOW_LABEL) else {
        return;
    };
    let Ok(orb_pos) = orb.outer_position() else {
        return;
    };
    let (work_area_x, work_area_y, work_area_width, work_area_height) = orb
        .current_monitor()
        .ok()
        .flatten()
        .map(monitor_to_logical_work_area)
        .or_else(|| {
            resolve_monitor_work_area(
                &app,
                orb_pos.x + FLOATING_ORB_SIZE as i32 / 2,
                orb_pos.y + FLOATING_ORB_SIZE as i32 / 2,
            )
        })
        .unwrap_or((0, 0, 2560, 1440));
    let (_, _, dock) = compute_snapped_orb_position(
        work_area_x,
        work_area_y,
        work_area_width,
        work_area_height,
        orb_pos.x,
        orb_pos.y,
    );
    let (panel_x, panel_y) = compute_panel_position(orb_pos.x, orb_pos.y, dock);

    let _ = panel.set_position(LogicalPosition::new(panel_x as f64, panel_y as f64));
    let _ = panel.show();
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
    let _ = app.emit_to(
        FLOATING_WINDOW_LABEL,
        "floating-native-panel-visibility",
        FloatingNativePanelVisibilityPayload { visible: true },
    );

    if let Ok(mut state) = shared.lock() {
        state.panel_visible = true;
    }
}

#[cfg(target_os = "windows")]
fn hide_floating_panel_native(shared: &Arc<Mutex<FloatingNativeState>>) {
    let app = {
        let Ok(state) = shared.lock() else {
            return;
        };
        state.app.clone()
    };
    if let Some(panel) = app.get_webview_window(FLOATING_PANEL_WINDOW_LABEL) {
        let _ = panel.hide();
    }
    let _ = app.emit_to(FLOATING_PANEL_WINDOW_LABEL, "floating-panel-hide", true);
    let _ = app.emit_to(
        FLOATING_WINDOW_LABEL,
        "floating-native-panel-visibility",
        FloatingNativePanelVisibilityPayload { visible: false },
    );
    if let Ok(mut state) = shared.lock() {
        state.panel_visible = false;
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
    let (work_area_x, work_area_y, work_area_width, work_area_height) = orb
        .current_monitor()
        .ok()
        .flatten()
        .map(monitor_to_logical_work_area)
        .or_else(|| {
            resolve_monitor_work_area(
                &app,
                orb_pos_x + FLOATING_ORB_SIZE as i32 / 2,
                orb_pos_y + FLOATING_ORB_SIZE as i32 / 2,
            )
        })
        .unwrap_or((0, 0, 2560, 1440));
    let (next_x, next_y, _) = compute_release_orb_position(
        work_area_x,
        work_area_y,
        work_area_width,
        work_area_height,
        orb_pos_x,
        orb_pos_y,
    );
    move_window_by_hwnd(
        orb_hwnd,
        next_x,
        next_y,
        FLOATING_ORB_SIZE as i32,
        FLOATING_ORB_SIZE as i32,
    );
    let _ = orb.set_position(LogicalPosition::new(next_x as f64, next_y as f64));
    if let Ok(mut state) = shared.lock() {
        state.orb_origin_x = next_x;
        state.orb_origin_y = next_y;
        state.drag_current_x = next_x;
        state.drag_current_y = next_y;
    }
}

#[cfg(target_os = "windows")]
fn schedule_native_hide(hwnd: usize) {
    unsafe {
        let _ = KillTimer(hwnd as *mut std::ffi::c_void, FLOATING_HIDE_TIMER_ID);
        let _ = SetTimer(hwnd as *mut std::ffi::c_void, FLOATING_HIDE_TIMER_ID, 260, std::ptr::null_mut());
    }
}

#[cfg(target_os = "windows")]
fn cancel_native_hide(hwnd: usize) {
    unsafe {
        let _ = KillTimer(hwnd as *mut std::ffi::c_void, FLOATING_HIDE_TIMER_ID);
    }
}

#[cfg(target_os = "windows")]
fn show_floating_context_menu_native(shared: &Arc<Mutex<FloatingNativeState>>) {
    let (app, orb_hwnd) = {
        let Ok(state) = shared.lock() else {
            return;
        };
        (state.app.clone(), state.orb_hwnd)
    };
    let Some(window) = app.get_webview_window(FLOATING_WINDOW_LABEL) else {
        return;
    };
    let toggle = match MenuItemBuilder::with_id(FLOATING_CONTEXT_TOGGLE_PANEL_ID, "展开/收起快捷面板").build(&app) {
        Ok(item) => item,
        Err(_) => return,
    };
    let open_main = match MenuItemBuilder::with_id(FLOATING_CONTEXT_OPEN_MAIN_ID, "打开主窗口").build(&app) {
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
    cancel_native_hide(orb_hwnd);
}

#[cfg(target_os = "windows")]
fn point_inside_window(hwnd: usize, x: i32, y: i32) -> bool {
    unsafe {
        let mut rect = NativeRect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if GetWindowRect(hwnd as *mut std::ffi::c_void, &mut rect).eq(&0) {
            return false;
        }
        x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom
    }
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
fn point_inside_orb_interaction_zone(app: &AppHandle, hwnd: usize, x: i32, y: i32) -> bool {
    if point_inside_window(hwnd, x, y) {
        return true;
    }

    let Some(rect) = get_window_rect(hwnd) else {
        return false;
    };
    if y < rect.top || y >= rect.bottom {
        return false;
    }

    let center_x = rect.left + ((rect.right - rect.left) / 2);
    let center_y = rect.top + ((rect.bottom - rect.top) / 2);
    let Some((work_area_x, _, work_area_width, _)) =
        resolve_monitor_work_area(app, center_x, center_y)
    else {
        return false;
    };
    let work_area_right = work_area_x + work_area_width;

    if rect.left < work_area_x {
        let visible_width = (rect.right.min(work_area_right) - work_area_x).max(0);
        let interaction_width = (visible_width + 24).min(FLOATING_ORB_SIZE as i32);
        return x >= work_area_x && x < work_area_x + interaction_width;
    }

    if rect.right > work_area_right {
        let visible_width = (work_area_right - rect.left.max(work_area_x)).max(0);
        let interaction_width = (visible_width + 24).min(FLOATING_ORB_SIZE as i32);
        return x >= work_area_right - interaction_width && x < work_area_right;
    }

    false
}

#[cfg(not(target_os = "windows"))]
fn point_inside_orb_interaction_zone(_app: &AppHandle, _hwnd: usize, _x: i32, _y: i32) -> bool {
    false
}

#[cfg(target_os = "windows")]
fn point_inside_orb_drag_zone(app: &AppHandle, hwnd: usize, x: i32, y: i32) -> bool {
    if point_inside_window(hwnd, x, y) {
        return true;
    }

    let Some(rect) = get_window_rect(hwnd) else {
        return false;
    };
    if y < rect.top || y >= rect.bottom {
        return false;
    }

    let center_x = rect.left + ((rect.right - rect.left) / 2);
    let center_y = rect.top + ((rect.bottom - rect.top) / 2);
    let Some((work_area_x, _, work_area_width, _)) =
        resolve_monitor_work_area(app, center_x, center_y)
    else {
        return false;
    };
    let work_area_right = work_area_x + work_area_width;

    if rect.left < work_area_x {
        return x >= work_area_x && x < work_area_x + FLOATING_ORB_SIZE as i32;
    }

    if rect.right > work_area_right {
        return x >= work_area_right - FLOATING_ORB_SIZE as i32 && x < work_area_right;
    }

    false
}

#[cfg(not(target_os = "windows"))]
fn point_inside_orb_drag_zone(_app: &AppHandle, _hwnd: usize, _x: i32, _y: i32) -> bool {
    false
}

#[cfg(target_os = "windows")]
fn handle_native_hover(shared: &Arc<Mutex<FloatingNativeState>>, orb_hovered: bool, panel_hovered: bool) {
    let (panel_visible, orb_hwnd, app) = {
        let Ok(mut state) = shared.lock() else {
            return;
        };
        state.orb_hovered = orb_hovered;
        state.panel_hovered = panel_hovered;
        (state.panel_visible, state.orb_hwnd, state.app.clone())
    };
    if should_keep_floating_panel_visible(&app) {
        cancel_native_hide(orb_hwnd);
        if !panel_visible {
            show_floating_panel_native(shared);
        }
        return;
    }

    if orb_hovered || panel_hovered {
        cancel_native_hide(orb_hwnd);
        if !panel_visible {
            unsafe {
                let _ = KillTimer(orb_hwnd as *mut std::ffi::c_void, FLOATING_HOVER_TIMER_ID);
                let _ = SetTimer(orb_hwnd as *mut std::ffi::c_void, FLOATING_HOVER_TIMER_ID, 240, std::ptr::null_mut());
            }
        }
        return;
    }

    schedule_native_hide(orb_hwnd);
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

    match msg {
        0x0200 => {
            let mut cursor = NativePoint { x: 0, y: 0 };
            let _ = GetCursorPos(&mut cursor);
            let mut track = NativeTrackMouseEvent {
                cb_size: std::mem::size_of::<NativeTrackMouseEvent>() as u32,
                dw_flags: TME_LEAVE,
                hwnd_track: hwnd,
                dw_hover_time: 0,
            };
            let _ = TrackMouseEvent(&mut track);
            let is_orb_source = subclass_id == FLOATING_SUBCLASS_ORB_ID;
            let is_panel_source = subclass_id == FLOATING_SUBCLASS_PANEL_ID;

            if is_orb_source {
                handle_native_hover(&shared, true, false);
            } else if is_panel_source {
                handle_native_hover(&shared, false, true);
            }
        }
        WM_MOUSELEAVE_NATIVE => {
            if subclass_id == FLOATING_SUBCLASS_ORB_ID {
                handle_native_hover(&shared, false, false);
            }

            if subclass_id == FLOATING_SUBCLASS_PANEL_ID {
                handle_native_hover(&shared, false, false);
            }
        }
        0x0201 => {
            if subclass_id != FLOATING_SUBCLASS_ORB_ID {
                return DefSubclassProc(hwnd, msg, wparam, lparam);
            }
            cancel_native_hide(hwnd as usize);
        }
        0x0202 => {
            if subclass_id != FLOATING_SUBCLASS_ORB_ID {
                return DefSubclassProc(hwnd, msg, wparam, lparam);
            }
            let app = {
                let Ok(state) = shared.lock() else {
                    return DefSubclassProc(hwnd, msg, wparam, lparam);
                };
                state.app.clone()
            };
            if should_keep_floating_panel_visible(&app) {
                show_floating_panel_native(&shared);
                return DefSubclassProc(hwnd, msg, wparam, lparam);
            }
            toggle_floating_panel_native(&shared);
        }
        0x0205 => {
            if subclass_id != FLOATING_SUBCLASS_ORB_ID {
                return DefSubclassProc(hwnd, msg, wparam, lparam);
            }
            show_floating_context_menu_native(&shared);
        }
        0x0113 => {
            if wparam == FLOATING_HOVER_TIMER_ID {
                show_floating_panel_native(&shared);
                unsafe {
                    let _ = KillTimer(hwnd, FLOATING_HOVER_TIMER_ID);
                }
            }
            if wparam == FLOATING_HIDE_TIMER_ID {
                let (orb_hwnd, panel_hwnd) = {
                    let Ok(state) = shared.lock() else {
                        return DefSubclassProc(hwnd, msg, wparam, lparam);
                    };
                    (state.orb_hwnd, state.panel_hwnd)
                };
                let mut cursor = NativePoint { x: 0, y: 0 };
                let _ = GetCursorPos(&mut cursor);
                let app = {
                    let Ok(state) = shared.lock() else {
                        return DefSubclassProc(hwnd, msg, wparam, lparam);
                    };
                    state.app.clone()
                };
                if should_keep_floating_panel_visible(&app) {
                    cancel_native_hide(hwnd as usize);
                    return DefSubclassProc(hwnd, msg, wparam, lparam);
                }
                let orb_hit = point_inside_orb_interaction_zone(&app, orb_hwnd, cursor.x, cursor.y);
                let panel_hit = point_inside_window(panel_hwnd, cursor.x, cursor.y);
                if !orb_hit && !panel_hit {
                    hide_floating_panel_native(&shared);
                }
                cancel_native_hide(hwnd as usize);
            }
        }
        _ => {}
    }

    DefSubclassProc(hwnd, msg, wparam, lparam)
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn install_child_subclass_proc(child: *mut std::ffi::c_void, _lparam: isize) -> i32 {
    let _ = SetWindowSubclass(
        child,
        Some(floating_native_subclass_proc),
        FLOATING_SUBCLASS_ORB_ID,
        0,
    );
    1
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn install_panel_child_subclass_proc(child: *mut std::ffi::c_void, _lparam: isize) -> i32 {
    let _ = SetWindowSubclass(
        child,
        Some(floating_native_subclass_proc),
        FLOATING_SUBCLASS_PANEL_ID,
        0,
    );
    1
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
        let _ = SetWindowSubclass(
            orb_hwnd as *mut std::ffi::c_void,
            Some(floating_native_subclass_proc),
            FLOATING_SUBCLASS_ORB_ID,
            0,
        );
        let _ = SetWindowSubclass(
            panel_hwnd as *mut std::ffi::c_void,
            Some(floating_native_subclass_proc),
            FLOATING_SUBCLASS_PANEL_ID,
            0,
        );
        let _ = EnumChildWindows(
            orb_hwnd as *mut std::ffi::c_void,
            Some(install_child_subclass_proc),
            0,
        );
        let _ = EnumChildWindows(
            panel_hwnd as *mut std::ffi::c_void,
            Some(install_panel_child_subclass_proc),
            0,
        );
    }
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
fn schedule_native_hide(_hwnd: usize) {}
#[cfg(not(target_os = "windows"))]
fn cancel_native_hide(_hwnd: usize) {}
#[cfg(not(target_os = "windows"))]
fn show_floating_context_menu_native(_shared: &Arc<Mutex<FloatingNativeState>>) {}

#[cfg(not(target_os = "windows"))]
fn emit_orb_native_action(_app: &AppHandle, _action: &'static str) {}

fn restore_or_place_floating_window(window: &WebviewWindow, app: &AppHandle) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let work_area = monitor.work_area();
        let scale = monitor.scale_factor();
        let work_area_x = work_area.position.x as f64 / scale;
        let work_area_y = work_area.position.y as f64 / scale;
        let work_area_width = work_area.size.width as f64 / scale;
        let work_area_height = work_area.size.height as f64 / scale;
        let left_x = work_area_x.round() as i32 - FLOATING_EDGE_HIDE;
        let right_x =
            (work_area_x + work_area_width - FLOATING_ORB_SIZE + FLOATING_EDGE_HIDE as f64).round() as i32;
        let default_x = work_area_x + work_area_width - FLOATING_ORB_SIZE + FLOATING_EDGE_HIDE as f64;
        let default_y = work_area_y + work_area_height - FLOATING_ORB_SIZE - 32.0;

        if window.restore_state(StateFlags::POSITION).is_ok() {
            if let Ok(position) = window.outer_position() {
                let is_legacy_top_anchor =
                    (position.y - (work_area_y.round() as i32 + 140)).abs() <= 4
                    && ((position.x - left_x).abs() <= 4 || (position.x - right_x).abs() <= 4);
                if !is_legacy_top_anchor {
                    let (next_x, next_y, _) = compute_snapped_orb_position(
                        work_area_x.round() as i32,
                        work_area_y.round() as i32,
                        work_area_width.round() as i32,
                        work_area_height.round() as i32,
                        position.x,
                        position.y,
                    );
                    let _ = window.set_position(LogicalPosition::new(next_x as f64, next_y as f64));
                    let _ = window.set_size(tauri::Size::Logical(LogicalSize::new(
                        FLOATING_ORB_SIZE,
                        FLOATING_ORB_SIZE,
                    )));
                    configure_native_floating_window(window, FLOATING_ORB_SIZE as i32, FLOATING_ORB_SIZE as i32);
                    return;
                }
            }
        }

        let _ = window.set_position(LogicalPosition::new(default_x, default_y));
    }
    configure_native_floating_window(window, FLOATING_ORB_SIZE as i32, FLOATING_ORB_SIZE as i32);
}

#[cfg(target_os = "windows")]
fn install_floating_native_state(app: &AppHandle) {
    let (Some(orb), Some(panel)) = (
        app.get_webview_window(FLOATING_WINDOW_LABEL),
        app.get_webview_window(FLOATING_PANEL_WINDOW_LABEL),
    ) else {
        return;
    };

    let Ok(orb_hwnd) = orb.hwnd() else {
        return;
    };
    let Ok(panel_hwnd) = panel.hwnd() else {
        return;
    };

    let shared = FLOATING_NATIVE_STATE
        .get_or_init(|| {
            Arc::new(Mutex::new(FloatingNativeState {
                app: app.clone(),
                orb_hwnd: orb_hwnd.0 as usize,
                panel_hwnd: panel_hwnd.0 as usize,
                orb_hovered: false,
                panel_hovered: false,
                pointer_down: false,
                drag_started: false,
                down_x: 0,
                down_y: 0,
                orb_origin_x: 0,
                orb_origin_y: 0,
                drag_current_x: 0,
                drag_current_y: 0,
                panel_visible: false,
                active_panel: "overview",
                last_left_down: false,
                last_right_down: false,
                hover_since: None,
                hide_since: None,
                suppress_hover_until: None,
                hover_reentry_required: false,
            }))
        })
        .clone();

    let lock_result = shared.lock();
    if let Ok(mut state) = lock_result {
        state.app = app.clone();
        state.orb_hwnd = orb_hwnd.0 as usize;
        state.panel_hwnd = panel_hwnd.0 as usize;
    }
}

#[cfg(not(target_os = "windows"))]
fn install_floating_native_state(_app: &AppHandle) {}

fn ensure_floating_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(FLOATING_WINDOW_LABEL) {
        configure_native_floating_window(&window, FLOATING_ORB_SIZE as i32, FLOATING_ORB_SIZE as i32);
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
        .visible(false)
        .focused(false)
        .shadow(false)
        .build()?;
    restore_or_place_floating_window(&window, app);
    configure_native_floating_window(&window, FLOATING_ORB_SIZE as i32, FLOATING_ORB_SIZE as i32);
    Ok(window)
}

fn ensure_floating_panel_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(FLOATING_PANEL_WINDOW_LABEL) {
        configure_native_floating_window(&window, FLOATING_PANEL_WIDTH as i32, FLOATING_PANEL_HEIGHT as i32);
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
    configure_native_floating_window(&window, FLOATING_PANEL_WIDTH as i32, FLOATING_PANEL_HEIGHT as i32);
    Ok(window)
}

fn hide_floating_group(app: &AppHandle) {
    hide_window(app, FLOATING_WINDOW_LABEL);
    hide_window(app, FLOATING_PANEL_WINDOW_LABEL);
}

fn sync_mode_windows(app: &AppHandle, prefs: &crate::contracts::DesktopUiPrefs) {
    if prefs.launch_mode == crate::contracts::AppLaunchMode::Floating {
        hide_window(app, MAIN_WINDOW_LABEL);
        hide_window(app, FLOATING_PANEL_WINDOW_LABEL);
        if let Ok(window) = ensure_floating_window(app) {
            show_window(&window);
        }
        let _ = ensure_floating_panel_window(app).map(|panel| {
            let _ = panel.hide();
        });
        return;
    }

    if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        show_window(&main);
    }
    let _ = ensure_floating_panel_window(app);
    if let Ok(window) = ensure_floating_window(app) {
        if prefs.open_floating_in_main_mode {
            show_window(&window);
        } else {
            hide_floating_group(app);
        }
    }
}

fn handle_tray_toggle(app: &AppHandle, ctx: &application::AppContext) {
    let prefs = match application::desktop_ui_service::get_desktop_ui_prefs(ctx) {
        Ok(value) => value,
        Err(_) => return,
    };
    let floating = match ensure_floating_window(app) {
        Ok(window) => window,
        Err(_) => return,
    };
    let _ = ensure_floating_panel_window(app);
    let visible = floating.is_visible().unwrap_or(false);
    if prefs.launch_mode == crate::contracts::AppLaunchMode::Floating {
        if visible {
            hide_floating_group(app);
        } else {
            show_window(&floating);
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
            show_window(&floating);
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open_main = MenuItemBuilder::with_id(TRAY_OPEN_MAIN_ID, "打开主窗口").build(app)?;
    let toggle_floating = MenuItemBuilder::with_id(TRAY_TOGGLE_FLOATING_ID, "切换悬浮窗").build(app)?;
    let quit = MenuItemBuilder::with_id(TRAY_QUIT_ID, "退出").build(app)?;
    let menu = Menu::with_items(app, &[&open_main, &toggle_floating, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip("Input面板")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let ctx = app.state::<application::AppContext>();
            match event.id.as_ref() {
                TRAY_OPEN_MAIN_ID => {
                    if let Ok(prefs) =
                        application::desktop_ui_service::set_launch_mode(&ctx, crate::contracts::AppLaunchMode::Main)
                    {
                        sync_mode_windows(app, &prefs);
                        let _ = app.emit("desktop-ui-prefs-updated", &prefs);
                    }
                }
                TRAY_TOGGLE_FLOATING_ID => handle_tray_toggle(app, &ctx),
                TRAY_QUIT_ID => {
                    let _ = app.save_window_state(StateFlags::all());
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let ctx = app.state::<application::AppContext>();
                if let Ok(prefs) = application::desktop_ui_service::get_desktop_ui_prefs(&ctx) {
                    sync_mode_windows(app, &prefs);
                }
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
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .skip_initial_state(FLOATING_WINDOW_LABEL)
                .skip_initial_state(FLOATING_PANEL_WINDOW_LABEL)
                .build(),
        )
        .setup(|app| {
            let ctx = application::AppContext::resolve()?;
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let app_handle = app.handle().clone();
            app.manage(ctx);
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
                    open_main_window_from_native(app);
                }
                FLOATING_CONTEXT_QUIT_ID => {
                    let _ = app.save_window_state(StateFlags::all());
                    app.exit(0);
                }
                _ => {}
            });
            let prefs = application::desktop_ui_service::get_desktop_ui_prefs(&app.state::<application::AppContext>())?;
            ensure_floating_window(&app_handle)?;
            ensure_floating_panel_window(&app_handle)?;
            sync_mode_windows(&app_handle, &prefs);
            install_floating_native_state(&app_handle);
            if let Some(shared) = FLOATING_NATIVE_STATE.get() {
                install_floating_native_subclasses(shared);
                start_floating_native_poller(shared.clone());
            }
            {
                let app_for_panel_hide = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                    if let Some(panel) = app_for_panel_hide.get_webview_window(FLOATING_PANEL_WINDOW_LABEL) {
                        let _ = panel.hide();
                    }
                    if let Some(shared) = FLOATING_NATIVE_STATE.get() {
                        if let Ok(mut state) = shared.lock() {
                            state.panel_visible = false;
                            state.orb_hovered = false;
                            state.panel_hovered = false;
                            state.pointer_down = false;
                            state.drag_started = false;
                        }
                    }
                });
            }
            if prefs.launch_mode == crate::contracts::AppLaunchMode::Floating {
                if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ = main.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let label = window.label();
                if label == FLOATING_WINDOW_LABEL || label == FLOATING_PANEL_WINDOW_LABEL {
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
                                let _ = app.save_window_state(StateFlags::all());
                                app.exit(0);
                            }
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            adapters::desktop::commands::health,
            adapters::desktop::commands::get_overview,
            adapters::desktop::commands::get_service_status,
            adapters::desktop::commands::get_desktop_ui_prefs,
            adapters::desktop::commands::update_desktop_ui_prefs,
            adapters::desktop::commands::switch_app_mode,
            adapters::desktop::commands::set_floating_window_visible,
            adapters::desktop::commands::show_floating_context_menu,
            adapters::desktop::commands::set_floating_panel_visible,
            adapters::desktop::commands::position_floating_panel,
            adapters::desktop::commands::open_main_window,
            adapters::desktop::commands::quit_application,
            adapters::desktop::commands::create_site,
            adapters::desktop::commands::update_site,
            adapters::desktop::commands::remove_site,
            adapters::desktop::commands::create_account,
            adapters::desktop::commands::update_account,
            adapters::desktop::commands::remove_account,
            adapters::desktop::commands::login_account,
            adapters::desktop::commands::persist_account_credential,
            adapters::desktop::commands::login_account_2fa,
            adapters::desktop::commands::refresh_account,
            adapters::desktop::commands::refresh_all_accounts,
            adapters::desktop::commands::get_available_groups,
            adapters::desktop::commands::list_managed_keys,
            adapters::desktop::commands::get_managed_key,
            adapters::desktop::commands::create_managed_key,
            adapters::desktop::commands::update_managed_key,
            adapters::desktop::commands::delete_managed_key,
            adapters::desktop::commands::list_usage_records,
            adapters::desktop::commands::get_usage_stats,
            adapters::desktop::commands::get_dashboard_models,
            adapters::desktop::commands::get_dashboard_trend,
            adapters::desktop::commands::get_key_daily_usage,
            adapters::desktop::commands::get_profile_record,
            adapters::desktop::commands::update_profile_record,
            adapters::desktop::commands::change_profile_password,
            adapters::desktop::commands::get_platform_quotas,
            adapters::desktop::commands::get_subscription_summary,
            adapters::desktop::commands::get_payment_config,
            adapters::desktop::commands::list_orders,
            adapters::desktop::commands::send_notify_email_code,
            adapters::desktop::commands::verify_notify_email,
            adapters::desktop::commands::remove_notify_email,
            adapters::desktop::commands::toggle_notify_email,
            adapters::desktop::commands::send_email_binding_code,
            adapters::desktop::commands::bind_email_identity,
            adapters::desktop::commands::unbind_auth_identity,
            adapters::desktop::commands::account_proxy_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
