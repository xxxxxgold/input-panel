import {
  CheckCircle2,
  ChevronUp,
  CircleAlert,
  CircleMinus,
  Clock3,
  ListChecks,
  LoaderCircle,
  Trash2
} from "lucide-react";

import { formatTime } from "../shared/lib/formatters";
import type {
  AccountSyncProgress,
  AccountSyncProgressDetail,
  AccountSyncProgressStage,
  DataSyncScope,
  SyncFailurePayload
} from "../types";

export type SyncTaskCenterTaskState = "running" | "succeeded" | "failed" | "interrupted";

export interface SyncTaskCenterTask {
  id: string;
  accountId: string;
  accountLabel: string;
  scope: DataSyncScope;
  state: SyncTaskCenterTaskState;
  startedAt?: string | null;
  finishedAt?: string | null;
  itemCount: number;
  error?: string | null;
  failure?: SyncFailurePayload | null;
  recoveredAt?: string | null;
  progress?: AccountSyncProgress | null;
}

const scopeLabels: Record<DataSyncScope, string> = {
  full: "账号数据同步",
  core: "账号资料同步",
  subscriptions: "订阅同步",
  keys: "密钥与分组同步",
  usage: "用量记录同步"
};

const stateLabels: Record<SyncTaskCenterTaskState, string> = {
  running: "进行中",
  succeeded: "已完成",
  failed: "失败",
  interrupted: "已中断"
};

const progressStageLabels: Record<AccountSyncProgressStage["id"], string> = {
  core: "账号资料",
  subscriptions: "订阅与摘要",
  keys: "密钥与分组",
  usage: "用量记录",
  subscription_rules: "订阅规则"
};

