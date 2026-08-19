import type { DesktopUiPrefs, DesktopUiPrefsPatch, NavKey, OpenMainWindowPayload } from "../../types";
import { desktopOrHttp, isTauriRuntime } from "../../shared/transport/runtime";

export const NATIVE_CAPABILITY_UNSUPPORTED_MESSAGE = "当前运行模式不支持原生窗口操作。";

function requireNativeDesktopCapability<T>(command: string, args?: Record<string, unknown>) {
  if (!isTauriRuntime()) {
    return Promise.reject(new Error(NATIVE_CAPABILITY_UNSUPPORTED_MESSAGE));
  }
  return desktopOrHttp<T>({ command, args, url: "" });
}

export function getDesktopUiPrefs() {
  return desktopOrHttp<DesktopUiPrefs>({
    command: "get_desktop_ui_prefs",
    url: "/api/desktop-ui/preferences"
  });
}

export function updateDesktopUiPrefs(payload: DesktopUiPrefsPatch) {
  return desktopOrHttp<DesktopUiPrefs>({
    command: "update_desktop_ui_prefs",
    args: { payload },
    url: "/api/desktop-ui/preferences",
    init: {
      method: "PATCH",
      body: JSON.stringify(payload)
    }
  });
}

export function selectFloatingNotificationSound() {
  return requireNativeDesktopCapability<DesktopUiPrefs | null>(
    "select_floating_notification_sound"
  );
}

export function previewFloatingNotificationSound() {
  return requireNativeDesktopCapability<boolean>("preview_floating_notification_sound");
}

export function restoreDefaultFloatingNotificationSound() {
  return requireNativeDesktopCapability<DesktopUiPrefs>(
    "restore_default_floating_notification_sound"
  );
}

export function setSystemFloatingNotificationSound() {
  return requireNativeDesktopCapability<DesktopUiPrefs>("use_system_floating_notification_sound");
}

export function muteFloatingNotificationSound() {
  return requireNativeDesktopCapability<DesktopUiPrefs>("mute_floating_notification_sound");
}

export function setSavedFloatingNotificationCustomSound() {
  return requireNativeDesktopCapability<DesktopUiPrefs>(
    "use_saved_floating_notification_custom_sound"
  );
}

/** 仅由悬浮通知窗口在卡片进入首帧后领取一次原生播放资格。 */
export function requestFloatingNotificationSound(notificationId: string) {
  return requireNativeDesktopCapability<boolean>("request_floating_notification_sound", {
    notificationId
  });
}

export function switchAppMode(launchMode: DesktopUiPrefs["launchMode"]) {
  return requireNativeDesktopCapability<DesktopUiPrefs>("switch_app_mode", { launchMode });
}

export function setFloatingWindowVisible(visible: boolean) {
  return requireNativeDesktopCapability<DesktopUiPrefs>("set_floating_window_visible", { visible });
}

export function setFloatingPanelVisible(visible: boolean) {
  return requireNativeDesktopCapability<boolean>("set_floating_panel_visible", { visible });
}

export function getFloatingPanelVisible() {
  return requireNativeDesktopCapability<boolean>("get_floating_panel_visible");
}

export function positionFloatingPanel(payload: { x: number; y: number }) {
  return requireNativeDesktopCapability<boolean>("position_floating_panel", { payload });
}

export function pushFloatingPanelToast(payload: {
  tone: "error" | "info" | "success";
  message: string;
  durationMs?: number;
}) {
  return requireNativeDesktopCapability<boolean>("push_floating_panel_toast", { payload });
}

export function showFloatingContextMenu(payload?: { x?: number; y?: number }) {
  return requireNativeDesktopCapability<boolean>("show_floating_context_menu", { payload });
}

export function openMainWindow(nav?: NavKey) {
  const payload: OpenMainWindowPayload = { nav: nav ?? null };
  return requireNativeDesktopCapability<DesktopUiPrefs>("open_main_window", { payload });
}

export function quitApplication() {
  return requireNativeDesktopCapability<boolean>("quit_application");
}
