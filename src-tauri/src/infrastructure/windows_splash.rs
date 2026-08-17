//! WebView2 初始化前的最小原生启动窗。
//!
//! 它只覆盖 Tauri 创建 WebView 到主窗口首帧可见之间的空白，不属于 Tauri
//! 窗口体系，因此不增加 label、capability 或额外 WebView。

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{
    ffi::c_void,
    panic::{catch_unwind, AssertUnwindSafe},
    ptr::{null, null_mut},
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex, OnceLock,
    },
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM},
    Graphics::Gdi::{
        BeginPaint, CreateSolidBrush, DeleteObject, DrawTextW, Ellipse, EndPaint, FillRect,
        SelectObject, SetBkMode, SetTextColor, DT_CENTER, DT_SINGLELINE, DT_VCENTER, PAINTSTRUCT,
        TRANSPARENT,
    },
    System::{
        LibraryLoader::{GetModuleHandleW, GetProcAddress},
        Threading::GetCurrentThreadId,
    },
    UI::{
        HiDpi::GetDpiForSystem,
        WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, KillTimer,
            RegisterClassW, SetTimer, ShowWindow, SystemParametersInfoW, UnregisterClassW,
            CS_HREDRAW, CS_VREDRAW, SPI_GETWORKAREA, SW_SHOWNOACTIVATE, WM_DESTROY, WM_ERASEBKGND,
            WM_PAINT, WM_TIMER, WNDCLASSW, WS_DISABLED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
            WS_POPUP,
        },
    },
};

const SPLASH_CLASS_NAME: &str = "InputPanelNativeStartupSplash";
const SPLASH_TITLE: &str = "Input面板正在启动";
const BASE_DPI: u32 = 96;
const SPLASH_LOGICAL_WIDTH: i32 = 420;
const SPLASH_LOGICAL_HEIGHT: i32 = 204;
const SPLASH_CORNER_RADIUS: i32 = 22;
const SPLASH_ANIMATION_TIMER_ID: usize = 0x4950;
const SPLASH_ANIMATION_INTERVAL_MS: u32 = 72;
const SPLASH_SPINNER_SEGMENT_COUNT: usize = 12;
const CS_DROPSHADOW: u32 = 0x0002_0000;
const WS_EX_LAYERED: u32 = 0x0008_0000;
const LWA_ALPHA: u32 = 0x0000_0002;
const WCA_ACCENT_POLICY: i32 = 19;
const ACCENT_ENABLE_ACRYLICBLURBEHIND: i32 = 4;
const DESKTOP_UI_PREFS_KEY: &str = "desktop_ui_prefs";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
enum StartupSplashTheme {
    SakuraSignal = 0,
    ArcticRelay = 1,
    EmberCircuit = 2,
    VerdantCore = 3,
    TitanNoir = 4,
}

impl Default for StartupSplashTheme {
    fn default() -> Self {
        Self::SakuraSignal
    }
}

impl StartupSplashTheme {
    fn from_persisted_value(value: &str) -> Option<Self> {
        match value {
            "sakura-signal" => Some(Self::SakuraSignal),
            "arctic-relay" => Some(Self::ArcticRelay),
            "ember-circuit" => Some(Self::EmberCircuit),
            "verdant-core" => Some(Self::VerdantCore),
            "titan-noir" => Some(Self::TitanNoir),
            _ => None,
        }
    }

    const fn from_stored_value(value: u32) -> Self {
        match value {
            1 => Self::ArcticRelay,
            2 => Self::EmberCircuit,
            3 => Self::VerdantCore,
            4 => Self::TitanNoir,
            _ => Self::SakuraSignal,
        }
    }

    const fn palette(self) -> StartupSplashPalette {
        match self {
            Self::SakuraSignal => SAKURA_SIGNAL_PALETTE,
            Self::ArcticRelay => ARCTIC_RELAY_PALETTE,
            Self::EmberCircuit => EMBER_CIRCUIT_PALETTE,
            Self::VerdantCore => VERDANT_CORE_PALETTE,
            Self::TitanNoir => TITAN_NOIR_PALETTE,
        }
    }
}

