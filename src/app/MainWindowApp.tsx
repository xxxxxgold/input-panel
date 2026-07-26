import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitTo } from "@tauri-apps/api/event";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent
} from "react";

import { AppShell } from "./AppShell";
import { FloatingRailDrawer, type FloatingRailDrawerPanelKey } from "./FloatingRailDrawer";
import {
  MainWindowAlertInbox,
  MainWindowNotificationChrome,
  MainWindowToastLayer
} from "./MainWindowChrome";
import { ModalHost } from "./ModalHost";
import { RailNav } from "./RailNav";
import { RetryableLazyPage } from "./RetryableLazyPage";
import { SyncTaskCenter, type SyncTaskCenterTask } from "./SyncTaskCenter";
import { Topbar } from "./Topbar";
import { WorkspaceFrame } from "./WorkspaceFrame";
import { WorkspaceLoadingState } from "./WorkspaceLoadingState";
import {
  getIdlePagePreloadCandidate,
  shouldStartPagePreload,
  type PagePreloadCoordinator,
  type PagePreloadTarget
} from "./page-preload";
import { buildWorkspaceSummaryTexts } from "./workspace-summary";
import {
  createWindowSelectionSyncQueue,
  readWindowSelection,
  resolveSelectedSiteAccountFallback,
  writeWindowSelection,
  type WindowSelectionState
} from "./window-selection-sync";
import {
  getPersistedWindowSelection,
  updatePersistedWindowSelection
} from "./window-selection-client";
import { navTitle as workspaceNavTitle } from "./navigation";
import { useShellWorkspace } from "./useShellWorkspace";
import { THEME_IDS, normalizeThemeId, type ThemeId } from "../shared/lib/theme";
import { createBoundedExecutor } from "../shared/lib/bounded-map";
import { useStableCallback } from "../shared/hooks/useStableCallback";
import { ScopedResourceCache } from "../shared/state/scoped-resource-cache";
import {
  useAccountDataWorkspace,
  type AccountDataResourceKey,
  type AccountDataResourcePresentationByKey,
  type AccountDataResources
} from "../features/accounts/useAccountDataWorkspace";
import { getAccountSyncStatus, syncAccountData } from "../features/accounts/client";
import { getSchedulerConfig, listManagedKeys, updateSchedulerConfig } from "../api";
import { useAccountWorkspace } from "../features/accounts/useAccountWorkspace";
import { clearRuntimeData } from "../features/maintenance/client";
import { getOverviewDashboardStats, syncAllAccounts } from "../features/overview/client";
import { useCodexRadarFastWorkspace } from "../features/overview/useCodexRadarFastWorkspace";
import { useCodexRadarIntelligenceWorkspace } from "../features/overview/useCodexRadarIntelligenceWorkspace";
import { useCodexRadarWorkspace } from "../features/overview/useCodexRadarWorkspace";
import {
  buildOverviewAllAccountKeysScopeKey,
  buildOverviewRealtimeScopeKey,
  overviewScopeReferencesAccount
} from "../features/overview/overview-realtime-scope";
import { useProfileWorkspace } from "../features/profile/useProfileWorkspace";
import { usePublicEndpointsWorkspace } from "../features/public-endpoints/usePublicEndpointsWorkspace";
import { useServiceStatusWorkspace } from "../features/service-status/useServiceStatusWorkspace";
import {
  buildServiceStatusNotificationRecord,
  sendAppNotification
} from "../features/service-status/notifications";
import { useSettingsWorkspace } from "../features/settings/useSettingsWorkspace";
import { getDashboardModels, getDashboardTrend, getUsageInsights } from "../features/usage/client";
import { useUsageWorkspace } from "../features/usage/useUsageWorkspace";
import { useDesktopUiPrefs } from "../features/desktop-ui/useDesktopUiPrefs";
import { useDatabaseStorageWorkspace } from "../features/database-storage/useDatabaseStorageWorkspace";
import {
  isAccountDataStaleForToday,
  normalizeAutoRefreshIntervalSeconds,
  resolveAutoRefreshGroupPolicy,
  resolveAutoRefreshScope,
  resolveServiceStatusAutoRefreshPolicy,
  shouldAutoRefreshSelectedAccountData,
  shouldHydrateOverviewRealtime,
} from "./refresh-policy";
import { useBackgroundWarmup } from "./background-warmup/useBackgroundWarmup";
import { getWarmupResourceForNav } from "./background-warmup/warmup-policy";
import type { WarmupResourceKey, WarmupTaskResult } from "./background-warmup/warmup-types";
import {
  selectLoading,
  selectNav,
  selectOverview,
  selectOverviewLastError,
  selectSelectedAccountId,
  selectSelectedSiteId,
  selectSelectionSyncNonce,
  selectTheme
} from "./main-window-store-selectors";
import { isTauriRuntime } from "../shared/transport/runtime";
import {
  buildTopbarSubscriptionPreviewRecords,
  mergeSubscriptionRecords
} from "../subscription-view";
import projectLogo from "../assets/project-logo-64.webp";
import { OverviewPage } from "../pages/OverviewPage";
import { ERROR_TOAST_DURATION_MS, INFO_TOAST_DURATION_MS, resolveOverviewSelection, useMonitorStore } from "../store/monitor-store";
import type {
  AccountSyncStatusRecord,
  AccountRuntime,
  DataSyncScope,
  KeyRecord,
  ManagedKeyRecord,
  NavKey,
  OverviewPayload,
  OverviewModelPoint,
  PlatformPoint,
  SchedulerConfigPayload,
  UsageInsightsPayload,
  UsageStatsRecord
} from "../types";

const ALLOWED_THEMES = new Set<string>(THEME_IDS);
const SCHEDULER_CONFIG_SAVE_DEBOUNCE_MS = 180;

type SchedulerConfigPendingSave = {
  value: SchedulerConfigPayload;
  revision: number;
  failed: boolean;
};

function lazyComponent<TProps>(
  loader: () => Promise<{ default: ComponentType<TProps> }>
) {
  return lazy(loader);
}

const AccountWorkspaceModals = lazyComponent(async () => ({
  default: (await import("../features/accounts/components/AccountWorkspaceModals")).AccountWorkspaceModals
}));
const AnalyticsLab = lazyComponent(async () => ({
  default: (await import("../features/analytics/AnalyticsLab")).AnalyticsLab
}));
const DesktopModeCloseDialog = lazyComponent(async () => ({
  default: (await import("./DesktopModeCloseDialog")).DesktopModeCloseDialog
}));
const KeyUsagePage = lazyComponent(async () => ({
  default: (await import("../pages/KeyUsagePage")).KeyUsagePage
}));
const ProfileWorkspaceModal = lazyComponent(async () => ({
  default: (await import("../features/profile/components/ProfileWorkspaceModal")).ProfileWorkspaceModal
}));
const SettingsPage = lazyComponent(async () => ({
  default: (await import("../pages/SettingsPage")).SettingsPage
}));
const AlertsPage = lazyComponent(async () => ({
  default: (await import("../pages/AlertsPage")).AlertsPage
}));
const CodexRadarPage = lazyComponent(async () => ({
  default: (await import("../pages/CodexRadarPage")).CodexRadarPage
}));

async function loadKeysPage() {
  return { default: (await import("../pages/KeysPage")).KeysPage };
}

async function loadModelStatsPage() {
  return { default: (await import("../pages/ModelStatsPage")).ModelStatsPage };
}

async function loadServiceStatusPage() {
  return { default: (await import("../pages/ServiceStatusPage")).ServiceStatusPage };
}

async function loadSubscriptionsPage() {
  return { default: (await import("../pages/SubscriptionsPage")).SubscriptionsPage };
}

async function loadSystemSettingsPage() {
  return { default: (await import("../pages/SystemSettingsPage")).SystemSettingsPage };
}

async function loadUsagePage() {
  return { default: (await import("../pages/UsagePage")).UsagePage };
}

type OverviewUsageStatsMode = "selected-account" | "all-accounts";
const OVERVIEW_USAGE_STATS_MODE_KEY = "input-panel.overview-usage-stats-mode";
const OVERVIEW_REALTIME_REFRESH_MIN_INTERVAL_MS = 30_000;
const OVERVIEW_ALL_ACCOUNT_KEYS_REFRESH_MIN_INTERVAL_MS = 30_000;
const OVERVIEW_UPSTREAM_REQUEST_CONCURRENCY = 3;
const OVERVIEW_MANAGED_KEYS_PAGE_SIZE = 100;
const OVERVIEW_REALTIME_CACHE_MAX_ENTRIES = 64;
const OVERVIEW_ALL_ACCOUNT_KEYS_CACHE_MAX_ENTRIES = 32;

type OverviewUsageStatsRow = {
  accountId: string;
  label: string;
  siteName: string;
  stats: UsageStatsRecord;
  totalStats?: UsageStatsRecord;
};

type OverviewDashboardStatsRow = OverviewUsageStatsRow & {
  totalStats: UsageStatsRecord;
  platformSeries: PlatformPoint[];
};

type OverviewDashboardRealtimeRow = OverviewDashboardStatsRow & {
  trendPoints: NonNullable<NonNullable<AccountRuntime["cacheView"]>["trend"]>;
  modelSeries: OverviewModelPoint[];
  usageInsights: UsageInsightsPayload;
};

type OverviewRealtimeSnapshot = {
  usageStats: UsageStatsRecord | null;
  totalUsageStats: UsageStatsRecord | null;
  platformSeries: PlatformPoint[] | null;
  trendPoints: NonNullable<NonNullable<AccountRuntime["cacheView"]>["trend"]> | null;
  modelSeries: OverviewModelPoint[] | null;
  usageInsights: UsageInsightsPayload | null;
  usageStatsRows: OverviewUsageStatsRow[];
};

const EMPTY_OVERVIEW_REALTIME_SNAPSHOT: OverviewRealtimeSnapshot = {
  usageStats: null,
  totalUsageStats: null,
  platformSeries: null,
  trendPoints: null,
  modelSeries: null,
  usageInsights: null,
  usageStatsRows: []
};

type OverviewUsageInsightRange = {
  startDate: string;
  endDate: string;
};

function toOverviewDateValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildDefaultOverviewUsageInsightRange(): OverviewUsageInsightRange {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  return { startDate: toOverviewDateValue(start), endDate: toOverviewDateValue(end) };
}

type OverviewManagedKeyRecord = ManagedKeyRecord & {
  accountId?: string | null;
  siteName?: string | null;
  accountLabel?: string | null;
};

function attachOverviewKeyAccountContext(
  keys: ManagedKeyRecord[],
  account: AccountRuntime
): OverviewManagedKeyRecord[] {
  const siteName = account.site?.name ?? account.cacheView?.siteName ?? null;
  return keys.map((key) => ({
    ...key,
    accountId: readOverviewKeyAccountId(key) ?? account.id,
    siteName: readOverviewKeySiteName(key) ?? siteName,
    accountLabel: account.label
  }));
}

async function loadAllOverviewManagedKeys(account: AccountRuntime) {
  const firstPage = await listManagedKeys(account.id, 1, OVERVIEW_MANAGED_KEYS_PAGE_SIZE);
  const expectedTotal = Math.max(firstPage.total, 0);
  const expectedPages = Math.max(1, Math.ceil(expectedTotal / OVERVIEW_MANAGED_KEYS_PAGE_SIZE));
  if (firstPage.page !== 1 || firstPage.pages !== expectedPages) {
    throw new Error("本地密钥分页结果不完整。");
  }

  const keys = [...firstPage.items];
  for (let page = 2; page <= expectedPages; page += 1) {
    const nextPage = await listManagedKeys(account.id, page, OVERVIEW_MANAGED_KEYS_PAGE_SIZE);
    if (
      nextPage.page !== page
      || nextPage.pages !== expectedPages
      || nextPage.total !== expectedTotal
    ) {
      throw new Error("本地密钥分页结果在读取期间发生变化。");
    }
    keys.push(...nextPage.items);
  }

  if (keys.length !== expectedTotal) {
    throw new Error("本地密钥分页结果不完整。");
  }
  return attachOverviewKeyAccountContext(keys, account);
}

function readOverviewKeyAccountId(key: KeyRecord) {
  const value = (key as KeyRecord & { accountId?: unknown }).accountId;
  return typeof value === "string" && value.trim() ? value : null;
}

function readOverviewKeySiteName(key: KeyRecord) {
  const value = (key as KeyRecord & { siteName?: unknown }).siteName;
  return typeof value === "string" && value.trim() ? value : null;
}

function renderDeferredPageFallback() {
  return <WorkspaceLoadingState staticBackdrop />;
}

type PageDataState = {
  hasSnapshot: boolean;
  initialLoading: boolean;
  lastError: string | null;
};

const KEYS_PAGE_RESOURCES: readonly AccountDataResourceKey[] = [
  "groups",
  "managedKeys",
  "subscriptions",
  "subscriptionSummary",
  "subscriptionSwitchRules"
];

const SUBSCRIPTIONS_PAGE_RESOURCES: readonly AccountDataResourceKey[] = [
  "managedKeys",
  "subscriptions",
  "subscriptionSummary"
];

type PagePreloadNavigator = Navigator & {
  connection?: {
    saveData?: boolean;
    effectiveType?: string | null;
  };
};

type IdleCallbackWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

function shouldRenderColdPageState(state: PageDataState, expectsSnapshot = false) {
  return !state.hasSnapshot && (expectsSnapshot || state.initialLoading || state.lastError !== null);
}

function resolveAccountPageDataState(
  resourcePresentation: AccountDataResourcePresentationByKey,
  resources: readonly AccountDataResourceKey[]
): PageDataState {
  const entries = resources.map((resource) => resourcePresentation[resource]);
  return {
    hasSnapshot: entries.every((entry) => entry.hasSnapshot),
    initialLoading: entries.some((entry) => entry.initialLoading),
    lastError: entries.map((entry) => entry.lastError).find((error): error is string => error !== null) ?? null
  };
}

