import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

import { DEFAULT_THEME_ID, normalizeThemeId } from "../../shared/lib/theme";
import type { CloseBehavior, DesktopUiPrefs } from "../../types";
import { isTauriRuntime } from "../../shared/transport/runtime";
import {
  getDesktopUiPrefs,
  openMainWindow,
  quitApplication,
  setFloatingWindowVisible,
  switchAppMode,
  updateDesktopUiPrefs
} from "./client";

const defaultPrefs: DesktopUiPrefs = {
  version: 1,
  launchMode: "main",
  openFloatingInMainMode: true,
  keepFloatingPanelVisible: false,
  closeBehavior: "ask",
  theme: DEFAULT_THEME_ID
};

export const DESKTOP_UI_PREFS_STORAGE_KEY = "input-panel.desktop-ui-prefs";

export function isDesktopUiPrefsPayload(value: unknown): value is DesktopUiPrefs {
  if (typeof value !== "object" || value == null) {
    return false;
  }

  const candidate = value as Partial<DesktopUiPrefs>;
  return (
    typeof candidate.version === "number" &&
    (candidate.launchMode === "main" || candidate.launchMode === "floating") &&
    typeof candidate.openFloatingInMainMode === "boolean" &&
    typeof candidate.keepFloatingPanelVisible === "boolean" &&
    (candidate.closeBehavior === "ask" ||
      candidate.closeBehavior === "switch_to_floating" ||
      candidate.closeBehavior === "exit_app") &&
    typeof candidate.theme === "string"
  );
}

function normalizeDesktopUiPrefs(prefs: DesktopUiPrefs): DesktopUiPrefs {
  return {
    ...prefs,
    theme: normalizeThemeId(prefs.theme)
  };
}

export function readBrowserDesktopUiPrefs(): DesktopUiPrefs | null {
  if (typeof window === "undefined" || isTauriRuntime()) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(DESKTOP_UI_PREFS_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    return isDesktopUiPrefsPayload(parsed) ? normalizeDesktopUiPrefs(parsed) : null;
  } catch {
    return null;
  }
}

export function writeBrowserDesktopUiPrefs(prefs: DesktopUiPrefs) {
  if (typeof window === "undefined" || isTauriRuntime()) {
    return;
  }

  try {
    window.localStorage.setItem(DESKTOP_UI_PREFS_STORAGE_KEY, JSON.stringify(normalizeDesktopUiPrefs(prefs)));
  } catch {
    // 忽略浏览器存储异常, 避免影响主偏好请求链路。
  }
}

export function useDesktopUiPrefs(windowLabel: "main" | "floating" | "floating-panel") {
  const [prefs, setPrefs] = useState<DesktopUiPrefs>(defaultPrefs);
  const [loading, setLoading] = useState(true);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);

  useEffect(() => {
    let disposed = false;
    const cachedPrefs = readBrowserDesktopUiPrefs();
    if (cachedPrefs) {
      setPrefs(cachedPrefs);
    }

    void getDesktopUiPrefs()
      .then((next) => {
        if (!disposed) {
          const normalized = normalizeDesktopUiPrefs(next);
          setPrefs(normalized);
          writeBrowserDesktopUiPrefs(normalized);
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false);
        }
      });

    if (!isTauriRuntime()) {
      const handleStorage = (event: StorageEvent) => {
        if (event.key !== DESKTOP_UI_PREFS_STORAGE_KEY) {
          return;
        }
        const next = readBrowserDesktopUiPrefs();
        if (!disposed && next) {
          setPrefs(next);
        }
      };
      window.addEventListener("storage", handleStorage);

      return () => {
        disposed = true;
        window.removeEventListener("storage", handleStorage);
      };
    }

    let unlistenPrefs: (() => void) | undefined;
    let unlistenClose: (() => void) | undefined;
    void listen<DesktopUiPrefs>("desktop-ui-prefs-updated", (event) => {
      if (!disposed) {
        setPrefs(normalizeDesktopUiPrefs(event.payload));
      }
    }).then((dispose) => {
      unlistenPrefs = dispose;
    });

    let unlistenDesktopClose: (() => void) | undefined;
    if (windowLabel === "main") {
      void listen<boolean>("desktop-close-requested", () => {
        if (!disposed) {
          setCloseDialogOpen(true);
        }
      }).then((dispose) => {
        unlistenDesktopClose = dispose;
      });
    }

    if (windowLabel === "main") {
      void getCurrentWindow().onCloseRequested((event) => {
        if (prefs.closeBehavior === "ask") {
          event.preventDefault();
          setCloseDialogOpen(true);
          return;
        }
        if (prefs.closeBehavior === "switch_to_floating") {
          event.preventDefault();
          void switchAppMode("floating").then((next) => setPrefs(next));
        }
      }).then((dispose) => {
        unlistenClose = dispose;
      });
    }

    return () => {
      disposed = true;
      unlistenPrefs?.();
      unlistenClose?.();
      unlistenDesktopClose?.();
    };
  }, [prefs.closeBehavior, windowLabel]);

  async function patchPrefs(
    patch: Partial<DesktopUiPrefs>,
    apply: (current: DesktopUiPrefs) => DesktopUiPrefs = (current) => ({ ...current, ...patch })
  ) {
    const next = await updateDesktopUiPrefs(patch);
    const resolved = normalizeDesktopUiPrefs(apply(next));
    setPrefs(resolved);
    writeBrowserDesktopUiPrefs(resolved);
    return resolved;
  }

  async function handleSwitchMode(mode: DesktopUiPrefs["launchMode"]) {
    const next = normalizeDesktopUiPrefs(await switchAppMode(mode));
    setPrefs(next);
    writeBrowserDesktopUiPrefs(next);
    return next;
  }

  async function handleFloatingVisible(visible: boolean) {
    const next = normalizeDesktopUiPrefs(await setFloatingWindowVisible(visible));
    setPrefs(next);
    writeBrowserDesktopUiPrefs(next);
    return next;
  }

  async function handleRememberCloseBehavior(value: CloseBehavior) {
    const next = normalizeDesktopUiPrefs(await updateDesktopUiPrefs({ closeBehavior: value }));
    setPrefs(next);
    writeBrowserDesktopUiPrefs(next);
    return next;
  }

  async function confirmExit(remember: CloseBehavior | null) {
    setCloseDialogOpen(false);
    if (remember) {
      await handleRememberCloseBehavior(remember);
    }
    await quitApplication();
  }

  async function confirmSwitchToFloating(remember: CloseBehavior | null) {
    setCloseDialogOpen(false);
    if (remember) {
      await handleRememberCloseBehavior(remember);
    }
    const next = normalizeDesktopUiPrefs(await switchAppMode("floating"));
    setPrefs(next);
  }

  async function handleOpenMain(nav?: Parameters<typeof openMainWindow>[0]) {
    const next = normalizeDesktopUiPrefs(await openMainWindow(nav));
    setPrefs(next);
    writeBrowserDesktopUiPrefs(next);
    return next;
  }

  return {
    prefs,
    loading,
    closeDialogOpen,
    setCloseDialogOpen,
    patchPrefs,
    handleSwitchMode,
    handleFloatingVisible,
    handleRememberCloseBehavior,
    confirmExit,
    confirmSwitchToFloating,
    handleOpenMain
  };
}
