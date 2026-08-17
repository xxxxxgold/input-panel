import { useCallback, useEffect, useRef, useState } from "react";

import type { SiteFailoverStatusPayload, SiteRecord } from "../../types";
import {
  clearSiteFailoverCooldown,
  getSiteFailoverStatus
} from "./client";
import {
  getSiteCooldownRemainingSeconds,
  isSiteFailoverStatusForSite
} from "./site-config-draft";

export interface SiteFailoverAddressAction {
  clearing: boolean;
  error: string | null;
}

type SiteFailoverStatusListener = (status: SiteFailoverStatusPayload) => void;

const siteFailoverStatusListeners = new Set<SiteFailoverStatusListener>();

/** 编辑弹窗完成操作后，将后端返回的最新快照同步给当前站点详情。 */
export function publishSiteFailoverStatus(status: SiteFailoverStatusPayload) {
  for (const listener of siteFailoverStatusListeners) {
    listener(status);
  }
}

function subscribeToSiteFailoverStatus(listener: SiteFailoverStatusListener) {
  siteFailoverStatusListeners.add(listener);
  return () => {
    siteFailoverStatusListeners.delete(listener);
  };
}

/** 当前选中站点的实时故障转移状态，独立于编辑弹窗的草稿生命周期。 */
export function useSiteFailoverStatus(site: SiteRecord | null) {
  const siteId = site?.id ?? null;
  const siteScopeKey = createSiteFailoverStatusScopeKey(site);
  const [status, setStatus] = useState<SiteFailoverStatusPayload | null>(null);
  const [statusScopeKey, setStatusScopeKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(siteId));
  const [error, setError] = useState<string | null>(null);
  const [errorScopeKey, setErrorScopeKey] = useState<string | null>(null);
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [nowMs, setNowMs] = useState(Date.now());
  const [addressActions, setAddressActions] = useState<Record<string, SiteFailoverAddressAction>>({});
  const activeSiteRef = useRef(site);
  const activeSiteScopeKeyRef = useRef(siteScopeKey);
  const statusRequestSequenceRef = useRef(0);
  /** 站点范围或外部快照切换时递增，阻止旧解除请求回写重新打开的相同配置。 */
  const statusSessionSequenceRef = useRef(0);
  const clearRequestSequenceRef = useRef(0);
  const activeClearRequestIdRef = useRef<number | null>(null);
  const expiredStatusRefreshKeyRef = useRef<string | null>(null);
  activeSiteRef.current = site;
  activeSiteScopeKeyRef.current = siteScopeKey;

  const commitStatus = useCallback((nextStatus: SiteFailoverStatusPayload, scopeKey: string) => {
    const serverNowMs = Date.parse(nextStatus.serverNow);
    const nextServerOffsetMs = Number.isFinite(serverNowMs)
      ? serverNowMs - Date.now()
      : 0;
    setServerOffsetMs(nextServerOffsetMs);
    setNowMs(Date.now() + nextServerOffsetMs);
    setStatus(nextStatus);
    setStatusScopeKey(scopeKey);
    setError(null);
    setErrorScopeKey(null);
  }, []);

  const refresh = useCallback(async () => {
    if (!siteId || !siteScopeKey) {
      return;
    }

    const requestSequence = ++statusRequestSequenceRef.current;
    setLoading(true);
    setError(null);
    setErrorScopeKey(null);
    try {
      const nextStatus = await getSiteFailoverStatus(siteId);
      if (
        activeSiteScopeKeyRef.current !== siteScopeKey
        || requestSequence !== statusRequestSequenceRef.current
        || !isSiteFailoverStatusForSite(nextStatus, activeSiteRef.current)
      ) {
        return;
      }
      commitStatus(nextStatus, siteScopeKey);
    } catch (cause) {
      if (
        activeSiteScopeKeyRef.current === siteScopeKey
        && requestSequence === statusRequestSequenceRef.current
      ) {
        setError((cause as Error).message);
        setErrorScopeKey(siteScopeKey);
      }
    } finally {
      if (
        activeSiteScopeKeyRef.current === siteScopeKey
        && requestSequence === statusRequestSequenceRef.current
      ) {
        setLoading(false);
      }
    }
  }, [commitStatus, siteId, siteScopeKey]);

  useEffect(() => {
    return subscribeToSiteFailoverStatus((nextStatus) => {
      const currentSite = activeSiteRef.current;
      const currentScopeKey = activeSiteScopeKeyRef.current;
      if (!currentScopeKey || !isSiteFailoverStatusForSite(nextStatus, currentSite)) {
        return;
      }
      statusRequestSequenceRef.current += 1;
      statusSessionSequenceRef.current += 1;
      activeClearRequestIdRef.current = null;
      expiredStatusRefreshKeyRef.current = null;
      setAddressActions({});
      setLoading(false);
      commitStatus(nextStatus, currentScopeKey);
    });
  }, [commitStatus]);

  useEffect(() => {
    statusRequestSequenceRef.current += 1;
    statusSessionSequenceRef.current += 1;
    activeClearRequestIdRef.current = null;
    expiredStatusRefreshKeyRef.current = null;
    setStatus(null);
    setStatusScopeKey(null);
    setError(null);
    setErrorScopeKey(null);
    setServerOffsetMs(0);
    setNowMs(Date.now());
    setAddressActions({});

    if (!siteId) {
      setLoading(false);
      return;
    }

    void refresh();
  }, [refresh, siteId, siteScopeKey]);

  const currentStatus = statusScopeKey === siteScopeKey ? status : null;
  const currentError = errorScopeKey === siteScopeKey ? error : null;

  useEffect(() => {
    if (!currentStatus?.addresses.some((address) => address.status === "cooling")) {
      return;
    }

    const updateClock = () => setNowMs(Date.now() + serverOffsetMs);
    updateClock();
    const timer = globalThis.setInterval(updateClock, 1_000);
    return () => globalThis.clearInterval(timer);
  }, [currentStatus, serverOffsetMs]);

  useEffect(() => {
    if (!siteId || !currentStatus) {
      return;
    }
    const expiredAddresses = currentStatus.addresses.filter(
      (address) =>
        address.status === "cooling"
        && getSiteCooldownRemainingSeconds(address, nowMs) <= 0
    );
    if (expiredAddresses.length === 0) {
      return;
    }

    const refreshKey = [
      currentStatus.evaluationRevision,
      ...expiredAddresses.map((address) => `${address.baseUrl}:${address.cooldownUntil ?? ""}`)
    ].join("|");
    if (expiredStatusRefreshKeyRef.current === refreshKey) {
      return;
    }
    expiredStatusRefreshKeyRef.current = refreshKey;
    void refresh();
  }, [currentStatus, nowMs, refresh, siteId]);

  const clearCooldown = useCallback(async (baseUrl: string) => {
    const currentSite = activeSiteRef.current;
    const currentSiteId = currentSite?.id ?? null;
    const currentScopeKey = activeSiteScopeKeyRef.current;
    if (
      !currentSiteId
      || !currentScopeKey
      || !currentStatus
      || !isSiteFailoverStatusForSite(currentStatus, currentSite)
      || !currentStatus.addresses.some((address) => address.baseUrl === baseUrl)
      || activeClearRequestIdRef.current !== null
    ) {
      return;
    }

    const statusSessionSequence = statusSessionSequenceRef.current;
    const clearRequestId = ++clearRequestSequenceRef.current;
    activeClearRequestIdRef.current = clearRequestId;
    setAddressActions((previous) => ({
      ...previous,
      [baseUrl]: {
        clearing: true,
        error: null
      }
    }));

    try {
      const nextStatus = await clearSiteFailoverCooldown(currentSiteId, { baseUrl });
      if (
        activeSiteScopeKeyRef.current !== currentScopeKey
        || statusSessionSequenceRef.current !== statusSessionSequence
        || activeClearRequestIdRef.current !== clearRequestId
        || !isSiteFailoverStatusForSite(nextStatus, activeSiteRef.current)
      ) {
        return;
      }
      commitStatus(nextStatus, currentScopeKey);
      setAddressActions((previous) => ({
        ...previous,
        [baseUrl]: {
          clearing: false,
          error: null
        }
      }));
      publishSiteFailoverStatus(nextStatus);
    } catch (cause) {
      if (
        activeSiteScopeKeyRef.current === currentScopeKey
        && statusSessionSequenceRef.current === statusSessionSequence
        && activeClearRequestIdRef.current === clearRequestId
      ) {
        setAddressActions((previous) => ({
          ...previous,
          [baseUrl]: {
            clearing: false,
            error: (cause as Error).message
          }
        }));
      }
    } finally {
      if (activeClearRequestIdRef.current === clearRequestId) {
        activeClearRequestIdRef.current = null;
      }
    }
  }, [commitStatus, currentStatus]);

  return {
    status: currentStatus,
    loading,
    error: currentError,
    nowMs,
    addressActions,
    refresh,
    clearCooldown
  };
}

function createSiteFailoverStatusScopeKey(site: SiteRecord | null) {
  if (!site) {
    return null;
  }
  return JSON.stringify([
    site.id,
    site.updatedAt,
    site.baseUrl,
    site.fallbackBaseUrls,
    site.failoverCooldownSeconds,
    site.maxAttemptsPerAddress
  ]);
}
