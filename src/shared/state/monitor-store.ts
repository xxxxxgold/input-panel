import { create } from "zustand";
import { getOverview, getOverviewShell, getOverviewShellLite } from "../../api";
import type { AppNotificationItem } from "../../features/service-status/notifications";
import { formatAppErrorMessage } from "../lib/error-display";
import { DEFAULT_THEME_ID, type ThemeId } from "../lib/theme";
import type {
  AccountRuntime,
  NavKey,
  OverviewPayload,
  SiteRecord
} from "../../types";

export const INFO_TOAST_DURATION_MS = 2400;
export const ERROR_TOAST_DURATION_MS = 4200;

export type MonitorToastTone = "error" | "info" | "success";

export interface MonitorToastAction {
  label: string;
  onClick: () => void;
}

export interface MonitorToast {
  id: string;
  tone: MonitorToastTone;
  title?: string;
  message: string;
  durationMs: number;
  loading?: boolean;
  action?: MonitorToastAction;
}

interface ToastInput {
  tone: MonitorToastTone;
  title?: string;
  message: string;
  durationMs?: number;
  loading?: boolean;
  action?: MonitorToastAction;
}

interface LoadOverviewOptions {
  busyText?: string;
  successMessage?: string;
  source?: "full" | "shell" | "shell-lite";
  silent?: boolean;
}

export interface OverviewEntityEvictionInput {
  accountIds?: readonly string[];
  siteIds?: readonly string[];
}

let overviewLoadRequestId = 0;
let overviewBusyRequestId: number | null = null;
let overviewBusyText: string | null = null;

interface MonitorStore {
  nav: NavKey;
  theme: ThemeId;
  overview: OverviewPayload | null;
  loading: boolean;
  overviewRefreshing: boolean;
  overviewLastError: string | null;
  overviewUpdatedAt: number | null;
  busyText: string | null;
  error: string | null;
  toasts: MonitorToast[];
  appNotifications: AppNotificationItem[];
  dismissedOverviewAlertIds: string[];
  readNotificationKeys: string[];
  activeBusyToastId: string | null;
  selectedSiteId: string | null;
  selectedAccountId: string | null;
  selectionSyncNonce: number;
  setNav: (nav: NavKey) => void;
  setTheme: (theme: ThemeId) => void;
  setBusyText: (text: string | null) => void;
  setError: (text: string | null) => void;
  pushToast: (toast: ToastInput) => string;
  pushAppNotification: (notification: AppNotificationItem) => void;
  markNotificationsRead: (keys: string[]) => void;
  dismissToast: (toastId: string) => void;
  dismissAppNotification: (notificationId: string) => void;
  acknowledgeOverviewAlert: (alertId: string) => void;
  setSelectedSiteId: (siteId: string | null) => void;
  setSelectedAccountId: (accountId: string | null) => void;
  refreshSelectedAccountSync: () => void;
  loadOverview: (options?: LoadOverviewOptions) => Promise<boolean>;
  replaceOverview: (overview: OverviewPayload) => void;
  evictOverviewEntities: (input: OverviewEntityEvictionInput) => void;
}

function isPreferredRuntimeAccount(account: AccountRuntime) {
  return account.sessionState === "ready" || Boolean(account.cacheView);
}

export function resolveOverviewSelection({
  accounts,
  sites,
  selectedAccountId,
  selectedSiteId
}: {
  accounts: AccountRuntime[];
  sites: SiteRecord[];
  selectedAccountId: string | null;
  selectedSiteId: string | null;
}) {
  const nextSiteId =
    selectedSiteId && sites.some((site) => site.id === selectedSiteId) ? selectedSiteId : null;
  const scopedAccounts = nextSiteId
    ? accounts.filter((account) => account.siteId === nextSiteId)
    : accounts;
  const activeAccount =
    accounts.find(
      (account) =>
        account.id === selectedAccountId && (!nextSiteId || account.siteId === nextSiteId)
    ) ??
    scopedAccounts.find(isPreferredRuntimeAccount) ??
    scopedAccounts[0] ??
    accounts.find(isPreferredRuntimeAccount) ??
    accounts[0] ??
    null;

  return {
    selectedAccountId: activeAccount?.id ?? null,
    selectedSiteId: activeAccount?.siteId ?? nextSiteId ?? sites[0]?.id ?? null
  };
}

export function appendToastDeduped(
  toasts: MonitorToast[],
  toast: Omit<MonitorToast, "id">,
  createId: () => string = () => crypto.randomUUID()
) {
  const duplicate = toasts.find(
    (item) =>
      item.tone === toast.tone &&
      item.title === toast.title &&
      item.message === toast.message &&
      item.loading === toast.loading &&
      item.action?.label === toast.action?.label
  );
  if (duplicate) {
    return {
      toastId: duplicate.id,
      toasts
    };
  }

  const toastId = createId();
  return {
    toastId,
    toasts: [...toasts, { ...toast, id: toastId }]
  };
}