function resolveWorkspaceHasRetainedSnapshot(input: {
  nav: NavKey;
  overview: OverviewPayload | null;
  account: PageDataState;
  keys: PageDataState;
  subscriptions: PageDataState;
  usage: PageDataState;
  keyUsage: PageDataState;
  serviceStatus: PageDataState;
}) {
  if (input.nav === "codexRadar") {
    return false;
  }
  if (input.nav === "serviceStatus") {
    return input.serviceStatus.hasSnapshot;
  }
  if (input.nav === "keys") {
    return input.keys.hasSnapshot;
  }
  if (input.nav === "subscriptions") {
    return input.subscriptions.hasSnapshot;
  }
  if (input.nav === "usage" || input.nav === "modelStats") {
    return input.usage.hasSnapshot;
  }
  if (input.nav === "keyUsage") {
    return input.keyUsage.hasSnapshot;
  }
  if (input.nav === "settings" || input.nav === "trends") {
    return input.account.hasSnapshot;
  }
  if (input.nav === "systemSettings") {
    return true;
  }
  return input.overview !== null;
}

function isPagePreloadTarget(nav: NavKey): nav is PagePreloadTarget {
  return nav === "systemSettings"
    || nav === "usage"
    || nav === "keys"
    || nav === "subscriptions"
    || nav === "serviceStatus"
    || nav === "modelStats";
}

function getPagePreloadEnvironment(isAppFocused: boolean) {
  const connection = typeof navigator === "undefined"
    ? undefined
    : (navigator as PagePreloadNavigator).connection;
  return {
    isAppFocused,
    saveData: connection?.saveData,
    effectiveType: connection?.effectiveType
  };
}

async function preloadPageChunk(target: PagePreloadTarget) {
  switch (target) {
    case "systemSettings":
      await loadSystemSettingsPage();
      return;
    case "usage":
      await loadUsagePage();
      return;
    case "keys":
      await loadKeysPage();
      return;
    case "subscriptions":
      await loadSubscriptionsPage();
      return;
    case "serviceStatus":
      await loadServiceStatusPage();
      return;
    case "modelStats":
      await loadModelStatsPage();
      return;
  }
}

function scheduleIdlePagePreload(callback: () => void) {
  if (typeof window === "undefined") {
    return () => {};
  }
  const idleWindow = window as IdleCallbackWindow;
  if (idleWindow.requestIdleCallback) {
    const idleId = idleWindow.requestIdleCallback(callback, { timeout: 1_500 });
    return () => idleWindow.cancelIdleCallback?.(idleId);
  }
  const timeoutId = window.setTimeout(callback, 1_000);
  return () => window.clearTimeout(timeoutId);
}

async function ignoreWindowMutation(task: Promise<unknown>) {
  try {
    await task;
  } catch {
    // 某些 Windows/Tauri 组合下窗口属性调用会偶发失败, 不能阻断主窗口渲染。
  }
}

