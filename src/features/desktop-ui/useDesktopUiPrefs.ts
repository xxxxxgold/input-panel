import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";

import {
  DEFAULT_AUTO_REFRESH_INTERVAL_SECONDS,
  normalizeAutoRefreshIntervalSeconds
} from "../../app/refresh-policy";
import { DEFAULT_THEME_ID, normalizeThemeId } from "../../shared/lib/theme";
import {
  DEFAULT_FLOATING_NOTIFICATION_DENSITY,
  DEFAULT_FLOATING_NOTIFICATION_MAX_VISIBLE,
  normalizeFloatingNotificationDensity,
  normalizeFloatingNotificationMaxVisible,
  type FloatingNotificationDensity
} from "../../shared/lib/floating-notification-layout";
import type { CloseBehavior, DesktopUiPrefs, DesktopUiPrefsPatch } from "../../types";
import { isTauriRuntime } from "../../shared/transport/runtime";
import {
  getDesktopUiPrefs,
  openMainWindow,
  previewFloatingNotificationSound,
  quitApplication,
  restoreDefaultFloatingNotificationSound,
  selectFloatingNotificationSound,
  setFloatingWindowVisible,
  switchAppMode,
  updateDesktopUiPrefs
} from "./client";
import {
  createDesktopUiPrefsSaveQueue,
  type DesktopUiPrefsSaveQueue,
  type DesktopUiPrefsSaveState
} from "./prefs-save-queue";

const defaultPrefs: DesktopUiPrefs = {
  version: 1,
  launchMode: "main",
  openFloatingInMainMode: true,
  keepFloatingPanelVisible: false,
  floatingPanelOpacity: 0.82,
  floatingNotificationDurationMs: 7000,
  floatingNotificationDensity: DEFAULT_FLOATING_NOTIFICATION_DENSITY,
  floatingNotificationMaxVisible: DEFAULT_FLOATING_NOTIFICATION_MAX_VISIBLE,
  floatingNotificationSoundSource: "default",
  floatingNotificationSoundFileName: null,
  floatingNotificationSoundStorageKey: null,
  floatingNotificationSoundVolume: 100,
  closeBehavior: "ask",
  autoRefreshEnabled: true,
  autoRefreshIntervalSeconds: DEFAULT_AUTO_REFRESH_INTERVAL_SECONDS,
  autoRefreshServiceStatusEnabled: true,
  autoRefreshCoreEnabled: true,
  autoRefreshCoreIntervalSeconds: DEFAULT_AUTO_REFRESH_INTERVAL_SECONDS,
  autoRefreshKeysEnabled: true,
  autoRefreshKeysIntervalSeconds: DEFAULT_AUTO_REFRESH_INTERVAL_SECONDS,
  autoRefreshUsageEnabled: true,
  autoRefreshUsageIntervalSeconds: DEFAULT_AUTO_REFRESH_INTERVAL_SECONDS,
  overviewAccountRuntimeTimeoutMs: 4500,
  theme: DEFAULT_THEME_ID
};

const MIN_FLOATING_PANEL_OPACITY = 0.45;
const MAX_FLOATING_PANEL_OPACITY = 0.95;
export const MIN_OVERVIEW_ACCOUNT_RUNTIME_TIMEOUT_MS = 1000;
export const MAX_OVERVIEW_ACCOUNT_RUNTIME_TIMEOUT_MS = 30000;
export const MIN_FLOATING_NOTIFICATION_DURATION_MS = 3000;
export const MAX_FLOATING_NOTIFICATION_DURATION_MS = 30000;
export const MIN_FLOATING_NOTIFICATION_SOUND_VOLUME = 0;
export const MAX_FLOATING_NOTIFICATION_SOUND_VOLUME = 100;

export function normalizeFloatingPanelOpacity(value: number) {
  if (!Number.isFinite(value)) {
    return defaultPrefs.floatingPanelOpacity;
  }
  return Math.min(Math.max(value, MIN_FLOATING_PANEL_OPACITY), MAX_FLOATING_PANEL_OPACITY);
}

export function normalizeOverviewAccountRuntimeTimeoutMs(value: number) {
  if (!Number.isFinite(value)) {
    return defaultPrefs.overviewAccountRuntimeTimeoutMs;
  }
  return Math.min(
    Math.max(Math.round(value), MIN_OVERVIEW_ACCOUNT_RUNTIME_TIMEOUT_MS),
    MAX_OVERVIEW_ACCOUNT_RUNTIME_TIMEOUT_MS
  );
}

