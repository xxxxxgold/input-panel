import { useEffect, useRef, useState } from "react";

import { getServiceStatus } from "./client";
import {
  buildServiceStatusModelHealthMap,
  buildServiceStatusModelTransitionEvents,
  buildServiceStatusMonitorRecoveredEvent,
  buildServiceStatusMonitorUnavailableEvent,
  describeServiceStatusIssue,
  type ServiceStatusModelHealthMap,
  type ServiceStatusTransitionEvent
} from "./notifications";
import type { ServiceStatusPayload } from "../../types";

const REFRESH_INTERVAL_MS = 5000;
type ServiceStatusRefreshSource = "page" | "topbar" | null;
export type ServiceStatusRefreshMode = "foreground" | "background";
export type ServiceStatusRefreshResult = "success" | "cancelled";

export function useServiceStatusWorkspace(options: {
  setError: (message: string | null) => void;
  notifyStatusTransition?: (event: ServiceStatusTransitionEvent) => void;
  refreshIntervalMs?: number;
  autoRefresh?: boolean;
  notifyInitialStatus?: boolean;
  enabled?: boolean;
}) {
  const {
    setError,
    notifyStatusTransition,
    refreshIntervalMs = REFRESH_INTERVAL_MS,
    autoRefresh = true,
    notifyInitialStatus = false,
    enabled = true
  } = options;
  const [status, setStatus] = useState<ServiceStatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshingSource, setRefreshingSource] = useState<ServiceStatusRefreshSource>(null);
  const [requestInFlight, setRequestInFlight] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const lastReportedRequestErrorRef = useRef<string | null>(null);
  const lastKnownModelsRef = useRef<ServiceStatusModelHealthMap | null>(null);
  const monitorRequestFailedRef = useRef(false);
  const lifecycleTokenRef = useRef(0);
  const activeRequestRef = useRef<{ id: number; token: number } | null>(null);
  const requestSequenceRef = useRef(0);
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

  function reportRequestError(message: string, mode: ServiceStatusRefreshMode) {
    setLastError(message);
    if (mode === "foreground" && lastReportedRequestErrorRef.current !== message) {
      setErrorRef.current(message);
      lastReportedRequestErrorRef.current = message;
    }
  }

  function syncStatusTransition(next: ServiceStatusPayload, shouldNotify: boolean) {
    const { events, nextModels } = buildServiceStatusModelTransitionEvents({
      previousModels: lastKnownModelsRef.current,
      nextStatus: next,
      notifyInitialFailures: shouldNotify
    });
    lastKnownModelsRef.current = nextModels;
    const notifyStatusTransition = notifyStatusTransitionRef.current;
    if (!shouldNotify || !notifyStatusTransition) {
      monitorRequestFailedRef.current = false;
      return;
    }

    if (monitorRequestFailedRef.current) {
      notifyStatusTransition(buildServiceStatusMonitorRecoveredEvent());
      monitorRequestFailedRef.current = false;
    }
    for (const event of events) {
      notifyStatusTransition(event);
    }
  }

  function reportMonitorRequestFailure(message: string, shouldNotify: boolean) {
    const notifyStatusTransition = notifyStatusTransitionRef.current;
    if (!shouldNotify || !notifyStatusTransition || monitorRequestFailedRef.current) {
      return;
    }
    const failedAt = new Date().toISOString();
    monitorRequestFailedRef.current = true;
    notifyStatusTransition(buildServiceStatusMonitorUnavailableEvent(
      failedAt,
      `无法读取 Input 服务状态: ${message}`
    ));
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
        token,
        refreshSource: null,
        mode: "background"
      }).catch(() => undefined);
    }, refreshIntervalMsRef.current);
  }

  async function executeRefresh(options: {
    initial: boolean;
    notifyTransition: boolean;
    token: number;
    refreshSource: ServiceStatusRefreshSource;
    mode: ServiceStatusRefreshMode;
  }): Promise<ServiceStatusRefreshResult> {
    const { initial, notifyTransition, token, refreshSource, mode } = options;
    const activeRequest = activeRequestRef.current;
    if (
      !mountedRef.current
      || !enabledRef.current
      || token !== lifecycleTokenRef.current
      || activeRequest?.token === token
    ) {
      return "cancelled";
    }

    const requestId = ++requestSequenceRef.current;
    activeRequestRef.current = { id: requestId, token };
    setRequestInFlight(true);
    if (initial) {
      setLoading(true);
    } else if (refreshSource) {
      setRefreshingSource(refreshSource);
    }

    try {
      const next = await getServiceStatus();
      if (!mountedRef.current || token !== lifecycleTokenRef.current) {
        return "cancelled";
      }
      setStatus(next);
      setLastSyncedAt(Date.now());
      setLastError(null);
      lastReportedRequestErrorRef.current = null;
      syncStatusTransition(next, notifyTransition);
    } catch (cause) {
      if (!mountedRef.current || token !== lifecycleTokenRef.current) {
        return "cancelled";
      }
      const message = (cause as Error).message;
      reportRequestError(message, mode);
      reportMonitorRequestFailure(message, notifyTransition);
      throw cause;
    } finally {
      const isActiveRequest = activeRequestRef.current?.id === requestId;
      if (isActiveRequest) {
        activeRequestRef.current = null;
      }
      if (isActiveRequest && mountedRef.current && token === lifecycleTokenRef.current) {
        setLoading(false);
        setRefreshingSource(null);
        setRequestInFlight(false);
        scheduleNextRefresh(token);
      }
    }
    return "success";
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
      activeRequestRef.current = null;
      setStatus(null);
      setLastError(null);
      setLastSyncedAt(null);
      setLoading(false);
      setRefreshingSource(null);
      setRequestInFlight(false);
      lastReportedRequestErrorRef.current = null;
      lastKnownModelsRef.current = null;
      monitorRequestFailedRef.current = false;
      return;
    }

    void executeRefresh({
      initial: true,
      notifyTransition: notifyInitialStatus,
      token,
      refreshSource: null,
      mode: "foreground"
    }).catch(() => undefined);

    if (!autoRefresh) {
      clearRefreshTimer();
    }

    return () => {
      if (lifecycleTokenRef.current === token) {
        lifecycleTokenRef.current += 1;
      }
      clearRefreshTimer();
    };
  }, [autoRefresh, enabled, notifyInitialStatus, refreshIntervalMs]);

  async function refreshNow(options: {
    notifyTransition?: boolean;
    source?: Exclude<ServiceStatusRefreshSource, null>;
    mode?: ServiceStatusRefreshMode;
  } = {}): Promise<ServiceStatusRefreshResult> {
    const activeRequest = activeRequestRef.current;
    if (!enabledRef.current || activeRequest?.token === lifecycleTokenRef.current) {
      return "cancelled";
    }
    clearRefreshTimer();
    const token = lifecycleTokenRef.current;
    return await executeRefresh({
      initial: false,
      notifyTransition: options.notifyTransition ?? true,
      token,
      refreshSource: options.source ?? null,
      mode: options.mode ?? "foreground"
    });
  }

  function acceptExternalSnapshot(next: ServiceStatusPayload, syncedAtEpochMs: number) {
    if (!mountedRef.current || !enabledRef.current) {
      return;
    }
    setStatus(next);
    setLastSyncedAt(syncedAtEpochMs);
    setLastError(null);
    setLoading(false);
    lastReportedRequestErrorRef.current = null;
    lastKnownModelsRef.current = buildServiceStatusModelHealthMap(next);
    monitorRequestFailedRef.current = false;
  }

  return {
    status,
    loading,
    refreshing: refreshingSource === "page",
    refreshingSource,
    requestInFlight,
    lastError,
    lastSyncedAt,
    refreshNow,
    acceptExternalSnapshot
  };
}

export function describeServiceStatusFailure(status: ServiceStatusPayload | null) {
  return describeServiceStatusIssue(status);
}