export function MainWindowApp() {
  const [alertInboxOpen, setAlertInboxOpen] = useState(false);
  const [profileWorkspaceRequested, setProfileWorkspaceRequested] = useState(false);
  const [accountSyncStatuses, setAccountSyncStatuses] = useState<AccountSyncStatusRecord[]>([]);
  const [syncTaskCenterOpen, setSyncTaskCenterOpen] = useState(false);
  const [syncTaskRecords, setSyncTaskRecords] = useState<SyncTaskCenterTask[]>([]);
  const [topbarReloadRefreshing, setTopbarReloadRefreshing] = useState(false);
  const [floatingRailPanel, setFloatingRailPanel] = useState<FloatingRailDrawerPanelKey | null>(null);
  const [pageVisible, setPageVisible] = useState(
    typeof document === "undefined" ? true : document.visibilityState === "visible"
  );
  const [windowFocused, setWindowFocused] = useState(
    typeof document === "undefined" ? true : document.hasFocus()
  );
  const [overviewUsageStatsMode, setOverviewUsageStatsMode] = useState<OverviewUsageStatsMode>(() => {
    if (typeof window === "undefined") {
      return "selected-account";
    }
    const saved = window.localStorage.getItem(OVERVIEW_USAGE_STATS_MODE_KEY);
    return saved === "all-accounts" ? "all-accounts" : "selected-account";
  });
  const [overviewUsageInsightRange, setOverviewUsageInsightRange] = useState<OverviewUsageInsightRange>(
    buildDefaultOverviewUsageInsightRange
  );
  const [pageMotionNav, setPageMotionNav] = useState<NavKey>("overview");
  const [pageMotionPhase, setPageMotionPhase] = useState<"idle" | "enter">("idle");
  const lastServiceStatusNavRef = useRef<NavKey | null>(null);
  const lastServiceStatusDrawerRef = useRef(false);
  const lastPageVisibleRef = useRef(pageVisible);
  const selectedAccountIdRef = useRef<string | null>(null);
  // 桌面窗口首帧可能在焦点事件抵达前完成总览快照，允许该快照水合一次。
  const overviewInitialHydrationPendingRef = useRef(true);
  const overviewRealtimeCacheRef = useRef<ScopedResourceCache<OverviewRealtimeSnapshot> | null>(null);
  const overviewAllAccountKeysCacheRef = useRef<ScopedResourceCache<OverviewManagedKeyRecord[]> | null>(null);
  const [, setOverviewScopeCacheRevision] = useState(0);
  if (!overviewRealtimeCacheRef.current) {
    overviewRealtimeCacheRef.current = new ScopedResourceCache<OverviewRealtimeSnapshot>({
      maxEntries: OVERVIEW_REALTIME_CACHE_MAX_ENTRIES
    });
  }
  if (!overviewAllAccountKeysCacheRef.current) {
    overviewAllAccountKeysCacheRef.current = new ScopedResourceCache<OverviewManagedKeyRecord[]>({
      maxEntries: OVERVIEW_ALL_ACCOUNT_KEYS_CACHE_MAX_ENTRIES
    });
  }
  const overviewRealtimeCache = overviewRealtimeCacheRef.current;
  const overviewAllAccountKeysCache = overviewAllAccountKeysCacheRef.current;
  const overviewUpstreamRequestExecutor = useMemo(
    () => createBoundedExecutor(OVERVIEW_UPSTREAM_REQUEST_CONCURRENCY),
    []
  );
  const invalidatePublicEndpointsSiteRef = useRef<(siteId: string) => void>(() => {});
  const invalidateUsageAccountRef = useRef<(accountId: string) => void>(() => {});
  const topbarReloadRunningRef = useRef(false);
  const pagePreloadCoordinatorRef = useRef<Promise<PagePreloadCoordinator> | null>(null);
  const pagePreloadNavRef = useRef<NavKey | null>(null);
  const pagePreloadIntentTimerRef = useRef<number | null>(null);
  const nav = useMonitorStore(selectNav);
  pagePreloadNavRef.current = nav;
  const theme = useMonitorStore(selectTheme);
  const overview = useMonitorStore(selectOverview);
  const loading = useMonitorStore(selectLoading);
  const overviewLastError = useMonitorStore(selectOverviewLastError);
  const selectedSiteId = useMonitorStore(selectSelectedSiteId);
  const selectedAccountId = useMonitorStore(selectSelectedAccountId);
  const selectionSyncNonce = useMonitorStore(selectSelectionSyncNonce);
  const {
    setNav,
    setTheme,
    setBusyText,
    setError,
    pushAppNotification,
    pushToast,
    setSelectedSiteId,
    setSelectedAccountId,
    refreshSelectedAccountSync,
    loadOverview,
    replaceOverview,
    evictOverviewEntities
  } = useMonitorStore.getState();
  const [clearRuntimeDataLoading, setClearRuntimeDataLoading] = useState(false);
  const [selectionBootstrapDone, setSelectionBootstrapDone] = useState(false);
  const lastPersistedSelectionKeyRef = useRef<string | null>(null);
  const lastQueuedSelectionKeyRef = useRef<string | null>(null);
  const selectionSyncQueueRef = useRef<ReturnType<typeof createWindowSelectionSyncQueue> | null>(null);
  useEffect(() => {
    selectedAccountIdRef.current = selectedAccountId;
  }, [selectedAccountId]);
  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    document.documentElement.classList.add("desktop-main-root");
    document.body.classList.add("desktop-main-window-body");
    document.getElementById("root")?.classList.add("desktop-main-window-root");

    void (async () => {
      const appWindow = getCurrentWindow();
      await ignoreWindowMutation(appWindow.setDecorations(false));
      await ignoreWindowMutation(appWindow.setShadow(false));
    })();
    return () => {
      document.documentElement.classList.remove("desktop-main-root");
      document.body.classList.remove("desktop-main-window-body");
      document.getElementById("root")?.classList.remove("desktop-main-window-root");
    };
  }, []);
  const desktopUi = useDesktopUiPrefs("main");
  const databaseStorage = useDatabaseStorageWorkspace({
    enabled: nav === "systemSettings"
  });
  const prefsRef = useRef(desktopUi.prefs);
  prefsRef.current = desktopUi.prefs;
  const [schedulerConfig, setSchedulerConfig] = useState<SchedulerConfigPayload>({ enabled: true, intervalSeconds: 9 });
  const [schedulerConfirmedConfig, setSchedulerConfirmedConfig] = useState<SchedulerConfigPayload>({
    enabled: true,
    intervalSeconds: 9
  });
  const [schedulerConfigLoading, setSchedulerConfigLoading] = useState(false);
  const [schedulerConfigSaving, setSchedulerConfigSaving] = useState(false);
  const [schedulerLoadError, setSchedulerLoadError] = useState<string | null>(null);
  const [schedulerSaveError, setSchedulerSaveError] = useState<string | null>(null);
  const schedulerConfigRef = useRef(schedulerConfig);
  const schedulerPendingSaveRef = useRef<SchedulerConfigPendingSave | null>(null);
  const schedulerSaveRunningRef = useRef(false);
  const schedulerSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulerSaveRevisionRef = useRef(0);
  const schedulerLoadRevisionRef = useRef(0);
  schedulerConfigRef.current = schedulerConfig;

  const loadSchedulerConfig = useCallback(async () => {
    const revision = schedulerLoadRevisionRef.current + 1;
    schedulerLoadRevisionRef.current = revision;
    setSchedulerConfigLoading(true);
    setSchedulerLoadError(null);
    try {
      const config = await getSchedulerConfig();
      if (schedulerLoadRevisionRef.current !== revision) {
        return;
      }
      setSchedulerConfirmedConfig(config);
      if (!schedulerPendingSaveRef.current) {
        setSchedulerConfig(config);
      }
    } catch (cause) {
      if (schedulerLoadRevisionRef.current !== revision) {
        return;
      }
      setSchedulerLoadError(
        cause instanceof Error && cause.message.trim()
          ? cause.message
          : "后端用量同步器设置读取失败。"
      );
    } finally {
      if (schedulerLoadRevisionRef.current === revision) {
        setSchedulerConfigLoading(false);
      }
    }
  }, []);

  function clearScheduledSchedulerSave() {
    if (schedulerSaveTimerRef.current !== null) {
      window.clearTimeout(schedulerSaveTimerRef.current);
      schedulerSaveTimerRef.current = null;
    }
  }

  function scheduleSchedulerSave(debounce: boolean) {
    const pending = schedulerPendingSaveRef.current;
    if (!pending || pending.failed) {
      return;
    }
    clearScheduledSchedulerSave();
    schedulerSaveTimerRef.current = window.setTimeout(
      () => {
        schedulerSaveTimerRef.current = null;
        void flushSchedulerConfigSave();
      },
      debounce ? SCHEDULER_CONFIG_SAVE_DEBOUNCE_MS : 0
    );
  }

  async function flushSchedulerConfigSave() {
    if (schedulerSaveRunningRef.current) {
      return;
    }
    const pending = schedulerPendingSaveRef.current;
    if (!pending || pending.failed) {
      return;
    }

    schedulerPendingSaveRef.current = null;
    schedulerSaveRunningRef.current = true;
    setSchedulerConfigSaving(true);
    try {
      const confirmed = await updateSchedulerConfig(pending.value);
      setSchedulerConfirmedConfig(confirmed);
      if (!schedulerPendingSaveRef.current) {
        setSchedulerConfig(confirmed);
      }
      setSchedulerSaveError(null);
    } catch (cause) {
      const newerPending = schedulerPendingSaveRef.current as SchedulerConfigPendingSave | null;
      if (!newerPending || newerPending.revision <= pending.revision) {
        schedulerPendingSaveRef.current = { ...pending, failed: true };
        setSchedulerSaveError(
          cause instanceof Error && cause.message.trim()
            ? cause.message
            : "设置保存失败，请重试。"
        );
      }
    } finally {
      schedulerSaveRunningRef.current = false;
      const nextPending = schedulerPendingSaveRef.current as SchedulerConfigPendingSave | null;
      setSchedulerConfigSaving(Boolean(nextPending && !nextPending.failed));
      if (nextPending && !nextPending.failed) {
        scheduleSchedulerSave(false);
      }
    }
  }

  function handleSchedulerConfigChange(
    value: SchedulerConfigPayload,
    options: { debounce?: boolean } = {}
  ) {
    const normalized: SchedulerConfigPayload = {
      enabled: value.enabled,
      intervalSeconds: Math.max(5, Math.round(value.intervalSeconds))
    };
    schedulerLoadRevisionRef.current += 1;
    schedulerSaveRevisionRef.current += 1;
    schedulerPendingSaveRef.current = {
      value: normalized,
      revision: schedulerSaveRevisionRef.current,
      failed: false
    };
    setSchedulerConfig(normalized);
    setSchedulerLoadError(null);
    setSchedulerSaveError(null);
    setSchedulerConfigSaving(true);
    scheduleSchedulerSave(options.debounce === true);
  }

  function retrySchedulerConfigSave() {
    const pending = schedulerPendingSaveRef.current;
    if (!pending || !pending.failed) {
      return;
    }
    schedulerPendingSaveRef.current = { ...pending, failed: false };
    setSchedulerSaveError(null);
    setSchedulerConfigSaving(true);
    scheduleSchedulerSave(false);
  }

  function retrySchedulerConfigLoad() {
    void loadSchedulerConfig();
  }

  useEffect(() => {
    void loadSchedulerConfig();
    return () => {
      schedulerLoadRevisionRef.current += 1;
    };
  }, [loadSchedulerConfig]);
  useEffect(() => () => clearScheduledSchedulerSave(), []);
  const sites = overview?.sites ?? [];
  const accounts = overview?.accounts ?? [];
  const hasAnyAccount = accounts.length > 0;
  const serviceStatusAvailable = true;
  const serviceStatusAutoRefreshPolicy = resolveServiceStatusAutoRefreshPolicy(desktopUi.prefs);
  const serviceStatusRefreshIntervalSeconds = normalizeAutoRefreshIntervalSeconds(
    desktopUi.prefs.autoRefreshIntervalSeconds
  );
  const shellWorkspace = useShellWorkspace({ accounts });
  const floatingRailServiceStatusOpen = floatingRailPanel === "serviceStatus";
  const floatingRailSubscriptionsOpen = floatingRailPanel === "subscriptions";
  const overviewVisible = nav === "overview";
  const overviewSubscriptionPanelVisible =
    overviewVisible || nav === "subscriptions" || floatingRailSubscriptionsOpen;
  const subscriptionIndicatorResource =
    nav === "keys"
    || nav === "trends"
    || overviewSubscriptionPanelVisible
      ? true
      : "deferred";
  const keysResources: AccountDataResources = {
    groups: nav === "keys",
    managedKeys:
      nav === "keys"
      || nav === "usage"
      || nav === "modelStats"
      || nav === "subscriptions"
      || nav === "keyUsage"
      || nav === "trends"
        ? true
        : overviewVisible
          ? true
          : false,
    subscriptions: subscriptionIndicatorResource,
    subscriptionSummary: subscriptionIndicatorResource,
    profileRecord:
      profileWorkspaceRequested
      || shellWorkspace.topbarAccountMenuOpen
      || nav === "trends"
      || nav === "settings"
        ? true
        : overviewVisible
          ? "deferred"
          : false,
    platformQuotas: profileWorkspaceRequested || nav === "trends",
    subscriptionSwitchRules: nav === "keys"
  };
  const keysEnabled = Object.values(keysResources).some(Boolean);
  const accountDataWorkspace = useAccountDataWorkspace({
    selectedAccountId,
    resources: keysResources,
    enabled: keysEnabled,
    setError
  });
  const invalidateOverviewAccountScopes = (accountIds: readonly string[]) => {
    const removedAccountIds = new Set(accountIds.map((accountId) => accountId.trim()).filter(Boolean));
    if (removedAccountIds.size === 0) {
      return;
    }
    const referencesRemovedAccount = (key: string) => (
      Array.from(removedAccountIds).some((accountId) => overviewScopeReferencesAccount(key, accountId))
    );
    overviewRealtimeCache.invalidateWhere(referencesRemovedAccount);
    overviewAllAccountKeysCache.invalidateWhere(referencesRemovedAccount);
  };
  const accountWorkspace = useAccountWorkspace({
    sites,
    accounts,
    selectedSiteId,
    selectedAccountId,
    setSelectedSiteId,
    setSelectedAccountId,
    invalidateAccount: (accountId) => {
      accountDataWorkspace.invalidateAccount(accountId);
      invalidateUsageAccountRef.current(accountId);
      invalidateOverviewAccountScopes([accountId]);
    },
    evictOverviewEntities,
    invalidateSite: (siteId) => invalidatePublicEndpointsSiteRef.current(siteId),
    invalidateAccountsForSite: (siteId) => {
      const removedAccountIds = accounts
        .filter((account) => account.siteId === siteId)
        .map((account) => account.id);
      for (const accountId of removedAccountIds) {
        accountDataWorkspace.invalidateAccount(accountId);
        invalidateUsageAccountRef.current(accountId);
      }
      invalidateOverviewAccountScopes(removedAccountIds);
    },
    refreshSelectedAccountSync,
    loadOverview: async (options) => {
      await loadOverview(options);
    },
    onSyncStatusChange: (accountId, statuses) => {
      if (selectedAccountIdRef.current === accountId) {
        setAccountSyncStatuses(statuses);
      }
    },
    setBusyText,
    setError
  });
  const profileWorkspace = useProfileWorkspace({
    selectedAccountId,
    profileRecord: accountDataWorkspace.profileRecord,
    setProfileRecord: accountDataWorkspace.setProfileRecord,
    loadOverview: async () => {
      await loadOverview();
    },
    setBusyText,
    setError
  });
  const topbarServiceStatusWorkspace = useServiceStatusWorkspace({
    setError,
    enabled: serviceStatusAvailable,
    autoRefresh: false,
    notifyStatusTransition: (event) => {
      const record = buildServiceStatusNotificationRecord(event);
      pushAppNotification(record);
      void sendAppNotification(record);
      const toastPayload = {
        tone: event.kind === "down" ? "error" : "success",
        message: event.detail,
        durationMs: event.kind === "down" ? ERROR_TOAST_DURATION_MS : INFO_TOAST_DURATION_MS
      } as const;
      pushToast(toastPayload);
      if (isTauriRuntime()) {
        void emitTo("floating-panel", "floating-panel-toast", toastPayload);
      }
    },
    refreshIntervalMs: serviceStatusRefreshIntervalSeconds * 1000
  });
  const codexRadarWorkspace = useCodexRadarWorkspace();
  const codexRadarIntelligenceWorkspace = useCodexRadarIntelligenceWorkspace({
    enabled: nav === "codexRadar"
  });
  const codexRadarFastWorkspace = useCodexRadarFastWorkspace({
    enabled: nav === "codexRadar"
  });
  const {
    usageApiKeyFilter,
    setUsageApiKeyFilter,
    usageModelFilter,
    setUsageModelFilter,
    usageGroupFilter,
    setUsageGroupFilter,
    usageSubscriptionFilter,
    setUsageSubscriptionFilter,
    usagePlatformFilter,
    setUsagePlatformFilter,
    usageReasoningEffortFilter,
    setUsageReasoningEffortFilter,
    usageRequestTypeFilter,
    setUsageRequestTypeFilter,
    usageBillingTypeFilter,
    setUsageBillingTypeFilter,
    usageBillingModeFilter,
    setUsageBillingModeFilter,
    usageRangePickerRef,
    usageRangePickerOpen,
    toggleUsageRangePicker,
    usageRangeLabel,
    usageRangePreset,
    applyUsagePreset,
    usageDraftRange,
    setUsageDraftRange,
    applyUsageRange,
    usageStats,
    usageExtremes,
    usageModelSummaries,
    usageModelSummariesLoading,
    usageRecords,
    usageScopeRows,
    usageScopeMeta,
    usagePageSize,
    usagePageSizeOptions,
    handleUsageSearch,
    handleUsagePageChange,
    handleUsagePageSizeChange,
    usageTrend,
    usageModels,
    keyUsageRows,
    keyUsageKeyId,
    keyUsagePresentation,
    retryKeyUsage,
    invalidateAccount: invalidateUsageAccount,
    presentation,
    loadKeyUsage,
    refreshUsageWorkspaceSilently,
    refreshUsageSurfaceSilently,
    preloadUsageSurface,
    usageStartDate,
    setUsageStartDate,
    usageEndDate,
    setUsageEndDate
  } = useUsageWorkspace({
    nav,
    selectedAccountId,
    managedKeys: accountDataWorkspace.managedKeys,
    fallbackManagedKeys:
      accounts.find((item) => item.id === selectedAccountId)?.cacheView?.keys ??
      [],
    setBusyText,
    setError
  });
  invalidateUsageAccountRef.current = invalidateUsageAccount;
  const accountPageDataState: PageDataState = accountDataWorkspace.presentation;
  const keysPageDataState = resolveAccountPageDataState(
    accountDataWorkspace.resourcePresentation,
    KEYS_PAGE_RESOURCES
  );
  const subscriptionsPageDataState = resolveAccountPageDataState(
    accountDataWorkspace.resourcePresentation,
    SUBSCRIPTIONS_PAGE_RESOURCES
  );
  const serviceStatusPageDataState: PageDataState = {
    hasSnapshot: topbarServiceStatusWorkspace.status !== null,
    initialLoading: topbarServiceStatusWorkspace.loading && !topbarServiceStatusWorkspace.status,
    lastError: topbarServiceStatusWorkspace.lastError
  };
  const workspaceHasRetainedSnapshot = resolveWorkspaceHasRetainedSnapshot({
    nav,
    overview,
    account: accountPageDataState,
    keys: keysPageDataState,
    subscriptions: subscriptionsPageDataState,
    usage: presentation,
    keyUsage: keyUsagePresentation,
    serviceStatus: serviceStatusPageDataState
  });
  const workspaceFrameLoading = nav === "codexRadar"
    ? false
    : nav === "serviceStatus"
    ? serviceStatusPageDataState.initialLoading
    : loading;
  const workspaceFrameReady = nav === "codexRadar"
    ? true
    : nav === "serviceStatus"
    ? serviceStatusPageDataState.hasSnapshot
    : Boolean(overview);

  useEffect(() => {
    if (ALLOWED_THEMES.has(desktopUi.prefs.theme) && theme !== desktopUi.prefs.theme) {
      setTheme(normalizeThemeId(desktopUi.prefs.theme));
    }
  }, [desktopUi.prefs.theme, setTheme, theme]);

  useEffect(() => {
    document.documentElement.classList.remove(...THEME_IDS);
    document.documentElement.classList.add(theme);
  }, [theme]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const syncVisibility = () => {
      setPageVisible(document.visibilityState === "visible");
    };
    const syncFocus = () => {
      setWindowFocused(document.hasFocus());
    };

    syncVisibility();
    syncFocus();
    document.addEventListener("visibilitychange", syncVisibility);
    window.addEventListener("focus", syncFocus);
    window.addEventListener("blur", syncFocus);
    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
      window.removeEventListener("focus", syncFocus);
      window.removeEventListener("blur", syncFocus);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const hydrateSelectionAndLoadOverview = async () => {
      const browserSelection = !isTauriRuntime() ? readWindowSelection() : {
        selectedSiteId: null,
        selectedAccountId: null
      };

      if (!cancelled) {
        setSelectedSiteId(browserSelection.selectedSiteId);
        setSelectedAccountId(browserSelection.selectedAccountId);
      }

      try {
        const persistedSelection = await getPersistedWindowSelection();
        if (!cancelled) {
          const mergedSelection = {
            selectedSiteId: persistedSelection.selectedSiteId ?? browserSelection.selectedSiteId,
            selectedAccountId: persistedSelection.selectedAccountId ?? browserSelection.selectedAccountId
          };
          lastPersistedSelectionKeyRef.current = JSON.stringify({
            ...mergedSelection,
            selectionSyncNonce: 0
          });
          setSelectedSiteId(mergedSelection.selectedSiteId);
          setSelectedAccountId(mergedSelection.selectedAccountId);
        }
      } catch {
        // 恢复失败时继续使用浏览器本地缓存或后续总览默认选择。
        if (!cancelled) {
          lastPersistedSelectionKeyRef.current = JSON.stringify({
            ...browserSelection,
            selectionSyncNonce: 0
          });
        }
      } finally {
        if (!cancelled) {
          setSelectionBootstrapDone(true);
          void loadOverview({ source: "shell" });
        }
      }
    };

    void hydrateSelectionAndLoadOverview();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (nav !== "settings") {
      return;
    }
    const timerId = window.setTimeout(() => {
      void loadOverview({ source: "full" });
    }, 700);
    return () => window.clearTimeout(timerId);
  }, [loadOverview, nav]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().listen<string>("open-nav", (event) => {
      if (!disposed) {
        setNav(event.payload as NavKey);
      }
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [setNav]);

  useEffect(() => {
    if (!selectionBootstrapDone) {
      return;
    }
    const nextSelectionKey = JSON.stringify({
      selectedSiteId,
      selectedAccountId,
      selectionSyncNonce
    });
    if (
      lastPersistedSelectionKeyRef.current === nextSelectionKey
      || lastQueuedSelectionKeyRef.current === nextSelectionKey
    ) {
      return;
    }
    lastQueuedSelectionKeyRef.current = nextSelectionKey;
    const selection: WindowSelectionState = {
      selectedSiteId,
      selectedAccountId
    };
    if (!isTauriRuntime()) {
      writeWindowSelection(selection);
      void updatePersistedWindowSelection(selection).catch((cause) => {
        console.error("写入窗口选择失败", cause);
      });
      return;
    }

    selectionSyncQueueRef.current ??= createWindowSelectionSyncQueue({
      persist: updatePersistedWindowSelection,
      broadcast: (payload) => emitTo("floating-panel", "floating-panel-selection-sync", payload),
      reportError: (stage, cause) => {
        console.error(`${stage === "persist" ? "写入" : "广播"}窗口选择失败`, cause);
      }
    });
    void selectionSyncQueueRef.current.enqueue(selection).then((outcome) => {
      if (outcome.persisted) {
        lastPersistedSelectionKeyRef.current = nextSelectionKey;
      }
      if (lastQueuedSelectionKeyRef.current === nextSelectionKey) {
        lastQueuedSelectionKeyRef.current = null;
      }
    });
  }, [selectedSiteId, selectedAccountId, selectionBootstrapDone, selectionSyncNonce]);

  useEffect(() => {
    if (nav === "sites" || nav === "accounts") {
      setNav("systemSettings");
    }
  }, [nav, setNav]);

  useEffect(() => {
    if (nav === pageMotionNav) {
      return;
    }
    setPageMotionNav(nav);
    setPageMotionPhase("enter");
    const timerId = window.setTimeout(() => {
      setPageMotionPhase("idle");
    }, 340);
    return () => window.clearTimeout(timerId);
  }, [nav, pageMotionNav]);

  useEffect(() => {
    if (nav !== "profile") {
      return;
    }
    setProfileWorkspaceRequested(true);
    profileWorkspace.openProfileModal();
    setNav("overview");
  }, [nav, setNav, profileWorkspace]);

  useEffect(() => {
    if (selectedAccountId) {
      return;
    }
    setProfileWorkspaceRequested(false);
    setAccountSyncStatuses([]);
  }, [selectedAccountId]);

  const refreshedFullSyncRunRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedAccountId) {
      return;
    }
    let cancelled = false;
    let timerId: number | null = null;
    let retriedInitialIdle = false;

    const loadSyncStatus = async () => {
      try {
        const payload = await getAccountSyncStatus(selectedAccountId);
        if (cancelled) {
          return;
        }
        setAccountSyncStatuses(payload.statuses);
        const isRunning = payload.statuses.some((item) => item.state === "running");
        if (isRunning) {
          timerId = window.setTimeout(() => {
            void loadSyncStatus();
          }, 1000);
        } else if (!retriedInitialIdle) {
          retriedInitialIdle = true;
          timerId = window.setTimeout(() => {
            void loadSyncStatus();
          }, 350);
        }
      } catch {
        if (!cancelled) {
          setAccountSyncStatuses([]);
        }
      }
    };

    void loadSyncStatus();
    return () => {
      cancelled = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [selectedAccountId, selectionSyncNonce, overview?.generatedAt]);

  useEffect(() => {
    if (!selectedAccountId) {
      refreshedFullSyncRunRef.current = null;
      return;
    }
    const fullStatus = accountSyncStatuses.find(
      (status) => status.accountId === selectedAccountId && status.scope === "full"
    );
    if (fullStatus?.state !== "succeeded") {
      return;
    }
    const runKey = [
      selectedAccountId,
      fullStatus.lastSuccessAt ?? fullStatus.lastAttemptAt ?? "unknown",
      fullStatus.itemCount
    ].join(":");
    if (refreshedFullSyncRunRef.current === runKey) {
      return;
    }
    refreshedFullSyncRunRef.current = runKey;
    invalidateUsageAccount(selectedAccountId);
    void Promise.all([
      loadOverview({ source: nav === "overview" ? "shell" : "full" }),
      accountDataWorkspace.refreshAccountData({ force: true }),
      refreshUsageWorkspaceSilently({ mode: "background" })
    ]).catch((cause) => {
      if (selectedAccountIdRef.current === selectedAccountId) {
        setError((cause as Error).message);
      }
    });
  }, [
    accountDataWorkspace,
    accountSyncStatuses,
    invalidateUsageAccount,
    loadOverview,
    nav,
    refreshUsageWorkspaceSilently,
    selectedAccountId,
    setError
  ]);

  const resolvedOverviewSelection = useMemo(
    () => resolveOverviewSelection({ accounts, sites, selectedAccountId, selectedSiteId }),
    [accounts, sites, selectedAccountId, selectedSiteId]
  );
  const selectedAccount = useMemo(() => {
    return accounts.find((item) => item.id === resolvedOverviewSelection.selectedAccountId) ?? null;
  }, [accounts, resolvedOverviewSelection.selectedAccountId]);
  const previousAccountSyncStatusesRef = useRef<AccountSyncStatusRecord[]>([]);

  useEffect(() => {
    if (!selectedAccount) {
      previousAccountSyncStatusesRef.current = [];
      return;
    }

    const previousStatuses = previousAccountSyncStatusesRef.current;
    const now = new Date().toISOString();
    const upsertTask = (
      tasks: SyncTaskCenterTask[],
      task: SyncTaskCenterTask
    ) => [
      task,
      ...tasks.filter((existing) => existing.id !== task.id)
    ].slice(0, 12);

    setSyncTaskRecords((previousTasks) => {
      let nextTasks = previousTasks;
      for (const status of accountSyncStatuses) {
        if (status.accountId !== selectedAccount.id || status.state === "idle") {
          continue;
        }
        const state = status.state === "running" || status.state === "failed"
          ? status.state
          : "succeeded";
        const existing = previousTasks.find((task) => task.id === `${status.accountId}:${status.scope}`);
        const wasRunning = previousStatuses.some(
          (previousStatus) => previousStatus.accountId === status.accountId
            && previousStatus.scope === status.scope
            && previousStatus.state === "running"
        );
        const isCachedUsageSnapshot = accountSyncStatuses.length === 1 && status.scope === "usage";
        if (state === "succeeded" && !existing && !wasRunning && isCachedUsageSnapshot) {
          continue;
        }
        nextTasks = upsertTask(nextTasks, {
          id: `${status.accountId}:${status.scope}`,
          accountId: status.accountId,
          accountLabel: selectedAccount.label || "未命名账号",
          scope: status.scope,
          state,
          startedAt: status.lastAttemptAt ?? existing?.startedAt ?? now,
          finishedAt: state === "running" ? null : status.lastSuccessAt ?? now,
          itemCount: status.itemCount,
          error: status.lastError,
          progress: status.progress
        });
      }

      return nextTasks;
    });

    if (accountSyncStatuses.some((status) => status.state === "running")) {
      setSyncTaskCenterOpen(true);
    }
    previousAccountSyncStatusesRef.current = accountSyncStatuses;
  }, [accountSyncStatuses, selectedAccount]);
  const readyOverviewAccountIds = useMemo(
    () => accounts
      .filter((account) => account.sessionState === "ready")
      .map((account) => account.id)
      .sort(),
    [accounts]
  );
  const selectedSite =
    sites.find((item) => item.id === selectedSiteId) ??
    (selectedAccount ? sites.find((item) => item.id === selectedAccount.siteId) ?? null : null);
  const publicEndpointsWorkspace = usePublicEndpointsWorkspace({
    selectedSite,
    autoPingEnabled: serviceStatusAutoRefreshPolicy.enabled && pageVisible,
    refreshIntervalMs: serviceStatusRefreshIntervalSeconds * 1000
  });
  invalidatePublicEndpointsSiteRef.current = publicEndpointsWorkspace.invalidateSite;
  const currentAccountCache = selectedAccount?.cacheView ?? null;
  const selectedAccountBalance =
    accountDataWorkspace.profileRecord?.balance ?? currentAccountCache?.balance ?? null;
  const selectedAccountApiKeyStats = accountDataWorkspace.managedKeys
    ? {
        totalApiKeys: accountDataWorkspace.managedKeys.items.length,
        activeApiKeys: accountDataWorkspace.managedKeys.items.filter((item) => item.status === "active").length
      }
    : null;
  const overviewRealtimeScopeKey = overviewUsageStatsMode === "selected-account"
    ? buildOverviewRealtimeScopeKey({
        mode: "selected-account",
        accountId: selectedAccount?.sessionState === "ready" ? selectedAccount.id : null,
        startDate: overviewUsageInsightRange.startDate,
        endDate: overviewUsageInsightRange.endDate
      })
    : buildOverviewRealtimeScopeKey({
        mode: "all-accounts",
        readyAccountIds: readyOverviewAccountIds,
        startDate: overviewUsageInsightRange.startDate,
        endDate: overviewUsageInsightRange.endDate
      });
  const overviewAllAccountKeysScopeKey = overviewUsageStatsMode === "all-accounts"
    ? buildOverviewAllAccountKeysScopeKey(readyOverviewAccountIds)
    : null;
  const overviewRealtimeEntry = overviewRealtimeScopeKey
    ? overviewRealtimeCache.peek(overviewRealtimeScopeKey)
    : null;
  const overviewAllAccountKeysEntry = overviewAllAccountKeysScopeKey
    ? overviewAllAccountKeysCache.peek(overviewAllAccountKeysScopeKey)
    : null;
  const overviewRealtimeSnapshot = overviewRealtimeEntry?.data ?? EMPTY_OVERVIEW_REALTIME_SNAPSHOT;
  const overviewDirectUsageStats = overviewRealtimeSnapshot.usageStats;
  const overviewDashboardTotalStats = overviewRealtimeSnapshot.totalUsageStats;
  const overviewDashboardPlatformSeries = overviewRealtimeSnapshot.platformSeries;
  const overviewDashboardTrendPoints = overviewRealtimeSnapshot.trendPoints;
  const overviewDashboardModelSeries = overviewRealtimeSnapshot.modelSeries;
  const overviewUsageInsights = overviewRealtimeSnapshot.usageInsights;
  const overviewUsageStatsRows = overviewRealtimeSnapshot.usageStatsRows;
  const overviewAllAccountKeys = overviewAllAccountKeysEntry?.data ?? null;
  const overviewAllAccountKeysLoading = overviewAllAccountKeysEntry?.initialLoading ?? false;
  const overviewRealtimeChartsLoading = overviewRealtimeEntry?.initialLoading ?? false;
  const overviewRealtimeLastError = overviewRealtimeEntry?.error ?? null;
  const overviewAllAccountKeysLastError = overviewAllAccountKeysEntry?.error ?? null;

  useEffect(() => {
    const unsubscribeRealtime = overviewRealtimeCache.subscribe(() => {
      setOverviewScopeCacheRevision((value) => value + 1);
    });
    const unsubscribeAllKeys = overviewAllAccountKeysCache.subscribe(() => {
      setOverviewScopeCacheRevision((value) => value + 1);
    });
    return () => {
      unsubscribeRealtime();
      unsubscribeAllKeys();
    };
  }, [overviewAllAccountKeysCache, overviewRealtimeCache]);

  const loadOverviewDirectUsageStats = useStableCallback(async (options?: {
    allowUnfocusedInitialHydration?: boolean;
    force?: boolean;
    bypassHydration?: boolean;
  }) => {
    if (!options?.bypassHydration && !shouldHydrateOverviewRealtime({
      nav,
      pageVisible,
      windowFocused,
      allowUnfocusedInitialHydration: options?.allowUnfocusedInitialHydration
    })) {
      return;
    }
    const scopeKey = overviewRealtimeScopeKey;
    if (!scopeKey) {
      return;
    }

    const existing = overviewRealtimeCache.peek(scopeKey);
    if (
      !options?.force
      && existing.hasSnapshot
      && existing.updatedAt !== null
      && Date.now() - existing.updatedAt < OVERVIEW_REALTIME_REFRESH_MIN_INTERVAL_MS
    ) {
      return;
    }

    const mode = overviewUsageStatsMode;
    const range = { ...overviewUsageInsightRange };
    const account = selectedAccount;
    const readyAccounts = accounts.filter((item) => item.sessionState === "ready");
    await overviewRealtimeCache.load(
      scopeKey,
      async (): Promise<OverviewRealtimeSnapshot> => {
        if (mode === "selected-account") {
          if (!account || account.sessionState !== "ready") {
            throw new Error("当前没有可用账号可读取实时用量。");
          }
          const [payload, trendResult, modelResult, usageInsights] = await Promise.all([
            overviewUpstreamRequestExecutor.run(() => getOverviewDashboardStats(account.id)),
            overviewUpstreamRequestExecutor.run(() => getDashboardTrend(account.id, { days: 7, ...range })),
            overviewUpstreamRequestExecutor.run(() => getDashboardModels(account.id, { days: 7, ...range })),
            overviewUpstreamRequestExecutor.run(() => getUsageInsights(account.id, { days: 7, ...range }))
          ]);
          return {
            usageStats: payload.todayStats,
            totalUsageStats: payload.totalStats,
            platformSeries: payload.platformSeries,
            trendPoints: normalizeOverviewTrendPoints(trendResult),
            modelSeries: normalizeOverviewModelSeries(modelResult),
            usageInsights,
            usageStatsRows: [
              {
                accountId: account.id,
                label: account.label,
                siteName: account.site?.name ?? account.cacheView?.siteName ?? "未命名站点",
                stats: payload.todayStats,
                totalStats: payload.totalStats
              }
            ]
          };
        }

        if (readyAccounts.length === 0) {
          throw new Error("当前没有可用账号可聚合实时用量。");
        }
        const rows = await overviewUpstreamRequestExecutor.map(
          readyAccounts,
          async (readyAccount) => {
            const payload = await getOverviewDashboardStats(readyAccount.id);
            const trendResult = await getDashboardTrend(readyAccount.id, { days: 7, ...range });
            const modelResult = await getDashboardModels(readyAccount.id, { days: 7, ...range });
            const usageInsights = await getUsageInsights(readyAccount.id, { days: 7, ...range });
            return {
              accountId: readyAccount.id,
              label: readyAccount.label,
              siteName: readyAccount.site?.name ?? "未命名站点",
              stats: payload.todayStats,
              totalStats: payload.totalStats,
              platformSeries: payload.platformSeries,
              trendPoints: normalizeOverviewTrendPoints(trendResult) ?? [],
              modelSeries: normalizeOverviewModelSeries(modelResult) ?? [],
              usageInsights
            } satisfies OverviewDashboardRealtimeRow;
          }
        );
        return {
          usageStats: aggregateOverviewUsageStats(rows),
          totalUsageStats: aggregateOverviewTotalStats(rows),
          platformSeries: aggregateOverviewPlatformSeries(rows),
          trendPoints: aggregateOverviewTrendPoints(rows),
          modelSeries: aggregateOverviewModelSeries(rows),
          usageInsights: aggregateOverviewUsageInsights(rows.map((item) => item.usageInsights)),
          usageStatsRows: rows
        };
      },
      { force: options?.force }
    );
  });
  const loadOverviewAllAccountKeys = useStableCallback(async (options?: {
    allowUnfocusedInitialHydration?: boolean;
    force?: boolean;
    bypassHydration?: boolean;
  }) => {
    if (!options?.bypassHydration && !shouldHydrateOverviewRealtime({
      nav,
      pageVisible,
      windowFocused,
      allowUnfocusedInitialHydration: options?.allowUnfocusedInitialHydration
    })) {
      return;
    }
    const scopeKey = overviewAllAccountKeysScopeKey;
    if (!scopeKey) {
      return;
    }
    const existing = overviewAllAccountKeysCache.peek(scopeKey);
    if (
      !options?.force
      && existing.hasSnapshot
      && existing.updatedAt !== null
      && Date.now() - existing.updatedAt < OVERVIEW_ALL_ACCOUNT_KEYS_REFRESH_MIN_INTERVAL_MS
    ) {
      return;
    }
    const readyAccounts = accounts.filter((item) => item.sessionState === "ready");
    await overviewAllAccountKeysCache.load(
      scopeKey,
      async () => (await overviewUpstreamRequestExecutor.map(
        readyAccounts,
        (account) => loadAllOverviewManagedKeys(account)
      )).flat(),
      { force: options?.force }
    );
  });
  const loadOverviewForCurrentSurface = useStableCallback(async (options?: {
    busyText?: string;
    successMessage?: string;
  }) => {
    await loadOverview({
      ...options,
      source: nav === "overview" ? "shell" : "full"
    });
  });
  const retryOverviewForCurrentScope = useStableCallback(async () => {
    const refreshes: Array<Promise<unknown>> = [
      loadOverviewForCurrentSurface(),
      loadOverviewDirectUsageStats({ force: true, bypassHydration: true })
    ];
    if (overviewUsageStatsMode === "all-accounts") {
      refreshes.push(loadOverviewAllAccountKeys({ force: true, bypassHydration: true }));
    }
    await Promise.all(refreshes);
  });
  const settingsWorkspace = useSettingsWorkspace({
    sites
  });
  const currentAccountSubscriptions =
    accountDataWorkspace.subscriptions ?? currentAccountCache?.subscriptions ?? [];
  const subscriptionCount =
    accountDataWorkspace.subscriptionSummary?.activeCount ?? currentAccountSubscriptions.length ?? 0;
  const usageStatusLabel = accountDataWorkspace.subscriptionSummary
    ? `${subscriptionCount} 个有效订阅`
    : currentAccountCache?.activeSubscription?.status ?? (subscriptionCount > 0 ? "已同步订阅" : "等待同步");
  const mergedTopbarSubscriptions = buildTopbarSubscriptionPreviewRecords({
    overviewSubscriptions: [],
    fallbackSubscriptions: mergeSubscriptionRecords(
      currentAccountSubscriptions,
      accountDataWorkspace.subscriptionSummary
    ),
    fallbackAccountLabel: selectedAccount?.label ?? null,
    fallbackSiteName: selectedSite?.name ?? null
  });
  useEffect(() => {
    if (!selectedAccount) {
      return;
    }
    if (!shouldAutoRefreshSelectedAccountData({
      nav,
      autoRefreshEnabled: desktopUi.prefs.autoRefreshEnabled,
      pageVisible,
      selectedAccount,
      prefs: desktopUi.prefs
    })) {
      return;
    }
    if (!isAccountDataStaleForToday(selectedAccount.cacheView?.fetchedAt)) {
      return;
    }
    const scope = resolveAutoRefreshScope(nav);
    if (scope === "none" || scope === "usage") {
      return;
    }
    void accountWorkspace.handleRefreshAccount(selectedAccount.id, {
      silent: true,
      scope,
      triggerSource: "stale_auto"
    });
  }, [desktopUi.prefs, nav, pageVisible, selectedAccount]);

  useEffect(() => {
    const enteredServiceStatusPage = nav === "serviceStatus" && lastServiceStatusNavRef.current !== "serviceStatus";
    const openedServiceStatusDrawer = floatingRailServiceStatusOpen && !lastServiceStatusDrawerRef.current;
    const pageBecameVisible = pageVisible && !lastPageVisibleRef.current;

    lastServiceStatusNavRef.current = nav;
    lastServiceStatusDrawerRef.current = floatingRailServiceStatusOpen;
    lastPageVisibleRef.current = pageVisible;

    if (!serviceStatusAvailable || !pageVisible) {
      return;
    }
    if (
      enteredServiceStatusPage ||
      openedServiceStatusDrawer ||
      (pageBecameVisible && (nav === "serviceStatus" || floatingRailServiceStatusOpen))
    ) {
      void topbarServiceStatusWorkspace.refreshNow({
        mode: "foreground",
        notifyTransition: true
      }).catch(() => undefined);
    }
  }, [nav, pageVisible, serviceStatusAvailable, floatingRailServiceStatusOpen]);

  useEffect(() => {
    const fallbackAccountId = resolveSelectedSiteAccountFallback({
      selectedSiteId,
      selectedAccountId,
      accounts
    });
    if (fallbackAccountId !== selectedAccountId) {
      setSelectedAccountId(fallbackAccountId);
    }
  }, [selectedSiteId, selectedAccountId, accounts, setSelectedAccountId]);

  const getPagePreloadCoordinator = useStableCallback(() => {
    if (pagePreloadCoordinatorRef.current) {
      return pagePreloadCoordinatorRef.current;
    }

    const initialization = import("./page-preload-coordinator").then(
      ({ PagePreloadCoordinator }) => new PagePreloadCoordinator({ maxCompletedPages: 3 })
    );
    pagePreloadCoordinatorRef.current = initialization;
    void initialization.catch(() => {
      if (pagePreloadCoordinatorRef.current === initialization) {
        pagePreloadCoordinatorRef.current = null;
      }
    });
    return initialization;
  });

  const requestPagePreload = useStableCallback(async (
    target: PagePreloadTarget,
    source: "intent" | "navigate" | "idle",
    sourceNav?: NavKey
  ) => {
    if (
      source !== "navigate"
      && !shouldStartPagePreload(getPagePreloadEnvironment(pageVisible && windowFocused))
    ) {
      return;
    }

    const coordinator = await getPagePreloadCoordinator();
    await coordinator.enqueue(target, async () => {
      if (source === "idle" && pagePreloadNavRef.current !== sourceNav) {
        return "skipped";
      }

      const preloadData = () => {
        if (target === "usage" || target === "modelStats") {
          return preloadUsageSurface(target);
        }
        if (target === "keys") {
          return accountDataWorkspace.preloadResources({
            groups: true,
            managedKeys: true,
            subscriptions: true,
            subscriptionSummary: true,
            subscriptionSwitchRules: true
          });
        }
        if (target === "subscriptions") {
          return accountDataWorkspace.preloadResources({
            managedKeys: true,
            subscriptions: true,
            subscriptionSummary: true
          });
        }
        return Promise.resolve();
      };

      await Promise.all([preloadPageChunk(target), preloadData()]);
    }, source);
  });

  function schedulePagePreloadIntent(nextNav: NavKey) {
    if (!isPagePreloadTarget(nextNav)) {
      return;
    }
    if (!shouldStartPagePreload(getPagePreloadEnvironment(pageVisible && windowFocused))) {
      return;
    }
    if (typeof window === "undefined") {
      void requestPagePreload(nextNav, "intent", nav);
      return;
    }
    if (pagePreloadIntentTimerRef.current !== null) {
      window.clearTimeout(pagePreloadIntentTimerRef.current);
    }
    pagePreloadIntentTimerRef.current = window.setTimeout(() => {
      pagePreloadIntentTimerRef.current = null;
      void requestPagePreload(nextNav, "intent", nav);
    }, 120);
  }

  useEffect(() => {
    return () => {
      if (pagePreloadIntentTimerRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(pagePreloadIntentTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const candidate = getIdlePagePreloadCandidate(nav);
    if (
      !candidate
      || !shouldStartPagePreload(getPagePreloadEnvironment(pageVisible && windowFocused))
    ) {
      return;
    }
    return scheduleIdlePagePreload(() => {
      void requestPagePreload(candidate, "idle", nav);
    });
  }, [nav, pageVisible, windowFocused, requestPagePreload]);

  function handleActionKey(event: KeyboardEvent<HTMLElement>, action: () => void) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  }

  function handleNavChange(nextNav: NavKey) {
    if (nextNav === nav) {
      return;
    }
    if (isPagePreloadTarget(nextNav)) {
      void requestPagePreload(nextNav, "navigate", nav);
    }
    setNav(nextNav);
  }

  const openProfileModal = useStableCallback(() => {
    shellWorkspace.closeTopbarAccountMenu();
    setProfileWorkspaceRequested(true);
    profileWorkspace.openProfileModal();
  });

  const closeTopbarPeekPanels = useStableCallback(() => {
    shellWorkspace.closeTopbarPeekPanels();
  });

  function closeProfileModal() {
    setProfileWorkspaceRequested(false);
    profileWorkspace.closeProfileModal();
  }

  function handleTopbarAccountSelect(account: AccountRuntime) {
    setSelectedSiteId(account.siteId);
    setSelectedAccountId(account.id);
    shellWorkspace.closeTopbarAccountMenu();
  }

  function handleThemeChange(nextTheme: ThemeId) {
    setTheme(nextTheme);
    void desktopUi.patchPrefs({ theme: nextTheme });
  }

  async function handleClearRuntimeData(removeSitesAndAccounts: boolean) {
    setClearRuntimeDataLoading(true);
    setBusyText(removeSitesAndAccounts ? "正在清空本地数据、站点和账号..." : "正在清空本地运行数据...");
    setError(null);
    try {
      await clearRuntimeData(removeSitesAndAccounts);
      setSelectedSiteId(null);
      setSelectedAccountId(null);
      setAccountSyncStatuses([]);
      setProfileWorkspaceRequested(false);
      overviewRealtimeCache.clear();
      overviewAllAccountKeysCache.clear();
      if (removeSitesAndAccounts) {
        publicEndpointsWorkspace.invalidateAllSites();
      }
      replaceOverview({
        sites: [],
        accounts: [],
        totals: {
          balance: 0,
          totalSites: 0,
          totalAccounts: 0,
          totalApiKeys: 0,
          activeApiKeys: 0,
          todayRequests: 0,
          totalRequests: 0,
          todayActualCost: 0,
          totalActualCost: 0,
          todayTokens: 0,
          totalTokens: 0
        },
        alerts: [],
        platformSeries: [],
        modelSeries: [],
        trend: [],
        recentUsage: [],
        subscriptions: [],
        keys: [],
        generatedAt: new Date().toISOString()
      });
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(OVERVIEW_USAGE_STATS_MODE_KEY);
        window.localStorage.removeItem("input-panel.window-selection");
      }
      setNav("systemSettings");
      pushToast({
        tone: "info",
        message: removeSitesAndAccounts ? "本地数据、站点和账号已清空" : "本地运行数据已清空"
      });
      await loadOverviewForCurrentSurface();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
      setClearRuntimeDataLoading(false);
    }
  }

  async function refreshSelectedAccountDataSilently(
    accountId: string,
    scope: DataSyncScope,
    triggerSource: "manual" | "stale_auto"
  ) {
    const syncStatus = await syncAccountData(accountId, {
      scope,
      triggerSource
    });
    if (selectedAccountIdRef.current === accountId) {
      setAccountSyncStatuses(syncStatus.statuses);
    }
    await Promise.all([
      loadOverviewForCurrentSurface(),
      accountDataWorkspace.refreshAccountData()
    ]);
  }

  async function refreshOverviewSilently(triggerSource: "manual" | "stale_auto") {
    const forceRealtime = triggerSource === "manual";
    if (overviewUsageStatsMode === "all-accounts") {
      if (triggerSource === "stale_auto") {
        await Promise.all([
          loadOverviewForCurrentSurface(),
          accountDataWorkspace.refreshAccountData(),
          loadOverviewDirectUsageStats({ force: forceRealtime, bypassHydration: true }),
          loadOverviewAllAccountKeys({ force: forceRealtime, bypassHydration: true })
        ]);
        return;
      }
      await syncAllAccounts("core", triggerSource);
      await Promise.all([
        loadOverviewForCurrentSurface(),
        accountDataWorkspace.refreshAccountData(),
        loadOverviewDirectUsageStats({ force: true, bypassHydration: true }),
        loadOverviewAllAccountKeys({ force: true, bypassHydration: true })
      ]);
      return;
    }
    if (selectedAccount) {
      if (triggerSource === "stale_auto") {
        await Promise.all([
          loadOverviewForCurrentSurface(),
          accountDataWorkspace.refreshAccountData(),
          loadOverviewDirectUsageStats({ force: forceRealtime, bypassHydration: true })
        ]);
        return;
      }
      await refreshSelectedAccountDataSilently(selectedAccount.id, "full", triggerSource);
      await loadOverviewDirectUsageStats({ force: true, bypassHydration: true });
    }
  }

  const refreshOverviewSnapshotSilently = useStableCallback(async (): Promise<WarmupTaskResult> => {
    const refreshed = await loadOverview({
      source: nav === "overview" ? "shell" : "full",
      silent: true
    });
    return refreshed ? "success" : "cancelled";
  });

  const runWarmupTask = useStableCallback(async (resource: WarmupResourceKey) => {
    switch (resource) {
      case "overview":
        return await refreshOverviewSnapshotSilently();
      case "subscriptions": {
        const result = await accountDataWorkspace.refreshResources(
          {
            subscriptionSummary: true
          },
          {
            clearError: false,
            mode: "background"
          }
        );
        return result.status === "cancelled" ? "cancelled" : "success";
      }
      case "keys": {
        const result = await accountDataWorkspace.refreshResources(
          {
            groups: true,
            managedKeys: true,
            profileRecord: true
          },
          {
            clearError: false,
            mode: "background"
          }
        );
        return result.status === "cancelled" ? "cancelled" : "success";
      }
      case "usage":
        return await refreshUsageSurfaceSilently("usage", { mode: "background" });
      case "modelStats":
        return await refreshUsageSurfaceSilently("modelStats", { mode: "background" });
      case "keyUsage":
        return await refreshUsageSurfaceSilently("keyUsage", { mode: "background" });
      case "serviceStatus":
        return await topbarServiceStatusWorkspace.refreshNow({
          mode: "background",
          notifyTransition: true
        });
      case "settings":
      default:
        return "cancelled";
    }
  });

  const refreshCurrentWarmPage = useStableCallback(async (resource: WarmupResourceKey) => {
    switch (resource) {
      case "overview":
        await refreshOverviewSilently("stale_auto");
        return;
      case "subscriptions":
        if (selectedAccount) {
          await refreshSelectedAccountDataSilently(selectedAccount.id, "full", "stale_auto");
        }
        return;
      case "keys":
        if (selectedAccount) {
          await refreshSelectedAccountDataSilently(selectedAccount.id, "keys", "stale_auto");
        }
        return;
      case "usage":
        await refreshUsageWorkspaceSilently({ mode: "foreground" });
        return;
      case "modelStats":
        await refreshUsageSurfaceSilently("modelStats", { mode: "background" });
        return;
      case "keyUsage":
        await refreshUsageSurfaceSilently("keyUsage", { mode: "background" });
        return;
      case "serviceStatus":
        await topbarServiceStatusWorkspace.refreshNow({ mode: "background", notifyTransition: true });
        return;
      case "settings":
      default:
        return;
    }
  });

  const refreshCurrentPageForManualReload = useStableCallback(async (resource: WarmupResourceKey | null) => {
    switch (resource) {
      case "overview":
        if (selectedAccount) {
          await refreshOverviewSilently("manual");
          return;
        }
        break;
      case "subscriptions":
      case "settings":
        if (selectedAccount) {
          await refreshSelectedAccountDataSilently(selectedAccount.id, "full", "manual");
          return;
        }
        break;
      case "keys":
        if (selectedAccount) {
          await refreshSelectedAccountDataSilently(selectedAccount.id, "keys", "manual");
          return;
        }
        break;
      case "usage":
        if (selectedAccount) {
          await refreshUsageWorkspaceSilently({ mode: "foreground" });
          return;
        }
        break;
      case "modelStats":
        if (selectedAccount) {
          await refreshUsageSurfaceSilently("modelStats", { mode: "foreground" });
          return;
        }
        break;
      case "keyUsage":
        if (selectedAccount) {
          await refreshUsageSurfaceSilently("keyUsage", { mode: "foreground" });
          return;
        }
        break;
      case "serviceStatus":
        await topbarServiceStatusWorkspace.refreshNow({
          mode: "foreground",
          source: "topbar",
          notifyTransition: true
        });
        return;
      case null:
      default:
        break;
    }

    await loadOverviewForCurrentSurface();
  });

  const warmRemainingResourcesAfterManualReload = useStableCallback(async (resource: WarmupResourceKey | null) => {
    const selectedAccountReady = Boolean(selectedAccount);
    const currentPageAlreadyReloadedOverview =
      resource === null
      || resource === "overview"
      || resource === "subscriptions"
      || resource === "keys"
      || resource === "settings";
    const currentPageAlreadyReloadedAccountData =
      resource === "overview"
      || resource === "subscriptions"
      || resource === "keys"
      || resource === "settings";
    const backgroundTasks: Promise<unknown>[] = [];

    if (!currentPageAlreadyReloadedOverview) {
      backgroundTasks.push(refreshOverviewSnapshotSilently());
    }

    if (selectedAccountReady && !currentPageAlreadyReloadedAccountData) {
      backgroundTasks.push(
        accountDataWorkspace.refreshResources(
          {
            groups: true,
            managedKeys: true,
            subscriptionSummary: true,
            profileRecord: true
          },
          {
            clearError: false,
            mode: "background"
          }
        )
      );
    }

    if (selectedAccountReady && resource !== "usage") {
      backgroundTasks.push(
        refreshUsageSurfaceSilently("usage", {
          forceFullUsageSurface: true,
          mode: "background"
        })
      );
    }

    if (resource !== "serviceStatus") {
      backgroundTasks.push(topbarServiceStatusWorkspace.refreshNow({
        mode: "background",
        notifyTransition: true
      }));
    }

    await Promise.allSettled(backgroundTasks);

    if (selectedAccountReady && resource !== "keyUsage") {
      await Promise.allSettled([refreshUsageSurfaceSilently("keyUsage", { mode: "background" })]);
    }
  });

  const handleTopbarReload = useStableCallback(async () => {
    if (topbarReloadRunningRef.current) {
      return;
    }

    topbarReloadRunningRef.current = true;
    setTopbarReloadRefreshing(true);
    const currentResource = selectedAccount
      ? nav === "trends"
        ? "usage"
        : getWarmupResourceForNav(nav)
      : null;

    try {
      await refreshCurrentPageForManualReload(currentResource);
      void warmRemainingResourcesAfterManualReload(currentResource);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      topbarReloadRunningRef.current = false;
      setTopbarReloadRefreshing(false);
    }
  });

  useBackgroundWarmup({
    environment: {
      nav,
      isAppFocused: pageVisible && windowFocused,
      overviewReady: Boolean(overview) && !loading,
      selectedAccountId,
      selectedAccountReady: selectedAccount?.sessionState === "ready",
      groupPolicies: {
        core: resolveAutoRefreshGroupPolicy(desktopUi.prefs, "core"),
        keys: resolveAutoRefreshGroupPolicy(desktopUi.prefs, "keys"),
        usage: resolveAutoRefreshGroupPolicy(desktopUi.prefs, "usage")
      },
      serviceStatusPolicy: serviceStatusAutoRefreshPolicy
    },
    tasks: {
      overview: {
        key: "overview",
        run: () => runWarmupTask("overview")
      },
      subscriptions: {
        key: "subscriptions",
        run: () => runWarmupTask("subscriptions")
      },
      keys: {
        key: "keys",
        run: () => runWarmupTask("keys")
      },
      usage: {
        key: "usage",
        run: () => runWarmupTask("usage")
      },
      modelStats: {
        key: "modelStats",
        run: () => runWarmupTask("modelStats")
      },
      keyUsage: {
        key: "keyUsage",
        run: () => runWarmupTask("keyUsage")
      },
      serviceStatus: {
        key: "serviceStatus",
        run: () => runWarmupTask("serviceStatus")
      }
    },
    onForegroundRefresh: (resource) => refreshCurrentWarmPage(resource)
  });

  const workspaceSubtitle = nav === "codexRadar"
    ? "授权数据源的最新模型 IQ 测评快照"
    : nav === "serviceStatus"
    ? hasAnyAccount
      ? "这里会持续显示当前服务是否可用, 方便你随时查看变化"
      : "这里会显示公共服务状态, 无需配置账号也可手动查看"
    : selectedSite
      ? `${selectedSite.name} / ${selectedAccount?.label ?? "未选择账号"}`
      : "先添加站点和账号, 再开始使用";

  const workspaceSummaryTexts = buildWorkspaceSummaryTexts({
    overview,
    accounts,
    usageStats: overviewDirectUsageStats,
    syncStatuses: accountSyncStatuses
  });
  const workspaceSummary = (
    <>
      {workspaceSummaryTexts.map((item) =>
        "segments" in item ? (
          <span key={item.key} className="workspace-summary-pill workspace-summary-pill-token-group">
            {item.segments.map((segment) => (
              <span key={segment.key} className="workspace-summary-token-tag">
                <strong>{segment.label}</strong>
                <span>{segment.value}</span>
              </span>
            ))}
          </span>
        ) : (
          <span key={item.key} className="workspace-summary-pill">{item.label}</span>
        )
      )}
    </>
  );
  const accountWorkspaceModalOpen =
    accountWorkspace.siteFormOpen
    || accountWorkspace.accountFormOpen
    || accountWorkspace.accountManagerOpen
    || Boolean(accountWorkspace.loginModal);

  const pageContent = (
    <div className={`page-stack page-stack-${nav}`}>
      {nav === "overview" && overview && (
        <OverviewPage
          overview={overview}
          currentAccount={selectedAccount}
          currentAccountBalance={selectedAccountBalance}
          currentAccountStats={currentAccountCache?.stats ?? null}
          currentAccountSubscriptions={currentAccountSubscriptions}
          subscriptionSummary={accountDataWorkspace.subscriptionSummary}
          currentAccountKeys={
            accountDataWorkspace.managedKeys
            && accountDataWorkspace.managedKeys.items.length === accountDataWorkspace.managedKeys.total
              ? accountDataWorkspace.managedKeys.items
              : null
          }
          allAccountKeys={overviewAllAccountKeys}
          allAccountKeysLoading={overviewAllAccountKeysLoading}
          currentAccountRecentUsage={currentAccountCache?.recentUsage ?? []}
          usageStats={overviewDirectUsageStats}
          totalUsageStats={overviewDashboardTotalStats}
          platformSeries={overviewDashboardPlatformSeries}
          trendPoints={overviewDashboardTrendPoints}
          modelSeries={overviewDashboardModelSeries}
          usageInsightRange={overviewUsageInsightRange}
          onUsageInsightRangeChange={(range) => {
            if (range.startDate && range.endDate && range.startDate <= range.endDate) {
              setOverviewUsageInsightRange(range);
            }
          }}
          usageInsights={overviewUsageInsights}
          overviewRealtimeChartsLoading={overviewRealtimeChartsLoading}
          usageStatsMode={overviewUsageStatsMode}
          onUsageStatsModeChange={setOverviewUsageStatsMode}
          usageStatsRows={overviewUsageStatsRows}
        />
      )}
      {nav === "serviceStatus" && (
        <RetryableLazyPage
          page="serviceStatus"
          loader={loadServiceStatusPage}
          render={(ServiceStatusPage) => (
            <ServiceStatusPage
              workspace={topbarServiceStatusWorkspace}
            />
          )}
        />
      )}
      {nav === "codexRadar" && (
        <Suspense fallback={renderDeferredPageFallback()}>
          <CodexRadarPage
            payload={codexRadarWorkspace.payload}
            presentation={codexRadarWorkspace.presentation}
            onRefresh={codexRadarWorkspace.refresh}
            intelligencePayload={codexRadarIntelligenceWorkspace.payload}
            intelligencePresentation={codexRadarIntelligenceWorkspace.presentation}
            onRefreshIntelligence={codexRadarIntelligenceWorkspace.refresh}
            fastPayload={codexRadarFastWorkspace.payload}
            fastPresentation={codexRadarFastWorkspace.presentation}
            onRefreshFast={codexRadarFastWorkspace.refresh}
          />
        </Suspense>
      )}
      {nav === "settings" && (
        <Suspense fallback={renderDeferredPageFallback()}>
          <SettingsPage
            siteSearch={settingsWorkspace.siteSearch}
            onSiteSearchChange={settingsWorkspace.setSiteSearch}
            filteredSites={settingsWorkspace.filteredSites}
            accounts={accounts}
            selectedSite={selectedSite}
            selectedAccountId={selectedAccountId}
            currentAccountBalance={selectedAccountBalance}
            currentAccountTotalKeys={selectedAccountApiKeyStats?.totalApiKeys ?? currentAccountCache?.stats.totalApiKeys ?? 0}
            currentAccountActiveKeys={selectedAccountApiKeyStats?.activeApiKeys ?? currentAccountCache?.stats.activeApiKeys ?? 0}
            currentAccountSubscriptions={currentAccountSubscriptions}
            currentAccountSyncStatuses={accountSyncStatuses}
            onOpenNewSite={accountWorkspace.openNewSite}
            onSelectSite={setSelectedSiteId}
            onOpenSiteAccountManager={accountWorkspace.openSiteAccountManager}
            onOpenEditSite={accountWorkspace.openEditSite}
            onRemoveSite={(siteId) => void accountWorkspace.handleRemoveSite(siteId)}
            onOpenNewAccount={accountWorkspace.openNewAccount}
            onSelectAccount={(account) => {
              setSelectedSiteId(account.siteId);
              setSelectedAccountId(account.id);
            }}
            onEditAccount={accountWorkspace.openEditAccount}
            onRemoveAccount={(accountId) => void accountWorkspace.handleRemoveAccount(accountId)}
            handleActionKey={handleActionKey}
          />
        </Suspense>
      )}
      {nav === "keys" && (
        <RetryableLazyPage
          page="keys"
          loader={loadKeysPage}
          render={(KeysPage) => {
            if (shouldRenderColdPageState(keysPageDataState, Boolean(selectedAccountId))) {
              return (
                <WorkspaceLoadingState
                  page="keys"
                  error={keysPageDataState.lastError}
                  onRetry={() => {
                    void accountDataWorkspace.refreshResources(
                      {
                        groups: true,
                        managedKeys: true,
                        subscriptions: true,
                        subscriptionSummary: true,
                        subscriptionSwitchRules: true
                      },
                      { force: true, mode: "background" }
                    ).catch(() => undefined);
                  }}
                />
              );
            }

            return (
              <KeysPage
                managedKeys={accountDataWorkspace.managedKeys}
                groups={accountDataWorkspace.groups}
                subscriptions={currentAccountSubscriptions}
                subscriptionSummary={accountDataWorkspace.subscriptionSummary}
                subscriptionSwitchRules={accountDataWorkspace.subscriptionSwitchRules}
                profileRecord={accountDataWorkspace.profileRecord}
                selectedAccountId={selectedAccountId}
                selectedSiteBaseUrl={selectedSite?.baseUrl ?? null}
                selectedSiteName={selectedSite?.name ?? null}
                onRefresh={() => {
                  if (selectedAccountId) {
                    void accountDataWorkspace.refreshAccountData();
                    void loadOverviewForCurrentSurface();
                  }
                }}
                onError={setError}
                onBusy={setBusyText}
                onRefreshSubscriptionChain={async () => {
                  await accountDataWorkspace.refreshResources({
                    groups: true,
                    managedKeys: true,
                    subscriptions: true,
                    subscriptionSummary: true,
                    subscriptionSwitchRules: true
                  });
                }}
              />
            );
          }}
        />
      )}
      {nav === "usage" && (
        <RetryableLazyPage
          page="usage"
          loader={loadUsagePage}
          render={(UsagePage) => {
            if (shouldRenderColdPageState(presentation, Boolean(selectedAccountId))) {
              return (
                <WorkspaceLoadingState
                  page="usage"
                  error={presentation.lastError}
                  onRetry={() => {
                    void refreshUsageWorkspaceSilently({ mode: "background" }).catch(() => undefined);
                  }}
                />
              );
            }

            return (
              <UsagePage
                managedKeys={accountDataWorkspace.managedKeys}
                usageApiKeyFilter={usageApiKeyFilter}
                setUsageApiKeyFilter={setUsageApiKeyFilter}
                usageModelFilter={usageModelFilter}
                setUsageModelFilter={setUsageModelFilter}
                usageGroupFilter={usageGroupFilter}
                setUsageGroupFilter={setUsageGroupFilter}
                usageSubscriptionFilter={usageSubscriptionFilter}
                setUsageSubscriptionFilter={setUsageSubscriptionFilter}
                usagePlatformFilter={usagePlatformFilter}
                setUsagePlatformFilter={setUsagePlatformFilter}
                usageReasoningEffortFilter={usageReasoningEffortFilter}
                setUsageReasoningEffortFilter={setUsageReasoningEffortFilter}
                usageRequestTypeFilter={usageRequestTypeFilter}
                setUsageRequestTypeFilter={setUsageRequestTypeFilter}
                usageBillingTypeFilter={usageBillingTypeFilter}
                setUsageBillingTypeFilter={setUsageBillingTypeFilter}
                usageBillingModeFilter={usageBillingModeFilter}
                setUsageBillingModeFilter={setUsageBillingModeFilter}
                usageRangePickerRef={usageRangePickerRef}
                usageRangePickerOpen={usageRangePickerOpen}
                toggleUsageRangePicker={toggleUsageRangePicker}
                usageRangeLabel={usageRangeLabel}
                usageRangePreset={usageRangePreset}
                applyUsagePreset={applyUsagePreset}
                usageDraftRange={usageDraftRange}
                setUsageDraftRange={setUsageDraftRange}
                applyUsageRange={applyUsageRange}
                usageStats={usageStats}
                usageExtremes={usageExtremes}
                usageModelSummaries={usageModelSummaries}
                usageModelSummariesLoading={usageModelSummariesLoading}
                usageRecords={usageRecords}
                usagePageSize={usagePageSize}
                usagePageSizeOptions={usagePageSizeOptions}
                handleUsageSearch={handleUsageSearch}
                handleUsagePageChange={handleUsagePageChange}
                handleUsagePageSizeChange={handleUsagePageSizeChange}
                usageTrend={usageTrend}
                usageModels={usageModels}
              />
            );
          }}
        />
      )}
      {nav === "modelStats" && (
        <RetryableLazyPage
          page="modelStats"
          loader={loadModelStatsPage}
          render={(ModelStatsPage) => {
            if (shouldRenderColdPageState(presentation, Boolean(selectedAccountId))) {
              return (
                <WorkspaceLoadingState
                  page="modelStats"
                  error={presentation.lastError}
                  onRetry={() => {
                    void refreshUsageSurfaceSilently("modelStats", { mode: "background" }).catch(() => undefined);
                  }}
                />
              );
            }

            return (
              <ModelStatsPage
                managedKeys={accountDataWorkspace.managedKeys}
                usageApiKeyFilter={usageApiKeyFilter}
                setUsageApiKeyFilter={setUsageApiKeyFilter}
                usageRangePickerRef={usageRangePickerRef}
                usageRangePickerOpen={usageRangePickerOpen}
                toggleUsageRangePicker={toggleUsageRangePicker}
                usageRangeLabel={usageRangeLabel}
                usageRangePreset={usageRangePreset}
                applyUsagePreset={applyUsagePreset}
                usageDraftRange={usageDraftRange}
                setUsageDraftRange={setUsageDraftRange}
                applyUsageRange={applyUsageRange}
                usageModels={usageModels}
                loading={usageModelSummariesLoading}
                onRefresh={handleUsageSearch}
              />
            );
          }}
        />
      )}
      {nav === "subscriptions" && (
        <RetryableLazyPage
          page="subscriptions"
          loader={loadSubscriptionsPage}
          render={(SubscriptionsPage) => {
            if (shouldRenderColdPageState(subscriptionsPageDataState, Boolean(selectedAccountId))) {
              return (
                <WorkspaceLoadingState
                  page="subscriptions"
                  error={subscriptionsPageDataState.lastError}
                  onRetry={() => {
                    void accountDataWorkspace.refreshResources(
                      {
                        managedKeys: true,
                        subscriptions: true,
                        subscriptionSummary: true
                      },
                      { force: true, mode: "background" }
                    ).catch(() => undefined);
                  }}
                />
              );
            }

            return (
              <SubscriptionsPage
                subscriptions={currentAccountSubscriptions}
                subscriptionSummary={accountDataWorkspace.subscriptionSummary}
                selectedAccountId={selectedAccountId}
                managedKeys={accountDataWorkspace.managedKeys?.items ?? []}
              />
            );
          }}
        />
      )}
      {nav === "keyUsage" && (
        <Suspense fallback={renderDeferredPageFallback()}>
          <KeyUsagePage
            keyUsageRows={keyUsageRows}
            keyUsageKeyId={keyUsageKeyId}
            managedKeys={accountDataWorkspace.managedKeys}
            loading={keyUsagePresentation.initialLoading}
            refreshing={keyUsagePresentation.refreshing}
            lastError={keyUsagePresentation.lastError}
            onRetry={() => void retryKeyUsage()}
            onLoadKeyUsage={(keyId) => void loadKeyUsage(keyId)}
          />
        </Suspense>
      )}
      {nav === "trends" && (
        <Suspense
          fallback={renderDeferredPageFallback()}
        >
          <AnalyticsLab
            overview={overview}
            selectedAccount={selectedAccount}
            loading={usageModelSummariesLoading}
            managedKeys={accountDataWorkspace.managedKeys}
            usageStats={usageStats}
            usageTrend={usageTrend}
            usageModels={usageModels}
            usageRecords={usageRecords}
            usageScopeRows={usageScopeRows}
            usageScopeMeta={usageScopeMeta}
            subscriptionSummary={accountDataWorkspace.subscriptionSummary}
            profileRecord={accountDataWorkspace.profileRecord}
            platformQuotas={accountDataWorkspace.platformQuotas}
            keyUsageRows={keyUsageRows}
            keyUsageKeyId={keyUsageKeyId}
            usageApiKeyFilter={usageApiKeyFilter}
            usageStartDate={usageStartDate}
            usageEndDate={usageEndDate}
            onUsageApiKeyFilterChange={setUsageApiKeyFilter}
            onUsageStartDateChange={setUsageStartDate}
            onUsageEndDateChange={setUsageEndDate}
            onUsageSearch={() => void handleUsageSearch()}
            onKeyUsageSelect={(keyId) => void loadKeyUsage(keyId)}
          />
        </Suspense>
      )}
      {nav === "alerts" && (
        <Suspense fallback={renderDeferredPageFallback()}>
          <AlertsPage alerts={overview?.alerts ?? []} />
        </Suspense>
      )}
      {nav === "systemSettings" && (
        <RetryableLazyPage
          page="systemSettings"
          loader={loadSystemSettingsPage}
          render={(SystemSettingsPage) => (
            <SystemSettingsPage
              theme={theme}
              setTheme={handleThemeChange}
              desktopUiPrefs={desktopUi.prefs}
              desktopUiLoading={desktopUi.loading}
              desktopUiSaveState={desktopUi.saveState}
              desktopUiLoadError={desktopUi.loadError}
              onRetryDesktopUiPrefs={desktopUi.retryFailedPrefs}
              nativeWindowControlsAvailable={isTauriRuntime()}
              onLaunchModeChange={(value) => void desktopUi.handleSwitchMode(value)}
              onFloatingVisibleChange={(value) => void desktopUi.handleFloatingVisible(value)}
              onFloatingPanelPinnedChange={(value) => void desktopUi.patchPrefs({ keepFloatingPanelVisible: value })}
              onFloatingPanelOpacityChange={(value) =>
                void desktopUi.patchPrefs({
                  floatingPanelOpacity: value
                }, { debounce: true })
              }
              onFloatingNotificationDurationMsChange={(value) =>
                void desktopUi.patchPrefs({
                  floatingNotificationDurationMs: value
                }, { debounce: true })
              }
              onFloatingNotificationDensityChange={(value) =>
                void desktopUi.patchPrefs({
                  floatingNotificationDensity: value
                })
              }
              onFloatingNotificationMaxVisibleChange={(value) =>
                void desktopUi.patchPrefs({
                  floatingNotificationMaxVisible: value
                }, { debounce: true })
              }
              onCloseBehaviorChange={(value) => void desktopUi.handleRememberCloseBehavior(value)}
              onAutoRefreshEnabledChange={(value) => void desktopUi.patchPrefs({ autoRefreshEnabled: value })}
              onServiceStatusAutoRefreshEnabledChange={(value) =>
                void desktopUi.patchPrefs({ autoRefreshServiceStatusEnabled: value })
              }
              onServiceStatusRefreshIntervalSecondsChange={(value) =>
                void desktopUi.patchPrefs({
                  autoRefreshIntervalSeconds: normalizeAutoRefreshIntervalSeconds(value)
                }, { debounce: true })
              }
              onCoreAutoRefreshEnabledChange={(value) =>
                void desktopUi.patchPrefs({ autoRefreshCoreEnabled: value })
              }
              onCoreAutoRefreshIntervalSecondsChange={(value) =>
                void desktopUi.patchPrefs({
                  autoRefreshCoreIntervalSeconds: normalizeAutoRefreshIntervalSeconds(value)
                }, { debounce: true })
              }
              onKeysAutoRefreshEnabledChange={(value) =>
                void desktopUi.patchPrefs({ autoRefreshKeysEnabled: value })
              }
              onKeysAutoRefreshIntervalSecondsChange={(value) =>
                void desktopUi.patchPrefs({
                  autoRefreshKeysIntervalSeconds: normalizeAutoRefreshIntervalSeconds(value)
                }, { debounce: true })
              }
              onUsageAutoRefreshEnabledChange={(value) =>
                void desktopUi.patchPrefs({ autoRefreshUsageEnabled: value })
              }
              onUsageAutoRefreshIntervalSecondsChange={(value) =>
                void desktopUi.patchPrefs({
                  autoRefreshUsageIntervalSeconds: normalizeAutoRefreshIntervalSeconds(value)
                }, { debounce: true })
              }
              onOverviewAccountRuntimeTimeoutMsChange={(value) =>
                void desktopUi.patchPrefs({
                  overviewAccountRuntimeTimeoutMs: value
                }, { debounce: true })
              }
              schedulerConfig={schedulerConfig}
              schedulerConfirmedConfig={schedulerConfirmedConfig}
              schedulerConfigLoading={schedulerConfigLoading}
              schedulerConfigSaving={schedulerConfigSaving}
              schedulerConfigAvailable={isTauriRuntime()}
              schedulerLoadError={schedulerLoadError}
              schedulerSaveError={schedulerSaveError}
              onRetrySchedulerConfigLoad={retrySchedulerConfigLoad}
              onRetrySchedulerConfig={retrySchedulerConfigSave}
              databaseStorageStatus={databaseStorage.status}
              databaseStorageTargetDirectory={databaseStorage.targetDirectory}
              databaseStorageLoading={databaseStorage.loading}
              databaseStorageMigrationLoading={databaseStorage.migrationLoading}
              databaseStorageLoadError={databaseStorage.loadError}
              databaseStorageMigrationError={databaseStorage.migrationError}
              databaseStorageMigrationResult={databaseStorage.migrationResult}
              onDatabaseStorageTargetDirectoryChange={databaseStorage.setTargetDirectory}
              onRetryDatabaseStorageStatus={() => void databaseStorage.refresh()}
              onMigrateDatabaseStorage={(targetDirectory) =>
                void databaseStorage.migrate(targetDirectory)
              }
              onClearRuntimeData={(value) => void handleClearRuntimeData(value)}
              clearRuntimeDataLoading={clearRuntimeDataLoading}
              onSchedulerConfigChange={handleSchedulerConfigChange}
            />
          )}
        />
      )}
    </div>
  );

  useEffect(() => {
    const hasReadyOverviewScope = overviewUsageStatsMode === "selected-account"
      ? selectedAccount?.sessionState === "ready"
      : readyOverviewAccountIds.length > 0;
    const allowUnfocusedInitialHydration =
      overviewInitialHydrationPendingRef.current && hasReadyOverviewScope;

    if (!overview || !shouldHydrateOverviewRealtime({
      nav,
      pageVisible,
      windowFocused,
      allowUnfocusedInitialHydration
    })) {
      return;
    }

    if (allowUnfocusedInitialHydration) {
      overviewInitialHydrationPendingRef.current = false;
    }

    void loadOverviewDirectUsageStats({ allowUnfocusedInitialHydration });
    void loadOverviewAllAccountKeys({ allowUnfocusedInitialHydration });
  }, [
    nav,
    overview?.generatedAt,
    overviewUsageStatsMode,
    overviewUsageInsightRange.startDate,
    overviewUsageInsightRange.endDate,
    selectedAccount?.id,
    selectedAccount?.sessionState,
    readyOverviewAccountIds,
    pageVisible,
    windowFocused,
    loadOverviewDirectUsageStats,
    loadOverviewAllAccountKeys
  ]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(OVERVIEW_USAGE_STATS_MODE_KEY, overviewUsageStatsMode);
  }, [overviewUsageStatsMode]);

  const overviewHeaderActions = nav === "overview" ? (
    <div className="overview-stats-mode-toggle workspace-header-compact-toggle" role="tablist" aria-label="总览实时用量口径">
      <button
        type="button"
        role="tab"
        aria-selected={overviewUsageStatsMode === "selected-account"}
        className={overviewUsageStatsMode === "selected-account" ? "primary-button" : "ghost-button"}
        onClick={() => setOverviewUsageStatsMode("selected-account")}
      >
        当前账号
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={overviewUsageStatsMode === "all-accounts"}
        className={overviewUsageStatsMode === "all-accounts" ? "primary-button" : "ghost-button"}
        onClick={() => setOverviewUsageStatsMode("all-accounts")}
      >
        全部账号
      </button>
    </div>
  ) : null;

  return (
    <>
      <AppShell
        windowChrome={
          <MainWindowNotificationChrome
            title="Input面板"
            logoSrc={projectLogo}
            onReload={handleTopbarReload}
            reloadRefreshing={topbarReloadRefreshing}
            onOpenProfile={openProfileModal}
            onCloseTopbarPeekPanels={closeTopbarPeekPanels}
            onAlertInboxOpenChange={setAlertInboxOpen}
          />
        }
        railCollapsed={!shellWorkspace.isRailExpanded}
        rail={
          <RailNav
            nav={nav}
            isRailExpanded={shellWorkspace.isRailExpanded}
            railToggleTitle={shellWorkspace.railToggleTitle}
            onOpenOverview={() => setNav("overview")}
            onToggleRail={() => shellWorkspace.setIsRailExpanded((current) => !current)}
            onNavChange={handleNavChange}
            onNavIntent={schedulePagePreloadIntent}
            projectLogo={projectLogo}
            selectedAccount={selectedAccount}
            accounts={accounts}
            onAccountSelect={handleTopbarAccountSelect}
          />
        }
      >
        <div className="workspace-floating-rail-host">
          <FloatingRailDrawer
            activePanel={floatingRailPanel}
            onActivePanelChange={setFloatingRailPanel}
            selectedSite={selectedSite}
            sitePublicEndpoints={publicEndpointsWorkspace.payload}
            sitePublicEndpointsLoading={publicEndpointsWorkspace.loading}
            sitePublicEndpointsSyncing={publicEndpointsWorkspace.syncing}
            sitePublicEndpointsPinging={publicEndpointsWorkspace.pinging}
            sitePublicEndpointsLastError={publicEndpointsWorkspace.lastError}
            onRetrySitePublicEndpoints={() => void publicEndpointsWorkspace.retry()}
            serviceStatus={topbarServiceStatusWorkspace.status}
            serviceStatusLastSyncedAt={topbarServiceStatusWorkspace.lastSyncedAt}
            serviceStatusLoading={topbarServiceStatusWorkspace.loading}
            serviceStatusRequestInFlight={topbarServiceStatusWorkspace.requestInFlight}
            serviceStatusLastError={topbarServiceStatusWorkspace.lastError}
            serviceStatusRefreshIntervalSeconds={serviceStatusRefreshIntervalSeconds}
            codexRadarModelIq={codexRadarWorkspace.payload}
            codexRadarModelIqLoading={codexRadarWorkspace.loading}
            codexRadarModelIqRefreshing={codexRadarWorkspace.presentation.refreshing}
            codexRadarModelIqIsStale={codexRadarWorkspace.presentation.isStale}
            codexRadarModelIqLastError={codexRadarWorkspace.lastError}
            usageStatusLabel={usageStatusLabel}
            subscriptionCount={subscriptionCount}
            subscriptionPreviewRecords={mergedTopbarSubscriptions}
            onRefreshServiceStatus={() => void topbarServiceStatusWorkspace.refreshNow({
              source: "topbar",
              notifyTransition: true
            }).catch(() => undefined)}
            onRefreshCodexRadarModelIq={() => void codexRadarWorkspace.refresh()}
            onOpenServiceStatus={() => {
              setFloatingRailPanel(null);
              setNav("serviceStatus");
            }}
            onOpenSubscriptions={() => {
              setFloatingRailPanel(null);
              setNav("subscriptions");
            }}
          />
          <WorkspaceFrame
            topbar={
              <Topbar summary={workspaceSummary} />
            }
            title={workspaceNavTitle(nav)}
            subtitle={nav === "systemSettings" ? "" : workspaceSubtitle}
            headerActions={overviewHeaderActions}
            loading={workspaceFrameLoading}
            ready={workspaceFrameReady}
            refreshError={workspaceHasRetainedSnapshot ? resolveWorkspaceRefreshError({
              nav,
              overviewLastError,
              overviewRealtimeError: overviewRealtimeLastError,
              overviewAllAccountKeysError: overviewAllAccountKeysLastError,
              accountError: accountDataWorkspace.presentation.lastError,
              usageError: presentation.lastError,
              keyUsageError: keyUsagePresentation.lastError,
              serviceStatusError: topbarServiceStatusWorkspace.lastError
            }) : null}
            onRetry={() => void retryCurrentWorkspaceSurface({
              nav,
              retryOverview: retryOverviewForCurrentScope,
              refreshAccountData: accountDataWorkspace.refreshAccountData,
              refreshUsage: refreshUsageWorkspaceSilently,
              refreshModelStats: refreshUsageSurfaceSilently,
              retryKeyUsage,
              refreshServiceStatus: topbarServiceStatusWorkspace.refreshNow
            })}
            navKey={nav}
            pageMotionPhase={pageMotionPhase}
          >
            {pageContent}
          </WorkspaceFrame>
        </div>
      </AppShell>

      <MainWindowToastLayer />

      <SyncTaskCenter
        tasks={syncTaskRecords}
        open={syncTaskCenterOpen}
        hidden={floatingRailPanel !== null}
        onOpenChange={setSyncTaskCenterOpen}
        onClearCompleted={() => {
          setSyncTaskRecords((tasks) => tasks.filter((task) => task.state === "running"));
        }}
      />

      <ModalHost>
        {accountWorkspaceModalOpen && (
          <Suspense fallback={null}>
            <AccountWorkspaceModals
              workspace={accountWorkspace}
              selectedSite={selectedSite}
              sites={sites}
              overview={overview}
            />
          </Suspense>
        )}
        {profileWorkspace.profileModalOpen && (
          <Suspense fallback={null}>
            <ProfileWorkspaceModal
              open={profileWorkspace.profileModalOpen}
              selectedAccount={selectedAccount}
              profileRecord={accountDataWorkspace.profileRecord}
              profileForm={profileWorkspace.profileForm}
              setProfileForm={profileWorkspace.setProfileForm}
              profilePassword={profileWorkspace.profilePassword}
              setProfilePassword={profileWorkspace.setProfilePassword}
              notifyEmailDraft={profileWorkspace.notifyEmailDraft}
              setNotifyEmailDraft={profileWorkspace.setNotifyEmailDraft}
              platformQuotas={accountDataWorkspace.platformQuotas}
              onClose={closeProfileModal}
              onRefreshSelectedAccount={() => {
                if (selectedAccount) {
                  if (nav === "overview") {
                    void refreshOverviewSilently("manual");
                  } else {
                    void accountWorkspace.handleRefreshAccount(selectedAccount.id, {
                      scope: "core"
                    });
                  }
                }
              }}
              onProfileSave={() => void profileWorkspace.handleProfileSave()}
              onPasswordChange={() => void profileWorkspace.handleProfilePasswordChange()}
              onNotifyEmailSend={() => void profileWorkspace.handleNotifyEmailSend()}
              onNotifyEmailVerify={() => void profileWorkspace.handleNotifyEmailVerify()}
              onUnbind={(provider) => void profileWorkspace.handleUnbind(provider)}
            />
          </Suspense>
        )}
        <MainWindowAlertInbox
          open={alertInboxOpen}
          onOpenChange={setAlertInboxOpen}
        />
        {desktopUi.closeDialogOpen && (
          <Suspense fallback={null}>
            <DesktopModeCloseDialog
              onClose={() => desktopUi.setCloseDialogOpen(false)}
              onExit={(remember) => void desktopUi.confirmExit(remember)}
              onSwitchToFloating={(remember) => void desktopUi.confirmSwitchToFloating(remember)}
            />
          </Suspense>
        )}
      </ModalHost>
    </>
  );
}