export function normalizeFloatingNotificationDurationMs(value: number) {
  if (!Number.isFinite(value)) {
    return defaultPrefs.floatingNotificationDurationMs;
  }
  return Math.min(
    Math.max(Math.round(value), MIN_FLOATING_NOTIFICATION_DURATION_MS),
    MAX_FLOATING_NOTIFICATION_DURATION_MS
  );
}

export function normalizeFloatingNotificationSoundVolume(value: number) {
  if (!Number.isFinite(value)) {
    return defaultPrefs.floatingNotificationSoundVolume;
  }
  return Math.min(
    Math.max(Math.round(value), MIN_FLOATING_NOTIFICATION_SOUND_VOLUME),
    MAX_FLOATING_NOTIFICATION_SOUND_VOLUME
  );
}

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
    typeof candidate.floatingPanelOpacity === "number" &&
    (candidate.floatingNotificationDurationMs === undefined ||
      typeof candidate.floatingNotificationDurationMs === "number") &&
    (candidate.floatingNotificationDensity === undefined ||
      candidate.floatingNotificationDensity === "compact" ||
      candidate.floatingNotificationDensity === "standard" ||
      candidate.floatingNotificationDensity === "relaxed") &&
    (candidate.floatingNotificationMaxVisible === undefined ||
      typeof candidate.floatingNotificationMaxVisible === "number") &&
    (candidate.floatingNotificationSoundSource === undefined ||
      candidate.floatingNotificationSoundSource === "default" ||
      candidate.floatingNotificationSoundSource === "custom") &&
    (candidate.floatingNotificationSoundFileName === undefined ||
      candidate.floatingNotificationSoundFileName === null ||
      typeof candidate.floatingNotificationSoundFileName === "string") &&
    (candidate.floatingNotificationSoundStorageKey === undefined ||
      candidate.floatingNotificationSoundStorageKey === null ||
      typeof candidate.floatingNotificationSoundStorageKey === "string") &&
    (candidate.floatingNotificationSoundVolume === undefined ||
      typeof candidate.floatingNotificationSoundVolume === "number") &&
    (candidate.closeBehavior === "ask" ||
      candidate.closeBehavior === "switch_to_floating" ||
      candidate.closeBehavior === "exit_app") &&
    typeof candidate.autoRefreshEnabled === "boolean" &&
    typeof candidate.autoRefreshIntervalSeconds === "number" &&
    (candidate.autoRefreshServiceStatusEnabled === undefined ||
      typeof candidate.autoRefreshServiceStatusEnabled === "boolean") &&
    (candidate.autoRefreshCoreEnabled === undefined || typeof candidate.autoRefreshCoreEnabled === "boolean") &&
    (candidate.autoRefreshCoreIntervalSeconds === undefined ||
      typeof candidate.autoRefreshCoreIntervalSeconds === "number") &&
    (candidate.autoRefreshKeysEnabled === undefined ||
      typeof candidate.autoRefreshKeysEnabled === "boolean") &&
    (candidate.autoRefreshKeysIntervalSeconds === undefined ||
      typeof candidate.autoRefreshKeysIntervalSeconds === "number") &&
    (candidate.autoRefreshUsageEnabled === undefined || typeof candidate.autoRefreshUsageEnabled === "boolean") &&
    (candidate.autoRefreshUsageIntervalSeconds === undefined ||
      typeof candidate.autoRefreshUsageIntervalSeconds === "number") &&
    (candidate.overviewAccountRuntimeTimeoutMs === undefined ||
      typeof candidate.overviewAccountRuntimeTimeoutMs === "number") &&
    typeof candidate.theme === "string"
  );
}