#[derive(Clone, Copy)]
struct StartupSplashPalette {
    background_color: COLORREF,
    glass_highlight_color: COLORREF,
    accent_color: COLORREF,
    accent_trail_color: COLORREF,
    spinner_muted_color: COLORREF,
    title_color: COLORREF,
    body_color: COLORREF,
    acrylic_tint_color: u32,
}

const SAKURA_SIGNAL_PALETTE: StartupSplashPalette = StartupSplashPalette {
    background_color: rgb(255, 247, 252),
    glass_highlight_color: rgb(255, 255, 255),
    accent_color: rgb(239, 120, 176),
    accent_trail_color: rgb(211, 137, 174),
    spinner_muted_color: rgb(229, 211, 224),
    title_color: rgb(86, 44, 72),
    body_color: rgb(130, 89, 112),
    acrylic_tint_color: acrylic_tint(0xD9, 255, 235, 247),
};

const ARCTIC_RELAY_PALETTE: StartupSplashPalette = StartupSplashPalette {
    background_color: rgb(244, 250, 255),
    glass_highlight_color: rgb(255, 255, 255),
    accent_color: rgb(53, 169, 191),
    accent_trail_color: rgb(85, 165, 184),
    spinner_muted_color: rgb(203, 228, 235),
    title_color: rgb(31, 73, 91),
    body_color: rgb(87, 117, 132),
    acrylic_tint_color: acrylic_tint(0xD9, 229, 246, 252),
};

const EMBER_CIRCUIT_PALETTE: StartupSplashPalette = StartupSplashPalette {
    background_color: rgb(31, 19, 21),
    glass_highlight_color: rgb(102, 48, 38),
    accent_color: rgb(255, 152, 99),
    accent_trail_color: rgb(204, 104, 72),
    spinner_muted_color: rgb(78, 47, 44),
    title_color: rgb(255, 242, 233),
    body_color: rgb(222, 190, 176),
    acrylic_tint_color: acrylic_tint(0xE1, 31, 19, 21),
};

const VERDANT_CORE_PALETTE: StartupSplashPalette = StartupSplashPalette {
    background_color: rgb(13, 27, 20),
    glass_highlight_color: rgb(38, 73, 54),
    accent_color: rgb(98, 212, 136),
    accent_trail_color: rgb(71, 161, 100),
    spinner_muted_color: rgb(39, 76, 57),
    title_color: rgb(238, 253, 244),
    body_color: rgb(184, 215, 195),
    acrylic_tint_color: acrylic_tint(0xE1, 13, 27, 20),
};

const TITAN_NOIR_PALETTE: StartupSplashPalette = StartupSplashPalette {
    background_color: rgb(20, 28, 37),
    glass_highlight_color: rgb(77, 104, 117),
    accent_color: rgb(126, 198, 255),
    accent_trail_color: rgb(83, 150, 195),
    spinner_muted_color: rgb(49, 67, 79),
    title_color: rgb(241, 245, 249),
    body_color: rgb(181, 195, 207),
    acrylic_tint_color: acrylic_tint(0xE1, 20, 28, 37),
};

static SPLASH_ANIMATION_TICK: AtomicU32 = AtomicU32::new(0);
static SPLASH_THEME: AtomicU32 = AtomicU32::new(StartupSplashTheme::SakuraSignal as u32);

#[repr(C)]
struct AccentPolicy {
    accent_state: i32,
    accent_flags: i32,
    gradient_color: u32,
    animation_id: i32,
}

#[repr(C)]
struct WindowCompositionAttributeData {
    attribute: i32,
    data: *mut c_void,
    size_of_data: usize,
}

#[link(name = "user32")]
unsafe extern "system" {
    fn InvalidateRect(hwnd: HWND, rect: *const RECT, erase: i32) -> i32;
    fn SetLayeredWindowAttributes(hwnd: HWND, color_key: COLORREF, alpha: u8, flags: u32) -> i32;
    fn SetWindowRgn(hwnd: HWND, region: *mut c_void, redraw: i32) -> i32;
}

#[link(name = "gdi32")]
unsafe extern "system" {
    fn CreateRoundRectRgn(
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
        width: i32,
        height: i32,
    ) -> *mut c_void;
}
// WndProc 内不分配字符串，避免 Rust 分配失败穿过 Win32 FFI 边界。
const SPLASH_HEADING_TEXT: &[u16] = &[73, 110, 112, 117, 116, 0x9762, 0x677f, 0];
const SPLASH_BODY_TEXT: &[u16] = &[
    0x6b63, 0x5728, 0x51c6, 0x5907, 0x5de5, 0x4f5c, 0x53f0, 46, 46, 46, 0,
];