function aggregateOverviewUsageStats(rows: OverviewUsageStatsRow[]): UsageStatsRecord | null {
  if (rows.length === 0) {
    return null;
  }

  const totalRequests = rows.reduce((sum, item) => sum + item.stats.totalRequests, 0);
  const totalInputTokens = rows.reduce((sum, item) => sum + item.stats.totalInputTokens, 0);
  const totalOutputTokens = rows.reduce((sum, item) => sum + item.stats.totalOutputTokens, 0);
  const totalTokens = rows.reduce((sum, item) => sum + item.stats.totalTokens, 0);
  const totalCost = rows.reduce((sum, item) => sum + item.stats.totalCost, 0);
  const totalActualCost = rows.reduce((sum, item) => sum + item.stats.totalActualCost, 0);
  const averageDurationMs = totalRequests > 0
    ? rows.reduce((sum, item) => sum + item.stats.averageDurationMs * item.stats.totalRequests, 0) / totalRequests
    : 0;

  return {
    totalRequests,
    totalInputTokens,
    totalOutputTokens,
    totalCacheTokens: sumOptionalUsageStat(rows, (item) => item.stats.totalCacheTokens),
    totalCacheCreationTokens: sumOptionalUsageStat(rows, (item) => item.stats.totalCacheCreationTokens),
    totalCacheReadTokens: sumOptionalUsageStat(rows, (item) => item.stats.totalCacheReadTokens),
    totalTokens,
    totalCost,
    totalActualCost,
    averageDurationMs,
    rpm: sumOptionalUsageStat(rows, (item) => item.stats.rpm),
    tpm: sumOptionalUsageStat(rows, (item) => item.stats.tpm)
  };
}

