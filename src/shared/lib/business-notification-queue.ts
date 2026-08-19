import {
  DEFAULT_FLOATING_NOTIFICATION_MAX_VISIBLE,
  normalizeFloatingNotificationMaxVisible
} from "./floating-notification-layout";

export const MAX_VISIBLE_BUSINESS_NOTIFICATIONS = DEFAULT_FLOATING_NOTIFICATION_MAX_VISIBLE;
export const DEFAULT_BUSINESS_NOTIFICATION_DURATION_MS = 7_000;

export type BusinessNotificationLevel =
  | "critical"
  | "high"
  | "medium"
  | "warning"
  | "low"
  | "success"
  | "info";

export type BusinessNotificationChannel = "business" | "usage";

export interface BusinessNotificationReference {
  id?: string;
  label: string;
}

export interface BusinessUsageNotification {
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
}

export interface BusinessNotificationPayload {
  id: string;
  dedupeKey: string;
  channel: BusinessNotificationChannel;
  title: string;
  level: BusinessNotificationLevel;
  source: string;
  createdAt: string;
  content: string;
  account?: BusinessNotificationReference;
  site?: BusinessNotificationReference;
  model?: BusinessNotificationReference;
  usage?: BusinessUsageNotification;
}

export type BusinessNotificationQueueInput =
  | {
      type: "business";
      notification: BusinessNotificationPayload;
      durationMs?: number;
    }
  | {
      type: "toast";
    };

export type BusinessNotificationLifecycle =
  | "entering"
  | "visible"
  | "exiting"
  | "awaiting-ack";

export interface BusinessNotificationQueueEntry {
  notification: BusinessNotificationPayload;
  durationMs: number;
  remainingMs: number;
  lastResumedAt: number;
  lifecycle: BusinessNotificationLifecycle;
}

export interface BusinessNotificationQueueState {
  visible: readonly BusinessNotificationQueueEntry[];
  pending: readonly BusinessNotificationQueueEntry[];
  awaitingAcknowledgement: readonly BusinessNotificationQueueEntry[];
  /** 已请求退场但仍在等待前一条消息完成流水线的消息 ID。 */
  exitRequestedIds: readonly string[];
  dedupeKeys: readonly string[];
  pauseReasons: readonly string[];
  detailNotificationId: string | null;
  maxVisible: number;
}

export function getNextBusinessNotificationExpiryDelay(
  state: BusinessNotificationQueueState,
  now = Date.now()
): number | null {
  const normalizedState = resetEmptyQueueInteractionState(state);
  if (
    normalizedState.pauseReasons.length > 0 ||
    normalizedState.visible.length === 0 ||
    hasLifecycleTransitionInProgress(normalizedState)
  ) {
    return null;
  }

  const expiringEntry = normalizedState.visible.find(isCountdownActive);
  if (!expiringEntry) {
    return null;
  }

  const elapsedMs = Math.max(0, now - expiringEntry.lastResumedAt);
  return Math.max(0, expiringEntry.remainingMs - elapsedMs);
}

export function getExpiredBusinessNotificationIds(
  state: BusinessNotificationQueueState,
  now = Date.now()
): string[] {
  if (state.pauseReasons.length > 0 || hasLifecycleTransitionInProgress(state)) {
    return [];
  }

  const expiringEntry = state.visible.find(isCountdownActive);
  if (!expiringEntry || now - expiringEntry.lastResumedAt < expiringEntry.remainingMs) {
    return [];
  }
  return [expiringEntry.notification.id];
}

export function createBusinessNotificationQueueState(): BusinessNotificationQueueState {
  return {
    visible: [],
    pending: [],
    awaitingAcknowledgement: [],
    exitRequestedIds: [],
    dedupeKeys: [],
    pauseReasons: [],
    detailNotificationId: null,
    maxVisible: DEFAULT_FLOATING_NOTIFICATION_MAX_VISIBLE
  };
}

