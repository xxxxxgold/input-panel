import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";

import {
  FloatingPanelWindow,
  type FloatingQuickSwitchSnapshot,
  type FloatingQuickSwitchSubmissionResult
} from "./FloatingPanelWindow";
import { ToastHost } from "./ToastHost";
import {
  getPersistedWindowSelection,
  updatePersistedWindowSelection
} from "./window-selection-client";
import { getFloatingPanelVisible } from "../features/desktop-ui/client";
import {
  createFloatingPanelSelectionCoordinator,
  createWindowSelectionSyncQueue,
  readWindowSelection,
  WINDOW_SELECTION_STORAGE_KEY,
  writeWindowSelection,
  type WindowSelectionResolution,
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
import { maskEmail } from "../shared/lib/formatters";
import { buildSubscriptionDetailRecords } from "../subscription-view";
import { requestMainWindowOverviewStats } from "./floating-overview-stats-request";
import type { AccountRuntime, OverviewPayload, UsageStatsRecord } from "../types";

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

interface FloatingPanelResourceIdentity {
  siteId: string;
  accountId: string;
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
    return input.overview.accounts.find(
      (account) => account.id === input.selectedAccountId
        && (!input.selectedSiteId || account.siteId === input.selectedSiteId)
    ) ?? null;
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
  resourceOwner: FloatingPanelResourceIdentity | null;
  currentIdentity: FloatingPanelResourceIdentity | null;
}) {
  return input.currentIdentity != null
    && input.resourceOwner?.siteId === input.currentIdentity.siteId
    && input.resourceOwner?.accountId === input.currentIdentity.accountId;
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
  const [dashboardStats, setDashboardStats] = useState<UsageStatsRecord | null>(null);
  const [dashboardStatsLoading, setDashboardStatsLoading] = useState(false);
  const [dashboardStatsError, setDashboardStatsError] = useState<string | null>(null);
  const [dashboardStatsUpdatedAt, setDashboardStatsUpdatedAt] = useState<string | null>(null);
  const [selectionResolution, setSelectionResolution] = useState<WindowSelectionResolution>({
    state: "resolving",
    message: null
  });
  const [resourceOwner, setResourceOwner] = useState<FloatingPanelResourceIdentity | null>(null);
  const dashboardStatsRequestIdRef = useRef(0);
  const dashboardStatsBridgeRequestIdRef = useRef(0);
  const resourceGenerationRef = useRef(0);
  const selectionGenerationRef = useRef(0);
  const panelVisibilityEventVersionRef = useRef(0);
  const outboundSelectionSyncQueueRef = useRef<ReturnType<typeof createWindowSelectionSyncQueue> | null>(null);
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
  const resolvedCurrentAccount = resolveFloatingPanelCurrentAccount({
    overview,
    selectedAccountId: effectiveSelectedAccountId,
    selectedSiteId: effectiveSelectedSiteId
  });
  const selectionBlocksAccount =
    selectionResolution.state === "resolving"
    || selectionResolution.state === "retryable-error";
  const currentAccount = selectionBlocksAccount ? null : resolvedCurrentAccount;
  const renderedSelectionState = currentAccount
    ? "resolved"
    : effectiveSelectedAccountId
      ? selectionResolution.state === "retryable-error"
        ? "retryable-error"
        : "resolving"
      : selectionResolution.state === "resolving" || selectionResolution.state === "retryable-error"
        ? selectionResolution.state
        : "empty";
  const currentResourceIdentity = currentAccount
    ? { siteId: currentAccount.siteId, accountId: currentAccount.id }
    : null;
  const currentAccountLabel = currentAccount
    ? currentAccount.label.trim() || maskEmail(currentAccount.email.trim()) || null
    : null;
  const currentResourceData = isFloatingPanelResourceDataCurrent({
    resourceOwner,
    currentIdentity: currentResourceIdentity
  });
  const currentResourceIdentityRef = useRef<FloatingPanelResourceIdentity | null>(currentResourceIdentity);
  currentResourceIdentityRef.current = currentResourceIdentity;
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

  const requestCurrentAccountOverviewStats = useCallback((accountId: string) => {
    if (!tauriRuntime) {
      return Promise.resolve(null);
    }

    return requestMainWindowOverviewStats({
      accountId,
      requestId: `floating-overview-${++dashboardStatsBridgeRequestIdRef.current}`
    });
  }, [tauriRuntime]);

  const refreshDashboardStats = useCallback(async (force = false) => {
    const accountId = currentAccount?.id ?? null;
    const requestId = ++dashboardStatsRequestIdRef.current;
    if (!accountId) {
      setDashboardStats(null);
      setDashboardStatsError(null);
      setDashboardStatsLoading(false);
      setDashboardStatsUpdatedAt(null);
      return;
    }
    if (!panelDataActive) {
      return;
    }

    setDashboardStatsLoading(true);
    setDashboardStatsError(null);
    try {
      const pageSnapshot = force ? null : await requestCurrentAccountOverviewStats(accountId);
      if (pageSnapshot) {
        if (requestId !== dashboardStatsRequestIdRef.current) {
          return;
        }
        setDashboardStats(pageSnapshot.stats);
        setDashboardStatsUpdatedAt(pageSnapshot.updatedAt);
        return;
      }
      const next = await getOverviewDashboardStats(accountId, force);
      if (requestId !== dashboardStatsRequestIdRef.current) {
        return;
      }
      setDashboardStats(next.todayStats);
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
  }, [currentAccount?.id, panelDataActive, requestCurrentAccountOverviewStats]);

  const invalidateFloatingResourceData = useCallback(() => {
    resourceGenerationRef.current += 1;
    dashboardStatsRequestIdRef.current += 1;
    setResourceOwner(null);
    setDashboardStats(null);
    setDashboardStatsError(null);
    setDashboardStatsLoading(false);
    setDashboardStatsUpdatedAt(null);
  }, []);

  const selectFloatingAccount = useCallback(async (account: AccountRuntime) => {
    const selection = {
      selectedSiteId: account.siteId,
      selectedAccountId: account.id
    };
    invalidateFloatingResourceData();
    selectionGenerationRef.current += 1;
    setSelectionResolution({ state: "resolved", message: null });
    setSelectedSiteId(account.siteId);
    setSelectedAccountId(account.id);
    if (!tauriRuntime) {
      setBrowserSelection(selection);
      writeWindowSelection(selection);
    }

    outboundSelectionSyncQueueRef.current ??= createWindowSelectionSyncQueue({
      persist: updatePersistedWindowSelection,
      broadcast: (payload) => tauriRuntime
        ? emitTo("main", "floating-panel-selection-sync", payload)
        : Promise.resolve(),
      reportError: (stage, cause) => {
        console.error(`${stage === "persist" ? "保存" : "同步"}悬浮面板账号选择失败`, cause);
        pushToast({
          tone: "error",
          message: stage === "persist"
            ? "账号已切换，但保存选择失败。"
            : "账号已切换，但主窗口同步失败。"
        });
      }
    });
    await outboundSelectionSyncQueueRef.current.enqueue(selection);
  }, [invalidateFloatingResourceData, pushToast, setSelectedAccountId, setSelectedSiteId, tauriRuntime]);

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
    return accountDataWorkspace.refreshAccountData({ force: false });
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
    if (effectiveSelectedAccountId && resolvedCurrentAccount?.id === effectiveSelectedAccountId) {
      setSelectionResolution((current) => current.state === "resolved" && current.message === null
        ? current
        : { state: "resolved", message: null });
      return;
    }
    if (tauriRuntime || !overview) {
      return;
    }
    setSelectionResolution(
      resolvedCurrentAccount
        ? { state: "resolved", message: null }
        : effectiveSelectedAccountId
          ? {
              state: "retryable-error",
              message: "当前账号暂时无法确认，请点击刷新重试。"
            }
          : { state: "empty", message: null }
    );
  }, [
    effectiveSelectedAccountId,
    overview,
    resolvedCurrentAccount,
    tauriRuntime
  ]);

  useEffect(() => {
    if (!currentResourceIdentity) {
      invalidateFloatingResourceData();
      return;
    }
    if (!panelDataActive) {
      return;
    }

    const generation = ++resourceGenerationRef.current;
    const resourceIdentity = currentResourceIdentity;
    setResourceOwner((previous) => isFloatingPanelResourceDataCurrent({
      resourceOwner: previous,
      currentIdentity: resourceIdentity
    }) ? previous : null);
    void Promise.all([refreshCurrentAccountData(), refreshDashboardStats()]).then(([resourceRefresh]) => {
      if (
        resourceGenerationRef.current === generation
        && panelDataActiveRef.current
        && resourceRefresh.status === "success"
        && isFloatingPanelResourceDataCurrent({
          resourceOwner: currentResourceIdentityRef.current,
          currentIdentity: resourceIdentity
        })
      ) {
        setResourceOwner(resourceIdentity);
      }
    });
    return () => {
      if (resourceGenerationRef.current === generation) {
        resourceGenerationRef.current += 1;
      }
      dashboardStatsRequestIdRef.current += 1;
    };
  }, [
    currentResourceIdentity?.accountId,
    currentResourceIdentity?.siteId,
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
    let unlistenNativePanelVisibility: (() => void) | undefined;
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
      if (disposed) {
        cleanup();
        return;
      }
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
        setSelectedSiteId(selection.selectedSiteId);
        setSelectedAccountId(selection.selectedAccountId);
      },
      isPanelDataActive: () => panelDataActiveRef.current,
      refreshOverview: async (selection) => {
        const selectionGeneration = selectionGenerationRef.current;
        const refreshed = await loadOverview({ source: "shell" });
        if (!refreshed) {
          throw new Error(useMonitorStore.getState().error || "刷新悬浮面板总览失败。");
        }
        if (disposed || selectionGenerationRef.current !== selectionGeneration) {
          return false;
        }
        if (selection.selectedAccountId) {
          const latestOverview = useMonitorStore.getState().overview;
          return Boolean(
            latestOverview?.accounts.some((account) => account.id === selection.selectedAccountId)
          );
        }
        return true;
      },
      updateResolution: setSelectionResolution,
      reportError: (stage, cause) => {
        console.error(`${stage === "hydrate" ? "读取" : "刷新"}悬浮面板选择失败`, cause);
      }
    });
    selectionCoordinatorRef.current = selectionCoordinator;
    const unlistenSelectionSync = () => selectionCoordinator.dispose();
    void selectionCoordinator.start();

    async function subscribePanelVisibility() {
      const syncCleanup = await listen<{ menuVisible: boolean }>("floating-panel-sync", (event) => {
        if (disposed) {
          return;
        }
        panelVisibilityEventVersionRef.current += 1;
        setPanelWindowVisible(event.payload.menuVisible);
      });
      if (disposed) {
        syncCleanup();
        return;
      }
      unlistenPanelSync = syncCleanup;

      const hideCleanup = await listen("floating-panel-hide", () => {
        if (disposed) {
          return;
        }
        panelVisibilityEventVersionRef.current += 1;
        setPanelWindowVisible(false);
      });
      if (disposed) {
        hideCleanup();
        return;
      }
      unlistenPanelHide = hideCleanup;

      const nativeVisibilityCleanup = await listen<{ visible: boolean }>(
        "floating-native-panel-visibility",
        (event) => {
          if (disposed) {
            return;
          }
          panelVisibilityEventVersionRef.current += 1;
          setPanelWindowVisible(event.payload.visible);
        }
      );
      if (disposed) {
        nativeVisibilityCleanup();
        return;
      }
      unlistenNativePanelVisibility = nativeVisibilityCleanup;

      // 监听就绪后回读原生状态，补偿启动阶段早于 WebView 监听的显隐事件。
      const hydrationEventVersion = panelVisibilityEventVersionRef.current;
      try {
        const nativeVisible = await getFloatingPanelVisible();
        if (!disposed && panelVisibilityEventVersionRef.current === hydrationEventVersion) {
          setPanelWindowVisible(nativeVisible);
        }
      } catch {
        // 读取失败时保持隐藏，避免在原生窗口状态未知时提前加载交互数据。
      }
    }

    void subscribePanelVisibility().catch(() => undefined);

    return () => {
      disposed = true;
      selectionCoordinatorRef.current = null;
      unlistenToast?.();
      unlistenSelectionSync();
      unlistenPanelSync?.();
      unlistenPanelHide?.();
      unlistenNativePanelVisibility?.();
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
        currentSiteId={currentAccount?.siteId ?? null}
        currentAccountLabel={currentAccountLabel}
        accounts={overview?.accounts ?? []}
        selectionState={renderedSelectionState}
        selectionError={selectionResolution.message}
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
          const overviewRefresh = tauriRuntime && renderedSelectionState !== "resolved"
            ? selectionCoordinatorRef.current?.refreshIfActive() ?? Promise.resolve(false)
            : loadOverview({ source: "shell" });
          void Promise.all([
            overviewRefresh,
            accountDataWorkspace.refreshAccountData(),
            refreshDashboardStats(true)
          ]);
        }}
        onAccountSelect={selectFloatingAccount}
        onValidateQuickSwitch={validateFloatingQuickSwitch}
        onSubmitQuickSwitch={submitFloatingQuickSwitch}
        onReloadQuickSwitchData={reloadFloatingQuickSwitchData}
      />
      <ToastHost toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