#[derive(Default)]
struct StartupSplashState {
    hwnd: Option<usize>,
    instance: usize,
    class_registered: bool,
    creator_thread_id: u32,
}

fn startup_splash_state() -> &'static Mutex<StartupSplashState> {
    static STATE: OnceLock<Mutex<StartupSplashState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(StartupSplashState::default()))
}

fn load_persisted_startup_splash_theme() -> StartupSplashTheme {
    let Ok(paths) = crate::infrastructure::files::AppPaths::resolve_desktop() else {
        return StartupSplashTheme::default();
    };
    if !paths.db_path.is_file() {
        return StartupSplashTheme::default();
    }

    // Splash 必须先于 AppContext 显示，不能通过 Database::connect() 触发 schema、迁移或锁等待。
    let Ok(connection) =
        Connection::open_with_flags(&paths.db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
    else {
        return StartupSplashTheme::default();
    };
    if connection.busy_timeout(Duration::ZERO).is_err() {
        return StartupSplashTheme::default();
    }

    let persisted_preferences = connection
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [DESKTOP_UI_PREFS_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten();
    persisted_preferences
        .as_deref()
        .and_then(parse_persisted_startup_splash_theme)
        .unwrap_or_default()
}

fn parse_persisted_startup_splash_theme(value: &str) -> Option<StartupSplashTheme> {
    serde_json::from_str::<serde_json::Value>(value)
        .ok()?
        .get("theme")?
        .as_str()
        .and_then(StartupSplashTheme::from_persisted_value)
}

fn current_startup_splash_palette() -> StartupSplashPalette {
    StartupSplashTheme::from_stored_value(SPLASH_THEME.load(Ordering::Relaxed)).palette()
}

/// 在 Tauri Builder 创建 WebView 之前同步绘制原生启动窗。
pub fn create_startup_splash() -> Result<(), String> {
    let mut state = startup_splash_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if state.hwnd.is_some() {
        return Ok(());
    }

    let theme = load_persisted_startup_splash_theme();
    SPLASH_THEME.store(theme as u32, Ordering::Relaxed);
    let palette = theme.palette();

    let class_name = wide(SPLASH_CLASS_NAME);
    let title = wide(SPLASH_TITLE);
    let instance = unsafe { GetModuleHandleW(null()) };
    let creator_thread_id = unsafe { GetCurrentThreadId() };
    if instance.is_null() {
        return Err("无法获取原生启动窗模块句柄".to_string());
    }

    if !state.class_registered {
        let window_class = WNDCLASSW {
            // CS_DROPSHADOW 为无边框启动窗提供轻微的原生边缘阴影。
            style: CS_HREDRAW | CS_VREDRAW | CS_DROPSHADOW,
            lpfnWndProc: Some(startup_splash_window_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: instance,
            hIcon: null_mut(),
            hCursor: null_mut(),
            hbrBackground: null_mut(),
            lpszMenuName: null(),
            lpszClassName: class_name.as_ptr(),
        };
        if unsafe { RegisterClassW(&window_class) } == 0 {
            return Err("无法注册原生启动窗窗口类".to_string());
        }
        state.class_registered = true;
        state.instance = instance as usize;
    }

    let dpi = unsafe { GetDpiForSystem() }.max(BASE_DPI);
    let width = scale_for_dpi(SPLASH_LOGICAL_WIDTH, dpi);
    let height = scale_for_dpi(SPLASH_LOGICAL_HEIGHT, dpi);
    let corner_radius = scale_for_dpi(SPLASH_CORNER_RADIUS, dpi);
    let work_area = resolve_work_area();
    let x = work_area.left + ((work_area.right - work_area.left - width).max(0) / 2);
    let y = work_area.top + ((work_area.bottom - work_area.top - height).max(0) / 2);
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED,
            class_name.as_ptr(),
            title.as_ptr(),
            WS_POPUP | WS_DISABLED,
            x,
            y,
            width,
            height,
            null_mut(),
            null_mut(),
            instance,
            null(),
        )
    };
    if hwnd.is_null() {
        unregister_splash_class(&mut state, &class_name);
        return Err("无法创建原生启动窗".to_string());
    }

    unsafe {
        apply_startup_splash_visual_treatment(hwnd, width, height, corner_radius, palette);
        SPLASH_ANIMATION_TICK.store(0, Ordering::Relaxed);
        let _ = SetTimer(
            hwnd,
            SPLASH_ANIMATION_TIMER_ID,
            SPLASH_ANIMATION_INTERVAL_MS,
            None,
        );
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        // 同步发送 WM_PAINT，保证进入 WebView2 初始化前已有可见内容。
        windows_sys::Win32::Graphics::Gdi::UpdateWindow(hwnd);
    }
    state.hwnd = Some(hwnd as usize);
    state.creator_thread_id = creator_thread_id;
    Ok(())
}

/// 让启动窗保持轻量的圆角亚克力质感，并在不支持亚克力的系统上自然降级为半透明面板。
unsafe fn apply_startup_splash_visual_treatment(
    hwnd: HWND,
    width: i32,
    height: i32,
    corner_radius: i32,
    palette: StartupSplashPalette,
) {
    let _ = SetLayeredWindowAttributes(hwnd, 0, 244, LWA_ALPHA);

    apply_startup_splash_acrylic_backdrop(hwnd, palette.acrylic_tint_color);

    let region = CreateRoundRectRgn(0, 0, width, height, corner_radius, corner_radius);
    if !region.is_null() && SetWindowRgn(hwnd, region, 1) == 0 {
        let _ = DeleteObject(region);
    }
}

/// 亚克力 API 不属于当前 SDK 的静态 import lib，按需解析可避免旧系统启动时链接失败。
unsafe fn apply_startup_splash_acrylic_backdrop(hwnd: HWND, acrylic_tint_color: u32) {
    type SetWindowCompositionAttributeFn =
        unsafe extern "system" fn(HWND, *mut WindowCompositionAttributeData) -> i32;

    let user32_module = GetModuleHandleW(wide("user32.dll").as_ptr());
    if user32_module.is_null() {
        return;
    }
    let Some(set_window_composition_attribute) =
        GetProcAddress(user32_module, b"SetWindowCompositionAttribute\0".as_ptr())
    else {
        return;
    };
    let set_window_composition_attribute: SetWindowCompositionAttributeFn =
        std::mem::transmute(set_window_composition_attribute);

    let mut acrylic_policy = AccentPolicy {
        accent_state: ACCENT_ENABLE_ACRYLICBLURBEHIND,
        accent_flags: 0,
        gradient_color: acrylic_tint_color,
        animation_id: 0,
    };
    let mut attribute_data = WindowCompositionAttributeData {
        attribute: WCA_ACCENT_POLICY,
        data: &mut acrylic_policy as *mut AccentPolicy as *mut c_void,
        size_of_data: std::mem::size_of::<AccentPolicy>(),
    };
    let _ = set_window_composition_attribute(hwnd, &mut attribute_data);
}

/// 在 Tauri UI 线程内幂等销毁启动窗。
pub fn dismiss_startup_splash() -> Result<(), String> {
    let mut state = startup_splash_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(hwnd) = state.hwnd else {
        return Ok(());
    };
    let current_thread_id = unsafe { GetCurrentThreadId() };
    if !can_destroy_startup_splash_on_current_thread(state.creator_thread_id, current_thread_id) {
        return Err("原生启动窗销毁线程与创建线程不一致".to_string());
    }

    let class_name = wide(SPLASH_CLASS_NAME);
    let destroy_result = unsafe { DestroyWindow(hwnd as HWND) };
    if !should_clear_startup_splash_state_after_destroy(destroy_result) {
        return Err("无法销毁原生启动窗".to_string());
    }

    // 只有 Win32 确认 HWND 已销毁后才能提交内部生命周期状态，失败时保留 HWND
    // 供后续 frontend_ready 或显式唤醒路径重试。
    state.hwnd = None;
    unregister_splash_class(&mut state, &class_name);
    Ok(())
}

pub fn startup_splash_visible() -> bool {
    startup_splash_state()
        .lock()
        .map(|state| state.hwnd.is_some())
        .unwrap_or(false)
}

fn unregister_splash_class(state: &mut StartupSplashState, class_name: &[u16]) {
    if !state.class_registered {
        return;
    }
    unsafe {
        let _ = UnregisterClassW(class_name.as_ptr(), state.instance as _);
    }
    state.class_registered = false;
    state.instance = 0;
    state.creator_thread_id = 0;
}

fn can_destroy_startup_splash_on_current_thread(
    owner_thread_id: u32,
    current_thread_id: u32,
) -> bool {
    owner_thread_id != 0 && owner_thread_id == current_thread_id
}

fn should_clear_startup_splash_state_after_destroy(destroy_result: i32) -> bool {
    destroy_result != 0
}

fn resolve_work_area() -> RECT {
    let mut work_area = RECT {
        left: 0,
        top: 0,
        right: 1280,
        bottom: 720,
    };
    let succeeded = unsafe {
        SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            &mut work_area as *mut RECT as *mut c_void,
            0,
        )
    };
    if succeeded == 0 || work_area.right <= work_area.left || work_area.bottom <= work_area.top {
        return RECT {
            left: 0,
            top: 0,
            right: 1280,
            bottom: 720,
        };
    }
    work_area
}

