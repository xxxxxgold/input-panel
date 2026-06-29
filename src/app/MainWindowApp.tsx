import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitTo } from "@tauri-apps/api/event";
import {
  Suspense,
  lazy,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent
} from "react";

import { DesktopModeCloseDialog } from "./DesktopModeCloseDialog";
import { AppShell } from "./AppShell";
import { ModalHost } from "./ModalHost";
import { RailNav } from "./RailNav";
import { ToastHost } from "./ToastHost";
import { Topbar } from "./Topbar";
import { WorkspaceFrame } from "./WorkspaceFrame";
import { buildWorkspaceSummaryTexts } from "./workspace-summary";
import { writeWindowSelection } from "./window-selection-sync";
import { navTitle as workspaceNavTitle } from "./navigation";
import { useShellWorkspace } from "./useShellWorkspace";
import { THEME_IDS, normalizeThemeId, type ThemeId } from "../shared/lib/theme";
import { useAccountDataWorkspace } from "../features/accounts/useAccountDataWorkspace";
import { AccountWorkspaceModals } from "../features/accounts/components/AccountWorkspaceModals";
import { getAccountSyncStatus, syncAccountData } from "../features/accounts/client";
import { getSchedulerConfig, updateSchedulerConfig } from "../api";
import { useAccountWorkspace } from "../features/accounts/useAccountWorkspace";
import { pushFloatingPanelToast } from "../features/desktop-ui/client";
import { AlertInboxModal, type AlertInboxItem } from "../features/overview/components/AlertInboxModal";
import type { NotificationInboxItem } from "../features/overview/components/AlertInboxModal";
import { useProfileWorkspace } from "../features/profile/useProfileWorkspace";
import { useServiceStatusWorkspace } from "../features/service-status/useServiceStatusWorkspace";
import {
  buildServiceStatusNotificationRecord,
  buildServiceStatusTestNotification,
  sendAppNotification
} from "../features/service-status/notifications";
import { useSettingsWorkspace } from "../features/settings/useSettingsWorkspace";
import { useUsageWorkspace } from "../features/usage/useUsageWorkspace";
import { useDesktopUiPrefs } from "../features/desktop-ui/useDesktopUiPrefs";
import {
  buildAutoRefreshWatcherKey,
  DEFAULT_AUTO_REFRESH_INTERVAL_SECONDS,
  isAccountDataStaleForToday,
  isAutoRefreshScopeEnabled,
  normalizeAutoRefreshIntervalSeconds,
  resolveAutoRefreshScope,
  resolveAutoRefreshIntervalSecondsForScope,
  shouldAutoRefreshSelectedAccountData,
  shouldRefreshCoreForNav
} from "./refresh-policy";
import {
  formatTime,
  formatUsd
} from "../shared/lib/formatters";
import { isTauriRuntime } from "../shared/transport/runtime";
import { resolveAccountAvatarUrl } from "../shared/lib/account-avatar";
import {
  buildTopbarSubscriptionPreviewRecords,
  mergeSubscriptionRecords
} from "../subscription-view";
import projectLogo from "../assets/project-logo.webp";
import { AlertsPage } from "../pages/AlertsPage";
import { KeyUsagePage } from "../pages/KeyUsagePage";
import { KeysPage } from "../pages/KeysPage";
import { OverviewPage } from "../pages/OverviewPage";
import { ServiceStatusPage } from "../pages/ServiceStatusPage";
import { SettingsPage } from "../pages/SettingsPage";
import { SubscriptionsPage } from "../pages/SubscriptionsPage";
import { SystemSettingsPage } from "../pages/SystemSettingsPage";
import { UsagePage } from "../pages/UsagePage";
import { ProfileWorkspaceModal } from "../features/profile/components/ProfileWorkspaceModal";
import {
  ERROR_TOAST_DURATION_MS,
  INFO_TOAST_DURATION_MS,
  useMonitorStore
} from "../store/monitor-store";
import type {
  AccountSyncStatusRecord,
  AccountRuntime,
  NavKey,
  SchedulerConfigPayload
} from "../types";

const ALLOWED_THEMES = new Set<string>(THEME_IDS);
const AnalyticsLab = lazy(async () => {
  const module = await import("../features/analytics/AnalyticsLab");
  return { default: module.AnalyticsLab };
});

