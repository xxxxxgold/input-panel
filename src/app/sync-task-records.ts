import type { AccountSyncStatusRecord } from "../types";
import type { SyncTaskCenterTask, SyncTaskCenterTaskState } from "./SyncTaskCenter";

/** 使用后端 runId 构造稳定任务身份，旧 payload 才回退到 scope 身份。 */
export function buildSyncTaskRecordId(status: AccountSyncStatusRecord) {
  const baseId = `${status.accountId}:${status.scope}`;
  return status.runId ? `${baseId}:${status.runId}` : baseId;
}

/** 将一次 status 轮询合并到任务中心历史，不覆盖同 scope 的其他 run。 */
export function mergeAccountSyncStatusesIntoTasks({
  previousTasks,
  previousStatuses,
  statuses,
  accountId,
  accountLabel
}: {
  previousTasks: SyncTaskCenterTask[];
  previousStatuses: AccountSyncStatusRecord[];
  statuses: AccountSyncStatusRecord[];
  accountId: string;
  accountLabel: string;
}) {
  let nextTasks = previousTasks;
  const accountStatuses = statuses.filter((status) => status.accountId === accountId);

  for (const status of accountStatuses) {
    if (status.state === "idle") {
      continue;
    }

    const id = buildSyncTaskRecordId(status);
    const state: SyncTaskCenterTaskState = status.state === "running" || status.state === "failed"
      ? status.state
      : "succeeded";
    const existing = previousTasks.find((task) => task.id === id);
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
      : status.finishedAt ?? (state === "succeeded" ? status.lastSuccessAt ?? null : null);
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
      finishedAt: replacement.finishedAt ?? replacement.lastAttemptAt ?? task.finishedAt ?? null,
      error: "后端未返回该任务的终态，已停止追踪。",
      failure: null,
      recoveredAt: null
    };
    nextTasks = [
      interrupted,
      ...nextTasks.filter((current) => current.id !== task.id)
    ].slice(0, 12);
  }

  return nextTasks;
}
