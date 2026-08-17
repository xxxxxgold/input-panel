import { useCallback, useEffect, useRef, useState } from "react";

import {
  getUpstreamNetworkConfig,
  updateUpstreamNetworkConfig
} from "../features/upstream-network/client";
import type { UpstreamNetworkConfigPayload } from "../types";

const DEFAULT_UPSTREAM_NETWORK_CONFIG: UpstreamNetworkConfigPayload = {
  useSystemProxy: false
};

type UpstreamNetworkPendingSave = {
  value: UpstreamNetworkConfigPayload;
  revision: number;
  failed: boolean;
};

/**
 * 上游网络模式的独立读取与 last-write-wins 保存状态机。
 * 默认强制直连，切换只影响后续新建的上游请求客户端。
 */
export function useUpstreamNetworkConfig() {
  const [upstreamNetworkConfig, setUpstreamNetworkConfig] = useState<UpstreamNetworkConfigPayload>(
    DEFAULT_UPSTREAM_NETWORK_CONFIG
  );
  const [upstreamNetworkConfigLoading, setUpstreamNetworkConfigLoading] = useState(false);
  const [upstreamNetworkConfigSaving, setUpstreamNetworkConfigSaving] = useState(false);
  const [upstreamNetworkLoadError, setUpstreamNetworkLoadError] = useState<string | null>(null);
  const [upstreamNetworkSaveError, setUpstreamNetworkSaveError] = useState<string | null>(null);
  const pendingSaveRef = useRef<UpstreamNetworkPendingSave | null>(null);
  const saveRunningRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const saveRevisionRef = useRef(0);
  const loadRevisionRef = useRef(0);

  const loadUpstreamNetworkConfig = useCallback(async () => {
    const revision = loadRevisionRef.current + 1;
    loadRevisionRef.current = revision;
    setUpstreamNetworkConfigLoading(true);
    setUpstreamNetworkLoadError(null);
    try {
      const config = normalizeUpstreamNetworkConfig(await getUpstreamNetworkConfig());
      if (loadRevisionRef.current !== revision) {
        return;
      }
      if (!pendingSaveRef.current) {
        setUpstreamNetworkConfig(config);
      }
    } catch (cause) {
      if (loadRevisionRef.current !== revision) {
        return;
      }
      setUpstreamNetworkLoadError(
        cause instanceof Error && cause.message.trim()
          ? cause.message
          : "上游网络设置读取失败。"
      );
    } finally {
      if (loadRevisionRef.current === revision) {
        setUpstreamNetworkConfigLoading(false);
      }
    }
  }, []);

  function clearScheduledSave() {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }

  function scheduleSave() {
    const pending = pendingSaveRef.current;
    if (!pending || pending.failed) {
      return;
    }
    clearScheduledSave();
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void flushUpstreamNetworkConfigSave();
    }, 0);
  }

  async function flushUpstreamNetworkConfigSave() {
    if (saveRunningRef.current) {
      return;
    }
    const pending = pendingSaveRef.current;
    if (!pending || pending.failed) {
      return;
    }

    pendingSaveRef.current = null;
    saveRunningRef.current = true;
    setUpstreamNetworkConfigSaving(true);
    try {
      const confirmed = normalizeUpstreamNetworkConfig(
        await updateUpstreamNetworkConfig(pending.value)
      );
      if (!pendingSaveRef.current) {
        setUpstreamNetworkConfig(confirmed);
      }
      setUpstreamNetworkSaveError(null);
    } catch (cause) {
      const newerPending = pendingSaveRef.current as UpstreamNetworkPendingSave | null;
      if (!newerPending || newerPending.revision <= pending.revision) {
        pendingSaveRef.current = { ...pending, failed: true };
        setUpstreamNetworkSaveError(
          cause instanceof Error && cause.message.trim()
            ? cause.message
            : "上游网络设置保存失败，请重试。"
        );
      }
    } finally {
      saveRunningRef.current = false;
      const nextPending = pendingSaveRef.current;
      setUpstreamNetworkConfigSaving(Boolean(nextPending && !nextPending.failed));
      if (nextPending && !nextPending.failed) {
        scheduleSave();
      }
    }
  }

  function handleUpstreamNetworkConfigChange(value: UpstreamNetworkConfigPayload) {
    const normalized = normalizeUpstreamNetworkConfig(value);
    loadRevisionRef.current += 1;
    saveRevisionRef.current += 1;
    pendingSaveRef.current = {
      value: normalized,
      revision: saveRevisionRef.current,
      failed: false
    };
    setUpstreamNetworkConfig(normalized);
    setUpstreamNetworkLoadError(null);
    setUpstreamNetworkSaveError(null);
    setUpstreamNetworkConfigSaving(true);
    scheduleSave();
  }

  function retryUpstreamNetworkConfigSave() {
    const pending = pendingSaveRef.current;
    if (!pending || !pending.failed) {
      return;
    }
    pendingSaveRef.current = { ...pending, failed: false };
    setUpstreamNetworkSaveError(null);
    setUpstreamNetworkConfigSaving(true);
    scheduleSave();
  }

  function retryUpstreamNetworkConfigLoad() {
    void loadUpstreamNetworkConfig();
  }

  useEffect(() => {
    void loadUpstreamNetworkConfig();
    return () => {
      loadRevisionRef.current += 1;
    };
  }, [loadUpstreamNetworkConfig]);
  useEffect(() => () => clearScheduledSave(), []);

  return {
    upstreamNetworkConfig,
    upstreamNetworkConfigLoading,
    upstreamNetworkConfigSaving,
    upstreamNetworkLoadError,
    upstreamNetworkSaveError,
    handleUpstreamNetworkConfigChange,
    retryUpstreamNetworkConfigSave,
    retryUpstreamNetworkConfigLoad
  };
}

/** 对非布尔响应保持直连默认值，避免页面将未知响应解释为启用代理。 */
export function normalizeUpstreamNetworkConfig(
  value: UpstreamNetworkConfigPayload
): UpstreamNetworkConfigPayload {
  return {
    useSystemProxy: value.useSystemProxy === true
  };
}
