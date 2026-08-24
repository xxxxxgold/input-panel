import type { AccountSyncStatusRecord } from "../types";
import type { SyncTaskCenterTask, SyncTaskCenterTaskState } from "./SyncTaskCenter";

const MIN_COMPLETED_TASK_RETENTION_MINUTES = 1;
const MAX_COMPLETED_TASK_RETENTION_MINUTES = 1_440;
const RFC3339_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[Tt](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function normalizeCompletedTaskRetentionMinutes(value: number) {
  if (!Number.isFinite(value)) {
    return MIN_COMPLETED_TASK_RETENTION_MINUTES;
  }
  return Math.min(
    Math.max(Math.round(value), MIN_COMPLETED_TASK_RETENTION_MINUTES),
    MAX_COMPLETED_TASK_RETENTION_MINUTES
  );
}

/** 只接受可确定瞬间且日历合法的 RFC3339 时间，避免 Date.parse 宽松归一化损坏载荷。 */
function parseRfc3339Timestamp(value: string) {
  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match || value.endsWith("-00:00")) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = month === 2
    ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** 使用后端 runId 构造稳定任务身份，旧 payload 才回退到 scope 身份。 */
export function buildSyncTaskRecordId(status: AccountSyncStatusRecord) {
  const baseId = `${status.accountId}:${status.scope}`;
  return status.runId ? `${baseId}:${status.runId}` : baseId;
}

/** 判断任务中心的终态任务是否已达到配置的保留期限。 */
export function isSyncTaskExpired(
  task: SyncTaskCenterTask,
  completedTaskRetentionMinutes: number,
  now = Date.now()
) {
  if (task.state === "running" || !task.finishedAt) {
    return false;
  }

  const finishedAt = parseRfc3339Timestamp(task.finishedAt);
  if (finishedAt === null) {
    return false;
  }

  const retentionMinutes = normalizeCompletedTaskRetentionMinutes(completedTaskRetentionMinutes);
  return now >= finishedAt + retentionMinutes * 60_000;
}

/** 移除已过期终态任务；没有过期记录时保留原数组引用，避免无效渲染。 */
export function filterExpiredSyncTasks(
  tasks: SyncTaskCenterTask[],
  completedTaskRetentionMinutes: number,
  now = Date.now()
) {
  const expiredTaskIds = new Set(
    getExpiredSyncTaskIds(tasks, completedTaskRetentionMinutes, now)
  );
  return expiredTaskIds.size > 0
    ? tasks.filter((task) => !expiredTaskIds.has(task.id))
    : tasks;
}

/** 返回当前已到期的终态记录，供调用方保留同一旧 run 的 finishedAt 身份。 */
export function getExpiredSyncTasks(
  tasks: SyncTaskCenterTask[],
  completedTaskRetentionMinutes: number,
  now = Date.now()
) {
  return tasks.filter((task) => isSyncTaskExpired(task, completedTaskRetentionMinutes, now));
}

/** 返回当前已到期任务的稳定 run ID，供壳层阻止同一旧 run 被状态轮询重新加入。 */
export function getExpiredSyncTaskIds(
  tasks: SyncTaskCenterTask[],
  completedTaskRetentionMinutes: number,
  now = Date.now()
) {
  return getExpiredSyncTasks(tasks, completedTaskRetentionMinutes, now).map((task) => task.id);
}

function hasDifferentFinishedAt(
  statusFinishedAt: string | null | undefined,
  suppressedFinishedAt: string
) {
  if (!statusFinishedAt) {
    return false;
  }
  const statusTimestamp = parseRfc3339Timestamp(statusFinishedAt);
  const suppressedTimestamp = parseRfc3339Timestamp(suppressedFinishedAt);
  // 仅接受严格 RFC3339 且不同的终态时间，损坏的旧 payload 不能解除已到期 run 的抑制。
  return statusTimestamp !== null &&
    suppressedTimestamp !== null &&
    statusTimestamp !== suppressedTimestamp;
}

/**
 * 后端同账号 scope 只返回当前 run；出现新 run 时移除该 scope 的旧抑制项。
 * 不依据 status 缺席清理，因为 Full 运行期间后端会有意省略其他 scope。
 */
export function pruneSuppressedSyncTaskRuns(
  suppressedTaskFinishedAt: Map<string, string>,
  latestStatuses: AccountSyncStatusRecord[]
) {
  for (const status of latestStatuses) {
    if (!status.runId) {
      continue;
    }

    const currentTaskId = buildSyncTaskRecordId(status);
    const scopeTaskId = `${status.accountId}:${status.scope}`;
    const scopeRunPrefix = `${scopeTaskId}:`;
    for (const taskId of suppressedTaskFinishedAt.keys()) {
      if (
        (taskId === scopeTaskId || taskId.startsWith(scopeRunPrefix)) &&
        taskId !== currentTaskId
      ) {
        suppressedTaskFinishedAt.delete(taskId);
      }
    }
  }
}

/** 返回下一条合法终态记录到期前的毫秒数；没有可自动清理记录时返回 null。 */
export function getNextSyncTaskExpirationDelay(
  tasks: SyncTaskCenterTask[],
  completedTaskRetentionMinutes: number,
  now = Date.now()
) {
  const retentionMinutes = normalizeCompletedTaskRetentionMinutes(completedTaskRetentionMinutes);
  let nextExpiration: number | null = null;

  for (const task of tasks) {
    if (task.state === "running" || !task.finishedAt) {
      continue;
    }
    const finishedAt = parseRfc3339Timestamp(task.finishedAt);
    if (finishedAt === null) {
      continue;
    }
    const expiration = finishedAt + retentionMinutes * 60_000;
    nextExpiration = nextExpiration === null ? expiration : Math.min(nextExpiration, expiration);
  }

  return nextExpiration === null ? null : Math.max(0, nextExpiration - now);
}

/** 将一次 status 轮询合并到任务中心历史，不覆盖同 scope 的其他 run。 */
export function mergeAccountSyncStatusesIntoTasks({
  previousTasks,
  previousStatuses,
  statuses,
  accountId,
  accountLabel,
  completedTaskRetentionMinutes,
  suppressedTaskFinishedAt,
  onExpiredTask,
  onNewLegacyTask,
  now = Date.now()
}: {
  previousTasks: SyncTaskCenterTask[];
  previousStatuses: AccountSyncStatusRecord[];
  statuses: AccountSyncStatusRecord[];
  accountId: string;
  accountLabel: string;
  completedTaskRetentionMinutes?: number;
  /** 已自动清理 run 的 finishedAt 身份，避免保留时间调长时同一旧 run 复活。 */
  suppressedTaskFinishedAt?: ReadonlyMap<string, string>;
  onExpiredTask?: (taskId: string, finishedAt: string) => void;
  /** 旧 payload 没有 runId 时，running 或不同 finishedAt 代表一个新的 scope run。 */
  onNewLegacyTask?: (taskId: string) => void;
  now?: number;
}) {
  if (completedTaskRetentionMinutes !== undefined) {
    for (const task of getExpiredSyncTasks(
      previousTasks,
      completedTaskRetentionMinutes,
      now
    )) {
      if (task.finishedAt) {
        onExpiredTask?.(task.id, task.finishedAt);
      }
    }
  }
  let nextTasks = completedTaskRetentionMinutes === undefined
    ? previousTasks
    : filterExpiredSyncTasks(previousTasks, completedTaskRetentionMinutes, now);
  const accountStatuses = statuses.filter((status) => status.accountId === accountId);

  for (const status of accountStatuses) {
    if (status.state === "idle") {
      continue;
    }

    const id = buildSyncTaskRecordId(status);
    const state: SyncTaskCenterTaskState = status.state === "running" || status.state === "failed"
      ? status.state
      : "succeeded";
    const existing = nextTasks.find((task) => task.id === id);
    const suppressedFinishedAt = suppressedTaskFinishedAt?.get(id);
    if (suppressedFinishedAt) {
      const isNewLegacyTask = !status.runId && (
        state === "running" || hasDifferentFinishedAt(status.finishedAt, suppressedFinishedAt)
      );
      if (isNewLegacyTask) {
        onNewLegacyTask?.(id);
      } else {
        continue;
      }
    }
    const wasRunning = previousStatuses.some(
      (previousStatus) => previousStatus.state === "running"
        && buildSyncTaskRecordId(previousStatus) === id
    );
    const isCachedUsageSnapshot = !status.runId && status.scope === "usage";
    if (state === "succeeded" && !existing && !wasRunning && isCachedUsageSnapshot) {
      continue;
    }

    const finishedAt = state === "running"
      ? null
      : status.finishedAt ?? existing?.finishedAt ?? null;
    const task: SyncTaskCenterTask = {
      id,
      accountId: status.accountId,
      accountLabel,
      scope: status.scope,
      state,
      startedAt: status.lastAttemptAt ?? existing?.startedAt ?? null,
      finishedAt,
      itemCount: status.itemCount,
      error: status.lastError,
      failure: status.failure,
      recoveredAt: status.recoveredAt,
      progress: status.progress
    };
    if (
      completedTaskRetentionMinutes !== undefined &&
      isSyncTaskExpired(task, completedTaskRetentionMinutes, now)
    ) {
      if (task.finishedAt) {
        onExpiredTask?.(id, task.finishedAt);
      }
      continue;
    }
    nextTasks = [task, ...nextTasks.filter((current) => current.id !== id)].slice(0, 12);
  }

  for (const task of nextTasks) {
    if (task.accountId !== accountId || task.state !== "running") {
      continue;
    }

    const replacement = accountStatuses.find((status) => status.scope === task.scope);
    if (!replacement) {
      // Full 运行时后端会有意省略其他 scope，不能仅凭缺席判断旧任务中断。
      continue;
    }
    const replacementId = buildSyncTaskRecordId(replacement);
    if (replacementId === task.id) {
      continue;
    }

    const interrupted: SyncTaskCenterTask = {
      ...task,
      state: "interrupted",
      // replacement 属于另一个 run，不能将它的完成时间当作当前任务的终态时间。
      finishedAt: task.finishedAt,
      error: "后端未返回该任务的终态，已停止追踪。",
      failure: null,
      recoveredAt: null
    };
    nextTasks = [
      interrupted,
      ...nextTasks.filter((current) => current.id !== task.id)
    ].slice(0, 12);
  }

  if (completedTaskRetentionMinutes === undefined) {
    return nextTasks;
  }

  for (const task of getExpiredSyncTasks(nextTasks, completedTaskRetentionMinutes, now)) {
    if (task.finishedAt) {
      onExpiredTask?.(task.id, task.finishedAt);
    }
  }
  return filterExpiredSyncTasks(nextTasks, completedTaskRetentionMinutes, now);
}