export function MainWindowApp() {
  const [alertInboxOpen, setAlertInboxOpen] = useState(false);
  const [profileWorkspaceRequested, setProfileWorkspaceRequested] = useState(false);
  const [accountSyncStatuses, setAccountSyncStatuses] = useState<AccountSyncStatusRecord[]>([]);
  const [pageVisible, setPageVisible] = useState(
    typeof document === "undefined" ? true : document.visibilityState === "visible"
  );
  const [pageMotionNav, setPageMotionNav] = useState<NavKey>("overview");
  const [pageMotionPhase, setPageMotionPhase] = useState<"idle" | "enter">("idle");
  const lastServiceStatusNavRef = useRef<NavKey | null>(null);
  const lastServiceStatusPeekRef = useRef(false);
  const lastPageVisibleRef = useRef(pageVisible);
  const selectedAccountIdRef = useRef<string | null>(null);
  const nav = useMonitorStore((state) => state.nav);
  const setNav = useMonitorStore((state) => state.setNav);
  const theme = useMonitorStore((state) => state.theme);
  const setTheme = useMonitorStore((state) => state.setTheme);
  const overview = useMonitorStore((state) => state.overview);
  const loading = useMonitorStore((state) => state.loading);
  const busyText = useMonitorStore((state) => state.busyText);
  const setBusyText = useMonitorStore((state) => state.setBusyText);
  const error = useMonitorStore((state) => state.error);
  const setError = useMonitorStore((state) => state.setError);
  const toasts = useMonitorStore((state) => state.toasts);
  const appNotifications = useMonitorStore((state) => state.appNotifications);
  const dismissedOverviewAlertIds = useMonitorStore((state) => state.dismissedOverviewAlertIds);
  const readNotificationKeys = useMonitorStore((state) => state.readNotificationKeys);
  const pushAppNotification = useMonitorStore((state) => state.pushAppNotification);
  const pushToast = useMonitorStore((state) => state.pushToast);
  const markNotificationsRead = useMonitorStore((state) => state.markNotificationsRead);
  const dismissToast = useMonitorStore((state) => state.dismissToast);
  const dismissAppNotification = useMonitorStore((state) => state.dismissAppNotification);
  const acknowledgeOverviewAlert = useMonitorStore((state) => state.acknowledgeOverviewAlert);
  const selectedSiteId = useMonitorStore((state) => state.selectedSiteId);
  const setSelectedSiteId = useMonitorStore((state) => state.setSelectedSiteId);
  const selectedAccountId = useMonitorStore((state) => state.selectedAccountId);
  const setSelectedAccountId = useMonitorStore((state) => state.setSelectedAccountId);
  const loadOverview = useMonitorStore((state) => state.loadOverview);
  useEffect(() => {
    selectedAccountIdRef.current = selectedAccountId;
  }, [selectedAccountId]);
  const desktopUi = useDesktopUiPrefs("main");
  const prefsRef = useRef(desktopUi.prefs);
  prefsRef.current = desktopUi.prefs;
  const [schedulerConfig, setSchedulerConfig] = useState<SchedulerConfigPayload>({ enabled: true, intervalSeconds: 9 });
  const [schedulerConfigLoading, setSchedulerConfigLoading] = useState(false);
  useEffect(() => {
    setSchedulerConfigLoading(true);
    getSchedulerConfig()
      .then((config) => setSchedulerConfig(config))
      .catch(() => {})
      .finally(() => setSchedulerConfigLoading(false));
  }, []);
  const sites = overview?.sites ?? [];
  const accounts = overview?.accounts ?? [];
  const hasAnyAccount = accounts.length > 0;
  const serviceStatusEnabled = desktopUi.prefs.autoRefreshEnabled && hasAnyAccount;
  const serviceStatusRefreshIntervalSeconds = normalizeAutoRefreshIntervalSeconds(
    desktopUi.prefs.autoRefreshIntervalSeconds
  );
  const shellWorkspace = useShellWorkspace({ accounts });
  const overviewSubscriptionPanelVisible =
    nav === "overview" || nav === "subscriptions" || shellWorkspace.topbarSubscriptionsExpanded;
  const subscriptionSummaryVisible =
    overviewSubscriptionPanelVisible;
  const keysResources = {
    groups: nav === "keys",
    managedKeys: nav === "keys" || nav === "usage" || nav === "keyUsage" || nav === "trends",
    subscriptionSummary: subscriptionSummaryVisible,
    profileRecord: profileWorkspaceRequested,
    platformQuotas: profileWorkspaceRequested
  };
  const keysEnabled = Object.values(keysResources).some(Boolean);
  const accountDataWorkspace = useAccountDataWorkspace({
    selectedAccountId,
    resources: keysResources,
    enabled: keysEnabled,
    setError
  });
  const accountWorkspace = useAccountWorkspace({
    sites,
    accounts,
    selectedSiteId,
    selectedAccountId,
    setSelectedSiteId,
    setSelectedAccountId,
    loadOverview,
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
    loadOverview,
    setBusyText,
    setError
  });
  const topbarServiceStatusWorkspace = useServiceStatusWorkspace({
    setError,
    enabled: serviceStatusEnabled,
    notifyStatusTransition: (event) => {
      const record = buildServiceStatusNotificationRecord(event);
      pushAppNotification(record);
      void sendAppNotification(record);
      const toastPayload = {
        tone: event.kind === "down" ? "error" : "info",
        message: event.title,
        durationMs: event.kind === "down" ? ERROR_TOAST_DURATION_MS : INFO_TOAST_DURATION_MS
      } as const;
      pushToast(toastPayload);
      if (isTauriRuntime()) {
        void emitTo("floating-panel", "floating-panel-toast", toastPayload);
      } else {
        void pushFloatingPanelToast(toastPayload);
      }
      if (event.kind === "down") {
        setError(event.detail);
      }
    },
    refreshIntervalMs: serviceStatusEnabled
      ? serviceStatusRefreshIntervalSeconds * 1000
      : DEFAULT_AUTO_REFRESH_INTERVAL_SECONDS * 1000
  });
  const {
    usageApiKeyFilter,
    setUsageApiKeyFilter,
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
    usageModelSummaries,
    usageModelSummariesLoading,
    usageRecords,
    usagePageSize,
    usagePageSizeOptions,
    handleUsageSearch,
    handleUsagePageChange,
    handleUsagePageSizeChange,
    usageTrend,
    usageModels,
    usageScopeRows,
    usageScopeMeta,
    keyUsageRows,
    keyUsageKeyId,
    loadKeyUsage,
    refreshUsageWorkspaceSilently,
    usageStartDate,
    setUsageStartDate,
    usageEndDate,
    setUsageEndDate
  } = useUsageWorkspace({
    nav,
    selectedAccountId,
    managedKeys: accountDataWorkspace.managedKeys,
    setBusyText,
    setError
  });

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

    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => document.removeEventListener("visibilitychange", syncVisibility);
  }, []);

  useEffect(() => {
    void loadOverview();
  }, []);

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
    if (!isTauriRuntime()) {
      writeWindowSelection({
        selectedSiteId,
        selectedAccountId
      });
      return;
    }
    void emitTo("floating-panel", "floating-panel-selection-sync", {
      selectedSiteId,
      selectedAccountId
    });
  }, [selectedSiteId, selectedAccountId]);

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

  useEffect(() => {
    if (!selectedAccountId) {
      return;
    }
    let cancelled = false;
    let timerId: number | null = null;

    const loadSyncStatus = async () => {
      try {
        const payload = await getAccountSyncStatus(selectedAccountId);
        if (cancelled) {
          return;
        }
        setAccountSyncStatuses(payload.statuses);
        if (payload.statuses.some((item) => item.state === "running")) {
          timerId = window.setTimeout(() => {
            void loadSyncStatus();
          }, 1000);
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
  }, [selectedAccountId, overview?.generatedAt]);

  const selectedSiteAccounts = useMemo(() => {
    return selectedSiteId
      ? accounts.filter((item) => item.siteId === selectedSiteId)
      : accounts;
  }, [accounts, selectedSiteId]);
  const selectedAccount = useMemo(() => {
    return (
      accounts.find((item) => item.id === selectedAccountId && (!selectedSiteId || item.siteId === selectedSiteId)) ??
      (selectedSiteId
        ? selectedSiteAccounts[0] ?? null
        : accounts.find((item) => item.id === selectedAccountId) ?? accounts[0] ?? null)
    );
  }, [accounts, selectedAccountId, selectedSiteId]);
  const selectedSite =
    sites.find((item) => item.id === selectedSiteId) ??
    (selectedAccount ? sites.find((item) => item.id === selectedAccount.siteId) ?? null : null);
  const currentAccountCache = selectedAccount?.cacheView ?? null;
  const settingsWorkspace = useSettingsWorkspace({
    sites
  });
  const subscriptionCount =
    accountDataWorkspace.subscriptionSummary?.activeCount ?? currentAccountCache?.subscriptions.length ?? 0;
  const subscriptionSpend = accountDataWorkspace.subscriptionSummary?.totalUsedUsd ?? 0;
  const usageStatusLabel = accountDataWorkspace.subscriptionSummary
    ? `${subscriptionCount} 个有效订阅`
    : currentAccountCache?.activeSubscription?.status ?? (subscriptionCount > 0 ? "已同步订阅" : "等待同步");
  const usageStatusHint = accountDataWorkspace.subscriptionSummary
    ? `已用 ${formatUsd(subscriptionSpend, 2)}`
    : currentAccountCache?.activeSubscription?.expiresAt
      ? `到期 ${formatTime(currentAccountCache.activeSubscription.expiresAt)}`
      : subscriptionCount > 0
        ? "查看配额与到期时间"
        : "暂无订阅数据";
  const selectedAccountStatusLabel = selectedAccount
    ? selectedAccount.sessionState === "ready"
      ? "已连接"
      : selectedAccount.sessionState === "expired"
        ? "已失效"
        : "未登录"
    : "未选择账号";
  const selectedAccountAvatarUrl = resolveAccountAvatarUrl({
    profileRecord: accountDataWorkspace.profileRecord
  });
  const autoRefreshWatcherKey = buildAutoRefreshWatcherKey({
    nav,
    pageVisible,
    selectedAccount,
    prefs: desktopUi.prefs
  });
  const mergedTopbarSubscriptions = buildTopbarSubscriptionPreviewRecords({
    overviewSubscriptions: [],
    fallbackSubscriptions: mergeSubscriptionRecords(
      currentAccountCache?.subscriptions ?? [],
      accountDataWorkspace.subscriptionSummary
    ),
    fallbackAccountLabel: selectedAccount?.label ?? null,
    fallbackSiteName: selectedSite?.name ?? null
  });
  const alertInboxItems: AlertInboxItem[] = (overview?.alerts ?? [])
    .filter((alert) => !dismissedOverviewAlertIds.includes(alert.id))
    .map((alert) => {
      const account = accounts.find((item) => item.id === alert.accountId) ?? null;
      const site = sites.find((item) => item.id === alert.siteId) ?? account?.site ?? null;
      return {
        ...alert,
        accountLabel: account?.label ?? null,
        siteName: site?.name ?? null
      };
    });
  const inboxItems: NotificationInboxItem[] = [
    ...appNotifications.map((item) => ({
      notificationKey: `service-status:${item.id}`,
      source: "service-status" as const,
      id: item.id,
      severity: item.severity,
      title: item.title,
      detail: item.detail,
      createdAt: item.createdAt,
      models: item.models
    })),
    ...alertInboxItems.map((item) => ({
      notificationKey: `overview-alert:${item.id}`,
      source: "overview-alert" as const,
      id: item.id,
      severity: item.severity,
      title: item.title,
      detail: item.detail,
      createdAt: item.createdAt,
      siteName: item.siteName,
      accountLabel: item.accountLabel
    }))
  ].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  const unreadInboxItems = inboxItems.filter((item) => !readNotificationKeys.includes(item.notificationKey));
  const latestUnreadInboxItem = unreadInboxItems[0] ?? null;
  const alertCount = inboxItems.length;
  const topbarAlertPreview = inboxItems.slice(0, 3).map((item) => ({
    id: item.id,
    severity: (item.severity === "critical" ? "critical" : item.severity === "success" ? "low" : "medium") as
      | "critical"
      | "high"
      | "medium"
      | "low",
    title: item.title,
    detail: item.detail,
    siteId: item.source === "overview-alert" ? item.siteName ?? "unknown-site" : "service-status",
    accountId: item.source === "overview-alert" ? item.accountLabel ?? "unknown-account" : "runtime",
    createdAt: item.createdAt
  }));

  function handleTestNotification(kind: "down" | "recovered") {
    const notification = buildServiceStatusTestNotification(kind);
    pushAppNotification(notification);
    void sendAppNotification(notification);
    const toastPayload = {
      tone: kind === "down" ? "error" : "info",
      message: notification.title,
      durationMs: kind === "down" ? ERROR_TOAST_DURATION_MS : INFO_TOAST_DURATION_MS
    } as const;
    pushToast(toastPayload);
    if (isTauriRuntime()) {
      void emitTo("floating-panel", "floating-panel-toast", toastPayload);
    } else {
      void pushFloatingPanelToast(toastPayload);
    }
  }

  function handleAcknowledgeInboxItem(item: NotificationInboxItem) {
    if (item.source === "service-status") {
      dismissAppNotification(item.id);
    } else {
      acknowledgeOverviewAlert(item.id);
    }
  }

  function handleOpenAlertInbox() {
    shellWorkspace.closeTopbarPeekPanels();
    markNotificationsRead(inboxItems.map((item) => item.notificationKey));
    setAlertInboxOpen(true);
  }

  useEffect(() => {
    if (!selectedAccount) {
      return;
    }
    if (!shouldRefreshCoreForNav(nav)) {
      return;
    }
    if (!isAccountDataStaleForToday(selectedAccount.cacheView?.fetchedAt)) {
      return;
    }
    void accountWorkspace.handleRefreshAccount(selectedAccount.id, {
      silent: true,
      triggerSource: "stale_auto"
    });
  }, [nav, selectedAccount]);

  const refreshSelectedPageSilently = useEffectEvent(async () => {
    const autoRefreshEnabled = prefsRef.current.autoRefreshEnabled;
    const scope = resolveAutoRefreshScope(nav);
    const canRefreshSelectedAccount = shouldAutoRefreshSelectedAccountData({
      nav,
      autoRefreshEnabled,
      pageVisible,
      selectedAccount,
      prefs: prefsRef.current
    });

    if (!canRefreshSelectedAccount) {
      return;
    }

    switch (scope) {
      case "core":
        if (selectedAccount) {
          if (nav === "overview") {
            await loadOverview();
            await accountDataWorkspace.refreshAccountData();
          } else {
            await loadOverview();
          }
        }
        break;
      case "keys":
        if (selectedAccount) {
          await Promise.all([
            accountDataWorkspace.refreshAccountData(),
            loadOverview()
          ]);
        }
        break;
      case "usage":
        if (selectedAccount) {
          await Promise.all([
            refreshUsageWorkspaceSilently(),
            loadOverview()
          ]);
        }
        break;
      default:
        break;
    }

    if (scope !== "none" && isAutoRefreshScopeEnabled(prefsRef.current, scope)) {
      return resolveAutoRefreshIntervalSecondsForScope(prefsRef.current, scope);
    }
  });

  useEffect(() => {
    let cancelled = false;
    let timerId: number | null = null;
    let running = false;

    const scheduleNextTick = (intervalSeconds?: number) => {
      if (cancelled || typeof intervalSeconds !== "number") {
        return;
      }
      timerId = window.setTimeout(() => {
        void tick();
      }, intervalSeconds * 1000);
    };

    const tick = async () => {
      if (cancelled || running) {
        return;
      }
      running = true;
      try {
        const scope = resolveAutoRefreshScope(nav);
        const fallbackIntervalSeconds = scope !== "none" && isAutoRefreshScopeEnabled(prefsRef.current, scope)
          ? resolveAutoRefreshIntervalSecondsForScope(prefsRef.current, scope)
          : undefined;
        const intervalSeconds = await refreshSelectedPageSilently();
        if (cancelled) {
          return;
        }
        scheduleNextTick(intervalSeconds ?? fallbackIntervalSeconds);
      } catch {
        const scope = resolveAutoRefreshScope(nav);
        if (cancelled || scope === "none" || !isAutoRefreshScopeEnabled(prefsRef.current, scope)) {
          return;
        }
        scheduleNextTick(resolveAutoRefreshIntervalSecondsForScope(prefsRef.current, scope));
      } finally {
        running = false;
      }
    };

    if (
      shouldAutoRefreshSelectedAccountData({
        nav,
        autoRefreshEnabled: prefsRef.current.autoRefreshEnabled,
        pageVisible,
        selectedAccount,
        prefs: prefsRef.current
      })
    ) {
      const scope = resolveAutoRefreshScope(nav);
      if (scope !== "none" && isAutoRefreshScopeEnabled(prefsRef.current, scope)) {
        scheduleNextTick(resolveAutoRefreshIntervalSecondsForScope(prefsRef.current, scope));
      }
    }

    return () => {
      cancelled = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [autoRefreshWatcherKey]);

  useEffect(() => {
    const enteredServiceStatusPage = nav === "serviceStatus" && lastServiceStatusNavRef.current !== "serviceStatus";
    const openedServiceStatusPeek = shellWorkspace.topbarServiceStatusExpanded && !lastServiceStatusPeekRef.current;
    const pageBecameVisible = pageVisible && !lastPageVisibleRef.current;

    lastServiceStatusNavRef.current = nav;
    lastServiceStatusPeekRef.current = shellWorkspace.topbarServiceStatusExpanded;
    lastPageVisibleRef.current = pageVisible;

    if (!serviceStatusEnabled || !pageVisible) {
      return;
    }
    if (
      enteredServiceStatusPage ||
      openedServiceStatusPeek ||
      (pageBecameVisible && (nav === "serviceStatus" || shellWorkspace.topbarServiceStatusExpanded))
    ) {
      void topbarServiceStatusWorkspace.refreshNow();
    }
  }, [nav, pageVisible, serviceStatusEnabled, shellWorkspace.topbarServiceStatusExpanded]);

  useEffect(() => {
    if (!selectedSiteId) return;
    const accountInSelectedSite = accounts.find(
      (item) => item.id === selectedAccountId && item.siteId === selectedSiteId
    );
    if (accountInSelectedSite) return;
    const fallbackAccount = accounts.find((item) => item.siteId === selectedSiteId) ?? null;
    if ((fallbackAccount?.id ?? null) !== selectedAccountId) {
      setSelectedAccountId(fallbackAccount?.id ?? null);
    }
  }, [selectedSiteId, selectedAccountId, accounts, setSelectedAccountId]);

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
    setNav(nextNav);
  }

  function openProfileModal() {
    shellWorkspace.closeTopbarAccountMenu();
    setProfileWorkspaceRequested(true);
    profileWorkspace.openProfileModal();
  }

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

  async function refreshOverviewAccountSilently(
    accountId: string,
    triggerSource: "manual" | "stale_auto"
  ) {
    const syncStatus = await syncAccountData(accountId, {
      scope: "full",
      triggerSource
    });
    if (selectedAccountIdRef.current === accountId) {
      setAccountSyncStatuses(syncStatus.statuses);
    }
    await Promise.all([
      loadOverview(),
      accountDataWorkspace.refreshAccountData()
    ]);
  }

  const workspaceSubtitle = nav === "serviceStatus"
    ? hasAnyAccount
      ? "本地服务状态页, 通过本地 /api/service-status 对接远端监控数据"
      : "当前还没有账号, 暂不启动服务状态监控"
    : selectedSite
      ? `${selectedSite.name} / ${selectedAccount?.label ?? "未选择账号"}`
      : "请先添加站点与账号";

  const workspaceSummaryTexts = buildWorkspaceSummaryTexts({
    overview,
    accounts,
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

  const pageContent = (
    <div className={`page-stack page-stack-${nav}`}>
      {nav === "overview" && overview && (
        <OverviewPage
          overview={overview}
          currentAccountStats={currentAccountCache?.stats ?? null}
          currentAccountSubscriptions={currentAccountCache?.subscriptions ?? []}
          subscriptionSummary={accountDataWorkspace.subscriptionSummary}
          currentAccountKeys={currentAccountCache?.keys ?? []}
          currentAccountRecentUsage={currentAccountCache?.recentUsage ?? []}
          usageStats={null}
        />
      )}
      {nav === "serviceStatus" && (
        <ServiceStatusPage
          workspace={topbarServiceStatusWorkspace}
          enabled={serviceStatusEnabled}
          refreshIntervalSeconds={serviceStatusRefreshIntervalSeconds}
        />
      )}
      {nav === "settings" && (
        <SettingsPage
          siteSearch={settingsWorkspace.siteSearch}
          onSiteSearchChange={settingsWorkspace.setSiteSearch}
          filteredSites={settingsWorkspace.filteredSites}
          accounts={accounts}
          selectedSite={selectedSite}
          selectedAccountId={selectedAccountId}
          currentAccountBalance={currentAccountCache?.balance ?? null}
          currentAccountTotalKeys={currentAccountCache?.stats.totalApiKeys ?? 0}
          currentAccountActiveKeys={currentAccountCache?.stats.activeApiKeys ?? 0}
          currentAccountSubscriptions={currentAccountCache?.subscriptions ?? []}
          currentAccountKeys={currentAccountCache?.keys ?? []}
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
          handleActionKey={handleActionKey}
        />
      )}
      {nav === "keys" && (
        <KeysPage
          managedKeys={accountDataWorkspace.managedKeys}
          groups={accountDataWorkspace.groups}
          profileRecord={accountDataWorkspace.profileRecord}
          selectedAccountId={selectedAccountId}
          onRefresh={() => {
            if (selectedAccountId) {
              void accountDataWorkspace.refreshAccountData();
              void loadOverview();
            }
          }}
          onError={setError}
          onBusy={setBusyText}
        />
      )}
      {nav === "usage" && (
        <UsagePage
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
          usageStats={usageStats}
          usageModelSummaries={usageModelSummaries}
          usageModelSummariesLoading={usageModelSummariesLoading}
          usageRecords={usageRecords}
          usagePageSize={usagePageSize}
          usagePageSizeOptions={usagePageSizeOptions}
          usageScopeRows={usageScopeRows}
          handleUsageSearch={handleUsageSearch}
          handleUsagePageChange={handleUsagePageChange}
          handleUsagePageSizeChange={handleUsagePageSizeChange}
          usageTrend={usageTrend}
          usageModels={usageModels}
        />
      )}
      {nav === "subscriptions" && (
        <SubscriptionsPage
          subscriptions={currentAccountCache?.subscriptions ?? []}
          subscriptionSummary={accountDataWorkspace.subscriptionSummary}
        />
      )}
      {nav === "keyUsage" && (
        <KeyUsagePage
          keyUsageRows={keyUsageRows}
          keyUsageKeyId={keyUsageKeyId}
          managedKeys={accountDataWorkspace.managedKeys}
          onLoadKeyUsage={(keyId) => void loadKeyUsage(keyId)}
        />
      )}
      {nav === "trends" && (
        <Suspense
          fallback={
            <section className="section-card analytics-lab-empty-shell">
              <header className="section-card-header">
                <div>
                  <h3>图表实验室</h3>
                  <p>正在按需加载图表模块...</p>
                </div>
              </header>
            </section>
          }
        >
          <AnalyticsLab
            overview={overview}
            selectedAccount={selectedAccount}
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
      {nav === "alerts" && <AlertsPage alerts={overview?.alerts ?? []} />}
      {nav === "systemSettings" && (
        <SystemSettingsPage
          theme={theme}
          setTheme={handleThemeChange}
          desktopUiPrefs={desktopUi.prefs}
          desktopUiLoading={desktopUi.loading}
          onLaunchModeChange={(value) => void desktopUi.handleSwitchMode(value)}
          onFloatingVisibleChange={(value) => void desktopUi.handleFloatingVisible(value)}
          onFloatingPanelPinnedChange={(value) => void desktopUi.patchPrefs({ keepFloatingPanelVisible: value })}
          onFloatingPanelOpacityChange={(value) =>
            void desktopUi.patchPrefs({
              floatingPanelOpacity: value
            })
          }
          onCloseBehaviorChange={(value) => void desktopUi.handleRememberCloseBehavior(value)}
          onAutoRefreshEnabledChange={(value) => void desktopUi.patchPrefs({ autoRefreshEnabled: value })}
          onServiceStatusRefreshIntervalSecondsChange={(value) =>
            void desktopUi.patchPrefs({
              autoRefreshIntervalSeconds: normalizeAutoRefreshIntervalSeconds(value)
            })
          }
          onAutoRefreshCoreEnabledChange={(value) =>
            void desktopUi.patchPrefs({
              autoRefreshCoreEnabled: value
            })
          }
          onAutoRefreshCoreIntervalSecondsChange={(value) =>
            void desktopUi.patchPrefs({
              autoRefreshCoreIntervalSeconds: normalizeAutoRefreshIntervalSeconds(value)
            })
          }
          onAutoRefreshKeysEnabledChange={(value) =>
            void desktopUi.patchPrefs({
              autoRefreshKeysEnabled: value
            })
          }
          onAutoRefreshKeysIntervalSecondsChange={(value) =>
            void desktopUi.patchPrefs({
              autoRefreshKeysIntervalSeconds: normalizeAutoRefreshIntervalSeconds(value)
            })
          }
          onAutoRefreshUsageEnabledChange={(value) =>
            void desktopUi.patchPrefs({
              autoRefreshUsageEnabled: value
            })
          }
          onAutoRefreshUsageIntervalSecondsChange={(value) =>
            void desktopUi.patchPrefs({
              autoRefreshUsageIntervalSeconds: normalizeAutoRefreshIntervalSeconds(value)
            })
          }
          schedulerConfig={schedulerConfig}
          schedulerConfigLoading={schedulerConfigLoading}
          onSchedulerConfigChange={(value) => {
            setSchedulerConfigLoading(true);
            updateSchedulerConfig(value)
              .then((config) => setSchedulerConfig(config))
              .catch(() => {})
              .finally(() => setSchedulerConfigLoading(false));
          }}
        />
      )}
    </div>
  );

  return (
    <>
      <AppShell
        railCollapsed={!shellWorkspace.isRailExpanded}
        rail={
          <RailNav
            nav={nav}
            isRailExpanded={shellWorkspace.isRailExpanded}
            railToggleTitle={shellWorkspace.railToggleTitle}
            onOpenOverview={() => setNav("overview")}
            onToggleRail={() => shellWorkspace.setIsRailExpanded((current) => !current)}
            onNavChange={handleNavChange}
            theme={theme}
            setTheme={handleThemeChange}
            projectLogo={projectLogo}
          />
        }
      >
        <WorkspaceFrame
          topbar={
            <Topbar
              onReload={() =>
                selectedAccount
                  ? nav === "overview"
                    ? void refreshOverviewAccountSilently(selectedAccount.id, "manual")
                    : void accountWorkspace.handleRefreshAccount(selectedAccount.id, {
                        scope: "core",
                        busyText: "正在刷新当前账号数据...",
                        successMessage: "当前账号数据已刷新"
                      })
                  : void loadOverview({
                      busyText: "正在刷新总览...",
                      successMessage: "总览已刷新"
                    })
              }
              serviceStatus={topbarServiceStatusWorkspace.status}
              serviceStatusLastSyncedAt={topbarServiceStatusWorkspace.lastSyncedAt}
              serviceStatusRefreshing={topbarServiceStatusWorkspace.refreshing}
              topbarServiceStatusExpanded={shellWorkspace.topbarServiceStatusExpanded}
              setTopbarServiceStatusExpanded={shellWorkspace.setTopbarServiceStatusExpanded}
              topbarServiceStatusRef={shellWorkspace.topbarServiceStatusRef}
              alertCount={alertCount}
              topbarAlertsExpanded={shellWorkspace.topbarAlertsExpanded}
              setTopbarAlertsExpanded={shellWorkspace.setTopbarAlertsExpanded}
              topbarAlertsRef={shellWorkspace.topbarAlertsRef}
              topbarAlertPreview={topbarAlertPreview}
              closeTopbarAccountMenu={shellWorkspace.closeTopbarAccountMenu}
              setTopbarSubscriptionsExpanded={shellWorkspace.setTopbarSubscriptionsExpanded}
              topbarSubscriptionsExpanded={shellWorkspace.topbarSubscriptionsExpanded}
              topbarSubscriptionsRef={shellWorkspace.topbarSubscriptionsRef}
              previewTopbarPeek={shellWorkspace.previewTopbarPeek}
              clearTopbarPeekPreview={shellWorkspace.clearTopbarPeekPreview}
              toggleTopbarPeek={shellWorkspace.toggleTopbarPeek}
              usageStatusLabel={usageStatusLabel}
              usageStatusHint={usageStatusHint}
              subscriptionSpend={subscriptionSpend}
              subscriptionCount={subscriptionCount}
              subscriptionPreviewRecords={mergedTopbarSubscriptions}
              closeTopbarPeekPanels={shellWorkspace.closeTopbarPeekPanels}
              onRefreshServiceStatus={() => void topbarServiceStatusWorkspace.refreshNow()}
              serviceStatusRefreshIntervalSeconds={serviceStatusRefreshIntervalSeconds}
              onTriggerTestNotification={handleTestNotification}
              onOpenAlerts={() => {
                handleOpenAlertInbox();
              }}
              onOpenSubscriptions={() => {
                shellWorkspace.closeTopbarPeekPanels();
                setNav("subscriptions");
              }}
              latestUnreadAlertSeverity={latestUnreadInboxItem?.severity ?? null}
              selectedAccount={selectedAccount}
              topbarAccountMenuOpen={shellWorkspace.topbarAccountMenuOpen}
              setTopbarAccountMenuOpen={shellWorkspace.setTopbarAccountMenuOpen}
              topbarAccountMenuRef={shellWorkspace.topbarAccountMenuRef}
              selectedAccountStatusLabel={selectedAccountStatusLabel}
              selectedAccountAvatarUrl={selectedAccountAvatarUrl}
              selectedSite={selectedSite}
              topbarFilteredAccounts={shellWorkspace.topbarFilteredAccounts}
              accounts={accounts}
              topbarAccountSearch={shellWorkspace.topbarAccountSearch}
              setTopbarAccountSearch={shellWorkspace.setTopbarAccountSearch}
              onAccountSelect={handleTopbarAccountSelect}
              onOpenProfileModal={openProfileModal}
              onOpenSystemSettings={() => {
                shellWorkspace.closeTopbarAccountMenu();
                setNav("systemSettings");
              }}
              onOpenSettings={() => {
                shellWorkspace.closeTopbarAccountMenu();
                setNav("settings");
              }}
              onRefreshSelectedAccount={() => {
                shellWorkspace.closeTopbarAccountMenu();
                if (selectedAccount) {
                  if (nav === "overview") {
                    void refreshOverviewAccountSilently(selectedAccount.id, "manual");
                  } else {
                    void accountWorkspace.handleRefreshAccount(selectedAccount.id, {
                      scope: "core"
                    });
                  }
                }
              }}
              onOpenSelectedAccountLogin={() => {
                shellWorkspace.closeTopbarAccountMenu();
                if (selectedAccount) {
                  accountWorkspace.openPasswordLogin(selectedAccount);
                }
              }}
            />
          }
          title={workspaceNavTitle(nav)}
          subtitle={workspaceSubtitle}
          summary={workspaceSummary}
          loading={loading}
          ready={Boolean(overview)}
          navKey={nav}
          pageMotionPhase={pageMotionPhase}
        >
          {pageContent}
        </WorkspaceFrame>
      </AppShell>

      <div className="main-window-toast-layer">
        <ToastHost toasts={toasts} onDismiss={dismissToast} />
      </div>

      <ModalHost>
        <AccountWorkspaceModals
          workspace={accountWorkspace}
          selectedSite={selectedSite}
          sites={sites}
          overview={overview}
        />
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
                void refreshOverviewAccountSilently(selectedAccount.id, "manual");
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
        {alertInboxOpen && (
          <AlertInboxModal
            items={inboxItems}
            onClose={() => setAlertInboxOpen(false)}
            onAcknowledge={handleAcknowledgeInboxItem}
          />
        )}
        {desktopUi.closeDialogOpen && (
          <DesktopModeCloseDialog
            onClose={() => desktopUi.setCloseDialogOpen(false)}
            onExit={(remember) => void desktopUi.confirmExit(remember)}
            onSwitchToFloating={(remember) => void desktopUi.confirmSwitchToFloating(remember)}
          />
        )}
      </ModalHost>
    </>
  );
}
