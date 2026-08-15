import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, CircleAlert, CircleCheck, Info, X } from "lucide-react";

import {
  getDesktopUiPrefs,
  getFloatingPanelVisible,
  requestFloatingNotificationSound
} from "../features/desktop-ui/client";
import {
  acknowledgeBusinessNotificationDismissal,
  closeBusinessNotificationDetail,
  completeBusinessNotificationExit,
  createBusinessNotificationQueueState,
  DEFAULT_BUSINESS_NOTIFICATION_DURATION_MS,
  dismissBusinessNotification,
  enqueueBusinessNotification,
  getExpiredBusinessNotificationIds,
  getNextBusinessNotificationExpiryDelay,
  openBusinessNotificationDetail,
  markBusinessNotificationExiting,
  markBusinessNotificationVisible,
  pauseBusinessNotifications,
  releaseBusinessNotificationDedupeKey,
  restoreBusinessNotificationAfterFailedDismissal,
  resumeBusinessNotifications,
  setBusinessNotificationDuration,
  setBusinessNotificationMaxVisible,
  type BusinessNotificationLevel,
  type BusinessNotificationPayload,
  type BusinessNotificationQueueState
} from "../shared/lib/business-notification-queue";
import {
  DEFAULT_FLOATING_NOTIFICATION_DENSITY,
  DEFAULT_FLOATING_NOTIFICATION_MAX_VISIBLE,
  getFloatingNotificationItemHeight,
  getFloatingNotificationLayout,
  normalizeFloatingNotificationDensity,
  normalizeFloatingNotificationMaxVisible,
  type FloatingNotificationDensity
} from "../shared/lib/floating-notification-layout";
import {
  compact,
  formatDateTimeFull,
  formatDurationSeconds,
  formatTimeOnly,
  formatUsageServiceTier
} from "../shared/lib/formatters";
import { DEFAULT_THEME_ID, normalizeThemeId, type ThemeId } from "../shared/lib/theme";
import { applyThemeToDocument } from "../shared/lib/apply-theme";
import { shouldApplyMailboxRevision } from "../shared/lib/mailbox-revision";
import {
  normalizeFloatingNotificationDock,
  type FloatingNotificationDock
} from "../shared/lib/floating-notification-dock";
import { isTauriRuntime } from "../shared/transport/runtime";

export interface FloatingNotificationMailboxReference {
  id?: string | null;
  label: string;
}

export interface FloatingNotificationMailboxItem {
  id: string;
  dedupeKey: string;
  channel?: "business" | "usage" | null;
  title: string;
  level: string;
  source: string;
  createdAt: string;
  content: string;
  account?: FloatingNotificationMailboxReference | null;
  site?: FloatingNotificationMailboxReference | null;
  model?: FloatingNotificationMailboxReference | null;
  usage?: {
    apiKeyLabel: string;
    model: string;
    reasoningEffort?: string | null;
    serviceTier?: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    actualCost: number;
    totalCost: number;
    firstTokenMs?: number | null;
  } | null;
}

export interface FloatingNotificationMailboxSnapshot {
  revision: number;
  items: FloatingNotificationMailboxItem[];
  dock?: FloatingNotificationDock | null;
}

export const FLOATING_NOTIFICATION_EXIT_DURATION_MS = 560;
export const FLOATING_NOTIFICATION_ENTER_DURATION_MS = 520;
export const FLOATING_NOTIFICATION_ANIMATION_FALLBACK_BUFFER_MS = 48;
export const FLOATING_NOTIFICATION_REGION_SETTLE_DELAY_MS =
  360 + FLOATING_NOTIFICATION_ANIMATION_FALLBACK_BUFFER_MS;
const NATIVE_DISMISS_SYNC_PAUSE_REASON = "native-dismiss-sync";
const NATIVE_DISMISS_SNAPSHOT_RETRY_DELAY_MS = 500;
const MAX_FLOATING_NOTIFICATION_SOUND_DISPLAY_ATTEMPTS = 90;

export type FloatingNotificationAnimationLifecycle = "enter" | "exit";

export interface FloatingNotificationAnimationFallback {
  remainingMs: number;
  startedAt: number | null;
}

type FloatingNotificationAnimationFallbackTimer = FloatingNotificationAnimationFallback & {
  timer: number | null;
};

export function isFloatingNotificationAnimationPaused(
  pauseReasons: readonly string[]
): boolean {
  return pauseReasons.length > 0;
}

export function createFloatingNotificationAnimationFallback(
  durationMs: number
): FloatingNotificationAnimationFallback {
  return {
    remainingMs: Math.max(0, durationMs),
    startedAt: null
  };
}

export function pauseFloatingNotificationAnimationFallback(
  fallback: FloatingNotificationAnimationFallback,
  now = Date.now()
): FloatingNotificationAnimationFallback {
  if (fallback.startedAt === null) {
    return fallback;
  }
  return {
    remainingMs: Math.max(0, fallback.remainingMs - Math.max(0, now - fallback.startedAt)),
    startedAt: null
  };
}

export function resumeFloatingNotificationAnimationFallback(
  fallback: FloatingNotificationAnimationFallback,
  now = Date.now()
): FloatingNotificationAnimationFallback {
  if (fallback.startedAt !== null) {
    return fallback;
  }
  return {
    ...fallback,
    startedAt: now
  };
}

export function applyNativeNotificationLifecyclePauseReasons(
  state: BusinessNotificationQueueState,
  pauseReasons: Iterable<string>,
  now = Date.now()
): BusinessNotificationQueueState {
  let next = state;
  for (const reason of pauseReasons) {
    next = pauseBusinessNotifications(next, reason, now);
  }
  return next;
}