function aggregateOverviewTotalStats(rows: OverviewDashboardStatsRow[]): UsageStatsRecord | null {
  return aggregateOverviewUsageStats(
    rows.map((row) => ({
      accountId: row.accountId,
      label: row.label,
      siteName: row.siteName,
      stats: row.totalStats
    }))
  );
}

function aggregateOverviewPlatformSeries(rows: OverviewDashboardStatsRow[]): PlatformPoint[] | null {
  if (rows.length === 0) {
    return null;
  }
  const map = new Map<string, PlatformPoint>();
  for (const row of rows) {
    for (const point of row.platformSeries) {
      const entry = map.get(point.platform) ?? {
        platform: point.platform,
        totalActualCost: 0,
        todayActualCost: 0,
        totalRequests: 0,
        totalTokens: 0
      };
      entry.totalActualCost += point.totalActualCost;
      entry.todayActualCost += point.todayActualCost;
      entry.totalRequests += point.totalRequests;
      entry.totalTokens += point.totalTokens;
      map.set(point.platform, entry);
    }
  }
  return Array.from(map.values());
}

function aggregateOverviewTrendPoints(
  rows: Array<{ trendPoints: NonNullable<NonNullable<AccountRuntime["cacheView"]>["trend"]> }>
): NonNullable<NonNullable<AccountRuntime["cacheView"]>["trend"]> | null {
  if (rows.length === 0) {
    return null;
  }

  const trendMap = new Map<string, NonNullable<NonNullable<AccountRuntime["cacheView"]>["trend"]>[number]>();
  for (const row of rows) {
    for (const point of row.trendPoints) {
      const entry = trendMap.get(point.bucket) ?? {
        bucket: point.bucket,
        actualCost: 0,
        totalCost: 0,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0
      };
      entry.actualCost += point.actualCost;
      entry.totalCost += point.totalCost;
      entry.requests += point.requests;
      entry.inputTokens += point.inputTokens;
      entry.outputTokens += point.outputTokens;
      entry.cacheCreationTokens += point.cacheCreationTokens;
      entry.cacheReadTokens += point.cacheReadTokens;
      entry.totalTokens += point.totalTokens;
      trendMap.set(point.bucket, entry);
    }
  }

  return Array.from(trendMap.values()).sort((left, right) => left.bucket.localeCompare(right.bucket));
}

