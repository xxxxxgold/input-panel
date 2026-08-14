import { useMonitorStore } from "../store/monitor-store";

type MonitorStoreState = ReturnType<typeof useMonitorStore.getState>;

const EMPTY_OVERVIEW_ALERTS: NonNullable<MonitorStoreState["overview"]>["alerts"] = [];
const EMPTY_ACCOUNTS: NonNullable<MonitorStoreState["overview"]>["accounts"] = [];
const EMPTY_SITES: NonNullable<MonitorStoreState["overview"]>["sites"] = [];

export const selectNav = (state: MonitorStoreState) => state.nav;
export const selectTheme = (state: MonitorStoreState) => state.theme;
export const selectOverview = (state: MonitorStoreState) => state.overview;
export const selectLoading = (state: MonitorStoreState) => state.loading;
export const selectOverviewRefreshing = (state: MonitorStoreState) => state.overviewRefreshing;
export const selectOverviewLastError = (state: MonitorStoreState) => state.overviewLastError;
export const selectSelectedSiteId = (state: MonitorStoreState) => state.selectedSiteId;
export const selectSelectedAccountId = (state: MonitorStoreState) => state.selectedAccountId;
export const selectSelectionSyncNonce = (state: MonitorStoreState) => state.selectionSyncNonce;
export const selectMainWindowNotificationState = (state: MonitorStoreState) => ({
  appNotifications: state.appNotifications,
  dismissedOverviewAlertIds: state.dismissedOverviewAlertIds,
  readNotificationKeys: state.readNotificationKeys,
  overviewAlerts: state.overview?.alerts ?? EMPTY_OVERVIEW_ALERTS,
  accounts: state.overview?.accounts ?? EMPTY_ACCOUNTS,
  sites: state.overview?.sites ?? EMPTY_SITES
});
