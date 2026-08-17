import { useCallback, useEffect, useRef, useState } from "react";

import {
  getRuntimeCoordinationConfig,
  updateRuntimeCoordinationConfig
} from "../features/runtime-coordination/client";
import type { RuntimeCoordinationConfigPayload } from "../types";

const RUNTIME_COORDINATION_SAVE_DEBOUNCE_MS = 180;
const DEFAULT_RUNTIME_COORDINATION_CONFIG: RuntimeCoordinationConfigPayload = {
  siteRequestsPerSecond: 3,
  siteMaxInFlight: 3,
  usagePageMaxInFlight: 6
};

type RuntimeCoordinationPendingSave = {
  value: RuntimeCoordinationConfigPayload;
  revision: number;
  failed: boolean;
};

/**
 * 共享请求协调配置的独立读取与 last-write-wins 保存状态机。
 * 配置只写 coordination SQLite，不与 scheduler 的业务 SQLite 保存合并。
 */
export function useRuntimeCoordinationConfig() {
  const [runtimeCoordinationConfig, setRuntimeCoordinationConfig] =
    useState<RuntimeCoordinationConfigPayload>(DEFAULT_RUNTIME_COORDINATION_CONFIG);
  const [runtimeCoordinationConfigLoading, setRuntimeCoordinationConfigLoading] = useState(false);
  const [runtimeCoordinationConfigSaving, setRuntimeCoordinationConfigSaving] = useState(false);
  const [runtimeCoordinationLoadError, setRuntimeCoordinationLoadError] = useState<string | null>(null);
  const [runtimeCoordinationSaveError, setRuntimeCoordinationSaveError] = useState<string | null>(null);
  const pendingSaveRef = useRef<RuntimeCoordinationPendingSave | null>(null);
  const saveRunningRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const saveRevisionRef = useRef(0);
  const loadRevisionRef = useRef(0);

  const loadRuntimeCoordinationConfig = useCallback(async () => {
    const revision = loadRevisionRef.current + 1;
    loadRevisionRef.current = revision;
    setRuntimeCoordinationConfigLoading(true);
    setRuntimeCoordinationLoadError(null);
    try {
      const config = normalizeRuntimeCoordinationConfig(await getRuntimeCoordinationConfig());
      if (loadRevisionRef.current !== revision) {
        return;
      }
      if (!pendingSaveRef.current) {
        setRuntimeCoordinationConfig(config);
      }
    } catch (cause) {
      if (loadRevisionRef.current !== revision) {
        return;
      }
      setRuntimeCoordinationLoadError(
        cause instanceof Error && cause.message.trim()
          ? cause.message
          : "共享请求协调设置读取失败。"
      );
    } finally {
      if (loadRevisionRef.current === revision) {
        setRuntimeCoordinationConfigLoading(false);
      }
    }
  }, []);

  function clearScheduledSave() {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }

  function scheduleSave(debounce: boolean) {
    const pending = pendingSaveRef.current;
    if (!pending || pending.failed) {
      return;
    }
    clearScheduledSave();
    saveTimerRef.current = window.setTimeout(
      () => {
        saveTimerRef.current = null;
        void flushRuntimeCoordinationConfigSave();
      },
      debounce ? RUNTIME_COORDINATION_SAVE_DEBOUNCE_MS : 0
    );
  }

  async function flushRuntimeCoordinationConfigSave() {
    if (saveRunningRef.current) {
      return;
    }
    const pending = pendingSaveRef.current;
    if (!pending || pending.failed) {
      return;
    }

    pendingSaveRef.current = null;
    saveRunningRef.current = true;
    setRuntimeCoordinationConfigSaving(true);
    try {
      const confirmed = normalizeRuntimeCoordinationConfig(
        await updateRuntimeCoordinationConfig(pending.value)
      );
      if (!pendingSaveRef.current) {
        setRuntimeCoordinationConfig(confirmed);
      }
      setRuntimeCoordinationSaveError(null);
    } catch (cause) {
      const newerPending = pendingSaveRef.current as RuntimeCoordinationPendingSave | null;
      if (!newerPending || newerPending.revision <= pending.revision) {
        pendingSaveRef.current = { ...pending, failed: true };
        setRuntimeCoordinationSaveError(
          cause instanceof Error && cause.message.trim()
            ? cause.message
            : "共享请求协调设置保存失败，请重试。"
        );
      }
    } finally {
      saveRunningRef.current = false;
      const nextPending = pendingSaveRef.current as RuntimeCoordinationPendingSave | null;
      setRuntimeCoordinationConfigSaving(Boolean(nextPending && !nextPending.failed));
      if (nextPending && !nextPending.failed) {
        scheduleSave(false);
      }
    }
  }

  function handleRuntimeCoordinationConfigChange(
    value: RuntimeCoordinationConfigPayload,
    options: { debounce?: boolean } = {}
  ) {
    const normalized = normalizeRuntimeCoordinationConfig(value);
    loadRevisionRef.current += 1;
    saveRevisionRef.current += 1;
    pendingSaveRef.current = {
      value: normalized,
      revision: saveRevisionRef.current,
      failed: false
    };
    setRuntimeCoordinationConfig(normalized);
    setRuntimeCoordinationLoadError(null);
    setRuntimeCoordinationSaveError(null);
    setRuntimeCoordinationConfigSaving(true);
    scheduleSave(options.debounce === true);
  }

  function retryRuntimeCoordinationConfigSave() {
    const pending = pendingSaveRef.current;
    if (!pending || !pending.failed) {
      return;
    }
    pendingSaveRef.current = { ...pending, failed: false };
    setRuntimeCoordinationSaveError(null);
    setRuntimeCoordinationConfigSaving(true);
    scheduleSave(false);
  }

  function retryRuntimeCoordinationConfigLoad() {
    void loadRuntimeCoordinationConfig();
  }

  useEffect(() => {
    void loadRuntimeCoordinationConfig();
    return () => {
      loadRevisionRef.current += 1;
    };
  }, [loadRuntimeCoordinationConfig]);
  useEffect(() => () => clearScheduledSave(), []);

  return {
    runtimeCoordinationConfig,
    runtimeCoordinationConfigLoading,
    runtimeCoordinationConfigSaving,
    runtimeCoordinationLoadError,
    runtimeCoordinationSaveError,
    handleRuntimeCoordinationConfigChange,
    retryRuntimeCoordinationConfigSave,
    retryRuntimeCoordinationConfigLoad
  };
}

/** 将共享协调数值收敛到后端允许的整数范围。 */
export function normalizeRuntimeCoordinationConfig(
  value: RuntimeCoordinationConfigPayload
): RuntimeCoordinationConfigPayload {
  return {
    siteRequestsPerSecond: clampInteger(value.siteRequestsPerSecond, 1, 10),
    siteMaxInFlight: clampInteger(value.siteMaxInFlight, 1, 8),
    usagePageMaxInFlight: clampInteger(value.usagePageMaxInFlight, 1, 16)
  };
}

function clampInteger(value: number, min: number, max: number) {
  const finiteValue = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, Math.round(finiteValue)));
}