function aggregateOverviewModelSeries(
  rows: Array<{ modelSeries: OverviewModelPoint[] }>
): OverviewModelPoint[] | null {
  if (rows.length === 0) {
    return null;
  }

  const modelMap = new Map<string, OverviewModelPoint>();
  for (const row of rows) {
    for (const point of row.modelSeries) {
      const entry = modelMap.get(point.model) ?? {
        model: point.model,
        requests: 0,
        totalTokens: 0,
        actualCost: 0,
        totalCost: 0
      };
      entry.requests += point.requests;
      entry.totalTokens += point.totalTokens;
      entry.actualCost += point.actualCost;
      entry.totalCost += point.totalCost;
      modelMap.set(point.model, entry);
    }
  }

  return Array.from(modelMap.values()).sort((left, right) => {
    const costDiff = right.actualCost - left.actualCost;
    if (costDiff !== 0) {
      return costDiff;
    }
    if (right.requests !== left.requests) {
      return right.requests - left.requests;
    }
    return left.model.localeCompare(right.model, "zh-CN");
  });
}

function aggregateOverviewUsageInsights(payloads: UsageInsightsPayload[]): UsageInsightsPayload | null {
  if (payloads.length === 0) {
    return null;
  }

  const merge = (selector: (payload: UsageInsightsPayload) => UsageInsightsPayload["groups"]) => {
    const points = new Map<string, UsageInsightsPayload["groups"][number]>();
    for (const payload of payloads) {
      for (const point of selector(payload)) {
        const entry = points.get(point.name) ?? {
          name: point.name,
          requests: 0,
          totalTokens: 0,
          actualCost: 0,
          totalCost: 0
        };
        entry.requests += point.requests;
        entry.totalTokens += point.totalTokens;
        entry.actualCost += point.actualCost;
        entry.totalCost += point.totalCost;
        points.set(point.name, entry);
      }
    }
    return Array.from(points.values()).sort((left, right) => {
      const costDifference = right.actualCost - left.actualCost;
      if (costDifference !== 0) {
        return costDifference;
      }
      return left.name.localeCompare(right.name, "zh-CN");
    });
  };

  return {
    startDate: payloads[0].startDate,
    endDate: payloads[0].endDate,
    totalRequests: payloads.reduce((sum, payload) => sum + payload.totalRequests, 0),
    groups: merge((payload) => payload.groups),
    endpoints: merge((payload) => payload.endpoints)
  };
}

