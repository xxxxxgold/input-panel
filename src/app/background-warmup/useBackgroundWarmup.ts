import { useEffect, useRef, useState } from "react";

import {
  createInitialWarmupSnapshot,
  markWarmupAttempt,
  markWarmupCancelled,
  markWarmupFailure,
  markWarmupSuccess,
  getNextWarmupWakeAt,
  pickNextWarmupTask,
  syncWarmupStaleness
} from "./warmup-queue";
import type {
  WarmupEnvironment,
  WarmupResourceKey,
  WarmupSnapshot,
  WarmupTask
} from "./warmup-types";

export function useBackgroundWarmup(options: {
  environment: WarmupEnvironment;
  tasks: Partial<Record<WarmupResourceKey, WarmupTask>>;
  /**
   * 保留旧调用方的参数形状. 后台 warmup 失败必须保持在本地状态,
   * 不能通过此前台入口改写当前页面的全局错误.
   */
  onForegroundRefresh?: (resource: WarmupResourceKey) => Promise<void>;
}) {
  const { environment, tasks } = options;
  const [snapshot, setSnapshot] = useState<WarmupSnapshot>(() => createInitialWarmupSnapshot());
  const snapshotRef = useRef(snapshot);
  const environmentRef = useRef(environment);
  const tasksRef = useRef(tasks);
  const runningRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const scheduleNextRef = useRef<((snapshot: WarmupSnapshot, now: number) => void) | null>(null);

  environmentRef.current = environment;
  tasksRef.current = tasks;

  const updateSnapshot = (updater: (current: WarmupSnapshot) => WarmupSnapshot) => {
    setSnapshot((current) => {
      const next = updater(current);
      snapshotRef.current = next;
      return next;
    });
  };

  useEffect(() => {
    updateSnapshot((current) => syncWarmupStaleness(current, environment, Date.now()));
  }, [
    environment.nav,
    environment.isAppFocused,
    environment.overviewReady,
    environment.selectedAccountId,
    environment.selectedAccountReady,
    environment.groupPolicies.core.enabled,
    environment.groupPolicies.core.intervalMs,
    environment.groupPolicies.keys.enabled,
    environment.groupPolicies.keys.intervalMs,
    environment.groupPolicies.usage.enabled,
    environment.groupPolicies.usage.intervalMs,
    environment.serviceStatusPolicy.enabled,
    environment.serviceStatusPolicy.intervalMs
  ]);

  useEffect(() => {
    let cancelled = false;

    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const schedule = (at: number | null) => {
      if (cancelled) {
        return;
      }
      clearTimer();
      if (at === null) {
        return;
      }
      timerRef.current = window.setTimeout(() => {
        void tick();
      }, Math.max(0, at - Date.now()));
    };

    const scheduleNext = (snapshot: WarmupSnapshot, now: number) => {
      schedule(getNextWarmupWakeAt(snapshot, environmentRef.current, tasksRef.current, now));
    };
    scheduleNextRef.current = scheduleNext;

    const tick = async () => {
      if (cancelled || runningRef.current) {
        return;
      }
      const now = Date.now();
      const currentSnapshot = snapshotRef.current;
      const warmedSnapshot = syncWarmupStaleness(currentSnapshot, environmentRef.current, now);
      if (warmedSnapshot !== currentSnapshot) {
        snapshotRef.current = warmedSnapshot;
        setSnapshot(warmedSnapshot);
      }
      const nextTask = pickNextWarmupTask(warmedSnapshot, environmentRef.current, tasksRef.current, now);
      if (!nextTask) {
        scheduleNext(warmedSnapshot, now);
        return;
      }
      runningRef.current = true;
      updateSnapshot((current) => markWarmupAttempt(current, nextTask.key, now));
      try {
        const outcome = await nextTask.run();
        if (!cancelled) {
          updateSnapshot((current) =>
            outcome === "cancelled"
              ? markWarmupCancelled(current, nextTask.key, Date.now())
              : markWarmupSuccess(current, nextTask.key, Date.now())
          );
        }
      } catch (cause) {
        if (!cancelled) {
          updateSnapshot((current) =>
            markWarmupFailure(
              current,
              nextTask.key,
              Date.now(),
              (cause as Error)?.message ?? "后台刷新失败"
            )
          );
        }
      } finally {
        runningRef.current = false;
        const scheduledAt = Date.now();
        let scheduledSnapshot = snapshotRef.current;

        if (cancelled) {
          // A prior effect may finish after navigation, focus, or policy changes. Its
          // result is no longer safe to commit, but leaving the resource as warming
          // would prevent the active effect from ever scheduling it again.
          scheduledSnapshot = markWarmupCancelled(scheduledSnapshot, nextTask.key, scheduledAt);
          snapshotRef.current = scheduledSnapshot;
          if (scheduleNextRef.current) {
            setSnapshot(scheduledSnapshot);
          }
        } else {
          scheduledSnapshot = syncWarmupStaleness(
            scheduledSnapshot,
            environmentRef.current,
            scheduledAt
          );
          if (scheduledSnapshot !== snapshotRef.current) {
            snapshotRef.current = scheduledSnapshot;
            setSnapshot(scheduledSnapshot);
          }
        }
        scheduleNextRef.current?.(scheduledSnapshot, scheduledAt);
      }
    };

    const initialAt = Date.now();
    const initialSnapshot = syncWarmupStaleness(snapshotRef.current, environmentRef.current, initialAt);
    if (initialSnapshot !== snapshotRef.current) {
      snapshotRef.current = initialSnapshot;
      setSnapshot(initialSnapshot);
    }
    scheduleNext(initialSnapshot, initialAt);

    return () => {
      cancelled = true;
      if (scheduleNextRef.current === scheduleNext) {
        scheduleNextRef.current = null;
      }
      clearTimer();
    };
  }, [
    environment.nav,
    environment.isAppFocused,
    environment.overviewReady,
    environment.selectedAccountId,
    environment.selectedAccountReady,
    environment.groupPolicies.core.enabled,
    environment.groupPolicies.core.intervalMs,
    environment.groupPolicies.keys.enabled,
    environment.groupPolicies.keys.intervalMs,
    environment.groupPolicies.usage.enabled,
    environment.groupPolicies.usage.intervalMs,
    environment.serviceStatusPolicy.enabled,
    environment.serviceStatusPolicy.intervalMs
  ]);

  return {
    snapshot
  };
}
