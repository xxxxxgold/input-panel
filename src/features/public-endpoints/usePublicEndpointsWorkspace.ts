import { useEffect, useRef, useState } from "react";

import { getSitePublicEndpoints, pingSitePublicEndpoints, syncSitePublicEndpoints } from "./client";
import { useStableCallback } from "../../shared/hooks/useStableCallback";
import type { SitePublicEndpointsPayload, SiteRecord } from "../../types";
import {
  buildScopedResourceKey,
  ScopedResourceCache,
  type ScopedResourceEntry
} from "../../shared/state/scoped-resource-cache";

const DEFAULT_PUBLIC_ENDPOINT_PING_INTERVAL_MS = 45_000;
const PUBLIC_ENDPOINT_CACHE_MAX_ENTRIES = 32;
const PUBLIC_ENDPOINT_RESOURCE = "site-public-endpoints";

type PublicEndpointsSnapshot = {
  payload: SitePublicEndpointsPayload | null;
  siteVersion: string;
  synced: boolean;
};

type PublicEndpointsCache = ScopedResourceCache<PublicEndpointsSnapshot>;

export type PublicEndpointsPresentationState = {
  scopeKey: string | null;
  siteId: string | null;
  hasSnapshot: boolean;
  initialLoading: boolean;
  refreshing: boolean;
  lastError: string | null;
  updatedAt: number | null;
};

export function buildSitePublicEndpointsSessionKey(site: Pick<SiteRecord, "id" | "updatedAt">) {
  return buildScopedResourceKey(PUBLIC_ENDPOINT_RESOURCE, { siteId: site.id });
}

function emptyEntry(): ScopedResourceEntry<PublicEndpointsSnapshot> {
  return {
    hasSnapshot: false,
    data: undefined,
    status: "idle",
    initialLoading: false,
    refreshing: false,
    error: null,
    updatedAt: null,
    requestId: 0
  };
}

