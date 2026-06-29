import { useEffect, useRef, useState } from "react";

import { getServiceStatus } from "./client";
import {
  buildServiceStatusTransitionEvent,
  describeServiceStatusIssue,
  resolveServiceStatusHealthState,
  type ServiceStatusTransitionEvent
} from "./notifications";
import type { ServiceStatusPayload } from "../../types";

const REFRESH_INTERVAL_MS = 5000;

export function useServiceStatusWorkspace(options: {
  setError: (message: string | null) => void;
  notifyStatusTransition?: (event: ServiceStatusTransitionEvent) => void;
  refreshIntervalMs?: number;
  autoRefresh?: boolean;
  enabled?: boolean;
}) {
  const {
    setError,
    notifyStatusTransition,
    refreshIntervalMs = REFRESH_INTERVAL_MS,
    autoRefresh = true,
    enabled = true
  } = options;
  const [status, setStatus] = useState<ServiceStatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const lastReportedRequestErrorRef = useRef<string | null>(null);
  const lastKnownHealthRef = useRef<"healthy" | "degraded" | null>(null);
  const lifecycleTokenRef = useRef(0);
  const requestInFlightRef = useRef(false);
  const enabledRef = useRef(enabled);
  const autoRefreshRef = useRef(autoRefresh);
  const refreshIntervalMsRef = useRef(refreshIntervalMs);
  const notifyStatusTransitionRef = useRef(notifyStatusTransition);
  const setErrorRef = useRef(setError);

  enabledRef.current = enabled;
  autoRefreshRef.current = autoRefresh;
  refreshIntervalMsRef.current = refreshIntervalMs;
  notifyStatusTransitionRef.current = notifyStatusTransition;
  setErrorRef.current = setError;

  function clearRefreshTimer() {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }

  function reportRequestError(message: string) {
    setLastError(message);
    if (lastReportedRequestErrorRef.current !== message) {
      setErrorRef.current(message);
      lastReportedRequestErrorRef.current = message;
    }
  }

  function syncStatusTransition(next: ServiceStatusPayload, shouldNotify: boolean) {
    const nextHealth = resolveServiceStatusHealthState(next);
    const notifyStatusTransition = notifyStatusTransitionRef.current;
    if (lastKnownHealthRef.current === null) {
      lastKnownHealthRef.current = nextHealth;
      return;
    }
    if (!shouldNotify || !notifyStatusTransition) {
      lastKnownHealthRef.current = nextHealth;
      return;
    }

    const event = buildServiceStatusTransitionEvent({
      previousHealth: lastKnownHealthRef.current,
      nextStatus: next
    });
    lastKnownHealthRef.current = nextHealth;
    if (!event) {
      return;
    }
    notifyStatusTransition(event);
  }

  function scheduleNextRefresh(token: number) {
    if (!mountedRef.current || !enabledRef.current || !autoRefreshRef.current || token !== lifecycleTokenRef.current) {
      return;
    }
    clearRefreshTimer();
    refreshTimerRef.current = window.setTimeout(() => {
      void executeRefresh({
        initial: false,
        notifyTransition: true,
        token
      });
    }, refreshIntervalMsRef.current);
  }

  async function executeRefresh(options: {
    initial: boolean;
    notifyTransition: boolean;
    token: number;
  }) {
    const { initial, notifyTransition, token } = options;
    if (
      !mountedRef.current
      || !enabledRef.current
      || token !== lifecycleTokenRef.current
      || requestInFlightRef.current
    ) {
      return;
    }

    requestInFlightRef.current = true;
    if (initial) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }

    try {
      const next = await getServiceStatus();
      if (!mountedRef.current || token !== lifecycleTokenRef.current) {
        return;
      }
      setStatus(next);
      setLastSyncedAt(Date.now());
      setLastError(null);
      lastReportedRequestErrorRef.current = null;
      syncStatusTransition(next, notifyTransition);
    } catch (cause) {
      if (!mountedRef.current || token !== lifecycleTokenRef.current) {
        return;
      }
      reportRequestError((cause as Error).message);
    } finally {
      requestInFlightRef.current = false;
      if (!mountedRef.current || token !== lifecycleTokenRef.current) {
        return;
      }
      setLoading(false);
      setRefreshing(false);
      scheduleNextRefresh(token);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearRefreshTimer();
    };
  }, []);

  useEffect(() => {
    lifecycleTokenRef.current += 1;
    const token = lifecycleTokenRef.current;

    if (!enabled) {
      clearRefreshTimer();
      requestInFlightRef.current = false;
      setStatus(null);
      setLastError(null);
      setLastSyncedAt(null);
      setLoading(false);
      setRefreshing(false);
      lastReportedRequestErrorRef.current = null;
      lastKnownHealthRef.current = null;
      return;
    }

    void executeRefresh({
      initial: true,
      notifyTransition: false,
      token
    });

    return () => {
      if (lifecycleTokenRef.current === token) {
        lifecycleTokenRef.current += 1;
      }
      clearRefreshTimer();
    };
  }, [autoRefresh, enabled, refreshIntervalMs]);

  async function refreshNow() {
    if (!enabledRef.current || requestInFlightRef.current) {
      return;
    }
    clearRefreshTimer();
    const token = lifecycleTokenRef.current;
    await executeRefresh({
      initial: false,
      notifyTransition: false,
      token
    });
  }

  return {
    status,
    loading,
    refreshing,
    lastError,
    lastSyncedAt,
    refreshNow
  };
}

export function describeServiceStatusFailure(status: ServiceStatusPayload | null) {
  return describeServiceStatusIssue(status);
}
