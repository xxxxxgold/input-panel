import { create } from "zustand";
import { getOverview } from "../../api";
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

export type MonitorToastTone = "error" | "info";

export interface MonitorToast {
  id: string;
  tone: MonitorToastTone;
  message: string;
  durationMs: number;
  loading?: boolean;
}

interface ToastInput {
  tone: MonitorToastTone;
  message: string;
  durationMs?: number;
  loading?: boolean;
}

interface LoadOverviewOptions {
  busyText?: string;
  successMessage?: string;
}

interface MonitorStore {
  nav: NavKey;
  theme: ThemeId;
  overview: OverviewPayload | null;
  loading: boolean;
  busyText: string | null;
  error: string | null;
  toasts: MonitorToast[];
  appNotifications: AppNotificationItem[];
  dismissedOverviewAlertIds: string[];
  readNotificationKeys: string[];
  activeBusyToastId: string | null;
  selectedSiteId: string | null;
  selectedAccountId: string | null;
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
  loadOverview: (options?: LoadOverviewOptions) => Promise<void>;
  replaceOverview: (overview: OverviewPayload) => void;
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
      item.message === toast.message &&
      item.loading === toast.loading
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

export const useMonitorStore = create<MonitorStore>((set, get) => ({
  nav: "overview",
  theme: DEFAULT_THEME_ID,
  overview: null,
  loading: true,
  busyText: null,
  error: null,
  toasts: [],
  appNotifications: [],
  dismissedOverviewAlertIds: [],
  readNotificationKeys: [],
  activeBusyToastId: null,
  selectedSiteId: null,
  selectedAccountId: null,
  setNav: (nav) => set({ nav }),
  setTheme: (theme) => set({ theme }),
  setBusyText: (busyText) => {
    const currentBusyToastId = get().activeBusyToastId;
    if (!busyText) {
      set((state) => ({
        busyText: null,
        activeBusyToastId: null,
        toasts: currentBusyToastId ? state.toasts.filter((item) => item.id !== currentBusyToastId) : state.toasts
      }));
      return;
    }
    if (currentBusyToastId) {
      set((state) => ({
        toasts: state.toasts.filter((item) => item.id !== currentBusyToastId),
        activeBusyToastId: null
      }));
    }
    if (busyText) {
      const toastId = get().pushToast({
        tone: "info",
        message: busyText,
        durationMs: INFO_TOAST_DURATION_MS,
        loading: true
      });
      set({ busyText, activeBusyToastId: toastId });
    }
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
  pushToast: ({ tone, message, durationMs, loading }) => {
    const resolvedDurationMs =
      durationMs ?? (tone === "error" ? ERROR_TOAST_DURATION_MS : INFO_TOAST_DURATION_MS);
    const nextToast = { tone, message, durationMs: resolvedDurationMs, loading };
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
      const duplicate = state.appNotifications.find((item) => item.dedupeKey === notification.dedupeKey);
      if (duplicate) {
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
  replaceOverview: (overview) =>
    set((state) => ({
      overview,
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
    })),
  loadOverview: async (options) => {
    const nextBusyText = options?.busyText?.trim() || null;
    if (nextBusyText) {
      get().setBusyText(nextBusyText);
    }
    set({ loading: true, error: null });
    try {
      const next = await getOverview();
      const selection = resolveOverviewSelection({
        accounts: next.accounts,
        sites: next.sites,
        selectedAccountId: get().selectedAccountId,
        selectedSiteId: get().selectedSiteId
      });
      set((state) => ({
        overview: next,
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
    } catch (cause) {
      get().setError((cause as Error).message);
    } finally {
      if (nextBusyText) {
        get().setBusyText(null);
      }
      set({ loading: false });
    }
  }
}));
