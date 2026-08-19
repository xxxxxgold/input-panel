import { useEffect, useRef, useState } from "react";

import { getCodexRadarModelIq } from "./client";
import type { CodexRadarModelIqPayload } from "../../types";
import {
  buildScopedResourceKey,
  ScopedResourceCache
} from "../../shared/state/scoped-resource-cache";

const CODEX_RADAR_MODEL_IQ_RESOURCE = "codex-radar-model-iq";
const CODEX_RADAR_MODEL_IQ_CACHE_MAX_ENTRIES = 1;
const CODEX_RADAR_MODEL_IQ_SCOPE_KEY = buildScopedResourceKey(CODEX_RADAR_MODEL_IQ_RESOURCE);

export type CodexRadarPresentationState = {
  scopeKey: string;
  hasSnapshot: boolean;
  initialLoading: boolean;
  refreshing: boolean;
  lastError: string | null;
  updatedAt: number | null;
  isStale: boolean;
};

export function useCodexRadarWorkspace() {
  const cacheRef = useRef<ScopedResourceCache<CodexRadarModelIqPayload> | null>(null);
  if (!cacheRef.current) {
    cacheRef.current = new ScopedResourceCache<CodexRadarModelIqPayload>({
      maxEntries: CODEX_RADAR_MODEL_IQ_CACHE_MAX_ENTRIES
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
    void cache.load(CODEX_RADAR_MODEL_IQ_SCOPE_KEY, getCodexRadarModelIq);
  }, [cache]);

  const entry = cache.peek(CODEX_RADAR_MODEL_IQ_SCOPE_KEY);
  const payload = entry.hasSnapshot ? entry.data ?? null : null;
  const lastError = entry.error ?? payload?.lastError ?? null;
  const presentation: CodexRadarPresentationState = {
    scopeKey: CODEX_RADAR_MODEL_IQ_SCOPE_KEY,
    hasSnapshot: entry.hasSnapshot,
    initialLoading: !entry.hasSnapshot && (entry.initialLoading || entry.status === "idle"),
    refreshing: entry.refreshing,
    lastError,
    updatedAt: entry.updatedAt,
    isStale: Boolean(payload?.isStale || (entry.hasSnapshot && lastError))
  };

  async function refresh() {
    await cache.load(CODEX_RADAR_MODEL_IQ_SCOPE_KEY, getCodexRadarModelIq, { force: true });
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