function normalizeOverviewTrendPoints(
  payload: { trend: Array<{
    date: string;
    actualCost?: number | null;
    totalCost?: number | null;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    totalTokens?: number | null;
  }> } | null
): NonNullable<NonNullable<AccountRuntime["cacheView"]>["trend"]> | null {
  if (!payload || payload.trend.length === 0) {
    return null;
  }

  return payload.trend.map((point) => ({
    bucket: point.date,
    actualCost: point.actualCost ?? 0,
    totalCost: point.totalCost ?? point.actualCost ?? 0,
    requests: point.requests,
    inputTokens: point.inputTokens,
    outputTokens: point.outputTokens,
    cacheCreationTokens: point.cacheWriteTokens ?? 0,
    cacheReadTokens: point.cacheReadTokens ?? 0,
    totalTokens: point.totalTokens ?? point.inputTokens + point.outputTokens
  }));
}

function normalizeOverviewModelSeries(
  payload: { models: Array<{
    model: string;
    requests: number;
    totalTokens: number;
    actualCost?: number | null;
    cost?: number | null;
  }> } | null
): OverviewModelPoint[] | null {
  if (!payload || payload.models.length === 0) {
    return null;
  }

  return payload.models.map((item) => ({
    model: item.model,
    requests: item.requests,
    totalTokens: item.totalTokens,
    actualCost: item.actualCost ?? item.cost ?? 0,
    totalCost: item.cost ?? item.actualCost ?? 0
  }));
}

