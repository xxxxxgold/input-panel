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
  const refreshTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const lastReportedRequestErrorRef = useRef<string | null>(null);
  const lastKnownHealthRef = useRef<"healthy" | "degraded" | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      setStatus(null);
      setLastError(null);
      setLoading(false);
      setRefreshing(false);
      lastReportedRequestErrorRef.current = null;
      lastKnownHealthRef.current = null;
      return;
    }

    let cancelled = false;

    function syncStatusTransition(next: ServiceStatusPayload, shouldNotify: boolean) {
      const nextHealth = resolveServiceStatusHealthState(next);
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

    async function run(initial = false) {
      if (!mountedRef.current || cancelled) {
        return;
      }
      if (initial) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }
      try {
        const next = await getServiceStatus();
        if (!mountedRef.current || cancelled) {
          return;
        }
        setStatus(next);
        setLastError(null);
        lastReportedRequestErrorRef.current = null;
        syncStatusTransition(next, !initial);
      } catch (cause) {
        if (!mountedRef.current || cancelled) {
          return;
        }
        const message = (cause as Error).message;
        setLastError(message);
        if (lastReportedRequestErrorRef.current !== message) {
          setError(message);
          lastReportedRequestErrorRef.current = message;
        }
      } finally {
        if (!mountedRef.current || cancelled) {
          return;
        }
        setLoading(false);
        setRefreshing(false);
        if (autoRefresh) {
          refreshTimerRef.current = window.setTimeout(() => {
            void run(false);
          }, refreshIntervalMs);
        }
      }
    }

    void run(true);

    return () => {
      cancelled = true;
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
    };
  }, [autoRefresh, enabled, notifyStatusTransition, refreshIntervalMs, setError]);

  async function refreshNow() {
    if (!enabled) {
      return;
    }
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    setRefreshing(true);
    try {
      const next = await getServiceStatus();
      if (!mountedRef.current) {
        return;
      }
      setStatus(next);
      setLastError(null);
      lastReportedRequestErrorRef.current = null;
      lastKnownHealthRef.current = resolveServiceStatusHealthState(next);
    } catch (cause) {
      if (!mountedRef.current) {
        return;
      }
      const message = (cause as Error).message;
      setLastError(message);
      if (lastReportedRequestErrorRef.current !== message) {
        setError(message);
        lastReportedRequestErrorRef.current = message;
      }
    } finally {
      if (!mountedRef.current) {
        return;
      }
      setLoading(false);
      setRefreshing(false);
      if (autoRefresh) {
        refreshTimerRef.current = window.setTimeout(() => {
          void refreshNow();
        }, refreshIntervalMs);
      }
    }
  }

  return {
    status,
    loading,
    refreshing,
    lastError,
    refreshNow
  };
}

export function describeServiceStatusFailure(status: ServiceStatusPayload | null) {
  return describeServiceStatusIssue(status);
}