const progressStageStateLabels: Record<AccountSyncProgressStage["state"], string> = {
  pending: "等待",
  running: "进行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

export function SyncTaskCenter({
  tasks,
  open,
  hidden = false,
  onOpenChange,
  onClearCompleted
}: {
  tasks: SyncTaskCenterTask[];
  open: boolean;
  hidden?: boolean;
  onOpenChange: (open: boolean) => void;
  onClearCompleted: () => void;
}) {
  if (hidden) {
    return null;
  }

  const runningCount = tasks.filter((task) => task.state === "running").length;
  const completedCount = tasks.length - runningCount;
  const visibleTasks = tasks.slice(0, 8);

  return (
    <aside
      className={`sync-task-center ${open ? "is-open" : ""}`.trim()}
      aria-label="任务中心"
    >
      {open && (
        <section className="sync-task-center-panel" aria-live="polite">
          <header className="sync-task-center-header">
            <div>
              <span className="sync-task-center-eyebrow">后台处理</span>
              <h2>任务中心</h2>
            </div>
            <button
              type="button"
              className="sync-task-center-collapse"
              onClick={() => onOpenChange(false)}
              aria-label="收起任务中心"
              title="收起任务中心"
            >
              <ChevronUp size={17} aria-hidden="true" />
            </button>
          </header>

          <div className="sync-task-center-summary">
            {runningCount > 0 ? (
              <>
                <LoaderCircle size={16} className="spin" aria-hidden="true" />
                <span>{runningCount} 个任务正在后台处理</span>
              </>
            ) : tasks.length > 0 ? (
              <>
                <CheckCircle2 size={16} aria-hidden="true" />
                <span>最近任务已处理完成</span>
              </>
            ) : (
              <>
                <Clock3 size={16} aria-hidden="true" />
                <span>当前没有后台任务</span>
              </>
            )}
          </div>

          {visibleTasks.length > 0 ? (
            <div className="sync-task-center-list">
              {visibleTasks.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </div>
          ) : (
            <p className="sync-task-center-empty">创建账号后的首次同步会显示在这里。</p>
          )}

          {completedCount > 0 && (
            <footer className="sync-task-center-footer">
              <button
                type="button"
                className="sync-task-center-clear"
                onClick={onClearCompleted}
              >
                <Trash2 size={14} aria-hidden="true" />
                清除已完成
              </button>
            </footer>
          )}
        </section>
      )}

      <button
        type="button"
        className={`sync-task-center-trigger ${runningCount > 0 ? "has-running" : ""}`.trim()}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-label={open ? "收起任务中心" : "打开任务中心"}
        title={open ? "收起任务中心" : "打开任务中心"}
      >
        {runningCount > 0 ? <LoaderCircle size={19} className="spin" aria-hidden="true" /> : <ListChecks size={19} aria-hidden="true" />}
        {runningCount > 0 && <span className="sync-task-center-count">{runningCount}</span>}
      </button>
    </aside>
  );
}

function TaskRow({ task }: { task: SyncTaskCenterTask }) {
  const TaskIcon = task.state === "running"
    ? LoaderCircle
    : task.state === "failed"
      ? CircleAlert
      : task.state === "interrupted"
        ? CircleMinus
      : CheckCircle2;
  const timestamp = task.state === "running"
    ? task.startedAt
    : task.state === "failed" || task.state === "interrupted"
      ? task.finishedAt
      : task.finishedAt ?? task.startedAt;
  const taskDuration = task.state === "succeeded"
    ? formatTaskDuration(task.startedAt, task.finishedAt)
    : null;
  const failureText = task.state === "failed" ? formatTaskFailure(task) : null;
  const progress = task.state === "running" ? task.progress : null;

  return (
    <article className={`sync-task-center-row is-${task.state}`}>
      <span className="sync-task-center-status-icon" aria-hidden="true">
        <TaskIcon size={16} className={task.state === "running" ? "spin" : ""} />
      </span>
      <div className="sync-task-center-row-copy">
        <div className="sync-task-center-row-title">
          <strong>{scopeLabels[task.scope]}</strong>
          <span>{stateLabels[task.state]}</span>
        </div>
        <p>{task.accountLabel}</p>
        {task.state === "failed" && failureText ? (
          <p className="sync-task-center-error">{failureText}</p>
        ) : task.state === "interrupted" ? (
          <p className="sync-task-center-interrupted">后端未返回该任务的终态，已停止追踪。</p>
        ) : task.state === "succeeded" && task.itemCount > 0 ? (
          <p>
            已处理 {task.itemCount.toLocaleString()} 条数据
            {taskDuration && ` · 耗时 ${taskDuration}`}
          </p>
        ) : task.state === "succeeded" && (task.scope === "full" || task.scope === "usage") ? (
          <p>
            已完成，未发现用量
            {taskDuration && ` · 耗时 ${taskDuration}`}
          </p>
        ) : task.state === "running" ? (
          !task.progress && <p>正在后台同步, 可继续使用其他功能</p>
        ) : null}
        {task.state === "failed" && task.recoveredAt && (
          <p className="sync-task-center-recovery">
            后续同步已于 {formatTime(task.recoveredAt)} 恢复
          </p>
        )}
        {progress && <TaskProgress progress={progress} />}
      </div>
      {timestamp && <time dateTime={timestamp}>{formatTime(timestamp)}</time>}
    </article>
  );
}

function TaskProgress({ progress }: { progress: AccountSyncProgress }) {
  if (progress.stages.length === 0) {
    return null;
  }

  return (
    <div className="sync-task-progress" aria-label="同步阶段">
      {progress.stages.map((stage) => (
        <ProgressStage key={stage.id} stage={stage} />
      ))}
    </div>
  );
}

function ProgressStage({ stage }: { stage: AccountSyncProgressStage }) {
  const StageIcon = stage.state === "running"
    ? LoaderCircle
    : stage.state === "succeeded"
      ? CheckCircle2
      : stage.state === "failed"
        ? CircleAlert
        : stage.state === "cancelled"
          ? CircleMinus
          : Clock3;
  const detail = stage.detail ?? null;
  const hasDeterminateProgress = stage.state === "running"
    && detail?.processed != null
    && detail.total != null
    && detail.total > 0;
  const processed = hasDeterminateProgress
    ? Math.min(Math.max(detail.processed ?? 0, 0), detail.total ?? 0)
    : 0;
  const total = hasDeterminateProgress ? detail.total ?? 0 : 0;
  const percentage = total > 0 ? (processed / total) * 100 : 0;
  const detailText = detail ? formatProgressDetail(detail) : null;
  const progressLabel = `${progressStageLabels[stage.id]}${detailText ? `, ${detailText}` : ""}`;

  return (
    <div className={`sync-task-progress-stage is-${stage.state}`}>
      <span className="sync-task-progress-stage-icon" aria-hidden="true">
        <StageIcon size={13} className={stage.state === "running" ? "spin" : ""} />
      </span>
      <div className="sync-task-progress-stage-copy">
        <div className="sync-task-progress-stage-heading">
          <span>{progressStageLabels[stage.id]}</span>
          <small>{progressStageStateLabels[stage.state]}</small>
        </div>
        {stage.state === "running" && detailText && (
          <p>{detailText}</p>
        )}
        {stage.state === "running" && (
          hasDeterminateProgress ? (
            <div
              className="sync-task-progress-track"
              role="progressbar"
              aria-label={progressLabel}
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={processed}
              aria-valuetext={detailText ?? undefined}
            >
              <span
                className="sync-task-progress-fill"
                style={{ width: `${percentage}%` }}
              />
            </div>
          ) : (
            <div
              className="sync-task-progress-track is-indeterminate"
              role="progressbar"
              aria-label={progressLabel}
            >
              <span className="sync-task-progress-fill" />
            </div>
          )
        )}
      </div>
    </div>
  );
}

function formatProgressDetail(detail: AccountSyncProgressDetail) {
  if (detail.wait) {
    return formatProgressWait(detail.wait);
  }

  const phaseLabel = detail.phase === "history_discovery"
    ? "正在确认历史范围"
    : detail.phase === "history_window"
      ? "正在同步历史用量"
      : detail.phase === "recent_window"
        ? "正在同步近期用量"
        : detail.phase === "latest_incremental"
          ? "正在检查最新用量"
          : "正在处理用量";
  const dateLabel = detail.currentDate ? ` ${detail.currentDate}` : "";
  const unitLabel = detail.unit === "records"
    ? "条"
    : detail.unit === "pages"
      ? "页"
      : detail.unit === "days"
        ? "天"
        : "";
  const countLabel = detail.processed != null && detail.total != null && detail.total > 0
    ? ` · ${Math.min(Math.max(detail.processed, 0), detail.total)}/${detail.total}${unitLabel}`
    : detail.processed != null && detail.processed > 0
      ? ` · 已处理 ${detail.processed}${unitLabel}`
      : "";
  const attemptLabel = detail.attempt != null && detail.attempt > 1
    ? ` · 第 ${detail.attempt} 次尝试`
    : "";

  return `${phaseLabel}${dateLabel}${countLabel}${attemptLabel}`;
}

function formatProgressWait(wait: NonNullable<AccountSyncProgressDetail["wait"]>) {
  const retryLabel = wait.retryAttempt != null && wait.maxAttempts != null
    ? `（${wait.retryAttempt}/${wait.maxAttempts}）`
    : wait.retryAttempt != null
      ? `（第 ${wait.retryAttempt} 次）`
      : "";
  const waitSeconds = wait.waitMs != null && wait.waitMs > 0
    ? Math.max(1, Math.ceil(wait.waitMs / 1000))
    : null;
  const resumeLabel = waitSeconds != null
    ? `${waitSeconds} 秒后`
    : wait.resumeAt
      ? `${formatTime(wait.resumeAt)} 后`
      : "稍后";

  if (wait.kind === "rate_limited") {
    return `上游请求受限，${resumeLabel}重试${retryLabel}`;
  }
  if (wait.kind === "request_budget") {
    return `正在等待共享请求额度，${resumeLabel}继续${retryLabel}`;
  }
  return `正在等待另一运行时完成同步，${resumeLabel}继续${retryLabel}`;
}

function formatTaskFailure(task: SyncTaskCenterTask) {
  const failure = task.failure;
  if (failure) {
    if (failure.category === "rate_limited" && failure.retryExhausted) {
      return "上游持续限流，本轮重试已用尽，将在后续自动同步中继续恢复";
    }
    if (failure.category === "rate_limited") {
      return "上游请求受限，本轮同步未完成，将在后续自动同步中继续恢复。";
    }
    if (failure.category === "unauthorized") {
      return "账号授权已失效，请重新登录后重试。";
    }
    if (failure.category === "timeout") {
      return "上游响应超时，请稍后重试。";
    }
    if (failure.category === "transport") {
      return "无法连接上游服务，请检查网络后重试。";
    }
    if (failure.category === "decode") {
      return "上游响应格式异常，本轮同步未完成。";
    }
    if (failure.category === "business") {
      return "上游拒绝了本次同步请求。";
    }
    if (failure.category === "http") {
      return "上游服务返回错误，本轮同步未完成。";
    }
    return "同步过程中发生内部错误，请稍后重试。";
  }

  const legacyError = task.error?.trim() ?? "";
  if (!legacyError || /[A-Za-z]/.test(legacyError) || legacyError.length > 160) {
    return "同步失败，请稍后重试。";
  }
  return legacyError;
}

function formatTaskDuration(startedAt?: string | null, finishedAt?: string | null) {
  if (!startedAt || !finishedAt) {
    return null;
  }

  const elapsedMilliseconds = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds < 0) {
    return null;
  }

  const elapsedSeconds = Math.floor(elapsedMilliseconds / 1000);
  if (elapsedSeconds < 1) {
    return "<1秒";
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return `${hours}小时${minutes}分${seconds}秒`;
  }
  if (minutes > 0) {
    return `${minutes}分${seconds}秒`;
  }
  return `${seconds}秒`;
}