export function resolveFloatingNotificationAnimationLifecycle(
  animationName: string
): FloatingNotificationAnimationLifecycle | null {
  if (
    animationName === "floating-notification-enter-left" ||
    animationName === "floating-notification-enter-right"
  ) {
    return "enter";
  }
  if (
    animationName === "floating-notification-exit-left" ||
    animationName === "floating-notification-exit-right"
  ) {
    return "exit";
  }
  return null;
}

export function collectNewlyExitingNotificationIds(
  current: BusinessNotificationQueueState,
  next: BusinessNotificationQueueState
): string[] {
  const currentLifecycles = new Map(
    current.visible.map((entry) => [entry.notification.id, entry.lifecycle])
  );
  return next.visible
    .filter(
      (entry) =>
        entry.lifecycle === "exiting" &&
        currentLifecycles.get(entry.notification.id) !== "exiting"
    )
    .map((entry) => entry.notification.id);
}

export function isFloatingNotificationDismissalAcknowledged(
  snapshot: FloatingNotificationMailboxSnapshot,
  notificationId: string
): boolean {
  return !snapshot.items.some((item) => item.id === notificationId);
}

export function isFloatingNotificationMotionSettled(
  state: BusinessNotificationQueueState
): boolean {
  return (
    state.visible.length > 0 &&
    state.awaitingAcknowledgement.length === 0 &&
    state.visible.every((entry) => entry.lifecycle === "visible")
  );
}

/** 确认详情时保留详情表面，直到原生 mailbox 返回删除确认。 */
export function beginFloatingNotificationDetailDismissal(
  state: BusinessNotificationQueueState,
  notificationId: string,
  now = Date.now()
): BusinessNotificationQueueState {
  const withoutHover = resumeBusinessNotifications(state, "hover", now);
  const withoutTransientPause = resumeBusinessNotifications(withoutHover, "focus", now);
  // 详情会隐藏列表并暂停动画 fallback，先结算入场事务，避免显式确认被永久阻塞。
  const withoutEnteringTransition: BusinessNotificationQueueState = {
    ...withoutTransientPause,
    visible: withoutTransientPause.visible.map((entry) =>
      entry.lifecycle === "entering"
        ? { ...entry, lifecycle: "visible", lastResumedAt: now }
        : entry
    )
  };
  return markBusinessNotificationExiting(withoutEnteringTransition, [notificationId]);
}

const levelLabels: Record<BusinessNotificationLevel, string> = {
  critical: "严重",
  high: "高",
  medium: "中",
  warning: "警告",
  low: "低",
  success: "成功",
  info: "信息"
};

function FloatingNotificationLevelIcon({
  level,
  size = 17
}: {
  level: BusinessNotificationLevel;
  size?: number;
}) {
  if (level === "success") {
    return <CircleCheck aria-hidden="true" size={size} strokeWidth={2.2} />;
  }
  if (level === "critical" || level === "high") {
    return <CircleAlert aria-hidden="true" size={size} strokeWidth={2.2} />;
  }
  if (level === "medium" || level === "warning") {
    return <AlertTriangle aria-hidden="true" size={size} strokeWidth={2.2} />;
  }
  return <Info aria-hidden="true" size={size} strokeWidth={2.2} />;
}

function applyFloatingNotificationTheme(theme: ThemeId) {
  applyThemeToDocument(theme);
}

function normalizeNotificationLevel(level: string): BusinessNotificationLevel {
  if (
    level === "critical" ||
    level === "high" ||
    level === "medium" ||
    level === "warning" ||
    level === "low" ||
    level === "success"
  ) {
    return level;
  }
  return "info";
}

function toBusinessNotification(item: FloatingNotificationMailboxItem): BusinessNotificationPayload {
  return {
    id: item.id,
    dedupeKey: item.dedupeKey,
    channel: item.channel === "usage" ? "usage" : "business",
    title: item.title,
    level: normalizeNotificationLevel(item.level),
    source: item.source,
    createdAt: item.createdAt,
    content: item.content,
    account: item.account ? { id: item.account.id ?? undefined, label: item.account.label } : undefined,
    site: item.site ? { id: item.site.id ?? undefined, label: item.site.label } : undefined,
    model: item.model ? { id: item.model.id ?? undefined, label: item.model.label } : undefined,
    usage: item.usage
      ? {
          apiKeyLabel: item.usage.apiKeyLabel,
          model: item.usage.model,
          reasoningEffort: item.usage.reasoningEffort,
          serviceTier: item.usage.serviceTier,
          inputTokens: item.usage.inputTokens,
          outputTokens: item.usage.outputTokens,
          cacheCreationTokens: item.usage.cacheCreationTokens,
          cacheReadTokens: item.usage.cacheReadTokens,
          actualCost: item.usage.actualCost,
          totalCost: item.usage.totalCost,
          firstTokenMs: item.usage.firstTokenMs
        }
      : undefined
  };
}

function formatUsageTokens(value: number) {
  return compact(value);
}

function formatUsageCost(value: number) {
  return `$${value.toFixed(6)}`;
}

function formatFirstToken(value: number | null | undefined) {
  return formatDurationSeconds(value, 3, "秒");
}

// 上游用 `none` 表示未启用推理，展示层统一收敛为短占位符。
function formatUsageReasoningEffort(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized && normalized.toLowerCase() !== "none" ? normalized : "-";
}

