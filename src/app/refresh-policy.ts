import type { NavKey } from "../types";
import type { AccountRuntime } from "../types";

export const MIN_AUTO_REFRESH_INTERVAL_SECONDS = 1;
export const DEFAULT_AUTO_REFRESH_INTERVAL_SECONDS = 9;

const ACCOUNT_SCOPED_REFRESH_NAVS: NavKey[] = [
  "overview",
  "keys",
  "usage",
  "subscriptions",
  "keyUsage",
  "trends",
  "settings",
  "alerts"
];

const SNAPSHOT_REFRESH_NAVS: NavKey[] = [
  "overview",
  "subscriptions",
  "settings",
  "alerts"
];

const AUTO_REFRESH_SNAPSHOT_NAVS: NavKey[] = [
  "overview",
  "subscriptions",
  "settings",
  "alerts"
];

const AUTO_REFRESH_ACCOUNT_SCOPED_NAVS: NavKey[] = [
  "keys"
];

const AUTO_REFRESH_USAGE_NAVS: NavKey[] = [
  "usage",
  "trends",
  "keyUsage"
];

export function shouldRefreshAccountScopedData(nav: NavKey) {
  return ACCOUNT_SCOPED_REFRESH_NAVS.includes(nav);
}

export function shouldRefreshSnapshotForNav(nav: NavKey) {
  return SNAPSHOT_REFRESH_NAVS.includes(nav);
}

export function normalizeAutoRefreshIntervalSeconds(value: number | null | undefined) {
  if (!Number.isFinite(value)) {
    return DEFAULT_AUTO_REFRESH_INTERVAL_SECONDS;
  }
  return Math.max(MIN_AUTO_REFRESH_INTERVAL_SECONDS, Math.round(value ?? DEFAULT_AUTO_REFRESH_INTERVAL_SECONDS));
}

export function resolveAutoRefreshScope(nav: NavKey) {
  if (AUTO_REFRESH_SNAPSHOT_NAVS.includes(nav)) {
    return "snapshot";
  }
  if (AUTO_REFRESH_ACCOUNT_SCOPED_NAVS.includes(nav)) {
    return "accountScoped";
  }
  if (AUTO_REFRESH_USAGE_NAVS.includes(nav)) {
    return "usage";
  }
  return "none";
}

export function shouldAutoRefreshSelectedAccountData(options: {
  nav: NavKey;
  autoRefreshEnabled: boolean;
  pageVisible: boolean;
  selectedAccount: AccountRuntime | null;
}) {
  const {
    nav,
    autoRefreshEnabled,
    pageVisible,
    selectedAccount
  } = options;
  if (!autoRefreshEnabled || !pageVisible || !selectedAccount) {
    return false;
  }
  if (selectedAccount.sessionState !== "ready") {
    return false;
  }
  return resolveAutoRefreshScope(nav) !== "none";
}

export function isSnapshotStaleForToday(
  fetchedAt: string | null | undefined,
  now: Date = new Date()
) {
  if (!fetchedAt) {
    return true;
  }

  const snapshotTime = new Date(fetchedAt);
  if (Number.isNaN(snapshotTime.getTime())) {
    return true;
  }

  return snapshotTime.toDateString() !== now.toDateString();
}
