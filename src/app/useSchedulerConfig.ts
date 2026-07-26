import { useCallback, useEffect, useRef, useState } from "react";

import { getSchedulerConfig, updateSchedulerConfig } from "../features/scheduler/client";
import type { SchedulerConfigPayload } from "../types";

const SCHEDULER_CONFIG_SAVE_DEBOUNCE_MS = 180;
const DEFAULT_SCHEDULER_CONFIG: SchedulerConfigPayload = { enabled: true, intervalSeconds: 15 };
const MIN_SCHEDULER_INTERVAL_SECONDS = 15;

type SchedulerConfigPendingSave = {
  value: SchedulerConfigPayload;
  revision: number;
  failed: boolean;
};

/**
 * 后端用量同步器配置的读取/去抖保存状态机。
 * 从 MainWindowApp 原样抽出：last-write-wins（revision 比较）、
 * 失败保留 pending 供重试、保存期间到达的新值在 finally 里续跑。
 */
export function useSchedulerConfig() {
  const [schedulerConfig, setSchedulerConfig] = useState<SchedulerConfigPayload>(DEFAULT_SCHEDULER_CONFIG);
  const [schedulerConfirmedConfig, setSchedulerConfirmedConfig] = useState<SchedulerConfigPayload>(
    DEFAULT_SCHEDULER_CONFIG
  );
  const [schedulerConfigLoading, setSchedulerConfigLoading] = useState(false);
  const [schedulerConfigSaving, setSchedulerConfigSaving] = useState(false);
  const [schedulerLoadError, setSchedulerLoadError] = useState<string | null>(null);
  const [schedulerSaveError, setSchedulerSaveError] = useState<string | null>(null);
  const schedulerPendingSaveRef = useRef<SchedulerConfigPendingSave | null>(null);
  const schedulerSaveRunningRef = useRef(false);
  const schedulerSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulerSaveRevisionRef = useRef(0);
  const schedulerLoadRevisionRef = useRef(0);

  const loadSchedulerConfig = useCallback(async () => {
    const revision = schedulerLoadRevisionRef.current + 1;
    schedulerLoadRevisionRef.current = revision;
    setSchedulerConfigLoading(true);
    setSchedulerLoadError(null);
    try {
      const config = await getSchedulerConfig();
      if (schedulerLoadRevisionRef.current !== revision) {
        return;
      }
      setSchedulerConfirmedConfig(config);
      if (!schedulerPendingSaveRef.current) {
        setSchedulerConfig(config);
      }
    } catch (cause) {
      if (schedulerLoadRevisionRef.current !== revision) {
        return;
      }
      setSchedulerLoadError(
        cause instanceof Error && cause.message.trim()
          ? cause.message
          : "后端用量同步器设置读取失败。"
      );
    } finally {
      if (schedulerLoadRevisionRef.current === revision) {
        setSchedulerConfigLoading(false);
      }
    }
  }, []);

  function clearScheduledSchedulerSave() {
    if (schedulerSaveTimerRef.current !== null) {
      window.clearTimeout(schedulerSaveTimerRef.current);
      schedulerSaveTimerRef.current = null;
    }
  }

  function scheduleSchedulerSave(debounce: boolean) {
    const pending = schedulerPendingSaveRef.current;
    if (!pending || pending.failed) {
      return;
    }
    clearScheduledSchedulerSave();
    schedulerSaveTimerRef.current = window.setTimeout(
      () => {
        schedulerSaveTimerRef.current = null;
        void flushSchedulerConfigSave();
      },
      debounce ? SCHEDULER_CONFIG_SAVE_DEBOUNCE_MS : 0
    );
  }

  async function flushSchedulerConfigSave() {
    if (schedulerSaveRunningRef.current) {
      return;
    }
    const pending = schedulerPendingSaveRef.current;
    if (!pending || pending.failed) {
      return;
    }

    schedulerPendingSaveRef.current = null;
    schedulerSaveRunningRef.current = true;
    setSchedulerConfigSaving(true);
    try {
      const confirmed = await updateSchedulerConfig(pending.value);
      setSchedulerConfirmedConfig(confirmed);
      if (!schedulerPendingSaveRef.current) {
        setSchedulerConfig(confirmed);
      }
      setSchedulerSaveError(null);
    } catch (cause) {
      const newerPending = schedulerPendingSaveRef.current as SchedulerConfigPendingSave | null;
      if (!newerPending || newerPending.revision <= pending.revision) {
        schedulerPendingSaveRef.current = { ...pending, failed: true };
        setSchedulerSaveError(
          cause instanceof Error && cause.message.trim()
            ? cause.message
            : "设置保存失败，请重试。"
        );
      }
    } finally {
      schedulerSaveRunningRef.current = false;
      const nextPending = schedulerPendingSaveRef.current as SchedulerConfigPendingSave | null;
      setSchedulerConfigSaving(Boolean(nextPending && !nextPending.failed));
      if (nextPending && !nextPending.failed) {
        scheduleSchedulerSave(false);
      }
    }
  }

  function handleSchedulerConfigChange(
    value: SchedulerConfigPayload,
    options: { debounce?: boolean } = {}
  ) {
    const normalized: SchedulerConfigPayload = {
      enabled: value.enabled,
      intervalSeconds: Math.max(MIN_SCHEDULER_INTERVAL_SECONDS, Math.round(value.intervalSeconds))
    };
    schedulerLoadRevisionRef.current += 1;
    schedulerSaveRevisionRef.current += 1;
    schedulerPendingSaveRef.current = {
      value: normalized,
      revision: schedulerSaveRevisionRef.current,
      failed: false
    };
    setSchedulerConfig(normalized);
    setSchedulerLoadError(null);
    setSchedulerSaveError(null);
    setSchedulerConfigSaving(true);
    scheduleSchedulerSave(options.debounce === true);
  }

  function retrySchedulerConfigSave() {
    const pending = schedulerPendingSaveRef.current;
    if (!pending || !pending.failed) {
      return;
    }
    schedulerPendingSaveRef.current = { ...pending, failed: false };
    setSchedulerSaveError(null);
    setSchedulerConfigSaving(true);
    scheduleSchedulerSave(false);
  }

  function retrySchedulerConfigLoad() {
    void loadSchedulerConfig();
  }

  useEffect(() => {
    void loadSchedulerConfig();
    return () => {
      schedulerLoadRevisionRef.current += 1;
    };
  }, [loadSchedulerConfig]);
  useEffect(() => () => clearScheduledSchedulerSave(), []);

  return {
    schedulerConfig,
    schedulerConfirmedConfig,
    schedulerConfigLoading,
    schedulerConfigSaving,
    schedulerLoadError,
    schedulerSaveError,
    handleSchedulerConfigChange,
    retrySchedulerConfigSave,
    retrySchedulerConfigLoad
  };
}
