import type { AccountRuntime, DesktopUiPrefs, NavKey } from "../types";

export const MIN_AUTO_REFRESH_INTERVAL_SECONDS = 1;
export const DEFAULT_AUTO_REFRESH_INTERVAL_SECONDS = 9;

export type AutoRefreshScope = "core" | "keys" | "usage" | "none";

const ACCOUNT_DATA_REFRESH_NAVS: NavKey[] = [
  "overview",
  "keys",
  "usage",
  "subscriptions",
  "keyUsage",
  "trends",
  "settings",
  "alerts"
];

const CORE_REFRESH_NAVS: NavKey[] = [
  "overview",
  "subscriptions",
  "settings",
  "alerts"
];

const AUTO_REFRESH_CORE_NAVS: NavKey[] = [
  "overview",
  "subscriptions",
  "settings",
  "alerts"
];

const AUTO_REFRESH_KEYS_NAVS: NavKey[] = [
  "keys"
];

const AUTO_REFRESH_USAGE_NAVS: NavKey[] = [
  "usage",
  "trends",
  "keyUsage"
];

export function shouldRefreshAccountData(nav: NavKey) {
  return ACCOUNT_DATA_REFRESH_NAVS.includes(nav);
}

export function shouldRefreshCoreForNav(nav: NavKey) {
  return CORE_REFRESH_NAVS.includes(nav);
}

export function normalizeAutoRefreshIntervalSeconds(value: number | null | undefined) {
  if (!Number.isFinite(value)) {
    return DEFAULT_AUTO_REFRESH_INTERVAL_SECONDS;
  }
  return Math.max(MIN_AUTO_REFRESH_INTERVAL_SECONDS, Math.round(value ?? DEFAULT_AUTO_REFRESH_INTERVAL_SECONDS));
}

export function resolveAutoRefreshScope(nav: NavKey): AutoRefreshScope {
  if (AUTO_REFRESH_CORE_NAVS.includes(nav)) {
    return "core";
  }
  if (AUTO_REFRESH_KEYS_NAVS.includes(nav)) {
    return "keys";
  }
  if (AUTO_REFRESH_USAGE_NAVS.includes(nav)) {
    return "usage";
  }
  return "none";
}

export function isAutoRefreshScopeEnabled(
  prefs: DesktopUiPrefs,
  scope: Exclude<AutoRefreshScope, "none">
) {
  switch (scope) {
    case "core":
      return prefs.autoRefreshCoreEnabled;
    case "keys":
      return prefs.autoRefreshKeysEnabled;
    case "usage":
      return prefs.autoRefreshUsageEnabled;
  }
}

export function resolveAutoRefreshIntervalSecondsForScope(
  prefs: DesktopUiPrefs,
  scope: Exclude<AutoRefreshScope, "none">
) {
  switch (scope) {
    case "core":
      return normalizeAutoRefreshIntervalSeconds(prefs.autoRefreshCoreIntervalSeconds);
    case "keys":
      return normalizeAutoRefreshIntervalSeconds(prefs.autoRefreshKeysIntervalSeconds);
    case "usage":
      return normalizeAutoRefreshIntervalSeconds(prefs.autoRefreshUsageIntervalSeconds);
  }
}

export function shouldAutoRefreshSelectedAccountData(options: {
  nav: NavKey;
  autoRefreshEnabled: boolean;
  pageVisible: boolean;
  selectedAccount: AccountRuntime | null;
  prefs: DesktopUiPrefs;
}) {
  const {
    nav,
    autoRefreshEnabled,
    pageVisible,
    selectedAccount,
    prefs
  } = options;
  if (!autoRefreshEnabled || !pageVisible || !selectedAccount) {
    return false;
  }
  if (selectedAccount.sessionState !== "ready") {
    return false;
  }
  const scope = resolveAutoRefreshScope(nav);
  if (scope === "none") {
    return false;
  }
  return isAutoRefreshScopeEnabled(prefs, scope);
}

export function buildAutoRefreshWatcherKey(options: {
  nav: NavKey;
  pageVisible: boolean;
  selectedAccount: AccountRuntime | null;
  prefs: DesktopUiPrefs;
}) {
  const {
    nav,
    pageVisible,
    selectedAccount,
    prefs
  } = options;
  return [
    nav,
    pageVisible ? "visible" : "hidden",
    selectedAccount?.id ?? "none",
    selectedAccount?.sessionState ?? "none",
    prefs.autoRefreshEnabled ? "1" : "0",
    prefs.autoRefreshCoreEnabled ? "1" : "0",
    normalizeAutoRefreshIntervalSeconds(prefs.autoRefreshCoreIntervalSeconds),
    prefs.autoRefreshKeysEnabled ? "1" : "0",
    normalizeAutoRefreshIntervalSeconds(prefs.autoRefreshKeysIntervalSeconds),
    prefs.autoRefreshUsageEnabled ? "1" : "0",
    normalizeAutoRefreshIntervalSeconds(prefs.autoRefreshUsageIntervalSeconds)
  ].join("|");
}

export function isAccountDataStaleForToday(
  fetchedAt: string | null | undefined,
  now: Date = new Date()
) {
  if (!fetchedAt) {
    return true;
  }

  const cacheViewTime = new Date(fetchedAt);
  if (Number.isNaN(cacheViewTime.getTime())) {
    return true;
  }

  return cacheViewTime.toDateString() !== now.toDateString();
}