export function enqueueBusinessNotification(
  state: BusinessNotificationQueueState,
  input: BusinessNotificationQueueInput,
  now = Date.now()
): BusinessNotificationQueueState {
  if (input.type !== "business") {
    return state;
  }

  const settled = resetEmptyQueueInteractionState(state);
  if (settled.dedupeKeys.includes(input.notification.dedupeKey)) {
    return settled;
  }

  return continueBusinessNotificationPipeline(
    {
      ...settled,
      pending: [...settled.pending, createQueueEntry(input.notification, input.durationMs, now)],
      dedupeKeys: [...settled.dedupeKeys, input.notification.dedupeKey]
    },
    now,
    false
  );
}

export function releaseBusinessNotificationDedupeKey(
  state: BusinessNotificationQueueState,
  dedupeKey: string
): BusinessNotificationQueueState {
  if (!state.dedupeKeys.includes(dedupeKey) || containsDedupeKey(state, dedupeKey)) {
    return state;
  }

  return {
    ...state,
    dedupeKeys: state.dedupeKeys.filter((item) => item !== dedupeKey)
  };
}

export function pauseBusinessNotifications(
  state: BusinessNotificationQueueState,
  reason: string,
  now = Date.now()
): BusinessNotificationQueueState {
  const normalizedState = resetEmptyQueueInteractionState(state);
  const normalizedReason = reason.trim();
  if (
    !normalizedReason ||
    !hasQueuedNotifications(normalizedState) ||
    normalizedState.pauseReasons.includes(normalizedReason)
  ) {
    return normalizedState;
  }

  const settled = advanceVisibleNotifications(normalizedState, now);
  return {
    ...settled,
    pauseReasons: [...settled.pauseReasons, normalizedReason]
  };
}

export function resumeBusinessNotifications(
  state: BusinessNotificationQueueState,
  reason: string,
  now = Date.now()
): BusinessNotificationQueueState {
  const normalizedState = resetEmptyQueueInteractionState(state);
  const normalizedReason = reason.trim();
  if (!normalizedReason || !normalizedState.pauseReasons.includes(normalizedReason)) {
    return normalizedState;
  }

  const pauseReasons = normalizedState.pauseReasons.filter((item) => item !== normalizedReason);
  if (pauseReasons.length > 0) {
    return {
      ...normalizedState,
      pauseReasons
    };
  }

  return {
    ...normalizedState,
    pauseReasons,
    visible: normalizedState.visible.map((entry) => ({
      ...entry,
      lastResumedAt: now
    }))
  };
}

export function expireBusinessNotifications(
  state: BusinessNotificationQueueState,
  now = Date.now()
): BusinessNotificationQueueState {
  const normalizedState = resetEmptyQueueInteractionState(state);
  if (normalizedState.pauseReasons.length > 0) {
    return normalizedState;
  }

  const settled = advanceVisibleNotifications(normalizedState, now);
  const expiredIds = getExpiredBusinessNotificationIds(settled, now);
  if (expiredIds.length === 0) {
    return settled;
  }

  return markBusinessNotificationExiting(settled, expiredIds);
}

/** 仅在 mailbox 确认消息已移除后清理本地队列项。 */
export function dismissBusinessNotification(
  state: BusinessNotificationQueueState,
  notificationId: string,
  now = Date.now()
): BusinessNotificationQueueState {
  const visible = state.visible.filter((entry) => entry.notification.id !== notificationId);
  const pending = state.pending.filter((entry) => entry.notification.id !== notificationId);
  const awaitingAcknowledgement = state.awaitingAcknowledgement.filter(
    (entry) => entry.notification.id !== notificationId
  );
  const exitRequestedIds = state.exitRequestedIds.filter((id) => id !== notificationId);
  if (
    visible.length === state.visible.length &&
    pending.length === state.pending.length &&
    awaitingAcknowledgement.length === state.awaitingAcknowledgement.length &&
    exitRequestedIds.length === state.exitRequestedIds.length
  ) {
    return state;
  }

  let next: BusinessNotificationQueueState = {
    ...state,
    visible,
    pending,
    awaitingAcknowledgement,
    exitRequestedIds,
    detailNotificationId:
      state.detailNotificationId === notificationId ? null : state.detailNotificationId
  };

  if (state.detailNotificationId === notificationId) {
    next = resumeBusinessNotifications(next, "detail", now);
  }

  return resetEmptyQueueInteractionState(
    continueBusinessNotificationPipeline(next, now, true)
  );
}

