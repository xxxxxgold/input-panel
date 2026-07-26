import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  FloatingPanelWindow,
  type FloatingQuickSwitchSnapshot,
  type FloatingQuickSwitchSubmissionResult
} from "./FloatingPanelWindow";
import { ToastHost } from "./ToastHost";
import { getPersistedWindowSelection } from "./window-selection-client";
import {
  createFloatingPanelSelectionCoordinator,
  readWindowSelection,
  WINDOW_SELECTION_STORAGE_KEY,
  type WindowSelectionSyncPayload
} from "./window-selection-sync";
import { useAccountDataWorkspace } from "../features/accounts/useAccountDataWorkspace";
import { useDesktopUiPrefs } from "../features/desktop-ui/useDesktopUiPrefs";
import { getAvailableGroups, listManagedKeys, updateManagedKey } from "../features/keys/client";
import { getOverviewDashboardStats } from "../features/overview/client";
import { getSubscriptions } from "../features/profile/client";
import { resolveOverviewSelection, useMonitorStore } from "../store/monitor-store";
import { isTauriRuntime } from "../shared/transport/runtime";
import { THEME_IDS, normalizeThemeId } from "../shared/lib/theme";
import { applyThemeToDocument } from "../shared/lib/apply-theme";
import { buildSubscriptionDetailRecords } from "../subscription-view";
import type { OverviewDashboardStatsPayload, OverviewPayload } from "../types";

const ALLOWED_THEMES = new Set<string>(THEME_IDS);
const FLOATING_LIVE_REFRESH_INTERVAL_MS = 30_000;

async function readFloatingQuickSwitchSnapshot(
  accountId: string,
  force = false
): Promise<FloatingQuickSwitchSnapshot> {
  const [managedKeys, groups, subscriptions] = await Promise.all([
    listManagedKeys(accountId, 1, 100, force),
    getAvailableGroups(accountId),
    getSubscriptions(accountId, force)
  ]);

  return {
    managedKeys: managedKeys.items,
    groups,
    subscriptionDetails: buildSubscriptionDetailRecords({
      summary: null,
      cacheViewSubscriptions: subscriptions
    })
  };
}

export function resolveFloatingPanelCurrentAccount(input: {
  overview: OverviewPayload | null;
  selectedAccountId: string | null;
  selectedSiteId: string | null;
}) {
  if (!input.overview) {
    return null;
  }

  if (input.selectedAccountId) {
    return input.overview.accounts.find((account) => account.id === input.selectedAccountId) ?? null;
  }

  const selection = resolveOverviewSelection({
    accounts: input.overview.accounts,
    sites: input.overview.sites,
    selectedAccountId: null,
    selectedSiteId: input.selectedSiteId
  });

  return input.overview.accounts.find((account) => account.id === selection.selectedAccountId) ?? null;
}

export function shouldActivateFloatingPanelData(input: {
  tauriRuntime: boolean;
  keepVisible: boolean;
  panelVisible: boolean;
}) {
  return !input.tauriRuntime || input.keepVisible || input.panelVisible;
}

export function isFloatingPanelResourceDataCurrent(input: {
  resourceAccountId: string | null;
  currentAccountId: string | null;
}) {
  return input.currentAccountId != null && input.resourceAccountId === input.currentAccountId;
}