export function pruneDismissedOverviewAlertIds(
  dismissedOverviewAlertIds: string[],
  activeOverviewAlertIds: string[]
) {
  if (dismissedOverviewAlertIds.length === 0 || activeOverviewAlertIds.length === 0) {
    return activeOverviewAlertIds.length === 0 ? [] : dismissedOverviewAlertIds.filter((id) => activeOverviewAlertIds.includes(id));
  }
  const activeIdSet = new Set(activeOverviewAlertIds);
  return dismissedOverviewAlertIds.filter((id) => activeIdSet.has(id));
}

export function pruneReadNotificationKeys(
  readNotificationKeys: string[],
  activeNotificationKeys: string[]
) {
  if (readNotificationKeys.length === 0 || activeNotificationKeys.length === 0) {
    return activeNotificationKeys.length === 0 ? [] : readNotificationKeys.filter((key) => activeNotificationKeys.includes(key));
  }
  const activeKeySet = new Set(activeNotificationKeys);
  return readNotificationKeys.filter((key) => activeKeySet.has(key));
}

function normalizeEntityIds(ids: readonly string[] | undefined) {
  return new Set((ids ?? []).map((id) => id.trim()).filter(Boolean));
}

/**
 * 后端 generatedAt 取自 Utc::now()，每次响应必然不同；忽略它比较其余内容，
 * 数据未变时保留旧引用，让订阅 overview 的组件跳过整轮重渲染。
 */
export function overviewSnapshotsEquivalent(
  previous: OverviewPayload | null,
  next: OverviewPayload
): boolean {
  if (!previous) {
    return false;
  }
  const { generatedAt: _previousGeneratedAt, ...previousRest } = previous;
  const { generatedAt: _nextGeneratedAt, ...nextRest } = next;
  return JSON.stringify(previousRest) === JSON.stringify(nextRest);
}

export function evictOverviewEntities(
  overview: OverviewPayload,
  input: OverviewEntityEvictionInput
): OverviewPayload {
  const accountIds = normalizeEntityIds(input.accountIds);
  const siteIds = normalizeEntityIds(input.siteIds);
  if (accountIds.size === 0 && siteIds.size === 0) {
    return overview;
  }

  const accounts = overview.accounts.filter(
    (account) => !accountIds.has(account.id) && !siteIds.has(account.siteId)
  );
  const sites = overview.sites.filter((site) => !siteIds.has(site.id));
  if (accounts.length === overview.accounts.length && sites.length === overview.sites.length) {
    return overview;
  }
  const visibleAccountIds = new Set(accounts.map((account) => account.id));
  const totals = accounts.reduce<OverviewPayload["totals"]>(
    (current, account) => {
      const stats = account.cacheView?.stats;
      return {
        balance: current.balance + (account.cacheView?.balance ?? 0),
        totalSites: sites.length,
        totalAccounts: current.totalAccounts + 1,
        totalApiKeys: current.totalApiKeys + (stats?.totalApiKeys ?? 0),
        activeApiKeys: current.activeApiKeys + (stats?.activeApiKeys ?? 0),
        todayRequests: current.todayRequests + (stats?.todayRequests ?? 0),
        totalRequests: current.totalRequests + (stats?.totalRequests ?? 0),
        todayActualCost: current.todayActualCost + (stats?.todayActualCost ?? 0),
        totalActualCost: current.totalActualCost + (stats?.totalActualCost ?? 0),
        todayTokens: current.todayTokens + (stats?.todayTokens ?? 0),
        totalTokens: current.totalTokens + (stats?.totalTokens ?? 0)
      };
    },
    {
      balance: 0,
      totalSites: sites.length,
      totalAccounts: 0,
      totalApiKeys: 0,
      activeApiKeys: 0,
      todayRequests: 0,
      totalRequests: 0,
      todayActualCost: 0,
      totalActualCost: 0,
      todayTokens: 0,
      totalTokens: 0
    }
  );

  return {
    ...overview,
    sites,
    accounts,
    totals,
    alerts: overview.alerts.filter((alert) => visibleAccountIds.has(alert.accountId)),
    platformSeries: [],
    modelSeries: [],
    trend: [],
    recentUsage: overview.recentUsage.filter((row) => visibleAccountIds.has(row.accountId)),
    subscriptions: overview.subscriptions.filter((subscription) => visibleAccountIds.has(subscription.accountId)),
    keys: overview.keys.filter((key) => visibleAccountIds.has(key.accountId))
  };
}

