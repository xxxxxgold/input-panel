import { useEffect, useRef, useState } from "react";

import { getCodexRadarInsights } from "./client";
import type { CodexRadarInsightsPayload } from "../../types";
import {
  buildScopedResourceKey,
  ScopedResourceCache
} from "../../shared/state/scoped-resource-cache";

const CODEX_RADAR_INSIGHTS_RESOURCE = "codex-radar-insights";
const CODEX_RADAR_INSIGHTS_CACHE_MAX_ENTRIES = 1;
const CODEX_RADAR_INSIGHTS_SCOPE_KEY = buildScopedResourceKey(CODEX_RADAR_INSIGHTS_RESOURCE);

let forcedInsightsRequest: Promise<CodexRadarInsightsPayload> | null = null;

export type CodexRadarInsightsPresentationState = {
  scopeKey: string;
  hasSnapshot: boolean;
  initialLoading: boolean;
  refreshing: boolean;
  lastError: string | null;
  updatedAt: number | null;
  isStale: boolean;
};

export type CodexRadarInsightsWorkspaceOptions = {
  enabled?: boolean;
};

function loadForcedInsights() {
  if (forcedInsightsRequest) {
    return forcedInsightsRequest;
  }

  const request = getCodexRadarInsights(true).finally(() => {
    if (forcedInsightsRequest === request) {
      forcedInsightsRequest = null;
    }
  });
  forcedInsightsRequest = request;
  return request;
}

export function useCodexRadarInsightsWorkspace(
  options: CodexRadarInsightsWorkspaceOptions = {}
) {
  const enabled = options.enabled ?? true;
  const cacheRef = useRef<ScopedResourceCache<CodexRadarInsightsPayload> | null>(null);
  if (!cacheRef.current) {
    cacheRef.current = new ScopedResourceCache<CodexRadarInsightsPayload>({
      maxEntries: CODEX_RADAR_INSIGHTS_CACHE_MAX_ENTRIES
    });
  }
  const cache = cacheRef.current;
  const [, setCacheRevision] = useState(0);

  useEffect(() => {
    return cache.subscribe(() => {
      setCacheRevision((value) => value + 1);
    });
  }, [cache]);

  useEffect(() => {
    const entry = cache.peek(CODEX_RADAR_INSIGHTS_SCOPE_KEY);
    if (!enabled || entry.hasSnapshot || entry.status !== "idle") {
      return;
    }
    void cache.load(CODEX_RADAR_INSIGHTS_SCOPE_KEY, () => getCodexRadarInsights(false));
  }, [cache, enabled]);

  const entry = cache.peek(CODEX_RADAR_INSIGHTS_SCOPE_KEY);
  const payload = entry.hasSnapshot ? entry.data ?? null : null;
  const lastError = entry.error ?? payload?.lastError ?? null;
  const presentation: CodexRadarInsightsPresentationState = {
    scopeKey: CODEX_RADAR_INSIGHTS_SCOPE_KEY,
    hasSnapshot: entry.hasSnapshot,
    initialLoading: !entry.hasSnapshot && (entry.initialLoading || entry.status === "idle"),
    refreshing: entry.refreshing,
    lastError,
    updatedAt: entry.updatedAt,
    isStale: Boolean(payload?.isStale || (entry.hasSnapshot && lastError))
  };

  async function refresh() {
    await cache.load(CODEX_RADAR_INSIGHTS_SCOPE_KEY, loadForcedInsights, { force: true });
  }

  return {
    payload,
    loading: presentation.initialLoading,
    lastError,
    presentation,
    refresh,
    retry: refresh
  };
}