fn scale_for_dpi(logical_value: i32, dpi: u32) -> i32 {
    ((logical_value as i64 * dpi as i64) / BASE_DPI as i64) as i32
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

const fn rgb(red: u8, green: u8, blue: u8) -> COLORREF {
    red as COLORREF | ((green as COLORREF) << 8) | ((blue as COLORREF) << 16)
}

/// SetWindowCompositionAttribute 使用 ABGR 排列的亚克力 tint 值。
const fn acrylic_tint(alpha: u8, red: u8, green: u8, blue: u8) -> u32 {
    ((alpha as u32) << 24) | ((blue as u32) << 16) | ((green as u32) << 8) | red as u32
}

unsafe extern "system" fn startup_splash_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // Win32 不允许 Rust panic 穿越 WndProc 的 FFI 边界。
    catch_unwind(AssertUnwindSafe(|| unsafe {
        startup_splash_window_proc_impl(hwnd, message, wparam, lparam)
    }))
    .unwrap_or_else(|_| unsafe { DefWindowProcW(hwnd, message, wparam, lparam) })
}

unsafe fn startup_splash_window_proc_impl(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_ERASEBKGND => 1,
        WM_TIMER if wparam == SPLASH_ANIMATION_TIMER_ID => {
            SPLASH_ANIMATION_TICK.fetch_add(1, Ordering::Relaxed);
            let _ = InvalidateRect(hwnd, null(), 0);
            0
        }
        WM_PAINT => {
            let mut paint: PAINTSTRUCT = std::mem::zeroed();
            let hdc = BeginPaint(hwnd, &mut paint);
            if !hdc.is_null() {
                draw_startup_splash(hdc, hwnd);
            }
            EndPaint(hwnd, &paint);
            0
        }
        WM_DESTROY => {
            let _ = KillTimer(hwnd, SPLASH_ANIMATION_TIMER_ID);
            0
        }
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}