/** 完成视觉退出后统一进入原生确认阶段, 在确认前继续占用队列容量。 */
export function completeBusinessNotificationExit(
  state: BusinessNotificationQueueState,
  notificationId: string,
  now = Date.now()
): BusinessNotificationQueueState {
  const entry = state.visible.find((item) => item.notification.id === notificationId);
  if (!entry || entry.lifecycle !== "exiting") {
    return state;
  }

  const visible = state.visible.filter((item) => item.notification.id !== notificationId);
  let next: BusinessNotificationQueueState = {
    ...state,
    visible,
    awaitingAcknowledgement: [
      ...state.awaitingAcknowledgement,
      { ...entry, lifecycle: "awaiting-ack" }
    ],
    detailNotificationId:
      state.detailNotificationId === notificationId ? null : state.detailNotificationId
  };
  if (state.detailNotificationId === notificationId) {
    next = resumeBusinessNotifications(next, "detail", now);
  }
  return resetEmptyQueueInteractionState(promotePendingNotifications(next, now));
}

/** 原生 dismiss 未获确认时恢复消息可见，不能把本地动画当作删除确认。 */
export function restoreBusinessNotificationAfterFailedDismissal(
  state: BusinessNotificationQueueState,
  notificationId: string,
  now = Date.now()
): BusinessNotificationQueueState {
  if (
    !state.visible.some(
      (entry) => entry.notification.id === notificationId && entry.lifecycle === "exiting"
    )
  ) {
    return state;
  }

  return {
    ...state,
    visible: state.visible.map((entry) =>
      entry.notification.id === notificationId && entry.lifecycle === "exiting"
        ? { ...entry, lifecycle: "visible", lastResumedAt: now }
        : entry
    ),
    exitRequestedIds: state.exitRequestedIds.filter((id) => id !== notificationId)
  };
}

export function acknowledgeBusinessNotificationDismissal(
  state: BusinessNotificationQueueState,
  notificationId: string,
  now = Date.now()
): BusinessNotificationQueueState {
  const acknowledgedEntry = state.awaitingAcknowledgement.find(
    (entry) => entry.notification.id === notificationId
  );
  if (!acknowledgedEntry) {
    return state;
  }
  return releaseBusinessNotificationDedupeKey(
    dismissBusinessNotification(state, notificationId, now),
    acknowledgedEntry.notification.dedupeKey
  );
}

export function markBusinessNotificationExiting(
  state: BusinessNotificationQueueState,
  notificationIds: readonly string[]
): BusinessNotificationQueueState {
  const ids = new Set(notificationIds);
  if (ids.size === 0) {
    return state;
  }

  const requestedIds = state.visible
    .filter(
      (entry) =>
        ids.has(entry.notification.id) &&
        entry.lifecycle !== "exiting" &&
        !state.exitRequestedIds.includes(entry.notification.id)
    )
    .map((entry) => entry.notification.id);
  if (requestedIds.length === 0) {
    return state;
  }

  return activateNextExitRequest({
    ...state,
    exitRequestedIds: [...state.exitRequestedIds, ...requestedIds]
  });
}

export function markBusinessNotificationVisible(
  state: BusinessNotificationQueueState,
  notificationId: string,
  now = Date.now()
): BusinessNotificationQueueState {
  if (
    !state.visible.some(
      (entry) => entry.notification.id === notificationId && entry.lifecycle === "entering"
    )
  ) {
    return state;
  }

  return continueBusinessNotificationPipeline({
      ...state,
      visible: state.visible.map((entry) =>
        entry.notification.id === notificationId && entry.lifecycle === "entering"
          ? { ...entry, lifecycle: "visible", lastResumedAt: now }
          : entry
      )
    },
    now,
    false
  );
}