function resolveWorkspaceRefreshError(input: {
  nav: NavKey;
  overviewLastError: string | null;
  overviewRealtimeError: string | null;
  overviewAllAccountKeysError: string | null;
  accountError: string | null;
  usageError: string | null;
  keyUsageError: string | null;
  serviceStatusError: string | null;
}) {
  if (input.nav === "serviceStatus") {
    return input.serviceStatusError;
  }
  if (input.nav === "overview") {
    return input.overviewRealtimeError ?? input.overviewAllAccountKeysError ?? input.overviewLastError;
  }
  if (input.nav === "trends") {
    return input.usageError ?? input.accountError;
  }
  if (input.nav === "keys" || input.nav === "subscriptions" || input.nav === "settings") {
    return input.accountError;
  }
  if (input.nav === "keyUsage") {
    return input.keyUsageError;
  }
  if (input.nav === "usage" || input.nav === "modelStats") {
    return input.usageError;
  }
  return input.overviewLastError;
}

async function retryCurrentWorkspaceSurface(input: {
  nav: NavKey;
  retryOverview: () => Promise<unknown>;
  refreshAccountData: () => Promise<unknown>;
  refreshUsage: (options?: { mode?: "foreground" | "background" }) => Promise<unknown>;
  refreshModelStats: (
    surface: "usage" | "modelStats" | "keyUsage",
    options?: { mode?: "foreground" | "background" }
  ) => Promise<unknown>;
  retryKeyUsage: () => Promise<unknown>;
  refreshServiceStatus: (options?: { mode?: "foreground" | "background" }) => Promise<unknown>;
}) {
  if (input.nav === "serviceStatus") {
    await input.refreshServiceStatus({ mode: "foreground" });
    return;
  }
  if (input.nav === "trends") {
    await Promise.all([
      input.refreshAccountData(),
      input.refreshUsage({ mode: "foreground" })
    ]);
    return;
  }
  if (input.nav === "usage") {
    await input.refreshUsage({ mode: "foreground" });
    return;
  }
  if (input.nav === "modelStats") {
    await input.refreshModelStats("modelStats", { mode: "foreground" });
    return;
  }
  if (input.nav === "keyUsage") {
    await input.retryKeyUsage();
    return;
  }
  if (input.nav === "keys" || input.nav === "subscriptions" || input.nav === "settings") {
    await input.refreshAccountData();
    return;
  }
  await input.retryOverview();
}

function sumOptionalUsageStat(
  rows: OverviewUsageStatsRow[],
  select: (row: OverviewUsageStatsRow) => number | null | undefined
) {
  const values = rows
    .map(select)
    .filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));

  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0);
}