unsafe fn draw_startup_splash(hdc: *mut c_void, hwnd: HWND) {
    let mut client = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    if GetClientRect(hwnd, &mut client) == 0 {
        return;
    }

    let palette = current_startup_splash_palette();
    fill_rect(hdc, &client, palette.background_color);
    let width = (client.right - client.left).max(1);
    let glass_highlight = RECT {
        left: 22,
        top: 1,
        right: (width - 22).max(22),
        bottom: 2,
    };
    fill_rect(hdc, &glass_highlight, palette.glass_highlight_color);
    draw_loading_spinner(
        hdc,
        width / 2,
        54,
        SPLASH_ANIMATION_TICK.load(Ordering::Relaxed),
        palette,
    );

    SetBkMode(hdc, TRANSPARENT as i32);
    let mut title_rect = RECT {
        left: 32,
        top: 91,
        right: client.right - 32,
        bottom: 129,
    };
    SetTextColor(hdc, palette.title_color);
    DrawTextW(
        hdc,
        SPLASH_HEADING_TEXT.as_ptr(),
        (SPLASH_HEADING_TEXT.len() - 1) as i32,
        &mut title_rect,
        DT_CENTER | DT_SINGLELINE | DT_VCENTER,
    );

    let mut body_rect = RECT {
        left: 32,
        top: 132,
        right: client.right - 32,
        bottom: 166,
    };
    SetTextColor(hdc, palette.body_color);
    DrawTextW(
        hdc,
        SPLASH_BODY_TEXT.as_ptr(),
        (SPLASH_BODY_TEXT.len() - 1) as i32,
        &mut body_rect,
        DT_CENTER | DT_SINGLELINE | DT_VCENTER,
    );
}

