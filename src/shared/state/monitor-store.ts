import { create } from "zustand";
import { getOverview } from "../../api";
import type { AppNotificationItem } from "../../features/service-status/notifications";
import { formatAppErrorMessage } from "../lib/error-display";
import type {
  AccountRuntime,
  NavKey,
  OverviewPayload,
  SiteRecord
} from "../../types";

const INFO_TOAST_DURATION_MS = 2400;
const ERROR_TOAST_DURATION_MS = 4200;

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
  theme: "light" | "dark" | "deep-blue";
  overview: OverviewPayload | null;
  loading: boolean;
  busyText: string | null;
  error: string | null;
  toasts: MonitorToast[];
  appNotifications: AppNotificationItem[];
  activeBusyToastId: string | null;
  selectedSiteId: string | null;
  selectedAccountId: string | null;
  setNav: (nav: NavKey) => void;
  setTheme: (theme: "light" | "dark" | "deep-blue") => void;
  setBusyText: (text: string | null) => void;
  setError: (text: string | null) => void;
  pushToast: (toast: ToastInput) => string;
  pushAppNotification: (notification: AppNotificationItem) => void;
  dismissToast: (toastId: string) => void;
  dismissAppNotification: (notificationId: string) => void;
  setSelectedSiteId: (siteId: string | null) => void;
  setSelectedAccountId: (accountId: string | null) => void;
  loadOverview: (options?: LoadOverviewOptions) => Promise<void>;
  replaceOverview: (overview: OverviewPayload) => void;
}

function isPreferredRuntimeAccount(account: AccountRuntime) {
  return account.sessionState === "ready" || Boolean(account.snapshot);
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

export const useMonitorStore = create<MonitorStore>((set, get) => ({
  nav: "overview",
  theme: "light",
  overview: null,
  loading: true,
  busyText: null,
  error: null,
  toasts: [],
  appNotifications: [],
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
  dismissToast: (toastId) =>
    set((state) => ({
      toasts: state.toasts.filter((item) => item.id !== toastId)
    })),
  dismissAppNotification: (notificationId) =>
    set((state) => ({
      appNotifications: state.appNotifications.filter((item) => item.id !== notificationId)
    })),
  setSelectedSiteId: (selectedSiteId) => set({ selectedSiteId }),
  setSelectedAccountId: (selectedAccountId) => set({ selectedAccountId }),
  replaceOverview: (overview) => set({ overview }),
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
      set({
        overview: next,
        selectedSiteId: selection.selectedSiteId,
        selectedAccountId: selection.selectedAccountId
      });
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