export function FloatingPanelWindowRoot() {
  const tauriRuntime = isTauriRuntime();
  const desktopUi = useDesktopUiPrefs("floating-panel");
  const theme = useMonitorStore((state) => state.theme);
  const setTheme = useMonitorStore((state) => state.setTheme);
  const overview = useMonitorStore((state) => state.overview);
  const loading = useMonitorStore((state) => state.loading);
  const toasts = useMonitorStore((state) => state.toasts);
  const pushToast = useMonitorStore((state) => state.pushToast);
  const dismissToast = useMonitorStore((state) => state.dismissToast);
  const loadOverview = useMonitorStore((state) => state.loadOverview);
  const setSelectedSiteId = useMonitorStore((state) => state.setSelectedSiteId);
  const setSelectedAccountId = useMonitorStore((state) => state.setSelectedAccountId);
  const selectedSiteId = useMonitorStore((state) => state.selectedSiteId);
  const selectedAccountId = useMonitorStore((state) => state.selectedAccountId);
  const [browserSelection, setBrowserSelection] = useState(readWindowSelection);
  const [panelWindowVisible, setPanelWindowVisible] = useState(false);
  const [dashboardStats, setDashboardStats] = useState<OverviewDashboardStatsPayload | null>(null);
  const [dashboardStatsLoading, setDashboardStatsLoading] = useState(false);
  const [dashboardStatsError, setDashboardStatsError] = useState<string | null>(null);
  const [dashboardStatsUpdatedAt, setDashboardStatsUpdatedAt] = useState<string | null>(null);
  const [selectionOverviewPending, setSelectionOverviewPending] = useState(false);
  const [resourceAccountId, setResourceAccountId] = useState<string | null>(null);
  const dashboardStatsRequestIdRef = useRef(0);
  const resourceGenerationRef = useRef(0);
  const selectionGenerationRef = useRef(0);
  const effectiveSelectedSiteId = tauriRuntime ? selectedSiteId : browserSelection.selectedSiteId ?? selectedSiteId;
  const effectiveSelectedAccountId = tauriRuntime ? selectedAccountId : browserSelection.selectedAccountId ?? selectedAccountId;
  const panelDataActive = shouldActivateFloatingPanelData({
    tauriRuntime,
    keepVisible: desktopUi.prefs.keepFloatingPanelVisible,
    panelVisible: panelWindowVisible
  });
  const panelDataActiveRef = useRef(panelDataActive);
  panelDataActiveRef.current = panelDataActive;
  const selectionCoordinatorRef = useRef<ReturnType<typeof createFloatingPanelSelectionCoordinator> | null>(null);
  const currentAccount = selectionOverviewPending
    ? null
    : resolveFloatingPanelCurrentAccount({
      overview,
      selectedAccountId: effectiveSelectedAccountId,
      selectedSiteId: effectiveSelectedSiteId
    });
  const currentAccountId = currentAccount?.id ?? null;
  const currentResourceData = isFloatingPanelResourceDataCurrent({
    resourceAccountId,
    currentAccountId
  });
  const currentAccountIdRef = useRef(currentAccountId);
  currentAccountIdRef.current = currentAccountId;
  const currentCacheView = currentAccount?.cacheView ?? null;
  const accountDataWorkspace = useAccountDataWorkspace({
    selectedAccountId: effectiveSelectedAccountId,
    resources: {
      groups: true,
      managedKeys: true,
      profileRecord: true,
      subscriptions: true,
      subscriptionSummary: true
    },
    enabled: Boolean(effectiveSelectedAccountId) && panelDataActive,
    setError: () => {}
  });

  const refreshDashboardStats = useCallback(async (force = false) => {
    const accountId = currentAccount?.id ?? null;
    const requestId = ++dashboardStatsRequestIdRef.current;
    if (!panelDataActive || !accountId) {
      setDashboardStats(null);
      setDashboardStatsError(null);
      setDashboardStatsLoading(false);
      setDashboardStatsUpdatedAt(null);
      return;
    }

    setDashboardStatsLoading(true);
    setDashboardStatsError(null);
    try {
      const next = await getOverviewDashboardStats(accountId, force);
      if (requestId !== dashboardStatsRequestIdRef.current) {
        return;
      }
      setDashboardStats(next);
      setDashboardStatsUpdatedAt(new Date().toISOString());
    } catch (cause) {
      if (requestId !== dashboardStatsRequestIdRef.current) {
        return;
      }
      setDashboardStatsError((cause as Error).message || "读取上游实时指标失败。");
    } finally {
      if (requestId === dashboardStatsRequestIdRef.current) {
        setDashboardStatsLoading(false);
      }
    }
  }, [currentAccount?.id, panelDataActive]);

  const invalidateFloatingResourceData = useCallback(() => {
    resourceGenerationRef.current += 1;
    dashboardStatsRequestIdRef.current += 1;
    setResourceAccountId(null);
    setDashboardStats(null);
    setDashboardStatsError(null);
    setDashboardStatsLoading(false);
    setDashboardStatsUpdatedAt(null);
  }, []);

  const validateFloatingQuickSwitch = useCallback(async () => {
    const accountId = currentAccount?.id ?? null;
    if (!accountId) {
      throw new Error("当前没有可用账号。");
    }
    return readFloatingQuickSwitchSnapshot(accountId, true);
  }, [currentAccount?.id]);

  const submitFloatingQuickSwitch = useCallback(async (
    input: { keyId: string; groupId: number }
  ): Promise<FloatingQuickSwitchSubmissionResult> => {
    const accountId = currentAccount?.id ?? null;
    if (!accountId) {
      throw new Error("当前没有可用账号。");
    }

    await updateManagedKey(accountId, input.keyId, { groupId: input.groupId });
    try {
      return {
        kind: "succeeded",
        snapshot: await readFloatingQuickSwitchSnapshot(accountId, true)
      };
    } catch (cause) {
      return {
        kind: "reload_failed",
        message: (cause as Error).message || "上游已更新，重新读取密钥和订阅数据失败。"
      };
    }
  }, [currentAccount?.id]);

  const reloadFloatingQuickSwitchData = useCallback(async () => {
    const accountId = currentAccount?.id ?? null;
    if (!accountId) {
      throw new Error("当前没有可用账号。");
    }
    return readFloatingQuickSwitchSnapshot(accountId, true);
  }, [currentAccount?.id]);

  const refreshFloatingLiveResources = useEffectEvent(async () => {
    await Promise.allSettled([
      loadOverview({ source: "shell" }),
      accountDataWorkspace.refreshAccountData({ force: false }),
      refreshDashboardStats()
    ]);
  });
  const refreshCurrentAccountData = useEffectEvent(async () => {
    await accountDataWorkspace.refreshAccountData({ force: false });
  });

  useEffect(() => {
    if (ALLOWED_THEMES.has(desktopUi.prefs.theme) && theme !== desktopUi.prefs.theme) {
      setTheme(normalizeThemeId(desktopUi.prefs.theme));
    }
  }, [desktopUi.prefs.theme, setTheme, theme]);

  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  useEffect(() => {
    document.title = "Input悬浮面板";
    document.documentElement.classList.add("floating-panel-root");
    document.body.classList.add("floating-window-body");
    document.body.classList.add("floating-panel-window-body");
    document.getElementById("root")?.classList.add("floating-panel-root");
    return () => {
      document.title = "Input悬浮面板";
      document.documentElement.classList.remove("floating-panel-root");
      document.body.classList.remove("floating-window-body");
      document.body.classList.remove("floating-panel-window-body");
      document.getElementById("root")?.classList.remove("floating-panel-root");
    };
  }, []);

  useEffect(() => {
    if (!panelDataActive) {
      return;
    }
    if (tauriRuntime) {
      void selectionCoordinatorRef.current?.refreshIfActive();
      return;
    }
    void loadOverview({ source: "shell" });
  }, [
    effectiveSelectedAccountId,
    effectiveSelectedSiteId,
    loadOverview,
    panelDataActive,
    tauriRuntime
  ]);

  useEffect(() => {
    if (!tauriRuntime) {
      setSelectionOverviewPending(false);
    }
  }, [overview?.generatedAt, tauriRuntime]);

  useEffect(() => {
    if (!panelDataActive || !currentAccountId) {
      invalidateFloatingResourceData();
      return;
    }

    const generation = ++resourceGenerationRef.current;
    setResourceAccountId((previous) => previous === currentAccountId ? previous : null);
    void Promise.allSettled([refreshCurrentAccountData(), refreshDashboardStats()]).then(() => {
      if (
        resourceGenerationRef.current === generation
        && panelDataActiveRef.current
        && currentAccountIdRef.current === currentAccountId
      ) {
        setResourceAccountId(currentAccountId);
      }
    });
    return () => {
      if (resourceGenerationRef.current === generation) {
        resourceGenerationRef.current += 1;
      }
      dashboardStatsRequestIdRef.current += 1;
    };
  }, [
    currentAccountId,
    invalidateFloatingResourceData,
    overview?.generatedAt,
    panelDataActive,
    refreshDashboardStats
  ]);

  useEffect(() => {
    if (!panelDataActive) {
      return;
    }

    let disposed = false;
    let timerId: number | null = null;
    const schedule = () => {
      timerId = window.setTimeout(async () => {
        await refreshFloatingLiveResources();
        if (!disposed) {
          schedule();
        }
      }, FLOATING_LIVE_REFRESH_INTERVAL_MS);
    };

    schedule();
    return () => {
      disposed = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [panelDataActive]);

  useEffect(() => {
    if (tauriRuntime) {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== WINDOW_SELECTION_STORAGE_KEY) {
        return;
      }
      setBrowserSelection(readWindowSelection());
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [tauriRuntime]);

  useEffect(() => {
    if (!tauriRuntime) {
      return;
    }

    let unlistenToast: (() => void) | undefined;
    let unlistenPanelSync: (() => void) | undefined;
    let unlistenPanelHide: (() => void) | undefined;
    let disposed = false;

    void listen<{
      tone: "error" | "info" | "success";
      message: string;
      durationMs?: number;
    }>("floating-panel-toast", (event) => {
      if (disposed) {
        return;
      }
      pushToast({
        tone: event.payload.tone,
        message: event.payload.message,
        durationMs: event.payload.durationMs
      });
    }).then((cleanup) => {
      unlistenToast = cleanup;
    });

    const selectionCoordinator = createFloatingPanelSelectionCoordinator({
      subscribe: (listener) =>
        listen<WindowSelectionSyncPayload>("floating-panel-selection-sync", (event) => {
          listener(event.payload);
        }),
      readPersisted: getPersistedWindowSelection,
      applySelection: (selection) => {
        invalidateFloatingResourceData();
        selectionGenerationRef.current += 1;
        setSelectionOverviewPending(true);
        setSelectedSiteId(selection.selectedSiteId);
        setSelectedAccountId(selection.selectedAccountId);
      },
      isPanelDataActive: () => panelDataActiveRef.current,
      refreshOverview: async () => {
        const selectionGeneration = selectionGenerationRef.current;
        const refreshed = await loadOverview({ source: "shell" });
        if (!refreshed) {
          throw new Error(useMonitorStore.getState().error || "刷新悬浮面板总览失败。");
        }
        if (!disposed && selectionGenerationRef.current === selectionGeneration) {
          setSelectionOverviewPending(false);
        }
        return true;
      },
      reportError: (stage, cause) => {
        console.error(`${stage === "hydrate" ? "读取" : "刷新"}悬浮面板选择失败`, cause);
      }
    });
    selectionCoordinatorRef.current = selectionCoordinator;
    const unlistenSelectionSync = () => selectionCoordinator.dispose();
    void selectionCoordinator.start();

    void listen<{ menuVisible: boolean }>("floating-panel-sync", (event) => {
      if (disposed) {
        return;
      }
      setPanelWindowVisible(event.payload.menuVisible);
    }).then((cleanup) => {
      unlistenPanelSync = cleanup;
    });

    void listen("floating-panel-hide", () => {
      if (disposed) {
        return;
      }
      setPanelWindowVisible(false);
    }).then((cleanup) => {
      unlistenPanelHide = cleanup;
    });

    return () => {
      disposed = true;
      selectionCoordinatorRef.current = null;
      unlistenToast?.();
      unlistenSelectionSync();
      unlistenPanelSync?.();
      unlistenPanelHide?.();
    };
  }, [invalidateFloatingResourceData, loadOverview, pushToast, setSelectedAccountId, setSelectedSiteId, tauriRuntime]);

  const currentAccountSubscriptionDetails = buildSubscriptionDetailRecords({
    summary: currentResourceData ? accountDataWorkspace.subscriptionSummary : null,
    cacheViewSubscriptions: currentResourceData
      ? accountDataWorkspace.subscriptions ?? currentCacheView?.subscriptions ?? []
      : currentCacheView?.subscriptions ?? []
  });

  return (
    <>
      <FloatingPanelWindow
        currentAccountId={currentAccount?.id ?? null}
        currentAccountLabel={currentAccount?.label ?? null}
        selectionLoading={selectionOverviewPending}
        dashboardStats={currentResourceData ? dashboardStats : null}
        dashboardStatsLoading={currentResourceData && dashboardStatsLoading}
        dashboardStatsError={currentResourceData ? dashboardStatsError : null}
        dashboardStatsUpdatedAt={currentResourceData ? dashboardStatsUpdatedAt : null}
        currentAccountSubscriptionDetails={currentAccountSubscriptionDetails}
        currentAccountRecentUsage={currentCacheView?.recentUsage ?? []}
        managedKeys={currentResourceData ? accountDataWorkspace.managedKeys?.items ?? [] : []}
        groups={currentResourceData ? accountDataWorkspace.groups : []}
        loading={loading}
        keepVisible={desktopUi.prefs.keepFloatingPanelVisible}
        floatingPanelOpacity={desktopUi.prefs.floatingPanelOpacity}
        onRefresh={() => {
          void Promise.all([
            loadOverview({ source: "shell" }),
            accountDataWorkspace.refreshAccountData(),
            refreshDashboardStats(true)
          ]);
        }}
        onValidateQuickSwitch={validateFloatingQuickSwitch}
        onSubmitQuickSwitch={submitFloatingQuickSwitch}
        onReloadQuickSwitchData={reloadFloatingQuickSwitchData}
      />
      <ToastHost toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