function normalizeDesktopUiPrefs(prefs: Partial<DesktopUiPrefs> & {
  autoRefreshSnapshotEnabled?: boolean;
  autoRefreshSnapshotIntervalSeconds?: number;
  autoRefreshAccountScopedEnabled?: boolean;
  autoRefreshAccountScopedIntervalSeconds?: number;
}): DesktopUiPrefs {
  const merged: DesktopUiPrefs = {
    ...defaultPrefs,
    ...prefs,
    autoRefreshCoreEnabled: prefs.autoRefreshCoreEnabled ?? prefs.autoRefreshSnapshotEnabled ?? defaultPrefs.autoRefreshCoreEnabled,
    autoRefreshCoreIntervalSeconds: prefs.autoRefreshCoreIntervalSeconds ?? prefs.autoRefreshSnapshotIntervalSeconds ?? defaultPrefs.autoRefreshCoreIntervalSeconds,
    autoRefreshKeysEnabled: prefs.autoRefreshKeysEnabled ?? prefs.autoRefreshAccountScopedEnabled ?? defaultPrefs.autoRefreshKeysEnabled,
    autoRefreshKeysIntervalSeconds: prefs.autoRefreshKeysIntervalSeconds ?? prefs.autoRefreshAccountScopedIntervalSeconds ?? defaultPrefs.autoRefreshKeysIntervalSeconds
  };
  const hasCustomSound =
    merged.floatingNotificationSoundSource === "custom"
    && typeof merged.floatingNotificationSoundFileName === "string"
    && Boolean(merged.floatingNotificationSoundFileName.trim())
    && typeof merged.floatingNotificationSoundStorageKey === "string"
    && Boolean(merged.floatingNotificationSoundStorageKey.trim());

  return {
    ...merged,
    floatingPanelOpacity: normalizeFloatingPanelOpacity(merged.floatingPanelOpacity),
    floatingNotificationDurationMs: normalizeFloatingNotificationDurationMs(
      merged.floatingNotificationDurationMs
    ),
    floatingNotificationDensity: normalizeFloatingNotificationDensity(
      merged.floatingNotificationDensity
    ) as FloatingNotificationDensity,
    floatingNotificationMaxVisible: normalizeFloatingNotificationMaxVisible(
      merged.floatingNotificationMaxVisible
    ),
    floatingNotificationSoundSource: hasCustomSound ? "custom" : "default",
    floatingNotificationSoundFileName: hasCustomSound
      ? merged.floatingNotificationSoundFileName?.trim() ?? null
      : null,
    floatingNotificationSoundStorageKey: hasCustomSound
      ? merged.floatingNotificationSoundStorageKey?.trim() ?? null
      : null,
    floatingNotificationSoundVolume: normalizeFloatingNotificationSoundVolume(
      merged.floatingNotificationSoundVolume
    ),
    autoRefreshIntervalSeconds: normalizeAutoRefreshIntervalSeconds(merged.autoRefreshIntervalSeconds),
    autoRefreshCoreIntervalSeconds: normalizeAutoRefreshIntervalSeconds(
      merged.autoRefreshCoreIntervalSeconds
    ),
    autoRefreshKeysIntervalSeconds: normalizeAutoRefreshIntervalSeconds(
      merged.autoRefreshKeysIntervalSeconds
    ),
    autoRefreshUsageIntervalSeconds: normalizeAutoRefreshIntervalSeconds(merged.autoRefreshUsageIntervalSeconds),
    overviewAccountRuntimeTimeoutMs: normalizeOverviewAccountRuntimeTimeoutMs(
      merged.overviewAccountRuntimeTimeoutMs
    ),
    theme: normalizeThemeId(merged.theme)
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
  const [confirmedPrefs, setConfirmedPrefs] = useState<DesktopUiPrefs>(defaultPrefs);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<DesktopUiPrefsSaveState>({
    phase: "idle",
    pendingFields: [],
    savingFields: [],
    failedFields: [],
    error: null,
    lastSavedAt: null
  });
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const prefsSaveQueueRef = useRef<DesktopUiPrefsSaveQueue | null>(null);
  const queueDisposeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefsLoadRevisionRef = useRef(0);
  if (prefsSaveQueueRef.current === null) {
    prefsSaveQueueRef.current = createDesktopUiPrefsSaveQueue({
      initialPrefs: defaultPrefs,
      normalize: (value) => normalizeDesktopUiPrefs(value),
      persistPatch: updateDesktopUiPrefs,
      onSnapshot: (snapshot) => {
        setPrefs(snapshot.optimisticPrefs);
        setConfirmedPrefs(snapshot.confirmedPrefs);
        setSaveState(snapshot.saveState);
      },
      onConfirmed: writeBrowserDesktopUiPrefs
    });
  }
  const prefsSaveQueue = prefsSaveQueueRef.current;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(() => {
    if (queueDisposeTimerRef.current !== null) {
      globalThis.clearTimeout(queueDisposeTimerRef.current);
      queueDisposeTimerRef.current = null;
    }

    return () => {
      queueDisposeTimerRef.current = globalThis.setTimeout(() => {
        queueDisposeTimerRef.current = null;
        if (prefsSaveQueueRef.current === prefsSaveQueue) {
          prefsSaveQueue.dispose();
        }
      }, 0);
    };
  }, [prefsSaveQueue]);

  useEffect(() => {
    let disposed = false;
    const loadRevision = prefsLoadRevisionRef.current + 1;
    prefsLoadRevisionRef.current = loadRevision;
    const canAcceptLoad = () => !disposed && prefsLoadRevisionRef.current === loadRevision;
    const cachedPrefs = readBrowserDesktopUiPrefs();
    if (cachedPrefs) {
      prefsSaveQueue.acceptConfirmed(cachedPrefs);
    }

    void getDesktopUiPrefs()
      .then((next) => {
        if (canAcceptLoad()) {
          setLoadError(null);
          prefsSaveQueue.acceptConfirmed(next, { persistToBrowser: true });
        }
      })
      .catch((cause) => {
        if (canAcceptLoad()) {
          setLoadError(
            cause instanceof Error && cause.message.trim()
              ? cause.message
              : "设置读取失败，请重试。"
          );
        }
      })
      .finally(() => {
        if (canAcceptLoad()) {
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
          prefsSaveQueue.acceptConfirmed(next);
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
        prefsSaveQueue.acceptConfirmed(event.payload);
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
        const currentPrefs = prefsRef.current;
        if (currentPrefs.closeBehavior === "ask") {
          event.preventDefault();
          setCloseDialogOpen(true);
          return;
        }
        if (currentPrefs.closeBehavior === "switch_to_floating") {
          event.preventDefault();
          void prefsSaveQueue.enqueue(
            { launchMode: "floating" },
            { transport: () => switchAppMode("floating") }
          );
        }
      }).then((dispose) => {
        unlistenClose = dispose;
      });
    }

    return () => {
      disposed = true;
      if (prefsLoadRevisionRef.current === loadRevision) {
        prefsLoadRevisionRef.current += 1;
      }
      unlistenPrefs?.();
      unlistenClose?.();
      unlistenDesktopClose?.();
    };
  }, [prefsSaveQueue, windowLabel]);

  function patchPrefs(
    patch: DesktopUiPrefsPatch,
    options: { debounce?: boolean } = {}
  ) {
    prefsLoadRevisionRef.current += 1;
    return prefsSaveQueue.enqueue(patch, options);
  }

  function handleSwitchMode(mode: DesktopUiPrefs["launchMode"]) {
    prefsLoadRevisionRef.current += 1;
    return prefsSaveQueue.enqueue(
      { launchMode: mode },
      { transport: () => switchAppMode(mode) }
    );
  }

  function handleFloatingVisible(visible: boolean) {
    prefsLoadRevisionRef.current += 1;
    return prefsSaveQueue.enqueue(
      { openFloatingInMainMode: visible },
      { transport: () => setFloatingWindowVisible(visible) }
    );
  }

  function handleRememberCloseBehavior(value: CloseBehavior) {
    return patchPrefs({ closeBehavior: value });
  }

  async function confirmExit(remember: CloseBehavior | null) {
    setCloseDialogOpen(false);
    if (remember) {
      const result = await handleRememberCloseBehavior(remember);
      if (!result.ok) {
        setCloseDialogOpen(true);
        return;
      }
    }
    await quitApplication();
  }

  async function confirmSwitchToFloating(remember: CloseBehavior | null) {
    setCloseDialogOpen(false);
    if (remember) {
      const result = await handleRememberCloseBehavior(remember);
      if (!result.ok) {
        setCloseDialogOpen(true);
        return;
      }
    }
    const result = await handleSwitchMode("floating");
    if (!result.ok) {
      setCloseDialogOpen(true);
    }
  }

  async function handleOpenMain(nav?: Parameters<typeof openMainWindow>[0]) {
    prefsLoadRevisionRef.current += 1;
    const next = normalizeDesktopUiPrefs(await openMainWindow(nav));
    prefsSaveQueue.acceptConfirmed(next, {
      persistToBrowser: true,
      markSaved: true
    });
    return next;
  }

  async function handleSelectFloatingNotificationSound() {
    prefsLoadRevisionRef.current += 1;
    const next = await selectFloatingNotificationSound();
    if (next === null) {
      return null;
    }
    const normalized = normalizeDesktopUiPrefs(next);
    prefsSaveQueue.acceptConfirmed(normalized, { persistToBrowser: true });
    return normalized;
  }

  async function handlePreviewFloatingNotificationSound() {
    return previewFloatingNotificationSound();
  }

  async function handleRestoreDefaultFloatingNotificationSound() {
    prefsLoadRevisionRef.current += 1;
    const normalized = normalizeDesktopUiPrefs(await restoreDefaultFloatingNotificationSound());
    prefsSaveQueue.acceptConfirmed(normalized, { persistToBrowser: true });
    return normalized;
  }

  return {
    prefs,
    confirmedPrefs,
    loading,
    loadError,
    saving: saveState.phase === "saving",
    saveState,
    retryFailedPrefs: prefsSaveQueue.retryFailed,
    closeDialogOpen,
    setCloseDialogOpen,
    patchPrefs,
    handleSwitchMode,
    handleFloatingVisible,
    handleRememberCloseBehavior,
    confirmExit,
    confirmSwitchToFloating,
    handleOpenMain,
    handleSelectFloatingNotificationSound,
    handlePreviewFloatingNotificationSound,
    handleRestoreDefaultFloatingNotificationSound
  };
}
