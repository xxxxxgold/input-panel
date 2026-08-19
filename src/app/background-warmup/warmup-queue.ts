import {
  createIdleWarmupState,
  getWarmupNextEligibleAt,
  getNextWarmupCandidate,
  isWarmupStateStale
} from "./warmup-policy";
import type {
  WarmupEnvironment,
  WarmupResourceKey,
  WarmupSnapshot,
  WarmupTask
} from "./warmup-types";
import { WARMUP_RESOURCE_KEYS } from "./warmup-types";

export function createInitialWarmupSnapshot(): WarmupSnapshot {
  return {
    overview: createIdleWarmupState(),
    subscriptions: createIdleWarmupState(),
    keys: createIdleWarmupState(),
    usage: createIdleWarmupState(),
    modelStats: createIdleWarmupState(),
    keyUsage: createIdleWarmupState(),
    serviceStatus: createIdleWarmupState(),
    settings: createIdleWarmupState()
  };
}

export function markWarmupAttempt(
  snapshot: WarmupSnapshot,
  resource: WarmupResourceKey,
  at: number
): WarmupSnapshot {
  return {
    ...snapshot,
    [resource]: {
      ...snapshot[resource],
      status: "warming",
      lastAttemptAt: at
    }
  };
}

export function markWarmupSuccess(
  snapshot: WarmupSnapshot,
  resource: WarmupResourceKey,
  at: number
): WarmupSnapshot {
  return {
    ...snapshot,
    [resource]: {
      status: "warm",
      lastSuccessAt: at,
      lastAttemptAt: at,
      errorCount: 0,
      lastError: null
    }
  };
}

export function markWarmupFailure(
  snapshot: WarmupSnapshot,
  resource: WarmupResourceKey,
  at: number,
  message: string
): WarmupSnapshot {
  const current = snapshot[resource];
  return {
    ...snapshot,
    [resource]: {
      status: "failed",
      lastSuccessAt: current.lastSuccessAt,
      lastAttemptAt: at,
      errorCount: current.errorCount + 1,
      lastError: message
    }
  };
}

export function markWarmupCancelled(
  snapshot: WarmupSnapshot,
  resource: WarmupResourceKey,
  at: number
): WarmupSnapshot {
  const current = snapshot[resource];
  return {
    ...snapshot,
    [resource]: {
      ...current,
      status: "cancelled",
      lastAttemptAt: at,
      lastError: null
    }
  };
}

export function syncWarmupStaleness(
  snapshot: WarmupSnapshot,
  environment: WarmupEnvironment,
  now: number
): WarmupSnapshot {
  let changed = false;
  const next = { ...snapshot };
  for (const resource of WARMUP_RESOURCE_KEYS) {
    const current = snapshot[resource];
    if (
      current.status === "warm"
      && isWarmupStateStale(
        resource,
        current,
        now,
        environment
      )
    ) {
      next[resource] = {
        ...current,
        status: "stale"
      };
      changed = true;
    }
  }
  return changed ? next : snapshot;
}

export function pickNextWarmupTask(
  snapshot: WarmupSnapshot,
  environment: WarmupEnvironment,
  tasks: Partial<Record<WarmupResourceKey, WarmupTask>>,
  now: number
) {
  const key = getNextWarmupCandidate(snapshot, environment, now);
  if (!key) {
    return null;
  }
  return tasks[key] ?? null;
}

export function getNextWarmupWakeAt(
  snapshot: WarmupSnapshot,
  environment: WarmupEnvironment,
  tasks: Partial<Record<WarmupResourceKey, WarmupTask>>,
  now: number
) {
  let earliest: number | null = null;
  for (const resource of WARMUP_RESOURCE_KEYS) {
    if (!tasks[resource]) {
      continue;
    }
    const eligibleAt = getWarmupNextEligibleAt(resource, snapshot[resource], environment, now);
    if (eligibleAt !== null && (earliest === null || eligibleAt < earliest)) {
      earliest = eligibleAt;
    }
  }
  return earliest;
}