export function UsageNotificationMetrics({
  usage,
  detail = false
}: {
  usage: NonNullable<BusinessNotificationPayload["usage"]>;
  detail?: boolean;
}) {
  const metrics = [
    ["输入", formatUsageTokens(usage.inputTokens)],
    ["输出", formatUsageTokens(usage.outputTokens)],
    ["缓存读取", formatUsageTokens(usage.cacheReadTokens)],
    ["生成费用", formatUsageCost(usage.actualCost)],
    ["首 Token", formatFirstToken(usage.firstTokenMs)]
  ];
  const detailMetrics = [
    ...metrics.slice(0, 2),
    ["缓存写入", formatUsageTokens(usage.cacheCreationTokens)],
    ...metrics.slice(2)
  ];

  return (
    <dl className={`floating-usage-metrics${detail ? " detail" : ""}`}>
      {!detail ? (
        <div className="floating-usage-model-metric">
          <dt>
            模型 <span>{formatUsageReasoningEffort(usage.reasoningEffort)}</span>
          </dt>
          <dd title={usage.model}>{usage.model}</dd>
        </div>
      ) : null}
      {(detail ? detailMetrics : metrics).map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function reconcileFloatingNotificationSnapshot(
  state: BusinessNotificationQueueState,
  snapshot: FloatingNotificationMailboxSnapshot,
  now = Date.now(),
  durationMs = DEFAULT_BUSINESS_NOTIFICATION_DURATION_MS,
  maxVisible = DEFAULT_FLOATING_NOTIFICATION_MAX_VISIBLE
): BusinessNotificationQueueState {
  const incomingIds = new Set(snapshot.items.map((item) => item.id));
  let next = setBusinessNotificationMaxVisible(state, maxVisible, now);
  const removedAwaitingIds = next.awaitingAcknowledgement
    .filter((entry) => !incomingIds.has(entry.notification.id))
    .map((entry) => entry.notification.id);
  for (const notificationId of removedAwaitingIds) {
    next = acknowledgeBusinessNotificationDismissal(next, notificationId, now);
  }
  const removedPendingIds = next.pending
    .filter((entry) => !incomingIds.has(entry.notification.id))
    .map((entry) => entry.notification.id);
  for (const notificationId of removedPendingIds) {
    next = dismissBusinessNotification(next, notificationId, now);
  }

  const removedVisibleIds = next.visible
    .filter(
      (entry) => !incomingIds.has(entry.notification.id) && entry.lifecycle !== "exiting"
    )
    .map((entry) => entry.notification.id);
  next = markBusinessNotificationExiting(next, removedVisibleIds);
  if (next.detailNotificationId && removedVisibleIds.includes(next.detailNotificationId)) {
    next = closeBusinessNotificationDetail(next, now);
  }

  const incomingById = new Map(snapshot.items.map((item) => [item.id, toBusinessNotification(item)]));
  const refreshEntry = <T extends BusinessNotificationQueueState["visible"][number]>(entry: T): T => {
    const notification = incomingById.get(entry.notification.id);
    return notification ? ({ ...entry, notification } as T) : entry;
  };
  next = {
    ...next,
    visible: next.visible.map(refreshEntry),
    pending: next.pending.map(refreshEntry),
    awaitingAcknowledgement: next.awaitingAcknowledgement.map(refreshEntry)
  };

  const queuedIds = new Set(
    [...next.visible, ...next.pending, ...next.awaitingAcknowledgement].map(
      (entry) => entry.notification.id
    )
  );
  for (const item of snapshot.items) {
    if (queuedIds.has(item.id)) {
      continue;
    }
    next = releaseBusinessNotificationDedupeKey(next, item.dedupeKey);
    next = enqueueBusinessNotification(
      next,
      { type: "business", notification: toBusinessNotification(item), durationMs },
      now
    );
    queuedIds.add(item.id);
  }
  return next;
}

/**
 * 原生快照到达后再结算退出态，避免最后一张卡片先被本地移除而暴露空窗口。
 */
export function settleFloatingNotificationExitAfterNativeDismissal(
  state: BusinessNotificationQueueState,
  notificationId: string,
  snapshot: FloatingNotificationMailboxSnapshot,
  now = Date.now()
): BusinessNotificationQueueState {
  const next = completeBusinessNotificationExit(state, notificationId, now);
  return snapshot.items.some((item) => item.id === notificationId)
    ? next
    : acknowledgeBusinessNotificationDismissal(next, notificationId, now);
}

export function FloatingNotificationWindowRoot() {
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME_ID);
  const [queue, setQueue] = useState<BusinessNotificationQueueState>(() =>
    createBusinessNotificationQueueState()
  );
  const queueRef = useRef(queue);
  const lastAppliedRevisionRef = useRef(0);
  const panelVisibleRef = useRef(false);
  const panelVisibilityEventVersionRef = useRef(0);
  const nativeLifecyclePauseReasonsRef = useRef(new Set<string>());
  const nativeDismissPendingIdsRef = useRef(new Set<string>());
  const nativeDismissRetryTimersRef = useRef(new Map<string, number>());
  const notificationSoundCompletedIdsRef = useRef(new Set<string>());
  const notificationSoundPendingIdsRef = useRef(new Set<string>());
  const notificationSoundFrameIdsRef = useRef(new Map<string, number>());
  const notificationSoundAttemptCountsRef = useRef(new Map<string, number>());
  const notificationWindowWasHiddenRef = useRef(false);
  const animationFallbackTimersRef = useRef(
    new Map<string, FloatingNotificationAnimationFallbackTimer>()
  );
  const [notificationDurationMs, setNotificationDurationMs] = useState(
    DEFAULT_BUSINESS_NOTIFICATION_DURATION_MS
  );
  const [notificationDensity, setNotificationDensity] = useState<FloatingNotificationDensity>(
    DEFAULT_FLOATING_NOTIFICATION_DENSITY
  );
  const [notificationMaxVisible, setNotificationMaxVisible] = useState(
    DEFAULT_FLOATING_NOTIFICATION_MAX_VISIBLE
  );
  const [notificationDock, setNotificationDock] = useState<FloatingNotificationDock>("right");
  const [notificationGeometryEpoch, setNotificationGeometryEpoch] = useState(0);
  const notificationDurationRef = useRef(notificationDurationMs);
  const notificationMaxVisibleRef = useRef(notificationMaxVisible);
  notificationDurationRef.current = notificationDurationMs;
  notificationMaxVisibleRef.current = notificationMaxVisible;
  const notificationLifecyclePaused = isFloatingNotificationAnimationPaused(queue.pauseReasons);
  const notificationWindowHidden = queue.pauseReasons.includes("notification-window-hidden");

  const commitQueue = useCallback(
    (update: (current: BusinessNotificationQueueState) => BusinessNotificationQueueState) => {
      const next = update(queueRef.current);
      queueRef.current = next;
      setQueue(next);
      return next;
    },
    []
  );

  const applyFloatingPanelPause = useCallback(
    (current: BusinessNotificationQueueState, now = Date.now()) =>
      panelVisibleRef.current
        ? pauseBusinessNotifications(current, "floating-panel", now)
        : resumeBusinessNotifications(current, "floating-panel", now),
    []
  );

  const applyMailboxSnapshot = useCallback(
    (snapshot: FloatingNotificationMailboxSnapshot) => {
      setNotificationDock(normalizeFloatingNotificationDock(snapshot.dock));
      setNotificationGeometryEpoch((current) => current + 1);
      const now = Date.now();
      if (!shouldApplyMailboxRevision(lastAppliedRevisionRef.current, snapshot.revision)) {
        commitQueue((current) =>
          resumeBusinessNotifications(current, NATIVE_DISMISS_SYNC_PAUSE_REASON, now)
        );
        return;
      }
      lastAppliedRevisionRef.current = snapshot.revision;
      commitQueue((current) =>
        applyFloatingPanelPause(
          applyNativeNotificationLifecyclePauseReasons(
            reconcileFloatingNotificationSnapshot(
              resumeBusinessNotifications(current, NATIVE_DISMISS_SYNC_PAUSE_REASON, now),
              snapshot,
              now,
              notificationDurationRef.current,
              notificationMaxVisibleRef.current
            ),
            nativeLifecyclePauseReasonsRef.current,
            now
          ),
          now
        )
      );
    },
    [applyFloatingPanelPause, commitQueue]
  );

  const dismissNativeNotification = useCallback(async (notificationId: string) => {
    try {
      const snapshot = await invoke<FloatingNotificationMailboxSnapshot>("dismiss_floating_notification", {
        notificationId
      });
      return isFloatingNotificationDismissalAcknowledged(snapshot, notificationId)
        ? snapshot
        : null;
    } catch {
      try {
        const snapshot = await invoke<FloatingNotificationMailboxSnapshot>(
          "get_floating_notification_snapshot"
        );
        return isFloatingNotificationDismissalAcknowledged(snapshot, notificationId)
          ? snapshot
          : null;
      } catch {
        return null;
      }
    }
  }, []);

  const retryNativeDismissSnapshot = useCallback(
    (notificationId: string) => {
      if (nativeDismissRetryTimersRef.current.has(notificationId)) {
        return;
      }
      const timer = window.setTimeout(() => {
        if (nativeDismissRetryTimersRef.current.get(notificationId) !== timer) {
          return;
        }
        nativeDismissRetryTimersRef.current.delete(notificationId);
        void invoke<FloatingNotificationMailboxSnapshot>("get_floating_notification_snapshot")
          .then((snapshot) => {
            applyMailboxSnapshot(snapshot);
          })
          .catch(() => undefined);
      }, NATIVE_DISMISS_SNAPSHOT_RETRY_DELAY_MS);
      nativeDismissRetryTimersRef.current.set(notificationId, timer);
    },
    [applyMailboxSnapshot]
  );

  const finishExit = useCallback(
    (notificationId: string) => {
      const currentEntry = queueRef.current.visible.find(
        (entry) => entry.notification.id === notificationId
      );
      const isDetailDismissal = queueRef.current.detailNotificationId === notificationId;
      if (
        currentEntry?.lifecycle !== "exiting" ||
        nativeDismissPendingIdsRef.current.has(notificationId)
      ) {
        return Promise.resolve(false);
      }
      nativeDismissPendingIdsRef.current.add(notificationId);
      return dismissNativeNotification(notificationId)
        .then((snapshot) => {
          if (snapshot) {
            commitQueue((current) =>
              settleFloatingNotificationExitAfterNativeDismissal(
                current,
                notificationId,
                snapshot,
                Date.now()
              )
            );
            applyMailboxSnapshot(snapshot);
            if (isDetailDismissal) {
              void invoke("set_floating_notification_detail_open", { open: false }).catch(
                () => undefined
              );
            }
            return true;
          }
          const now = Date.now();
          commitQueue((current) =>
            pauseBusinessNotifications(
              restoreBusinessNotificationAfterFailedDismissal(current, notificationId, now),
              NATIVE_DISMISS_SYNC_PAUSE_REASON,
              now
            )
          );
          retryNativeDismissSnapshot(notificationId);
          return false;
        })
        .finally(() => {
          nativeDismissPendingIdsRef.current.delete(notificationId);
        });
    },
    [applyMailboxSnapshot, commitQueue, dismissNativeNotification, retryNativeDismissSnapshot]
  );

  const beginExit = useCallback(
    (notificationIds: readonly string[]) => {
      if (notificationIds.length === 0) {
        return;
      }
      commitQueue((current) => markBusinessNotificationExiting(current, notificationIds));
    },
    [commitQueue]
  );

  useEffect(() => {
    applyFloatingNotificationTheme(theme);
  }, [theme]);

  useEffect(() => {
    document.title = "Input消息提醒";
    document.documentElement.classList.add("floating-notification-root");
    document.body.classList.add("floating-window-body", "floating-notification-window-body");
    document.getElementById("root")?.classList.add("floating-notification-root");
    return () => {
      document.documentElement.classList.remove("floating-notification-root");
      document.body.classList.remove("floating-window-body", "floating-notification-window-body");
      document.getElementById("root")?.classList.remove("floating-notification-root");
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    async function hydrateTheme() {
      try {
        const prefs = await getDesktopUiPrefs();
        if (!disposed) {
          setTheme(normalizeThemeId(prefs.theme));
          setNotificationDurationMs(prefs.floatingNotificationDurationMs);
          setNotificationDensity(normalizeFloatingNotificationDensity(prefs.floatingNotificationDensity));
          setNotificationMaxVisible(
            normalizeFloatingNotificationMaxVisible(prefs.floatingNotificationMaxVisible)
          );
        }
      } catch {
        // 主题读取失败时保留默认主题，不影响通知窗口接收 mailbox 快照。
      }
    }

    async function subscribeTheme() {
      const cleanup = await listen<{
        theme?: string | null;
        floatingNotificationDurationMs?: number;
        floatingNotificationDensity?: FloatingNotificationDensity;
        floatingNotificationMaxVisible?: number;
      }>("desktop-ui-prefs-updated", (event) => {
        if (!disposed) {
          if (event.payload.theme) {
            setTheme(normalizeThemeId(event.payload.theme));
          }
          if (typeof event.payload.floatingNotificationDurationMs === "number") {
            setNotificationDurationMs(event.payload.floatingNotificationDurationMs);
          }
          if (event.payload.floatingNotificationDensity) {
            setNotificationDensity(
              normalizeFloatingNotificationDensity(event.payload.floatingNotificationDensity)
            );
          }
          if (typeof event.payload.floatingNotificationMaxVisible === "number") {
            setNotificationMaxVisible(
              normalizeFloatingNotificationMaxVisible(event.payload.floatingNotificationMaxVisible)
            );
          }
        }
      });
      if (disposed) {
        cleanup();
        return;
      }
      unlisten = cleanup;
    }

    void hydrateTheme();
    void subscribeTheme();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    async function subscribeAndHydrate() {
      const cleanup = await listen<FloatingNotificationMailboxSnapshot>(
        "floating-notification-sync",
        (event) => {
          if (!disposed) {
            applyMailboxSnapshot(event.payload);
          }
        }
      );
      if (disposed) {
        cleanup();
        return;
      }
      unlisten = cleanup;

      try {
        const next = await invoke<FloatingNotificationMailboxSnapshot>(
          "get_floating_notification_snapshot"
        );
        if (!disposed) {
          applyMailboxSnapshot(next);
        }
      } catch {
        // 读取失败不能等价为原生 mailbox 为空，否则会留下已显示窗口的前端空壳。
      }
    }

    void subscribeAndHydrate();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applyMailboxSnapshot]);

  useEffect(() => {
    commitQueue((current) =>
      setBusinessNotificationDuration(current, notificationDurationMs, Date.now())
    );
  }, [commitQueue, notificationDurationMs]);

  useEffect(() => {
    commitQueue((current) =>
      setBusinessNotificationMaxVisible(current, notificationMaxVisible, Date.now())
    );
  }, [commitQueue, notificationMaxVisible]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    async function subscribePanelVisibility() {
      const cleanup = await listen<{ visible: boolean }>(
        "floating-notification-panel-visibility",
        ({ payload }) => {
          if (disposed) {
            return;
          }
          panelVisibilityEventVersionRef.current += 1;
          panelVisibleRef.current = payload.visible;
          commitQueue((current) => applyFloatingPanelPause(current, Date.now()));
        }
      );
      if (disposed) {
        cleanup();
        return;
      }
      unlisten = cleanup;

      // 不依赖一次性事件重放：监听就绪后以原生状态补齐面板打开期间漏掉的暂停。
      const hydrationEventVersion = panelVisibilityEventVersionRef.current;
      try {
        const panelVisible = await getFloatingPanelVisible();
        if (!disposed && panelVisibilityEventVersionRef.current === hydrationEventVersion) {
          panelVisibleRef.current = panelVisible;
          commitQueue((current) => applyFloatingPanelPause(current, Date.now()));
        }
      } catch {
        // 状态读取失败时保持现有暂停状态，避免凭空恢复消息倒计时。
      }
    }

    void subscribePanelVisibility();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applyFloatingPanelPause, commitQueue]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    async function subscribeLifecyclePause() {
      const cleanup = await listen<{ reason?: string; paused?: boolean }>(
        "floating-notification-lifecycle-pause",
        ({ payload }) => {
          if (disposed || !payload.reason?.trim()) {
            return;
          }
          const reason = payload.reason.trim();
          if (payload.paused) {
            nativeLifecyclePauseReasonsRef.current.add(reason);
          } else {
            nativeLifecyclePauseReasonsRef.current.delete(reason);
          }
          commitQueue((current) =>
            payload.paused
              ? pauseBusinessNotifications(current, reason, Date.now())
              : resumeBusinessNotifications(current, reason, Date.now())
          );
        }
      );
      if (disposed) {
        cleanup();
        return;
      }
      unlisten = cleanup;
    }

    void subscribeLifecyclePause();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [commitQueue]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    const activeNotificationIds = new Set(
      [...queue.visible, ...queue.pending, ...queue.awaitingAcknowledgement].map(
        (entry) => entry.notification.id
      )
    );
    for (const notificationId of notificationSoundCompletedIdsRef.current) {
      if (!activeNotificationIds.has(notificationId)) {
        notificationSoundCompletedIdsRef.current.delete(notificationId);
        notificationSoundAttemptCountsRef.current.delete(notificationId);
      }
    }
    for (const [notificationId, frameId] of notificationSoundFrameIdsRef.current) {
      if (!activeNotificationIds.has(notificationId)) {
        window.cancelAnimationFrame(frameId);
        notificationSoundFrameIdsRef.current.delete(notificationId);
        notificationSoundPendingIdsRef.current.delete(notificationId);
        notificationSoundAttemptCountsRef.current.delete(notificationId);
      }
    }

    const wasNotificationWindowHidden = notificationWindowWasHiddenRef.current;
    notificationWindowWasHiddenRef.current = notificationWindowHidden;
    if (notificationWindowHidden) {
      return;
    }
    if (wasNotificationWindowHidden) {
      for (const entry of queue.visible) {
        if (entry.lifecycle === "entering") {
          notificationSoundAttemptCountsRef.current.delete(entry.notification.id);
        }
      }
    }

    const isNotificationWindowHidden = () =>
      queueRef.current.pauseReasons.includes("notification-window-hidden");
    const isStillEntering = (notificationId: string) =>
      queueRef.current.visible.some(
        (entry) =>
          entry.notification.id === notificationId && entry.lifecycle === "entering"
      );

    function requestDisplayStartedSound(notificationId: string) {
      if (
        notificationSoundCompletedIdsRef.current.has(notificationId) ||
        notificationSoundPendingIdsRef.current.has(notificationId) ||
        isNotificationWindowHidden() ||
        !isStillEntering(notificationId)
      ) {
        return;
      }
      const attemptCount = notificationSoundAttemptCountsRef.current.get(notificationId) ?? 0;
      if (attemptCount >= MAX_FLOATING_NOTIFICATION_SOUND_DISPLAY_ATTEMPTS) {
        return;
      }
      notificationSoundAttemptCountsRef.current.set(notificationId, attemptCount + 1);
      notificationSoundPendingIdsRef.current.add(notificationId);
      const frameId = window.requestAnimationFrame(() => {
        if (notificationSoundFrameIdsRef.current.get(notificationId) !== frameId) {
          return;
        }
        notificationSoundFrameIdsRef.current.delete(notificationId);
        if (isNotificationWindowHidden() || !isStillEntering(notificationId)) {
          notificationSoundPendingIdsRef.current.delete(notificationId);
          return;
        }
        void requestFloatingNotificationSound(notificationId)
          .then((accepted) => {
            notificationSoundPendingIdsRef.current.delete(notificationId);
            if (accepted) {
              if (isStillEntering(notificationId)) {
                notificationSoundCompletedIdsRef.current.add(notificationId);
              }
              return;
            }
            if (
              !isNotificationWindowHidden() &&
              isStillEntering(notificationId)
            ) {
              requestDisplayStartedSound(notificationId);
            }
          })
          .catch(() => {
            notificationSoundPendingIdsRef.current.delete(notificationId);
          });
      });
      notificationSoundFrameIdsRef.current.set(notificationId, frameId);
    }

    for (const entry of queue.visible) {
      if (entry.lifecycle === "entering") {
        requestDisplayStartedSound(entry.notification.id);
      }
    }
  }, [notificationWindowHidden, queue]);

  useEffect(() => {
    const activeFallbackKeys = new Set<string>();
    for (const entry of queue.visible) {
      if (entry.lifecycle !== "entering" && entry.lifecycle !== "exiting") {
        continue;
      }
      const fallbackKey = `${entry.notification.id}:${entry.lifecycle}`;
      activeFallbackKeys.add(fallbackKey);
      const duration =
        entry.lifecycle === "entering"
          ? FLOATING_NOTIFICATION_ENTER_DURATION_MS
          : FLOATING_NOTIFICATION_EXIT_DURATION_MS;
      let fallback = animationFallbackTimersRef.current.get(fallbackKey);
      if (!fallback) {
        fallback = {
          ...createFloatingNotificationAnimationFallback(
            duration + FLOATING_NOTIFICATION_ANIMATION_FALLBACK_BUFFER_MS
          ),
          timer: null
        };
        animationFallbackTimersRef.current.set(fallbackKey, fallback);
      }
      if (notificationLifecyclePaused) {
        if (fallback.timer !== null) {
          window.clearTimeout(fallback.timer);
        }
        const paused = pauseFloatingNotificationAnimationFallback(fallback, Date.now());
        fallback.remainingMs = paused.remainingMs;
        fallback.startedAt = paused.startedAt;
        fallback.timer = null;
        continue;
      }
      if (fallback.timer !== null) {
        continue;
      }
      const resumed = resumeFloatingNotificationAnimationFallback(fallback, Date.now());
      fallback.remainingMs = resumed.remainingMs;
      fallback.startedAt = resumed.startedAt;
      const timer = window.setTimeout(() => {
        const current = animationFallbackTimersRef.current.get(fallbackKey);
        if (current?.timer !== timer) {
          return;
        }
        animationFallbackTimersRef.current.delete(fallbackKey);
        if (entry.lifecycle === "entering") {
          commitQueue((current) =>
            markBusinessNotificationVisible(current, entry.notification.id, Date.now())
          );
          return;
        }
        finishExit(entry.notification.id);
      }, fallback.remainingMs);
      fallback.timer = timer;
    }
    for (const [fallbackKey, fallback] of animationFallbackTimersRef.current) {
      if (!activeFallbackKeys.has(fallbackKey)) {
        if (fallback.timer !== null) {
          window.clearTimeout(fallback.timer);
        }
        animationFallbackTimersRef.current.delete(fallbackKey);
      }
    }
  }, [commitQueue, finishExit, notificationLifecyclePaused, queue.visible]);

  useEffect(
    () => () => {
      for (const fallback of animationFallbackTimersRef.current.values()) {
        if (fallback.timer !== null) {
          window.clearTimeout(fallback.timer);
        }
      }
      animationFallbackTimersRef.current.clear();
      for (const timer of nativeDismissRetryTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      nativeDismissRetryTimersRef.current.clear();
      for (const frameId of notificationSoundFrameIdsRef.current.values()) {
        window.cancelAnimationFrame(frameId);
      }
      notificationSoundFrameIdsRef.current.clear();
      notificationSoundPendingIdsRef.current.clear();
      notificationSoundCompletedIdsRef.current.clear();
      notificationSoundAttemptCountsRef.current.clear();
    },
    []
  );

  useEffect(() => {
    const expiryDelay = getNextBusinessNotificationExpiryDelay(queue, Date.now());
    if (expiryDelay === null) {
      return;
    }
    const timer = window.setTimeout(() => {
      const expiredIds = getExpiredBusinessNotificationIds(queueRef.current, Date.now());
      if (expiredIds.length === 0) {
        return;
      }
      beginExit(expiredIds);
    }, expiryDelay);
    return () => window.clearTimeout(timer);
  }, [beginExit, queue]);

  useEffect(() => {
    if (
      !isTauriRuntime() ||
      queue.detailNotificationId ||
      !isFloatingNotificationMotionSettled(queue)
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      void invoke("settle_floating_notification_motion").catch(() => undefined);
    }, FLOATING_NOTIFICATION_REGION_SETTLE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [notificationDensity, notificationDock, notificationGeometryEpoch, queue]);

  useEffect(() => {
    if (!queue.detailNotificationId) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        commitQueue((current) => closeBusinessNotificationDetail(current, Date.now()));
        void invoke("set_floating_notification_detail_open", { open: false }).catch(() => undefined);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [commitQueue, queue.detailNotificationId]);

  const pause = (reason: "hover" | "focus") => {
    commitQueue((current) => pauseBusinessNotifications(current, reason, Date.now()));
  };
  const resume = (reason: "hover" | "focus") => {
    commitQueue((current) => resumeBusinessNotifications(current, reason, Date.now()));
  };
  const openDetail = (notificationId: string) => {
    const now = Date.now();
    commitQueue((current) => {
      const withoutHover = resumeBusinessNotifications(current, "hover", now);
      const withoutTransientPause = resumeBusinessNotifications(withoutHover, "focus", now);
      return openBusinessNotificationDetail(withoutTransientPause, notificationId, now);
    });
    void invoke("set_floating_notification_detail_open", { open: true }).catch(() => undefined);
  };
  const closeDetail = () => {
    const now = Date.now();
    commitQueue((current) => {
      const withoutHover = resumeBusinessNotifications(current, "hover", now);
      const withoutTransientPause = resumeBusinessNotifications(withoutHover, "focus", now);
      return closeBusinessNotificationDetail(withoutTransientPause, now);
    });
    void invoke("set_floating_notification_detail_open", { open: false }).catch(() => undefined);
  };
  const dismissDetail = (notificationId: string) => {
    commitQueue((current) =>
      beginFloatingNotificationDetailDismissal(current, notificationId, Date.now())
    );
    void finishExit(notificationId);
  };

  const detail = queue.detailNotificationId
    ? [...queue.visible, ...queue.pending].find(
        (entry) => entry.notification.id === queue.detailNotificationId
      )?.notification
    : undefined;
  const layout = getFloatingNotificationLayout(notificationDensity);
  const notificationSlots = new Map<string, { height: number; offset: number }>();
  let notificationOffset = layout.verticalPadding / 2;
  for (let index = queue.visible.length - 1; index >= 0; index -= 1) {
    const notification = queue.visible[index]?.notification;
    if (!notification) {
      continue;
    }
    const height = getFloatingNotificationItemHeight(Boolean(notification.usage), notificationDensity);
    notificationSlots.set(notification.id, { height, offset: notificationOffset });
    notificationOffset += height + layout.gap;
  }

  return (
    <main
      className={`floating-notification-window${detail ? " detail-open" : ""}`}
      data-density={notificationDensity}
      data-dock={notificationDock}
      data-lifecycle-paused={notificationLifecyclePaused ? "true" : "false"}
      style={
        {
          "--notification-gap": `${layout.gap}px`,
          "--notification-padding": `${layout.verticalPadding / 2}px`
        } as CSSProperties
      }
    >
      {detail ? (
        <section
          className="floating-notification-detail"
          role="dialog"
          aria-modal="true"
          aria-labelledby="floating-notification-detail-title"
        >
          <header>
            <div className="floating-notification-detail-heading">
              <span className={`floating-notification-level level-${detail.level}`}>
                <FloatingNotificationLevelIcon level={detail.level} />
                {levelLabels[detail.level]}
              </span>
              <h1 id="floating-notification-detail-title">{detail.title}</h1>
            </div>
            <button
              type="button"
              className="floating-notification-detail-close"
              onClick={closeDetail}
              aria-label="关闭消息详情"
              autoFocus
            >
              <X aria-hidden="true" size={16} />
            </button>
          </header>
          <div className="floating-notification-detail-body">
            {detail.usage ? (
              <div className="floating-usage-detail-grid">
                <section>
                  <span>请求信息</span>
                  <dl>
                    <div><dt>API Key</dt><dd>{detail.usage.apiKeyLabel}</dd></div>
                    <div><dt>模型</dt><dd>{detail.usage.model}</dd></div>
                    <div><dt>推理强度</dt><dd>{formatUsageReasoningEffort(detail.usage.reasoningEffort)}</dd></div>
                    <div><dt>更新时间</dt><dd><time dateTime={detail.createdAt}>{formatDateTimeFull(detail.createdAt)}</time></dd></div>
                  </dl>
                </section>
                <section>
                  <span>Token 与性能</span>
                  <UsageNotificationMetrics usage={detail.usage} detail />
                </section>
                <section className="floating-usage-total-cost">
                  <span>计费总额</span>
                  <strong>{formatUsageCost(detail.usage.totalCost)}</strong>
                </section>
              </div>
            ) : (
              <>
                <dl>
                  <div><dt>来源</dt><dd>{detail.source}</dd></div>
                  <div><dt>时间</dt><dd><time dateTime={detail.createdAt}>{formatDateTimeFull(detail.createdAt)}</time></dd></div>
                  {detail.account ? <div><dt>账号</dt><dd>{detail.account.label}</dd></div> : null}
                  {detail.site ? <div><dt>站点</dt><dd>{detail.site.label}</dd></div> : null}
                  {detail.model ? <div><dt>模型</dt><dd>{detail.model.label}</dd></div> : null}
                </dl>
                <div className="floating-notification-detail-content">
                  <span>完整内容</span>
                  <p>{detail.content}</p>
                </div>
              </>
            )}
          </div>
          <footer>
            <button type="button" className="floating-notification-dismiss" onClick={() => dismissDetail(detail.id)}>
              我知道了
            </button>
          </footer>
        </section>
      ) : (
        <ol className="floating-notification-list" aria-live="polite" aria-atomic="false">
          {queue.visible.map((entry) => {
            const { notification } = entry;
            const slot = notificationSlots.get(notification.id) ?? {
              height: getFloatingNotificationItemHeight(Boolean(notification.usage), notificationDensity),
              offset: layout.verticalPadding / 2
            };
            return (
              <li
                className={`floating-notification-slot is-${entry.lifecycle} level-${notification.level}`}
                key={notification.id}
                style={
                  {
                    "--notification-height": `${slot.height}px`,
                    "--notification-offset": `${slot.offset}px`
                  } as CSSProperties
                }
                onAnimationEnd={(event) => {
                  if (event.target !== event.currentTarget) {
                    return;
                  }
                  const lifecycle = resolveFloatingNotificationAnimationLifecycle(
                    event.animationName
                  );
                  if (lifecycle === "exit") {
                    const fallbackKey = `${notification.id}:exiting`;
                    const fallback = animationFallbackTimersRef.current.get(fallbackKey);
                    if (fallback?.timer !== null && fallback?.timer !== undefined) {
                      window.clearTimeout(fallback.timer);
                    }
                    animationFallbackTimersRef.current.delete(fallbackKey);
                    finishExit(notification.id);
                  } else if (lifecycle === "enter") {
                    const fallbackKey = `${notification.id}:entering`;
                    const fallback = animationFallbackTimersRef.current.get(fallbackKey);
                    if (fallback?.timer !== null && fallback?.timer !== undefined) {
                      window.clearTimeout(fallback.timer);
                    }
                    animationFallbackTimersRef.current.delete(fallbackKey);
                    commitQueue((current) =>
                      markBusinessNotificationVisible(current, notification.id, Date.now())
                    );
                  }
                }}
              >
                <button
                  className={`floating-notification-pill level-${notification.level}${notification.usage ? " usage-notification-pill" : ""}`}
                  type="button"
                  onPointerEnter={() => pause("hover")}
                  onPointerLeave={() => resume("hover")}
                  onFocus={() => pause("focus")}
                  onBlur={() => resume("focus")}
                  onClick={() => openDetail(notification.id)}
                  aria-label={`打开消息详情: ${notification.title}`}
                >
                  {notification.usage ? (
                    <span className="floating-usage-card">
                      <span className="floating-usage-card-header">
                        <span className="floating-notification-icon"><FloatingNotificationLevelIcon level={notification.level} size={14} /></span>
                        <span className="floating-usage-card-identity">
                          <strong title={notification.usage.apiKeyLabel}>{notification.usage.apiKeyLabel}</strong>
                        </span>
                        {notification.usage.serviceTier?.trim() ? (
                          <span className="floating-usage-service-tier" title={notification.usage.serviceTier}>
                            {formatUsageServiceTier(notification.usage.serviceTier)}
                          </span>
                        ) : null}
                        <span className="floating-usage-card-meta">
                          <time dateTime={notification.createdAt} title={formatDateTimeFull(notification.createdAt)}>{formatTimeOnly(notification.createdAt)}</time>
                        </span>
                      </span>
                      <UsageNotificationMetrics usage={notification.usage} />
                    </span>
                  ) : (
                    <>
                      <span className="floating-notification-icon"><FloatingNotificationLevelIcon level={notification.level} /></span>
                      <span className="floating-notification-copy">
                        <span className="floating-notification-title-line"><strong title={notification.title}>{notification.title}</strong><span>{levelLabels[notification.level]}</span></span>
                        <span className="floating-notification-content" title={notification.content}>{notification.content}</span>
                      </span>
                      <time className="floating-notification-time" dateTime={notification.createdAt} title={formatDateTimeFull(notification.createdAt)}>{formatTimeOnly(notification.createdAt)}</time>
                    </>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </main>
  );
}