/** 更新队列停留时长并保留每条可计时消息已经消耗的时间。 */
export function setBusinessNotificationDuration(
  state: BusinessNotificationQueueState,
  durationMs: number,
  now = Date.now()
): BusinessNotificationQueueState {
  const resolvedDurationMs = normalizeDuration(durationMs);
  const settled = advanceVisibleNotifications(state, now);
  const updateEntry = (entry: BusinessNotificationQueueEntry) => {
    if (entry.lifecycle === "exiting" || entry.lifecycle === "awaiting-ack") {
      return entry;
    }
    const elapsedMs = Math.max(0, entry.durationMs - entry.remainingMs);
    return {
      ...entry,
      durationMs: resolvedDurationMs,
      remainingMs: Math.max(0, resolvedDurationMs - elapsedMs)
    };
  };
  return {
    ...settled,
    visible: settled.visible.map(updateEntry),
    pending: settled.pending.map(updateEntry)
  };
}

export function setBusinessNotificationMaxVisible(
  state: BusinessNotificationQueueState,
  maxVisible: number,
  now = Date.now()
): BusinessNotificationQueueState {
  const resolvedMaxVisible = normalizeFloatingNotificationMaxVisible(maxVisible);
  const settled = advanceVisibleNotifications(
    { ...state, maxVisible: resolvedMaxVisible },
    now
  );
  if (
    settled.visible.length + settled.awaitingAcknowledgement.length <=
    resolvedMaxVisible
  ) {
    return continueBusinessNotificationPipeline(settled, now, false);
  }

  const exitingCount = settled.visible.filter((entry) => entry.lifecycle === "exiting").length;
  const reservedCapacity = exitingCount + settled.awaitingAcknowledgement.length;
  const activeCapacity = Math.max(0, resolvedMaxVisible - reservedCapacity);
  const activeVisible = settled.visible.filter((entry) => entry.lifecycle !== "exiting");
  const keepIds = new Set(
    activeVisible.slice(0, activeCapacity).map((entry) => entry.notification.id)
  );
  const moved = settled.visible.filter(
    (entry) => entry.lifecycle !== "exiting" && !keepIds.has(entry.notification.id)
  );
  const retained = settled.visible.filter(
    (entry) => entry.lifecycle === "exiting" || keepIds.has(entry.notification.id)
  );
  return continueBusinessNotificationPipeline(
    {
      ...settled,
      visible: retained,
      pending: [...moved, ...settled.pending]
    },
    now,
    false
  );
}

export function openBusinessNotificationDetail(
  state: BusinessNotificationQueueState,
  notificationId: string,
  now = Date.now()
): BusinessNotificationQueueState {
  if (
    !state.visible.some(
      (entry) => entry.notification.id === notificationId && entry.lifecycle !== "exiting"
    )
  ) {
    return state;
  }

  const paused = pauseBusinessNotifications(state, "detail", now);
  return {
    ...paused,
    detailNotificationId: notificationId
  };
}

export function closeBusinessNotificationDetail(
  state: BusinessNotificationQueueState,
  now = Date.now()
): BusinessNotificationQueueState {
  if (!state.detailNotificationId) {
    return resetEmptyQueueInteractionState(state);
  }

  return resumeBusinessNotifications(
    {
      ...state,
      detailNotificationId: null
    },
    "detail",
    now
  );
}

function advanceVisibleNotifications(
  state: BusinessNotificationQueueState,
  now: number
): BusinessNotificationQueueState {
  if (state.pauseReasons.length > 0 || state.visible.length === 0) {
    return state;
  }

  return {
    ...state,
    visible: state.visible.map((entry) => {
      if (!isCountdownActive(entry)) {
        return entry;
      }
      const lastResumedAt = Math.max(entry.lastResumedAt, now);
      const elapsedMs = lastResumedAt - entry.lastResumedAt;
      return {
        ...entry,
        remainingMs: Math.max(0, entry.remainingMs - elapsedMs),
        lastResumedAt
      };
    })
  };
}