/// 顶部圆点环以有限帧率转动，替代不可表达真实进度的静态横向条。
unsafe fn draw_loading_spinner(
    hdc: *mut c_void,
    center_x: i32,
    center_y: i32,
    tick: u32,
    palette: StartupSplashPalette,
) {
    let active_segment = resolve_splash_spinner_active_segment(tick);
    for segment in 0..SPLASH_SPINNER_SEGMENT_COUNT {
        let distance = (active_segment + SPLASH_SPINNER_SEGMENT_COUNT - segment)
            % SPLASH_SPINNER_SEGMENT_COUNT;
        let (color, radius) = match distance {
            0 => (palette.accent_color, 4),
            1 => (palette.accent_trail_color, 3),
            2 => (palette.accent_trail_color, 2),
            _ => (palette.spinner_muted_color, 2),
        };
        let angle = (segment as f64 / SPLASH_SPINNER_SEGMENT_COUNT as f64) * std::f64::consts::TAU
            - std::f64::consts::FRAC_PI_2;
        let point_x = center_x + (angle.cos() * 16.0).round() as i32;
        let point_y = center_y + (angle.sin() * 16.0).round() as i32;
        fill_circle(hdc, point_x, point_y, radius, color);
    }
}

fn resolve_splash_spinner_active_segment(tick: u32) -> usize {
    (tick as usize) % SPLASH_SPINNER_SEGMENT_COUNT
}

unsafe fn fill_rect(hdc: *mut c_void, rect: &RECT, color: COLORREF) {
    let brush = CreateSolidBrush(color);
    if !brush.is_null() {
        FillRect(hdc, rect, brush);
        let _ = DeleteObject(brush);
    }
}

unsafe fn fill_circle(
    hdc: *mut c_void,
    center_x: i32,
    center_y: i32,
    radius: i32,
    color: COLORREF,
) {
    let brush = CreateSolidBrush(color);
    if brush.is_null() {
        return;
    }
    let previous_brush = SelectObject(hdc, brush);
    let _ = Ellipse(
        hdc,
        center_x - radius,
        center_y - radius,
        center_x + radius + 1,
        center_y + radius + 1,
    );
    let _ = SelectObject(hdc, previous_brush);
    let _ = DeleteObject(brush);
}

#[cfg(test)]
mod tests {
    use super::{
        can_destroy_startup_splash_on_current_thread, resolve_splash_spinner_active_segment,
        should_clear_startup_splash_state_after_destroy, SPLASH_SPINNER_SEGMENT_COUNT,
    };

    #[test]
    fn startup_splash_destroy_requires_its_creator_thread() {
        assert!(can_destroy_startup_splash_on_current_thread(101, 101));
        assert!(!can_destroy_startup_splash_on_current_thread(101, 202));
        assert!(!can_destroy_startup_splash_on_current_thread(0, 101));
    }

    #[test]
    fn startup_splash_state_only_clears_after_successful_destroy() {
        assert!(should_clear_startup_splash_state_after_destroy(1));
        assert!(!should_clear_startup_splash_state_after_destroy(0));
    }

    #[test]
    fn startup_splash_spinner_cycles_through_every_segment() {
        assert_eq!(resolve_splash_spinner_active_segment(0), 0);
        assert_eq!(
            resolve_splash_spinner_active_segment(SPLASH_SPINNER_SEGMENT_COUNT as u32 - 1),
            SPLASH_SPINNER_SEGMENT_COUNT - 1
        );
        assert_eq!(
            resolve_splash_spinner_active_segment(SPLASH_SPINNER_SEGMENT_COUNT as u32),
            0
        );
    }
}