export const useMonitorStore = create<MonitorStore>((set, get) => ({
  nav: "overview",
  theme: DEFAULT_THEME_ID,
  overview: null,
  loading: true,
  overviewRefreshing: false,
  overviewLastError: null,
  overviewUpdatedAt: null,
  busyText: null,
  error: null,
  toasts: [],
  appNotifications: [],
  dismissedOverviewAlertIds: [],
  readNotificationKeys: [],
  activeBusyToastId: null,
  selectedSiteId: null,
  selectedAccountId: null,
  selectionSyncNonce: 0,
  setNav: (nav) => set({ nav }),
  setTheme: (theme) => set({ theme }),
  setBusyText: (busyText) => {
    const currentBusyToastId = get().activeBusyToastId;
    const nextBusyText = busyText?.trim() || null;
    set((state) => ({
      busyText: nextBusyText,
      activeBusyToastId: null,
      toasts: currentBusyToastId ? state.toasts.filter((item) => item.id !== currentBusyToastId) : state.toasts
    }));
  },
  setError: (error) => {
    const nextError = error ? formatAppErrorMessage(error) : null;
    set({ error: nextError });
    if (nextError) {
      get().pushToast({
        tone: "error",
        message: nextError,
        durationMs: ERROR_TOAST_DURATION_MS
      });
    }
  },
  pushToast: ({ tone, title, message, durationMs, loading, action }) => {
    const resolvedDurationMs =
      durationMs ?? (tone === "error" ? ERROR_TOAST_DURATION_MS : INFO_TOAST_DURATION_MS);
    const nextToast = { tone, title, message, durationMs: resolvedDurationMs, loading, action };
    let toastId = "";
    set((state) => {
      const next = appendToastDeduped(state.toasts, nextToast);
      toastId = next.toastId;
      return {
        toasts: next.toasts
      };
    });
    return toastId;
  },
  pushAppNotification: (notification) =>
    set((state) => {
      const mostRecent = state.appNotifications[0];
      if (mostRecent?.dedupeKey === notification.dedupeKey) {
        return state;
      }
      return {
        appNotifications: [notification, ...state.appNotifications].slice(0, 50)
      };
    }),
  markNotificationsRead: (keys) =>
    set((state) => {
      if (keys.length === 0) {
        return state;
      }
      const next = new Set(state.readNotificationKeys);
      for (const key of keys) {
        next.add(key);
      }
      return {
        readNotificationKeys: Array.from(next)
      };
    }),
  dismissToast: (toastId) =>
    set((state) => ({
      toasts: state.toasts.filter((item) => item.id !== toastId)
    })),
  dismissAppNotification: (notificationId) =>
    set((state) => ({
      appNotifications: state.appNotifications.filter((item) => item.id !== notificationId)
    })),
  acknowledgeOverviewAlert: (alertId) =>
    set((state) => ({
      dismissedOverviewAlertIds: state.dismissedOverviewAlertIds.includes(alertId)
        ? state.dismissedOverviewAlertIds
        : [...state.dismissedOverviewAlertIds, alertId]
    })),
  setSelectedSiteId: (selectedSiteId) => set({ selectedSiteId }),
  setSelectedAccountId: (selectedAccountId) => set({ selectedAccountId }),
  refreshSelectedAccountSync: () => set((state) => ({ selectionSyncNonce: state.selectionSyncNonce + 1 })),
  replaceOverview: (overview) => {
    const busyTextToClear = overviewBusyText;
    const ownsCurrentBusyText = Boolean(busyTextToClear && get().busyText === busyTextToClear);
    overviewLoadRequestId += 1;
    overviewBusyRequestId = null;
    overviewBusyText = null;
    if (ownsCurrentBusyText) {
      get().setBusyText(null);
    }
    set((state) => ({
      overview,
      loading: false,
      overviewRefreshing: false,
      overviewLastError: null,
      overviewUpdatedAt: Date.now(),
      dismissedOverviewAlertIds: pruneDismissedOverviewAlertIds(
        state.dismissedOverviewAlertIds,
        overview.alerts.map((alert) => alert.id)
      ),
      readNotificationKeys: pruneReadNotificationKeys(
        state.readNotificationKeys,
        [
          ...state.appNotifications.map((item) => `service-status:${item.id}`),
          ...overview.alerts.map((alert) => `overview-alert:${alert.id}`)
        ]
      )
    }));
  },
  evictOverviewEntities: (input) => {
    const accountIds = normalizeEntityIds(input.accountIds);
    const siteIds = normalizeEntityIds(input.siteIds);
    if (accountIds.size === 0 && siteIds.size === 0) {
      return;
    }
    const current = get().overview;
    const busyTextToClear = overviewBusyText;
    const ownsCurrentBusyText = Boolean(busyTextToClear && get().busyText === busyTextToClear);
    overviewLoadRequestId += 1;
    overviewBusyRequestId = null;
    overviewBusyText = null;
    if (ownsCurrentBusyText) {
      get().setBusyText(null);
    }
    if (!current) {
      const selectedSiteId = get().selectedSiteId;
      const selectedAccountId = get().selectedAccountId;
      if (
        accountIds.has(selectedAccountId ?? "")
        || siteIds.has(selectedSiteId ?? "")
      ) {
        set({ selectedSiteId: null, selectedAccountId: null });
      }
      return;
    }
    const next = evictOverviewEntities(current, input);
    if (next === current) {
      return;
    }
    const selection = resolveOverviewSelection({
      accounts: next.accounts,
      sites: next.sites,
      selectedAccountId: get().selectedAccountId,
      selectedSiteId: get().selectedSiteId
    });
    set((state) => ({
      overview: next,
      loading: false,
      overviewRefreshing: false,
      overviewLastError: null,
      overviewUpdatedAt: Date.now(),
      selectedSiteId: selection.selectedSiteId,
      selectedAccountId: selection.selectedAccountId,
      dismissedOverviewAlertIds: pruneDismissedOverviewAlertIds(
        state.dismissedOverviewAlertIds,
        next.alerts.map((alert) => alert.id)
      ),
      readNotificationKeys: pruneReadNotificationKeys(
        state.readNotificationKeys,
        [
          ...state.appNotifications.map((item) => `service-status:${item.id}`),
          ...next.alerts.map((alert) => `overview-alert:${alert.id}`)
        ]
      )
    }));
  },
  loadOverview: async (options) => {
    const requestId = ++overviewLoadRequestId;
    const nextBusyText = options?.busyText?.trim() || null;
    const hasSnapshot = get().overview !== null;
    if (nextBusyText) {
      overviewBusyRequestId = requestId;
      overviewBusyText = nextBusyText;
      get().setBusyText(nextBusyText);
    }
    if (hasSnapshot) {
      set({ loading: false, overviewRefreshing: true, overviewLastError: null });
      if (!options?.silent) {
        set({ error: null });
      }
    } else {
      set({ loading: true, overviewRefreshing: false, overviewLastError: null });
      if (!options?.silent) {
        set({ error: null });
      }
    }
    try {
      const next = await (
        options?.source === "shell"
          ? getOverviewShell()
          : options?.source === "shell-lite"
            ? getOverviewShellLite()
            : getOverview()
      );
      const selection = resolveOverviewSelection({
        accounts: next.accounts,
        sites: next.sites,
        selectedAccountId: get().selectedAccountId,
        selectedSiteId: get().selectedSiteId
      });
      if (requestId !== overviewLoadRequestId) {
        return false;
      }
      set((state) => ({
        overview: overviewSnapshotsEquivalent(state.overview, next) ? state.overview : next,
        loading: false,
        overviewRefreshing: false,
        overviewLastError: null,
        overviewUpdatedAt: Date.now(),
        selectedSiteId: selection.selectedSiteId,
        selectedAccountId: selection.selectedAccountId,
        dismissedOverviewAlertIds: pruneDismissedOverviewAlertIds(
          state.dismissedOverviewAlertIds,
          next.alerts.map((alert) => alert.id)
        ),
        readNotificationKeys: pruneReadNotificationKeys(
          state.readNotificationKeys,
          [
            ...state.appNotifications.map((item) => `service-status:${item.id}`),
            ...next.alerts.map((alert) => `overview-alert:${alert.id}`)
          ]
        )
      }));
      if (options?.successMessage) {
        get().pushToast({
          tone: "info",
          message: options.successMessage
        });
      }
      return true;
    } catch (cause) {
      if (requestId === overviewLoadRequestId) {
        const message = (cause as Error).message;
        set({ overviewRefreshing: false, overviewLastError: message });
        if (!options?.silent) {
          get().setError(message);
        }
      }
      return false;
    } finally {
      if (nextBusyText && overviewBusyRequestId === requestId) {
        overviewBusyRequestId = null;
        overviewBusyText = null;
        if (get().busyText === nextBusyText) {
          get().setBusyText(null);
        }
      }
      if (requestId === overviewLoadRequestId) {
        const current = get();
        // 成功路径已在主 set 中清掉两个标志，这里只兜底失败/竞态残留，
        // 避免同一轮刷新触发第二次订阅者通知。
        if (current.loading || current.overviewRefreshing) {
          set({
            loading: false,
            overviewRefreshing: false
          });
        }
      }
    }
  }
}));