function promotePendingNotifications(
  state: BusinessNotificationQueueState,
  now: number
): BusinessNotificationQueueState {
  const occupiedCapacity = state.visible.length + state.awaitingAcknowledgement.length;
  if (
    state.pending.length === 0 ||
    occupiedCapacity >= state.maxVisible ||
    hasLifecycleTransitionInProgress(state)
  ) {
    return state;
  }

  const [entry, ...pending] = state.pending;
  if (!entry) {
    return state;
  }
  return {
    ...state,
    visible: [
      ...state.visible,
      {
        ...entry,
        lastResumedAt: now,
        lifecycle: "entering"
      }
    ],
    pending
  };
}

/** 在没有入场、退场或原生确认任务时，只启动队首的一条待退场消息。 */
function activateNextExitRequest(
  state: BusinessNotificationQueueState
): BusinessNotificationQueueState {
  const visibleIds = new Set(state.visible.map((entry) => entry.notification.id));
  const exitRequestedIds = state.exitRequestedIds.filter((id) => visibleIds.has(id));
  const normalizedState =
    exitRequestedIds.length === state.exitRequestedIds.length
      ? state
      : { ...state, exitRequestedIds };
  if (
    exitRequestedIds.length === 0 ||
    hasLifecycleTransitionInProgress(normalizedState)
  ) {
    return normalizedState;
  }

  const [notificationId, ...remainingExitRequestedIds] = exitRequestedIds;
  return {
    ...normalizedState,
    exitRequestedIds: remainingExitRequestedIds,
    visible: normalizedState.visible.map((entry) =>
      entry.notification.id === notificationId
        ? { ...entry, lifecycle: "exiting" }
        : entry
    )
  };
}

/**
 * 推进统一动画流水线。确认退场后优先补一个底部槽位；入场完成后优先处理下一条退场请求。
 */
function continueBusinessNotificationPipeline(
  state: BusinessNotificationQueueState,
  now: number,
  preferPromotion: boolean
): BusinessNotificationQueueState {
  if (hasLifecycleTransitionInProgress(state)) {
    return state;
  }

  if (preferPromotion) {
    const promoted = promotePendingNotifications(state, now);
    if (promoted !== state) {
      return promoted;
    }
  }

  const exiting = activateNextExitRequest(state);
  if (hasLifecycleTransitionInProgress(exiting)) {
    return exiting;
  }
  return promotePendingNotifications(exiting, now);
}

function hasLifecycleTransitionInProgress(state: BusinessNotificationQueueState) {
  return (
    state.awaitingAcknowledgement.length > 0 ||
    state.visible.some(
      (entry) => entry.lifecycle === "entering" || entry.lifecycle === "exiting"
    )
  );
}

function isCountdownActive(entry: BusinessNotificationQueueEntry) {
  return entry.lifecycle === "visible";
}

function containsDedupeKey(state: BusinessNotificationQueueState, dedupeKey: string) {
  return [...state.visible, ...state.pending, ...state.awaitingAcknowledgement].some(
    (entry) => entry.notification.dedupeKey === dedupeKey
  );
}

function createQueueEntry(
  notification: BusinessNotificationPayload,
  durationMs: number | undefined,
  now: number
): BusinessNotificationQueueEntry {
  const resolvedDurationMs = normalizeDuration(durationMs);
  return {
    notification,
    durationMs: resolvedDurationMs,
    remainingMs: resolvedDurationMs,
    lastResumedAt: now,
    lifecycle: "entering"
  };
}

function normalizeDuration(value: number | undefined) {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return DEFAULT_BUSINESS_NOTIFICATION_DURATION_MS;
  }
  return Math.floor(value);
}

function hasQueuedNotifications(state: BusinessNotificationQueueState) {
  return (
    state.visible.length > 0 ||
    state.pending.length > 0 ||
    state.awaitingAcknowledgement.length > 0
  );
}

function resetEmptyQueueInteractionState(
  state: BusinessNotificationQueueState
): BusinessNotificationQueueState {
  if (
    hasQueuedNotifications(state) ||
    (state.pauseReasons.length === 0 && state.detailNotificationId === null)
  ) {
    return state;
  }

  return {
    ...state,
    exitRequestedIds: [],
    pauseReasons: [],
    detailNotificationId: null
  };
}
