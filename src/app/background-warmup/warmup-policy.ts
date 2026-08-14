import type { NavKey } from "../../types";
import {
  getAutoRefreshResourceForNav,
  resolveAutoRefreshScopeForResource,
  type AutoRefreshResource
} from "../refresh-policy";
import type {
  WarmupEnvironment,
  WarmupGroupPolicy,
  WarmupResourceKey,
  WarmupSnapshot,
  WarmupState
} from "./warmup-types";

export const WARMUP_FOCUS_MULTIPLIER = 2;
export const WARMUP_MIN_INTERVAL_MS = 1_000;
export const WARMUP_FAILURE_COOLDOWN_MS = 30_000;

const BASE_TTL_MS: Record<WarmupResourceKey, number | null> = {
  overview: 15_000,
  subscriptions: 60_000,
  keys: 60_000,
  usage: 30_000,
  modelStats: 45_000,
  keyUsage: 30_000,
  serviceStatus: 60_000,
  settings: null
};

const STARTUP_ORDER: WarmupResourceKey[] = [
  "overview",
  "subscriptions",
  "keys",
  "usage",
  "modelStats",
  "keyUsage",
  "serviceStatus"
];

const WARMUP_RESOURCE_BY_AUTO_REFRESH_RESOURCE: Record<AutoRefreshResource, WarmupResourceKey> = {
  overview: "overview",
  subscriptions: "subscriptions",
  keys: "keys",
  usage: "usage",
  modelStats: "modelStats",
  keyUsage: "keyUsage",
  trends: "usage",
  settings: "settings",
  serviceStatus: "serviceStatus"
};

export function createIdleWarmupState(): WarmupState {
  return {
    status: "idle",
    lastSuccessAt: null,
    lastAttemptAt: null,
    errorCount: 0,
    lastError: null
  };
}

export function getWarmupResourceForNav(nav: NavKey): WarmupResourceKey | null {
  const resource = getAutoRefreshResourceForNav(nav);
  return resource ? WARMUP_RESOURCE_BY_AUTO_REFRESH_RESOURCE[resource] : null;
}

export function getBaseWarmupTtlMs(resource: WarmupResourceKey) {
  return BASE_TTL_MS[resource];
}

export function getEffectiveWarmupTtlMs(
  resource: WarmupResourceKey,
  isAppFocused: boolean,
  refreshIntervalMs = WARMUP_MIN_INTERVAL_MS
) {
  const ttl = BASE_TTL_MS[resource];
  if (ttl === null) {
    return null;
  }
  const minimumInterval = Math.max(
    WARMUP_MIN_INTERVAL_MS,
    Math.round(refreshIntervalMs)
  );
  if (!isAppFocused) {
    return Math.max(ttl, minimumInterval);
  }
  return Math.max(Math.round(ttl / WARMUP_FOCUS_MULTIPLIER), minimumInterval);
}

export function getStartupWarmupOrder() {
  return [...STARTUP_ORDER];
}

export function getWarmupResourcePolicy(
  resource: WarmupResourceKey,
  environment: WarmupEnvironment
): WarmupGroupPolicy | null {
  if (resource === "settings") {
    return null;
  }
  if (resource === "serviceStatus") {
    return environment.serviceStatusPolicy;
  }
  const scope = resolveAutoRefreshScopeForResource(resource);
  return scope === "none" ? null : environment.groupPolicies[scope];
}

export function shouldWarmupResource(resource: WarmupResourceKey, environment: WarmupEnvironment) {
  if (!environment.isAppFocused) {
    return false;
  }
  const policy = getWarmupResourcePolicy(resource, environment);
  if (!policy?.enabled) {
    return false;
  }
  if (resource === "serviceStatus") {
    return true;
  }
  if (resource === "overview") {
    return environment.overviewReady;
  }
  if (!environment.overviewReady || !environment.selectedAccountId || !environment.selectedAccountReady) {
    return false;
  }
  return true;
}

export function isWarmupStateStale(
  resource: WarmupResourceKey,
  state: WarmupState,
  now: number,
  environment: WarmupEnvironment
) {
  const policy = getWarmupResourcePolicy(resource, environment);
  if (!policy) {
    return false;
  }
  const ttl = getEffectiveWarmupTtlMs(
    resource,
    environment.isAppFocused,
    policy.intervalMs
  );
  if (ttl === null) {
    return false;
  }
  if (!state.lastSuccessAt) {
    return true;
  }
  return now - state.lastSuccessAt >= ttl;
}

export function shouldAttemptWarmup(
  resource: WarmupResourceKey,
  state: WarmupState,
  environment: WarmupEnvironment,
  now: number
) {
  if (!shouldWarmupResource(resource, environment)) {
    return false;
  }
  if (state.status === "warming") {
    return false;
  }
  if (
    state.status === "failed"
    && state.lastAttemptAt !== null
    && now - state.lastAttemptAt < WARMUP_FAILURE_COOLDOWN_MS
  ) {
    return false;
  }
  return isWarmupStateStale(
    resource,
    state,
    now,
    environment
  );
}

export function getWarmupNextEligibleAt(
  resource: WarmupResourceKey,
  state: WarmupState,
  environment: WarmupEnvironment,
  now: number
) {
  if (!shouldWarmupResource(resource, environment) || state.status === "warming") {
    return null;
  }
  if (state.status === "failed" && state.lastAttemptAt !== null) {
    return Math.max(now, state.lastAttemptAt + WARMUP_FAILURE_COOLDOWN_MS);
  }
  const policy = getWarmupResourcePolicy(resource, environment);
  if (!policy) {
    return null;
  }
  const ttl = getEffectiveWarmupTtlMs(resource, environment.isAppFocused, policy.intervalMs);
  if (ttl === null) {
    return null;
  }
  if (state.status === "cancelled") {
    const retryAt = state.lastAttemptAt === null
      ? now
      : state.lastAttemptAt + policy.intervalMs;
    const expiryAt = state.lastSuccessAt === null
      ? retryAt
      : state.lastSuccessAt + ttl;
    return Math.max(now, retryAt, expiryAt);
  }
  if (state.lastSuccessAt === null || state.status === "stale") {
    return now;
  }
  return Math.max(now, state.lastSuccessAt + ttl);
}

export function getNextWarmupCandidate(
  snapshot: WarmupSnapshot,
  environment: WarmupEnvironment,
  now: number
) {
  const currentResource = getWarmupResourceForNav(environment.nav);
  const prioritized = currentResource ? [currentResource, ...STARTUP_ORDER.filter((item) => item !== currentResource)] : STARTUP_ORDER;
  for (const resource of prioritized) {
    if (shouldAttemptWarmup(resource, snapshot[resource], environment, now)) {
      return resource;
    }
  }
  return null;
}
