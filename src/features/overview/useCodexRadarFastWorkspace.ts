import { useEffect, useRef, useState } from "react";

import { getCodexRadarFast } from "./client";
import type { CodexRadarFastRadarPayload } from "../../types";
import {
  buildScopedResourceKey,
  ScopedResourceCache
} from "../../shared/state/scoped-resource-cache";

const CODEX_RADAR_FAST_RESOURCE = "codex-radar-fast";
const CODEX_RADAR_FAST_CACHE_MAX_ENTRIES = 1;
const CODEX_RADAR_FAST_SCOPE_KEY = buildScopedResourceKey(CODEX_RADAR_FAST_RESOURCE);

export type CodexRadarFastPresentationState = {
  scopeKey: string;
  hasSnapshot: boolean;
  initialLoading: boolean;
  refreshing: boolean;
  lastError: string | null;
  updatedAt: number | null;
  isStale: boolean;
};

export type CodexRadarFastWorkspaceOptions = {
  enabled?: boolean;
};

export function useCodexRadarFastWorkspace(
  options: CodexRadarFastWorkspaceOptions = {}
) {
  const enabled = options.enabled ?? true;
  const cacheRef = useRef<ScopedResourceCache<CodexRadarFastRadarPayload> | null>(null);
  if (!cacheRef.current) {
    cacheRef.current = new ScopedResourceCache<CodexRadarFastRadarPayload>({
      maxEntries: CODEX_RADAR_FAST_CACHE_MAX_ENTRIES
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
    const entry = cache.peek(CODEX_RADAR_FAST_SCOPE_KEY);
    if (!enabled || entry.hasSnapshot || entry.status !== "idle") {
      return;
    }
    void cache.load(CODEX_RADAR_FAST_SCOPE_KEY, getCodexRadarFast);
  }, [cache, enabled]);

  const entry = cache.peek(CODEX_RADAR_FAST_SCOPE_KEY);
  const payload = entry.hasSnapshot ? entry.data ?? null : null;
  const lastError = entry.error ?? payload?.lastError ?? null;
  const presentation: CodexRadarFastPresentationState = {
    scopeKey: CODEX_RADAR_FAST_SCOPE_KEY,
    hasSnapshot: entry.hasSnapshot,
    initialLoading: !entry.hasSnapshot && (entry.initialLoading || entry.status === "idle"),
    refreshing: entry.refreshing,
    lastError,
    updatedAt: entry.updatedAt,
    isStale: Boolean(payload?.isStale || (entry.hasSnapshot && lastError))
  };

  async function refresh() {
    await cache.load(CODEX_RADAR_FAST_SCOPE_KEY, getCodexRadarFast, { force: true });
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
