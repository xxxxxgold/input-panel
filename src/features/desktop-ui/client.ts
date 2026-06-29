import type { DesktopUiPrefs, DesktopUiPrefsPatch, NavKey, OpenMainWindowPayload } from "../../types";
import { desktopOrHttp } from "../../shared/transport/runtime";

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

export function switchAppMode(launchMode: DesktopUiPrefs["launchMode"]) {
  return desktopOrHttp<DesktopUiPrefs>({
    command: "switch_app_mode",
    args: { launchMode },
    url: "/api/desktop-ui/mode",
    init: {
      method: "POST",
      body: JSON.stringify({ launchMode })
    }
  });
}

export function setFloatingWindowVisible(visible: boolean) {
  return desktopOrHttp<DesktopUiPrefs>({
    command: "set_floating_window_visible",
    args: { visible },
    url: "/api/desktop-ui/floating/visibility",
    init: {
      method: "POST",
      body: JSON.stringify({ visible })
    }
  });
}

export function setFloatingPanelVisible(visible: boolean) {
  return desktopOrHttp<boolean>({
    command: "set_floating_panel_visible",
    args: { visible },
    url: "/api/desktop-ui/floating-panel/visibility",
    init: {
      method: "POST",
      body: JSON.stringify({ visible })
    }
  });
}

export function positionFloatingPanel(payload: { x: number; y: number }) {
  return desktopOrHttp<boolean>({
    command: "position_floating_panel",
    args: { payload },
    url: "/api/desktop-ui/floating-panel/position",
    init: {
      method: "POST",
      body: JSON.stringify(payload)
    }
  });
}

export function pushFloatingPanelToast(payload: {
  tone: "error" | "info";
  message: string;
  durationMs?: number;
}) {
  return desktopOrHttp<boolean>({
    command: "push_floating_panel_toast",
    args: { payload },
    url: "/api/desktop-ui/floating-panel/toast",
    init: {
      method: "POST",
      body: JSON.stringify(payload)
    }
  });
}

export function showFloatingContextMenu(payload?: { x?: number; y?: number }) {
  return desktopOrHttp<boolean>({
    command: "show_floating_context_menu",
    args: { payload },
    url: "/api/desktop-ui/floating/context-menu",
    init: {
      method: "POST",
      body: JSON.stringify(payload ?? {})
    }
  });
}

export function openMainWindow(nav?: NavKey) {
  const payload: OpenMainWindowPayload = { nav: nav ?? null };
  return desktopOrHttp<DesktopUiPrefs>({
    command: "open_main_window",
    args: { payload },
    url: "/api/desktop-ui/open-main",
    init: {
      method: "POST",
      body: JSON.stringify(payload)
    }
  });
}

export function quitApplication() {
  return desktopOrHttp<boolean>({
    command: "quit_application",
    url: "/api/desktop-ui/quit",
    init: {
      method: "POST"
    }
  });
}
