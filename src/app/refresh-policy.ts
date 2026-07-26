import type { AccountRuntime, DesktopUiPrefs, NavKey } from "../types";

export const MIN_AUTO_REFRESH_INTERVAL_SECONDS = 5;
export const DEFAULT_AUTO_REFRESH_INTERVAL_SECONDS = 9;

export type AutoRefreshScope = "core" | "keys" | "usage" | "none";
export type AutoRefreshResource =
  | "overview"
  | "subscriptions"
  | "keys"
  | "usage"
  | "modelStats"
  | "keyUsage"
  | "trends"
  | "settings"
  | "serviceStatus";

export type AutoRefreshGroupPolicy = {
  enabled: boolean;
  intervalMs: number;
};

const ACCOUNT_DATA_REFRESH_NAVS: NavKey[] = [
  "overview",
  "keys",
  "usage",
  "modelStats",
  "subscriptions",
  "keyUsage",
  "trends"
];

const AUTO_REFRESH_RESOURCE_BY_NAV: Partial<Record<NavKey, AutoRefreshResource>> = {
  overview: "overview",
  subscriptions: "subscriptions",
  keys: "keys",
  usage: "usage",
  modelStats: "modelStats",
  keyUsage: "keyUsage",
  trends: "trends",
  settings: "settings",
  serviceStatus: "serviceStatus"
};

const AUTO_REFRESH_SCOPE_BY_RESOURCE: Record<AutoRefreshResource, AutoRefreshScope> = {
  overview: "core",
  subscriptions: "core",
  keys: "keys",
  usage: "usage",
  modelStats: "usage",
  keyUsage: "usage",
  trends: "usage",
  settings: "none",
  serviceStatus: "none"
};

export function shouldRefreshAccountData(nav: NavKey) {
  return ACCOUNT_DATA_REFRESH_NAVS.includes(nav);
}

export function shouldRefreshCoreForNav(nav: NavKey) {
  return resolveAutoRefreshScope(nav) === "core";
}

export function shouldHydrateOverviewRealtime(options: {
  nav: NavKey;
  pageVisible: boolean;
  windowFocused: boolean;
  allowUnfocusedInitialHydration?: boolean;
}) {
  const {
    nav,
    pageVisible,
    windowFocused,
    allowUnfocusedInitialHydration = false
  } = options;

  return (
    nav === "overview"
    && pageVisible
    && (windowFocused || allowUnfocusedInitialHydration)
  );
}

export function normalizeAutoRefreshIntervalSeconds(value: number | null | undefined) {
  if (!Number.isFinite(value)) {
    return DEFAULT_AUTO_REFRESH_INTERVAL_SECONDS;
  }
  return Math.max(MIN_AUTO_REFRESH_INTERVAL_SECONDS, Math.round(value ?? DEFAULT_AUTO_REFRESH_INTERVAL_SECONDS));
}

export function resolveAutoRefreshScope(nav: NavKey): AutoRefreshScope {
  const resource = getAutoRefreshResourceForNav(nav);
  return resource ? resolveAutoRefreshScopeForResource(resource) : "none";
}

export function getAutoRefreshResourceForNav(nav: NavKey): AutoRefreshResource | null {
  return AUTO_REFRESH_RESOURCE_BY_NAV[nav] ?? null;
}

export function resolveAutoRefreshScopeForResource(resource: AutoRefreshResource): AutoRefreshScope {
  return AUTO_REFRESH_SCOPE_BY_RESOURCE[resource];
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

export function resolveAutoRefreshGroupPolicy(
  prefs: DesktopUiPrefs,
  scope: Exclude<AutoRefreshScope, "none">
): AutoRefreshGroupPolicy {
  return {
    enabled: prefs.autoRefreshEnabled && isAutoRefreshScopeEnabled(prefs, scope),
    intervalMs: resolveAutoRefreshIntervalSecondsForScope(prefs, scope) * 1000
  };
}

export function resolveServiceStatusAutoRefreshPolicy(
  prefs: DesktopUiPrefs
): AutoRefreshGroupPolicy {
  return {
    enabled: prefs.autoRefreshEnabled && prefs.autoRefreshServiceStatusEnabled,
    intervalMs: normalizeAutoRefreshIntervalSeconds(prefs.autoRefreshIntervalSeconds) * 1000
  };
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

export function shouldRefreshSwitchRulesOnSettingsOpen(options: {
  nav: NavKey;
  pageVisible: boolean;
  selectedAccount: AccountRuntime | null;
  fetchedAt: string | null | undefined;
  now?: Date;
}) {
  const {
    nav,
    pageVisible,
    selectedAccount,
    fetchedAt,
    now
  } = options;
  return (
    nav === "settings"
    && pageVisible
    && Boolean(selectedAccount)
    && selectedAccount?.sessionState === "ready"
    && isAccountDataStaleForToday(fetchedAt, now)
  );
}