export function usePublicEndpointsWorkspace(options: {
  selectedSite: SiteRecord | null;
  autoPingEnabled?: boolean;
  refreshIntervalMs?: number;
}) {
  const {
    selectedSite,
    autoPingEnabled = false,
    refreshIntervalMs = DEFAULT_PUBLIC_ENDPOINT_PING_INTERVAL_MS
  } = options;
  const cacheRef = useRef<PublicEndpointsCache | null>(null);
  if (!cacheRef.current) {
    cacheRef.current = new ScopedResourceCache<PublicEndpointsSnapshot>({
      maxEntries: PUBLIC_ENDPOINT_CACHE_MAX_ENTRIES
    });
  }
  const cache = cacheRef.current;
  const [, setCacheRevision] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [pinging, setPinging] = useState(false);
  const requestTokenRef = useRef(0);
  const pingTokenRef = useRef(0);
  const activeSiteRef = useRef<SiteRecord | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const pingRequestTokenRef = useRef<number | null>(null);
  const syncingSiteKeyRef = useRef<string | null>(null);
  const refreshIntervalMsRef = useRef(refreshIntervalMs);
  const autoPingEnabledRef = useRef(autoPingEnabled);
  const selectedSiteRef = useRef(selectedSite);

  refreshIntervalMsRef.current = refreshIntervalMs;
  autoPingEnabledRef.current = autoPingEnabled;
  selectedSiteRef.current = selectedSite;

  useEffect(() => {
    return cache.subscribe(() => {
      setCacheRevision((value) => value + 1);
    });
  }, [cache]);

  function clearRefreshTimer() {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }

  function invalidateSite(siteId: string) {
    cache.invalidate(buildScopedResourceKey(PUBLIC_ENDPOINT_RESOURCE, { siteId }));
    if (activeSiteRef.current?.id === siteId) {
      requestTokenRef.current += 1;
      pingTokenRef.current += 1;
      syncingSiteKeyRef.current = null;
      pingRequestTokenRef.current = null;
      clearRefreshTimer();
      setSyncing(false);
      setPinging(false);
    }
  }

  function invalidateAllSites() {
    cache.clear();
    requestTokenRef.current += 1;
    pingTokenRef.current += 1;
    syncingSiteKeyRef.current = null;
    pingRequestTokenRef.current = null;
    clearRefreshTimer();
    setSyncing(false);
    setPinging(false);
  }

  const runSite = async (
    site: SiteRecord,
    options: { forceRead?: boolean; forceSync?: boolean } = {}
  ) => {
    const token = ++requestTokenRef.current;
    pingTokenRef.current += 1;
    pingRequestTokenRef.current = null;
    clearRefreshTimer();
    setPinging(false);
    const sessionKey = buildSitePublicEndpointsSessionKey(site);
    const previousEntry = cache.peek(sessionKey);
    const versionChanged = previousEntry.hasSnapshot
      && previousEntry.data?.siteVersion !== site.updatedAt;
    const shouldSync = options.forceSync === true
      || versionChanged
      || previousEntry.data?.synced !== true;
    syncingSiteKeyRef.current = null;
    setSyncing(false);

    const cached = await cache.load(
      sessionKey,
      async () => {
        const next = await getSitePublicEndpoints(site.id);
        const previousSnapshot = previousEntry.hasSnapshot ? previousEntry.data : undefined;
        if (next === null && previousSnapshot) {
          return previousSnapshot;
        }
        return {
          payload: next,
          siteVersion: site.updatedAt,
          synced: previousSnapshot?.siteVersion === site.updatedAt
            ? previousSnapshot.synced
            : false
        };
      },
      { force: options.forceRead || versionChanged || !previousEntry.hasSnapshot }
    );
    if (token !== requestTokenRef.current || selectedSiteRef.current?.id !== site.id) {
      return;
    }

    if (!shouldSync) {
      return;
    }

    if (
      cached.status === "success"
      && cached.data.payload === null
      && previousEntry.data?.payload == null
    ) {
      cache.invalidate(sessionKey);
    }

    syncingSiteKeyRef.current = sessionKey;
    setSyncing(true);
    try {
      const synced = await cache.load(
        sessionKey,
        async () => ({
          payload: await syncSitePublicEndpoints(site.id),
          siteVersion: site.updatedAt,
          synced: true
        }),
        { force: true }
      );
      if (token !== requestTokenRef.current || selectedSiteRef.current?.id !== site.id) {
        return;
      }
      if (synced.status === "cancelled") {
        return;
      }
    } finally {
      if (token === requestTokenRef.current && selectedSiteRef.current?.id === site.id) {
        syncingSiteKeyRef.current = null;
        setSyncing(false);
      }
    }
  };

  useEffect(() => {
    const previousSite = activeSiteRef.current;
    if (!selectedSite) {
      if (previousSite) {
        invalidateSite(previousSite.id);
      } else {
        requestTokenRef.current += 1;
        pingTokenRef.current += 1;
        pingRequestTokenRef.current = null;
        clearRefreshTimer();
      }
      activeSiteRef.current = null;
      syncingSiteKeyRef.current = null;
      setSyncing(false);
      setPinging(false);
      return;
    }

    const previousEntry = cache.peek(buildSitePublicEndpointsSessionKey(selectedSite));
    const activeVersionChanged = previousSite?.id === selectedSite.id
      && previousSite.updatedAt !== selectedSite.updatedAt;
    const cachedVersionChanged = previousEntry.hasSnapshot
      && previousEntry.data?.siteVersion !== selectedSite.updatedAt;
    activeSiteRef.current = selectedSite;
    pingTokenRef.current += 1;
    pingRequestTokenRef.current = null;
    clearRefreshTimer();
    void runSite(selectedSite, { forceRead: activeVersionChanged || cachedVersionChanged });

    return () => {
      requestTokenRef.current += 1;
      pingTokenRef.current += 1;
      pingRequestTokenRef.current = null;
      syncingSiteKeyRef.current = null;
      clearRefreshTimer();
    };
  }, [cache, selectedSite?.id, selectedSite?.updatedAt]);

  const cachedEndpointEntry = selectedSite
    ? cache.peek(buildSitePublicEndpointsSessionKey(selectedSite))
    : emptyEntry();
  const endpointEntry = cachedEndpointEntry;
  const payload = endpointEntry.hasSnapshot ? endpointEntry.data?.payload ?? null : null;
  const lastError = endpointEntry.error ?? payload?.lastError ?? null;
  const initialLoading = Boolean(selectedSite)
    && !endpointEntry.hasSnapshot
    && (endpointEntry.initialLoading || endpointEntry.status === "idle");
  const presentation: PublicEndpointsPresentationState = {
    scopeKey: selectedSite ? buildSitePublicEndpointsSessionKey(selectedSite) : null,
    siteId: selectedSite?.id ?? null,
    hasSnapshot: endpointEntry.hasSnapshot,
    initialLoading,
    refreshing: endpointEntry.refreshing,
    lastError,
    updatedAt: endpointEntry.updatedAt
  };

  const endpointFingerprint = payload?.endpoints.map((item) => `${item.name}::${item.endpoint}`).join("|") ?? "";

  function scheduleNextAutoPing(token: number) {
    if (!autoPingEnabledRef.current || token !== pingTokenRef.current) {
      return;
    }

    clearRefreshTimer();
    refreshTimerRef.current = window.setTimeout(() => {
      const currentSite = selectedSiteRef.current;
      if (!currentSite) {
        return;
      }
      void executeAutoPing(currentSite.id, token);
    }, refreshIntervalMsRef.current);
  }

  const executeAutoPing = useStableCallback(async (siteId: string, token: number) => {
    if (
      !autoPingEnabledRef.current
      || pingRequestTokenRef.current !== null
      || syncingSiteKeyRef.current !== null
      || token !== pingTokenRef.current
    ) {
      return;
    }

    pingRequestTokenRef.current = token;
    setPinging(true);
    try {
      await cache.load(
        buildScopedResourceKey(PUBLIC_ENDPOINT_RESOURCE, { siteId }),
        async () => {
          const site = selectedSiteRef.current;
          const current = cache.peek(buildScopedResourceKey(PUBLIC_ENDPOINT_RESOURCE, { siteId })).data;
          return {
            payload: await pingSitePublicEndpoints(siteId),
            siteVersion: site?.id === siteId ? site.updatedAt : current?.siteVersion ?? "",
            synced: current?.synced ?? false
          };
        },
        { force: true }
      );
    } finally {
      if (pingRequestTokenRef.current === token) {
        pingRequestTokenRef.current = null;
      }
      if (token === pingTokenRef.current) {
        setPinging(false);
        scheduleNextAutoPing(token);
      }
    }
  });

  useEffect(() => {
    pingTokenRef.current += 1;
    const token = pingTokenRef.current;
    pingRequestTokenRef.current = null;
    clearRefreshTimer();

    if (!autoPingEnabled) {
      setPinging(false);
      return;
    }

    if (!selectedSite || syncing || !payload || payload.endpoints.length <= 0) {
      return;
    }

    void executeAutoPing(selectedSite.id, token);

    return () => {
      if (pingTokenRef.current === token) {
        pingTokenRef.current += 1;
      }
      if (pingRequestTokenRef.current === token) {
        pingRequestTokenRef.current = null;
      }
      clearRefreshTimer();
    };
  }, [
    selectedSite?.id,
    selectedSite?.updatedAt,
    autoPingEnabled,
    endpointFingerprint,
    refreshIntervalMs,
    syncing,
    executeAutoPing
  ]);

  async function refresh(options: { mode?: "sync" | "ping" } = {}) {
    const site = selectedSiteRef.current;
    if (!site) {
      return;
    }
    if (options.mode === "ping") {
      const token = ++pingTokenRef.current;
      await executeAutoPing(site.id, token);
      return;
    }
    await runSite(site, { forceRead: true, forceSync: true });
  }

  return {
    payload,
    loading: presentation.initialLoading,
    syncing,
    pinging,
    lastError,
    presentation,
    refresh,
    retry: refresh,
    invalidateSite,
    invalidateAllSites
  };
}
