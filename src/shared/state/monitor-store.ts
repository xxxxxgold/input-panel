import { create } from "zustand";
import { getOverview } from "../../api";
import type { NavKey, OverviewPayload } from "../../types";

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

interface MonitorStore {
  nav: NavKey;
  theme: "light" | "dark" | "deep-blue";
  overview: OverviewPayload | null;
  loading: boolean;
  busyText: string | null;
  error: string | null;
  toasts: MonitorToast[];
  activeBusyToastId: string | null;
  selectedSiteId: string | null;
  selectedAccountId: string | null;
  siteSearch: string;
  accountSearch: string;
  setNav: (nav: NavKey) => void;
  setTheme: (theme: "light" | "dark" | "deep-blue") => void;
  setBusyText: (text: string | null) => void;
  setError: (text: string | null) => void;
  pushToast: (toast: ToastInput) => string;
  dismissToast: (toastId: string) => void;
  setSelectedSiteId: (siteId: string | null) => void;
  setSelectedAccountId: (accountId: string | null) => void;
  setSiteSearch: (text: string) => void;
  setAccountSearch: (text: string) => void;
  loadOverview: () => Promise<void>;
  replaceOverview: (overview: OverviewPayload) => void;
}

export const useMonitorStore = create<MonitorStore>((set, get) => ({
  nav: "overview",
  theme: "light",
  overview: null,
  loading: true,
  busyText: null,
  error: null,
  toasts: [],
  activeBusyToastId: null,
  selectedSiteId: null,
  selectedAccountId: null,
  siteSearch: "",
  accountSearch: "",
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
    set({ error });
    if (error) {
      get().pushToast({
        tone: "error",
        message: error,
        durationMs: ERROR_TOAST_DURATION_MS
      });
    }
  },
  pushToast: ({ tone, message, durationMs, loading }) => {
    const toastId = crypto.randomUUID();
    const resolvedDurationMs =
      durationMs ?? (tone === "error" ? ERROR_TOAST_DURATION_MS : INFO_TOAST_DURATION_MS);
    set((state) => ({
      toasts: [...state.toasts, { id: toastId, tone, message, durationMs: resolvedDurationMs, loading }]
    }));
    return toastId;
  },
  dismissToast: (toastId) =>
    set((state) => ({
      toasts: state.toasts.filter((item) => item.id !== toastId)
    })),
  setSelectedSiteId: (selectedSiteId) => set({ selectedSiteId }),
  setSelectedAccountId: (selectedAccountId) => set({ selectedAccountId }),
  setSiteSearch: (siteSearch) => set({ siteSearch }),
  setAccountSearch: (accountSearch) => set({ accountSearch }),
  replaceOverview: (overview) => set({ overview }),
  loadOverview: async () => {
    set({ loading: true, error: null });
    try {
      const next = await getOverview();
      const selectedSiteId = get().selectedSiteId ?? next.sites[0]?.id ?? null;
      const selectedAccountId = get().selectedAccountId ?? next.accounts[0]?.id ?? null;
      set({
        overview: next,
        selectedSiteId,
        selectedAccountId
      });
    } catch (cause) {
      set({ error: (cause as Error).message });
    } finally {
      set({ loading: false });
    }
  }
}));
