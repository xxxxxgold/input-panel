//! WebView2 初始化前的最小原生启动窗。
//!
//! 它只覆盖 Tauri 创建 WebView 到主窗口首帧可见之间的空白，不属于 Tauri
//! 窗口体系，因此不增加 label、capability 或额外 WebView。

use std::{
    ffi::c_void,
    panic::{catch_unwind, AssertUnwindSafe},
    ptr::{null, null_mut},
    sync::{Mutex, OnceLock},
};
use windows_sys::Win32::{
    Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM},
    Graphics::Gdi::{
        BeginPaint, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, FillRect, SetBkMode,
        SetTextColor, DT_CENTER, DT_SINGLELINE, DT_VCENTER, PAINTSTRUCT, TRANSPARENT,
    },
    System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
    UI::{
        HiDpi::GetDpiForSystem,
        WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, RegisterClassW,
            ShowWindow, SystemParametersInfoW, UnregisterClassW, CS_HREDRAW, CS_VREDRAW,
            SPI_GETWORKAREA, SW_SHOWNOACTIVATE, WM_ERASEBKGND, WM_PAINT, WNDCLASSW, WS_DISABLED,
            WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
        },
    },
};

const SPLASH_CLASS_NAME: &str = "InputPanelNativeStartupSplash";
const SPLASH_TITLE: &str = "Input面板正在启动";
const BASE_DPI: u32 = 96;
const SPLASH_LOGICAL_WIDTH: i32 = 420;
const SPLASH_LOGICAL_HEIGHT: i32 = 176;
const BACKGROUND_COLOR: COLORREF = rgb(22, 27, 33);
const ACCENT_COLOR: COLORREF = rgb(91, 204, 180);
const TITLE_COLOR: COLORREF = rgb(241, 245, 249);
const BODY_COLOR: COLORREF = rgb(181, 195, 207);
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

/// 在 Tauri Builder 创建 WebView 之前同步绘制原生启动窗。
pub fn create_startup_splash() -> Result<(), String> {
    let mut state = startup_splash_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if state.hwnd.is_some() {
        return Ok(());
    }

    let class_name = wide(SPLASH_CLASS_NAME);
    let title = wide(SPLASH_TITLE);
    let instance = unsafe { GetModuleHandleW(null()) };
    let creator_thread_id = unsafe { GetCurrentThreadId() };
    if instance.is_null() {
        return Err("无法获取原生启动窗模块句柄".to_string());
    }

    if !state.class_registered {
        let window_class = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
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
    let work_area = resolve_work_area();
    let x = work_area.left + ((work_area.right - work_area.left - width).max(0) / 2);
    let y = work_area.top + ((work_area.bottom - work_area.top - height).max(0) / 2);
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
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
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        // 同步发送 WM_PAINT，保证进入 WebView2 初始化前已有可见内容。
        windows_sys::Win32::Graphics::Gdi::UpdateWindow(hwnd);
    }
    state.hwnd = Some(hwnd as usize);
    state.creator_thread_id = creator_thread_id;
    Ok(())
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
        WM_PAINT => {
            let mut paint: PAINTSTRUCT = std::mem::zeroed();
            let hdc = BeginPaint(hwnd, &mut paint);
            if !hdc.is_null() {
                draw_startup_splash(hdc, hwnd);
            }
            EndPaint(hwnd, &paint);
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

    fill_rect(hdc, &client, BACKGROUND_COLOR);
    let width = (client.right - client.left).max(1);
    let accent = RECT {
        left: 32,
        top: 34,
        right: (32 + width / 4).min(client.right - 32),
        bottom: 38,
    };
    fill_rect(hdc, &accent, ACCENT_COLOR);

    SetBkMode(hdc, TRANSPARENT as i32);
    let mut title_rect = RECT {
        left: 32,
        top: 54,
        right: client.right - 32,
        bottom: 104,
    };
    SetTextColor(hdc, TITLE_COLOR);
    DrawTextW(
        hdc,
        SPLASH_HEADING_TEXT.as_ptr(),
        (SPLASH_HEADING_TEXT.len() - 1) as i32,
        &mut title_rect,
        DT_CENTER | DT_SINGLELINE | DT_VCENTER,
    );

    let mut body_rect = RECT {
        left: 32,
        top: 102,
        right: client.right - 32,
        bottom: 142,
    };
    SetTextColor(hdc, BODY_COLOR);
    DrawTextW(
        hdc,
        SPLASH_BODY_TEXT.as_ptr(),
        (SPLASH_BODY_TEXT.len() - 1) as i32,
        &mut body_rect,
        DT_CENTER | DT_SINGLELINE | DT_VCENTER,
    );
}

unsafe fn fill_rect(hdc: *mut c_void, rect: &RECT, color: COLORREF) {
    let brush = CreateSolidBrush(color);
    if !brush.is_null() {
        FillRect(hdc, rect, brush);
        let _ = DeleteObject(brush);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        can_destroy_startup_splash_on_current_thread,
        should_clear_startup_splash_state_after_destroy,
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
}
