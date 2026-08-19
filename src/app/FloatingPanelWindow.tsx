import {
  ArrowLeftRight,
  BadgeDollarSign,
  Check,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  LayoutDashboard,
  RefreshCw,
  UserRoundX,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { getFloatingPanelVisible, openMainWindow } from "../features/desktop-ui/client";
import type {
  AccountRuntime,
  GroupRecord,
  ManagedKeyRecord,
  UsageStatsRecord,
  UsageRow
} from "../types";
import {
  getSubscriptionQuotaProgressMeta,
  getSubscriptionStatusPresentation,
  type SubscriptionDetailRecord
} from "../subscription-view";
import {
  compact,
  formatDateTimeFull,
  formatDurationSeconds,
  formatPercent,
  formatRemainingDaysLabel,
  formatTime,
  formatUsd,
  maskEmail
} from "../shared/lib/formatters";
import { EmptyState } from "../shared/ui/EmptyState";
import { TitleHint } from "../shared/ui/TitleHint";
import { UsageDetailPopover } from "../shared/ui/UsageDetailPopover";
import { isTauriRuntime } from "../shared/transport/runtime";
import {
  type FloatingPanelKey
} from "./floating-layout";
import {
  FLOATING_PANEL_WIDTH,
  resolveFloatingPanelWindowHeight
} from "./floating-panel-size";
import type { WindowSelectionResolutionState } from "./window-selection-sync";

type FloatingMenuItem = {
  key: FloatingPanelKey;
  label: string;
  shortLabel: string;
  hint: string;
  nav: "overview" | "usage" | "keys";
  icon: typeof LayoutDashboard;
};

type FloatingPanelSyncPayload = {
  dock: "left" | "right";
  x: number;
  y: number;
  menuVisible: boolean;
  activePanel: FloatingPanelKey;
};

type FloatingQuickSwitchPhase =
  | "idle"
  | "validating"
  | "submitting"
  | "succeeded"
  | "failed"
  | "reload_failed";

export type FloatingQuickSwitchSnapshot = {
  managedKeys: ManagedKeyRecord[];
  groups: GroupRecord[];
  subscriptionDetails: SubscriptionDetailRecord[];
};

export type FloatingQuickSwitchSubmissionResult =
  | {
      kind: "succeeded";
      snapshot: FloatingQuickSwitchSnapshot;
    }
  | {
      kind: "reload_failed";
      message: string;
    };

export type FloatingQuickSwitchCandidate = {
  groupId: number;
  name: string;
  platform: string | null;
  status: string;
};

async function ignoreWindowMutation(task: Promise<unknown>) {
  try {
    await task;
  } catch {
    // Windows 下浮窗属性调用偶发失败时, 不应阻断悬浮面板继续同步位置与显隐。
  }
}

const MENU_ITEMS: FloatingMenuItem[] = [
  { key: "overview", label: "实时总览", shortLabel: "总览", hint: "实时指标与订阅", nav: "overview", icon: LayoutDashboard },
  { key: "usage", label: "最新用量", shortLabel: "用量", hint: "最近调用与 IP", nav: "usage", icon: BadgeDollarSign },
  { key: "subscriptions", label: "快速切换", shortLabel: "切换", hint: "修改密钥订阅", nav: "keys", icon: ArrowLeftRight }
];

function FloatingAccountSelectionPlaceholder({
  state,
  error
}: {
  state: WindowSelectionResolutionState;
  error: string | null;
}) {
  const presentation = state === "resolving"
    ? {
        tone: "info",
        label: "正在同步",
        title: "正在读取账号",
        detail: "正在同步当前账号数据，请稍候。",
        Icon: RefreshCw
      }
    : state === "retryable-error"
      ? {
          tone: "danger",
          label: "同步异常",
          title: "账号同步失败",
          detail: error ?? "当前账号暂时无法确认，请点击刷新重试。",
          Icon: CircleAlert
        }
      : {
          tone: "warning",
          label: "账号不可用",
          title: "暂无可用账号",
          detail: "请先在主窗口添加账号，或切换到已有账号。",
          Icon: UserRoundX
        };
  const { Icon } = presentation;

  function openAccountSettings() {
    if (isTauriRuntime()) {
      void openMainWindow("settings");
    }
  }

  return (
    <section
      className={`floating-account-alert tone-${presentation.tone}`}
      role={presentation.tone === "danger" ? "alert" : "status"}
      aria-live={presentation.tone === "danger" ? "assertive" : "polite"}
    >
      <span className="floating-account-alert-icon" aria-hidden="true">
        <Icon size={19} className={state === "resolving" ? "spin" : undefined} />
      </span>
      <div className="floating-account-alert-copy">
        <span className="floating-account-alert-label">{presentation.label}</span>
        <strong>{presentation.title}</strong>
        <p>{presentation.detail}</p>
      </div>
      {state === "empty" ? (
        <button type="button" className="floating-account-alert-action" onClick={openAccountSettings}>
          <ExternalLink size={13} aria-hidden="true" />
          账号与站点
        </button>
      ) : null}
    </section>
  );
}

/** 在悬浮面板内提供可键盘操作的账号切换弹窗。 */
function FloatingAccountSwitcher({
  accounts,
  currentAccountId,
  currentSiteId,
  accountStatusLabel,
  panelVisible,
  onAccountSelect
}: {
  accounts: AccountRuntime[];
  currentAccountId: string | null;
  currentSiteId: string | null;
  accountStatusLabel: string;
  panelVisible: boolean;
  onAccountSelect: (account: AccountRuntime) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [switchingAccountIdentity, setSwitchingAccountIdentity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const interactionRevisionRef = useRef(0);
  const canSwitch = accounts.length > 0;

  const closeDialog = useCallback((restoreFocus = true) => {
    interactionRevisionRef.current += 1;
    setOpen(false);
    setSwitchingAccountIdentity(null);
    setError(null);
    if (restoreFocus) {
      window.setTimeout(() => triggerRef.current?.focus(), 0);
    }
  }, []);

  useEffect(() => {
    if (panelVisible) {
      return;
    }
    closeDialog(false);
  }, [closeDialog, panelVisible]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (!dialog) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialog();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>("button:not(:disabled)")
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeDialog, open]);

  async function selectAccount(account: AccountRuntime) {
    const selected = account.id === currentAccountId && account.siteId === currentSiteId;
    if (selected) {
      closeDialog();
      return;
    }

    const interactionRevision = ++interactionRevisionRef.current;
    const identity = `${account.siteId}:${account.id}`;
    setSwitchingAccountIdentity(identity);
    setError(null);
    try {
      await onAccountSelect(account);
      if (interactionRevision !== interactionRevisionRef.current) {
        return;
      }
      closeDialog();
    } catch (cause) {
      if (interactionRevision !== interactionRevisionRef.current) {
        return;
      }
      setSwitchingAccountIdentity(null);
      setError((cause as Error).message || "切换账号失败，请重试。");
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="floating-account-trigger"
        disabled={!canSwitch}
        aria-label={`切换账号，当前${accountStatusLabel}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? "floating-account-switcher-dialog" : undefined}
        title={canSwitch ? "切换账号" : "暂无可切换账号"}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <span title={accountStatusLabel}>{accountStatusLabel}</span>
        {canSwitch ? <ChevronDown size={12} aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div
          className="floating-account-switcher-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeDialog();
            }
          }}
        >
          <section
            ref={dialogRef}
            id="floating-account-switcher-dialog"
            className="floating-account-switcher-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="floating-account-switcher-title"
            tabIndex={-1}
          >
            <header className="floating-account-switcher-header">
              <span>
                <strong id="floating-account-switcher-title">切换账号</strong>
                <small>{accounts.length} 个账号</small>
              </span>
              <button type="button" onClick={() => closeDialog()} aria-label="关闭账号切换" title="关闭">
                <X size={15} aria-hidden="true" />
              </button>
            </header>
            <div className="floating-account-switcher-list" aria-label="可切换账号列表">
              {accounts.map((account) => {
                const identity = `${account.siteId}:${account.id}`;
                const selected = account.id === currentAccountId && account.siteId === currentSiteId;
                const switching = switchingAccountIdentity === identity;
                const label = account.label.trim() || maskEmail(account.email.trim()) || "未命名账号";
                const siteName = account.site?.name.trim() || "未知站点";
                const email = maskEmail(account.email.trim());
                const meta = account.label.trim() && email ? `${siteName} · ${email}` : siteName;
                const sessionLabel = account.sessionState === "ready"
                  ? "可用"
                  : account.sessionState === "expired"
                    ? "已过期"
                    : "未登录";
                return (
                  <button
                    key={identity}
                    type="button"
                    className={`floating-account-option ${selected ? "selected" : ""}`}
                    disabled={switchingAccountIdentity !== null}
                    aria-current={selected ? "true" : undefined}
                    aria-busy={switching}
                    aria-label={selected ? `${label}，当前账号` : `切换到 ${label}`}
                    onClick={() => void selectAccount(account)}
                  >
                    <span className="floating-account-option-copy">
                      <strong>{label}</strong>
                      <small>{meta}</small>
                    </span>
                    <span className={`floating-account-option-state tone-${account.sessionState}`}>
                      {switching ? (
                        <><RefreshCw size={12} className="spin" aria-hidden="true" />切换中</>
                      ) : selected ? (
                        <><Check size={12} aria-hidden="true" />当前</>
                      ) : sessionLabel}
                    </span>
                  </button>
                );
              })}
            </div>
            {error ? <p className="floating-account-switcher-error" role="alert">{error}</p> : null}
          </section>
        </div>
      ) : null}
    </>
  );
}

/** 仅将有限正数视为可展示的额度上限。 */
function hasPositiveFiniteQuotaLimit(limit: number | null | undefined): limit is number {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0;
}

/** 悬浮总览中单个有效额度窗口。 */
function FloatingSubscriptionQuota({
  label,
  used,
  limit
}: {
  label: "每日" | "每周" | "每月";
  used: number;
  limit: number;
}) {
  const safeUsed = Number.isFinite(used) ? Math.max(0, used) : 0;
  const progress = getSubscriptionQuotaProgressMeta(safeUsed, limit);
  return (
    <div className={`floating-subscription-quota ${progress.tone}`}>
      <div className="floating-subscription-quota-copy">
        <span>{label}</span>
        <strong>{formatUsd(safeUsed, 2)} / {formatUsd(limit, 2)}</strong>
        <small>{formatPercent(progress.rawPercent, 1)}</small>
      </div>
      <div className="floating-subscription-quota-track" aria-label={`${label}额度进度 ${formatPercent(progress.rawPercent, 1)}`}>
        <span className="floating-subscription-quota-fill" style={{ width: `${progress.percent}%` }} />
      </div>
    </div>
  );
}

function FloatingOverviewPanel({
  accountLabel,
  selectionState,
  selectionError,
  dashboardStats,
  dashboardStatsError,
  dashboardStatsUpdatedAt,
  subscriptionDetails
}: {
  accountLabel: string | null;
  selectionState: WindowSelectionResolutionState;
  selectionError: string | null;
  dashboardStats: UsageStatsRecord | null;
  dashboardStatsError: string | null;
  dashboardStatsUpdatedAt: string | null;
  subscriptionDetails: SubscriptionDetailRecord[];
}) {
  if (!accountLabel) {
    return (
      <FloatingAccountSelectionPlaceholder
        state={selectionState}
        error={selectionError}
      />
    );
  }

  const stats = dashboardStats;
  const metrics = [
    {
      label: "今日金额",
      value: stats ? formatUsd(stats.totalActualCost, 4) : "--",
      status: stats ? "实际消费" : "等待统计",
      title: "今日金额明细",
      detail: [
        ["实际消费", stats ? formatUsd(stats.totalActualCost, 4) : "--"],
        ["标准消费", stats ? formatUsd(stats.totalCost, 4) : "--"],
        ["更新时间", dashboardStatsUpdatedAt ? formatTime(dashboardStatsUpdatedAt) : "等待更新"]
      ]
    },
    {
      label: "RPM/TPM",
      value: `${stats?.rpm == null ? "--" : stats.rpm.toLocaleString()}/${stats?.tpm == null ? "--" : compact(stats.tpm)}`,
      status: stats?.rpm == null && stats?.tpm == null
        ? "等待上游"
        : dashboardStatsUpdatedAt
          ? "已更新"
          : "已获取",
      title: "实时 RPM/TPM 明细",
      detail: [
        ["RPM", stats?.rpm == null ? "上游未提供" : stats.rpm.toLocaleString()],
        ["TPM", stats?.tpm == null ? "上游未提供" : compact(stats.tpm)],
        ["数据更新时间", dashboardStatsUpdatedAt ? formatTime(dashboardStatsUpdatedAt) : "等待更新"]
      ]
    },
    {
      label: "今日 Token",
      value: stats ? compact(stats.totalTokens) : "--",
      status: stats ? "累计用量" : "等待统计",
      title: "今日 Token 明细",
      detail: [
        ["输入 Token", stats ? compact(stats.totalInputTokens) : "--"],
        ["输出 Token", stats ? compact(stats.totalOutputTokens) : "--"],
        ["缓存读取", stats?.totalCacheReadTokens == null ? "--" : compact(stats.totalCacheReadTokens)]
      ]
    },
    {
      label: "今日请求",
      value: stats ? stats.totalRequests.toLocaleString() : "--",
      status: stats ? "累计请求" : "等待统计",
      title: "今日请求明细",
      detail: [
        ["请求数", stats ? stats.totalRequests.toLocaleString() : "--"],
        ["更新时间", dashboardStatsUpdatedAt ? formatTime(dashboardStatsUpdatedAt) : "等待更新"]
      ]
    },
  ] as const;

  return (
    <div className="floating-overview-content">
      <div className="floating-overview-metrics">
        <div className="floating-live-metrics" aria-label="实时指标">
          {metrics.map((metric, index) => (
            <UsageDetailPopover
              key={metric.label}
              title={metric.title}
              panelAlign={index % 2 === 1 ? "end" : "start"}
              trigger={
                <div className="floating-live-metric" aria-label={`${metric.label}: ${metric.value}，${metric.status}`}>
                  <div className="floating-live-metric-copy">
                    <span>{metric.label}</span>
                    <small>{metric.status}</small>
                  </div>
                  <strong>{metric.value}</strong>
                </div>
              }
            >
              <div className="floating-live-metric-detail">
                {metric.detail.map(([label, value]) => (
                  <span key={label}>
                    <small>{label}</small>
                    <b>{value}</b>
                  </span>
                ))}
              </div>
            </UsageDetailPopover>
          ))}
        </div>
        {dashboardStatsError ? <p className="floating-panel-inline-state error">实时指标暂不可用: {dashboardStatsError}</p> : null}
      </div>
      <section className="floating-subscription-summary" aria-labelledby="floating-subscription-summary-title">
        <div className="floating-subscription-summary-heading">
          <strong id="floating-subscription-summary-title">订阅概览</strong>
          <TitleHint
            content="当前账号的全部订阅与额度"
            label="查看订阅概览说明"
          />
        </div>
        {subscriptionDetails.length === 0 ? (
          <p className="floating-subscription-empty">尚未读取到订阅数据。</p>
        ) : (
          <div className="floating-subscription-list" role="list" aria-label="当前账号订阅列表">
            {subscriptionDetails.map((subscription) => {
              const status = getSubscriptionStatusPresentation(subscription.status);
              const subscriptionName = subscription.name.trim() || "未命名订阅";
              const platform = subscription.platform ?? "未提供平台";
              const remainingDays = formatRemainingDaysLabel(subscription.expiresAt);
              const quotaWindows = [
                { label: "每日", used: subscription.dailyUsedUsd, limit: subscription.dailyLimitUsd },
                { label: "每周", used: subscription.weeklyUsedUsd, limit: subscription.weeklyLimitUsd },
                { label: "每月", used: subscription.monthlyUsedUsd, limit: subscription.monthlyLimitUsd }
              ].filter(
                (quota): quota is {
                  label: "每日" | "每周" | "每月";
                  used: number;
                  limit: number;
                } => hasPositiveFiniteQuotaLimit(quota.limit)
              );
              return (
                <article key={subscription.id} className="floating-subscription-item" role="listitem">
                  <div className="floating-subscription-item-heading">
                    <div className="floating-subscription-title-row">
                      <strong className="floating-subscription-name" title={subscriptionName}>{subscriptionName}</strong>
                      <span className={`floating-subscription-status tone-${status.tone}`}>{status.label}</span>
                    </div>
                    <div className="floating-subscription-meta">
                      <span title={platform}>{platform}</span>
                      <span title={remainingDays}>{remainingDays}</span>
                    </div>
                  </div>
                  {quotaWindows.length > 0 ? (
                    <div className="floating-subscription-quotas" aria-label={`${subscriptionName}额度详情`}>
                      {quotaWindows.map((quota) => (
                        <FloatingSubscriptionQuota key={quota.label} {...quota} />
                      ))}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

export function sortFloatingUsageRows(rows: UsageRow[]) {
  return [...rows].sort((left, right) => {
    const leftTime = new Date(left.createdAt).getTime();
    const rightTime = new Date(right.createdAt).getTime();
    return rightTime - leftTime;
  });
}

export function resolveFloatingUsageIp(row: Pick<UsageRow, "ipAddress">) {
  return row.ipAddress?.trim() || "-";
}

function FloatingUsagePanel({
  accountLabel,
  selectionState,
  selectionError,
  recentUsage
}: {
  accountLabel: string | null;
  selectionState: WindowSelectionResolutionState;
  selectionError: string | null;
  recentUsage: UsageRow[];
}) {
  const rows = useMemo(() => sortFloatingUsageRows(recentUsage), [recentUsage]);
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  if (!accountLabel) {
    return (
      <FloatingAccountSelectionPlaceholder
        state={selectionState}
        error={selectionError}
      />
    );
  }

  return (
    <>
      {rows.length === 0 ? (
        <EmptyState title="暂无近期调用" detail="本地用量数据同步后会显示最近调用。" compact />
      ) : (
        <div className="floating-usage-scroll" tabIndex={0} aria-label="最新调用记录">
          <ol className="floating-usage-records">
            {rows.map((row) => {
              const ipAddress = resolveFloatingUsageIp(row);
              const detailId = `floating-usage-detail-${row.id}`;
              const expanded = expandedRowId === row.id;
              return (
                <li key={row.id}>
                  <article
                    className={`floating-usage-record${expanded ? " expanded" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`查看 ${row.model} 调用详情`}
                    aria-expanded={expanded}
                    aria-controls={detailId}
                    onClick={() => {
                      setExpandedRowId((current) => current === row.id ? null : row.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") {
                        return;
                      }
                      event.preventDefault();
                      setExpandedRowId((current) => current === row.id ? null : row.id);
                    }}
                  >
                    <header className="floating-usage-record-heading">
                      <span className="floating-usage-record-key" title={row.apiKeyName ?? undefined}>{row.apiKeyName ?? "未知 Key"}</span>
                      <span className="floating-usage-record-model" title={row.model}>{row.model}</span>
                      <span className="floating-usage-record-action" aria-hidden="true">
                        <ChevronDown size={13} />
                      </span>
                    </header>
                    <div className="floating-usage-record-meta">
                      <time dateTime={row.createdAt} title={formatDateTimeFull(row.createdAt)}>{formatTime(row.createdAt)}</time>
                      <span className="floating-usage-record-ip" title={ipAddress}>{ipAddress}</span>
                    </div>
                    <div className="floating-usage-record-facts" aria-label="调用统计">
                      <span><small>Token</small><strong>{compact(row.totalTokens)}</strong></span>
                      <span><small>消费</small><strong>{formatUsd(row.actualCost, 4)}</strong></span>
                      <span><small>耗时</small><strong>{formatDurationSeconds(row.durationMs, 1, "秒")}</strong></span>
                    </div>
                    {expanded ? (
                      <div id={detailId} className="floating-usage-record-detail" role="region" aria-label={`${row.model} 调用详情`}>
                        <span className="wide"><small>完整时间</small><strong>{formatDateTimeFull(row.createdAt)}</strong></span>
                        <span><small>输入 Token</small><strong>{compact(row.inputTokens)}</strong></span>
                        <span><small>输出 Token</small><strong>{compact(row.outputTokens)}</strong></span>
                        <span><small>缓存读取</small><strong>{compact(row.cacheReadTokens ?? 0)}</strong></span>
                        <span><small>总 Token</small><strong>{compact(row.totalTokens)}</strong></span>
                        <span><small>实际消费</small><strong>{formatUsd(row.actualCost, 4)}</strong></span>
                        <span><small>标准消费</small><strong>{formatUsd(row.totalCost, 4)}</strong></span>
                        <span><small>首 Token</small><strong>{formatDurationSeconds(row.firstTokenMs, 1, "秒")}</strong></span>
                        <span><small>总耗时</small><strong>{formatDurationSeconds(row.durationMs, 1, "秒")}</strong></span>
                        <span className="wide"><small>接口</small><strong>{row.endpoint ?? row.upstreamEndpoint ?? "-"}</strong></span>
                        <span className="wide"><small>请求 ID</small><strong>{row.requestId ?? "-"}</strong></span>
                        <span className="wide"><small>来源 IP</small><strong>{ipAddress}</strong></span>
                      </div>
                    ) : null}
                  </article>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </>
  );
}

export function buildFloatingQuickSwitchCandidates(input: {
  key: ManagedKeyRecord | null;
  groups: GroupRecord[];
  subscriptionDetails: SubscriptionDetailRecord[];
}): FloatingQuickSwitchCandidate[] {
  const currentGroupId = input.key?.groupId ?? null;
  const candidates = new Map<number, FloatingQuickSwitchCandidate>();

  for (const subscription of input.subscriptionDetails) {
    const groupId = subscription.sourceGroupId;
    if (groupId == null || groupId <= 0 || groupId === currentGroupId) {
      continue;
    }
    if (getSubscriptionStatusPresentation(subscription.status).tone !== "ready") {
      continue;
    }
    const group = input.groups.find((item) => item.id === groupId) ?? null;
    candidates.set(groupId, {
      groupId,
      name: subscription.name,
      platform: subscription.platform ?? group?.platform ?? null,
      status: subscription.status
    });
  }

  return Array.from(candidates.values()).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

function resolveFloatingCurrentBinding(input: {
  key: ManagedKeyRecord | null;
  groups: GroupRecord[];
  subscriptionDetails: SubscriptionDetailRecord[];
}) {
  const groupId = input.key?.groupId ?? null;
  if (groupId == null) {
    return "未绑定订阅";
  }
  const subscription = input.subscriptionDetails.find((item) => item.sourceGroupId === groupId);
  if (subscription) {
    return subscription.name;
  }
  const group = input.groups.find((item) => item.id === groupId);
  return group?.name ?? `分组 #${groupId}`;
}

export function resolveFloatingQuickSwitchPanelKey(
  accountId: string | null,
  siteId: string | null = null
) {
  return accountId ? JSON.stringify({ siteId, accountId }) : "unselected-account";
}

function FloatingQuickSwitchPanel({
  accountLabel,
  selectionState,
  selectionError,
  managedKeys,
  groups,
  subscriptionDetails,
  onValidate,
  onSubmit,
  onReload
}: {
  accountLabel: string | null;
  selectionState: WindowSelectionResolutionState;
  selectionError: string | null;
  managedKeys: ManagedKeyRecord[];
  groups: GroupRecord[];
  subscriptionDetails: SubscriptionDetailRecord[];
  onValidate: () => Promise<FloatingQuickSwitchSnapshot>;
  onSubmit: (input: { keyId: string; groupId: number }) => Promise<FloatingQuickSwitchSubmissionResult>;
  onReload: () => Promise<FloatingQuickSwitchSnapshot>;
}) {
  const [snapshot, setSnapshot] = useState<FloatingQuickSwitchSnapshot | null>(null);
  const [selectedKeyId, setSelectedKeyId] = useState("");
  const [activeGroupId, setActiveGroupId] = useState<number | null>(null);
  const [phase, setPhase] = useState<FloatingQuickSwitchPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const effectiveKeys = snapshot?.managedKeys ?? managedKeys;
  const effectiveGroups = snapshot?.groups ?? groups;
  const effectiveSubscriptions = snapshot?.subscriptionDetails ?? subscriptionDetails;
  const selectedKey = useMemo(
    () => effectiveKeys.find((item) => item.id === selectedKeyId) ?? effectiveKeys[0] ?? null,
    [effectiveKeys, selectedKeyId]
  );
  const candidates = useMemo(
    () => buildFloatingQuickSwitchCandidates({ key: selectedKey, groups: effectiveGroups, subscriptionDetails: effectiveSubscriptions }),
    [effectiveGroups, effectiveSubscriptions, selectedKey]
  );
  const busy = phase === "validating" || phase === "submitting";
  const currentBinding = resolveFloatingCurrentBinding({
    key: selectedKey,
    groups: effectiveGroups,
    subscriptionDetails: effectiveSubscriptions
  });

  useEffect(() => {
    if (selectedKeyId && effectiveKeys.some((item) => item.id === selectedKeyId)) {
      return;
    }
    setSelectedKeyId(effectiveKeys[0]?.id ?? "");
  }, [effectiveKeys, selectedKeyId]);

  if (!accountLabel) {
    return (
      <FloatingAccountSelectionPlaceholder
        state={selectionState}
        error={selectionError}
      />
    );
  }

  if (effectiveKeys.length === 0) {
    return <EmptyState title="暂无可切换密钥" detail="当前账号还没有可用的密钥。" compact />;
  }

  async function submitSelection(candidate: FloatingQuickSwitchCandidate) {
    if (!selectedKey || busy) {
      return;
    }
    const keyAtSubmission = selectedKey;
    setActiveGroupId(candidate.groupId);
    setPhase("validating");
    setMessage(null);
    try {
      const validatedSnapshot = await onValidate();
      const validatedKey = validatedSnapshot.managedKeys.find((item) => item.id === keyAtSubmission.id) ?? null;
      const nextCandidates = buildFloatingQuickSwitchCandidates({
        key: validatedKey,
        groups: validatedSnapshot.groups,
        subscriptionDetails: validatedSnapshot.subscriptionDetails
      });
      const validatedCandidate = nextCandidates.find((item) => item.groupId === candidate.groupId) ?? null;
      if (!validatedKey || !validatedCandidate) {
        setSnapshot(validatedSnapshot);
        setActiveGroupId(null);
        setPhase("failed");
        setMessage("密钥或候选订阅已变化, 请重新选择目标订阅。");
        return;
      }
      setSnapshot(validatedSnapshot);
      setSelectedKeyId(validatedKey.id);
      setPhase("submitting");
      const result = await onSubmit({ keyId: validatedKey.id, groupId: validatedCandidate.groupId });
      if (result.kind === "reload_failed") {
        setActiveGroupId(null);
        setPhase("reload_failed");
        setMessage(result.message);
        return;
      }
      setSnapshot(result.snapshot);
      setSelectedKeyId(validatedKey.id);
      setActiveGroupId(null);
      setPhase("succeeded");
      setMessage(`已将 ${validatedKey.name} 切换到 ${validatedCandidate.name}。`);
    } catch (cause) {
      setActiveGroupId(null);
      setPhase("failed");
      setMessage((cause as Error).message || "校验或切换失败, 当前绑定未在界面中提前修改。");
    }
  }

  async function reloadAfterFailure() {
    setPhase("validating");
    setMessage(null);
    try {
      const next = await onReload();
      setSnapshot(next);
      setPhase("succeeded");
      setMessage("已重新读取密钥、分组和订阅数据。");
    } catch (cause) {
      setPhase("reload_failed");
      setMessage((cause as Error).message || "重新读取仍然失败, 请稍后重试。");
    }
  }

  return (
    <>
      <div className="floating-switch-scroll">
        <section className="floating-switch-current" aria-label="当前订阅绑定">
          <div>
            <span>当前绑定</span>
            <strong title={currentBinding}>{currentBinding}</strong>
          </div>
          <em className="floating-metric-tag tone-success">已绑定</em>
        </section>
        <label className="floating-switch-field">
          <span>选择密钥</span>
          <select
            aria-label="选择要切换的密钥"
            value={selectedKey?.id ?? ""}
            disabled={busy}
            onChange={(event) => {
              setSnapshot(null);
              setSelectedKeyId(event.target.value);
              setActiveGroupId(null);
              setPhase("idle");
              setMessage(null);
            }}
          >
            {effectiveKeys.map((key) => (
              <option key={key.id} value={key.id}>{key.name}</option>
            ))}
          </select>
        </label>
        {candidates.length > 0 ? (
          <section className="floating-switch-candidates" aria-label="候选订阅">
            <div className="floating-switch-candidates-heading">
              <span>候选订阅</span>
              <small>{candidates.length} 项可切换</small>
            </div>
            <div className="floating-switch-candidate-list" aria-busy={busy}>
              {candidates.map((candidate) => {
                const switching = busy && candidate.groupId === activeGroupId;
                return (
                  <button
                    key={candidate.groupId}
                    type="button"
                    className={`floating-switch-candidate ${switching ? "switching" : ""}`}
                    disabled={busy}
                    aria-busy={switching}
                    aria-label={`切换到 ${candidate.name}`}
                    title={`切换到 ${candidate.name}`}
                    onClick={() => void submitSelection(candidate)}
                  >
                    <span>
                      <strong>{candidate.name}</strong>
                      <small>{candidate.platform ?? "未标注平台"}</small>
                    </span>
                    <em className={`floating-metric-tag ${switching ? "tone-info" : "tone-success"}`}>
                      {switching ? (phase === "validating" ? "校验中" : "切换中") : "可用"}
                    </em>
                  </button>
                );
              })}
            </div>
          </section>
        ) : (
          <p className="floating-panel-inline-state">当前没有与密钥不同的可用订阅。</p>
        )}
        {message ? (
          <p
            className={`floating-panel-inline-state ${phase === "succeeded" ? "success" : "error"}`}
            role={phase === "failed" || phase === "reload_failed" ? "alert" : "status"}
          >
            {message}
          </p>
        ) : null}
        {phase === "reload_failed" ? (
          <div className="floating-switch-actions">
            <button type="button" className="floating-switch-secondary" onClick={() => void reloadAfterFailure()}>
              <RefreshCw size={13} />重新读取
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}

export function FloatingPanelWindow({
  currentAccountId,
  currentSiteId = null,
  currentAccountLabel,
  accounts,
  selectionState = "empty",
  selectionError = null,
  dashboardStats,
  dashboardStatsLoading,
  dashboardStatsError,
  dashboardStatsUpdatedAt,
  currentAccountSubscriptionDetails,
  currentAccountRecentUsage,
  managedKeys,
  groups,
  loading,
  keepVisible,
  floatingPanelOpacity,
  onRefresh,
  onAccountSelect,
  onValidateQuickSwitch,
  onSubmitQuickSwitch,
  onReloadQuickSwitchData,
  initialPanel = "overview",
  initialDock = "right"
}: {
  currentAccountId: string | null;
  currentSiteId?: string | null;
  currentAccountLabel: string | null;
  accounts: AccountRuntime[];
  selectionState?: WindowSelectionResolutionState;
  selectionError?: string | null;
  dashboardStats: UsageStatsRecord | null;
  dashboardStatsLoading: boolean;
  dashboardStatsError: string | null;
  dashboardStatsUpdatedAt: string | null;
  currentAccountSubscriptionDetails: SubscriptionDetailRecord[];
  currentAccountRecentUsage: UsageRow[];
  managedKeys: ManagedKeyRecord[];
  groups: GroupRecord[];
  loading: boolean;
  keepVisible: boolean;
  floatingPanelOpacity: number;
  onRefresh: () => void;
  onAccountSelect: (account: AccountRuntime) => Promise<void>;
  onValidateQuickSwitch: () => Promise<FloatingQuickSwitchSnapshot>;
  onSubmitQuickSwitch: (input: { keyId: string; groupId: number }) => Promise<FloatingQuickSwitchSubmissionResult>;
  onReloadQuickSwitchData: () => Promise<FloatingQuickSwitchSnapshot>;
  initialPanel?: FloatingPanelKey;
  initialDock?: "left" | "right";
}) {
  const tauriRuntime = isTauriRuntime();
  const [dock, setDock] = useState<"left" | "right">(initialDock);
  const [visible, setVisible] = useState(!tauriRuntime || keepVisible);
  const [activePanel, setActivePanel] = useState<FloatingPanelKey>(initialPanel);
  const visibilityEventVersionRef = useRef(0);
  const displayAccountLabel = currentAccountId
    ? currentAccountLabel?.trim() || "未命名账号"
    : null;
  const panelWindowHeight = resolveFloatingPanelWindowHeight(currentAccountId);

  const activeMenu = useMemo(() => MENU_ITEMS.find((item) => item.key === activePanel) ?? MENU_ITEMS[0], [activePanel]);

  useEffect(() => {
    if (!tauriRuntime) {
      return;
    }

    let unlistenSync: (() => void) | undefined;
    let unlistenHide: (() => void) | undefined;
    let active = true;

    async function setup() {
      const appWindow = getCurrentWindow();
      await ignoreWindowMutation(appWindow.setDecorations(false));
      await ignoreWindowMutation(appWindow.setResizable(false));
      await ignoreWindowMutation(appWindow.setAlwaysOnTop(true));
      await ignoreWindowMutation(appWindow.setShadow(false));
      unlistenSync = await listen<FloatingPanelSyncPayload>(
        "floating-panel-sync",
        ({ payload }) => {
          if (!active) {
            return;
          }
          visibilityEventVersionRef.current += 1;
          setDock(payload.dock);
          setVisible(payload.menuVisible);
          setActivePanel(payload.activePanel);
        },
        { target: { kind: "WebviewWindow", label: "floating-panel" } }
      );
      if (!active) {
        unlistenSync();
        return;
      }

      unlistenHide = await listen(
        "floating-panel-hide",
        () => {
          if (!active) {
            return;
          }
          visibilityEventVersionRef.current += 1;
          setVisible(false);
        },
        { target: { kind: "WebviewWindow", label: "floating-panel" } }
      );
      if (!active) {
        unlistenHide();
        return;
      }

      // 监听已就绪后再读取当前窗口状态；期间若收到了事件，不能用旧回读结果覆盖它。
      const hydrationEventVersion = visibilityEventVersionRef.current;
      try {
        const nativeVisible = await getFloatingPanelVisible();
        if (active && visibilityEventVersionRef.current === hydrationEventVersion) {
          setVisible(nativeVisible);
        }
      } catch {
        // 原生状态读取失败时保持默认隐藏，避免渲染一个可见但不可交互的面板空壳。
      }
    }

    void setup();

    return () => {
      active = false;
      unlistenSync?.();
      unlistenHide?.();
    };
  }, [tauriRuntime]);

  useEffect(() => {
    if (tauriRuntime) {
      return;
    }
    setVisible(keepVisible);
  }, [keepVisible, tauriRuntime]);

  useEffect(() => {
    if (!tauriRuntime) {
      return;
    }

    let active = true;

    async function resizePanelWindow() {
      const appWindow = getCurrentWindow();
      const previousGeometry = visible
        ? await (async () => {
            try {
              const [size, position] = await Promise.all([
                appWindow.outerSize(),
                appWindow.outerPosition()
              ]);
              return { size, position };
            } catch {
              return null;
            }
          })()
        : null;

      await ignoreWindowMutation(
        appWindow.setSize(new LogicalSize(FLOATING_PANEL_WIDTH, panelWindowHeight))
      );

      if (!active || !visible || previousGeometry == null) {
        return;
      }

      try {
        const nextSize = await appWindow.outerSize();
        const heightDelta = previousGeometry.size.height - nextSize.height;
        if (!active || heightDelta === 0) {
          return;
        }
        await ignoreWindowMutation(
          appWindow.setPosition(new PhysicalPosition(
            previousGeometry.position.x,
            previousGeometry.position.y + heightDelta
          ))
        );
      } catch {
        // 下次显示时 Rust 会按当前 outer_size 重新计算停靠位置。
      }
    }

    void resizePanelWindow();
    return () => {
      active = false;
    };
  }, [panelWindowHeight, tauriRuntime, visible]);

  async function selectPanel(key: FloatingPanelKey) {
    setActivePanel(key);
    if (!tauriRuntime) {
      return;
    }
    await emitTo("floating", "floating-panel-select", { panel: key });
  }

  function handleOpenMain(nav: FloatingMenuItem["nav"]) {
    if (tauriRuntime) {
      void openMainWindow(nav);
    }
  }

  function renderPanel() {
    switch (activePanel) {
      case "usage":
        return (
          <FloatingUsagePanel
            accountLabel={displayAccountLabel}
            selectionState={selectionState}
            selectionError={selectionError}
            recentUsage={currentAccountRecentUsage}
          />
        );
      case "subscriptions":
        return (
          <FloatingQuickSwitchPanel
          key={resolveFloatingQuickSwitchPanelKey(currentAccountId, currentSiteId)}
            accountLabel={displayAccountLabel}
            selectionState={selectionState}
            selectionError={selectionError}
            managedKeys={managedKeys}
            groups={groups}
            subscriptionDetails={currentAccountSubscriptionDetails}
            onValidate={onValidateQuickSwitch}
            onSubmit={onSubmitQuickSwitch}
            onReload={onReloadQuickSwitchData}
          />
        );
      case "overview":
      default:
        return (
          <FloatingOverviewPanel
            accountLabel={displayAccountLabel}
            selectionState={selectionState}
            selectionError={selectionError}
            dashboardStats={dashboardStats}
            dashboardStatsError={dashboardStatsError}
            dashboardStatsUpdatedAt={dashboardStatsUpdatedAt}
            subscriptionDetails={currentAccountSubscriptionDetails}
          />
        );
    }
  }

  const accountStatusLabel = displayAccountLabel
    ?? (selectionState === "resolving"
      ? "正在读取账号"
      : selectionState === "retryable-error"
        ? "账号同步失败"
        : "未选择账号");
  const selectionTone = currentAccountId != null
    ? "success"
    : selectionState === "retryable-error"
      ? "danger"
      : selectionState === "resolving"
        ? "info"
        : "warning";
  const selectionPlaceholder = currentAccountId == null;
  const refreshInProgress = loading || dashboardStatsLoading;

  return (
    <main
      className={`floating-panel-window dock-${dock} ${visible ? "visible" : "hidden"} ${keepVisible ? "pinned-glass" : ""} selection-${selectionState} ${selectionPlaceholder ? "selection-placeholder" : ""}`}
      style={{ ["--floating-panel-opacity" as string]: floatingPanelOpacity }}
    >
      <section className={`floating-command-panel dock-${dock}`}>
        <header className="floating-command-header">
          <div className="floating-command-title">
            <span
              className={`floating-command-status tone-${selectionTone}`}
              title={`账号状态：${accountStatusLabel}`}
            />
            <div>
              <strong>{activeMenu.label}</strong>
              <FloatingAccountSwitcher
                accounts={accounts}
                currentAccountId={currentAccountId}
                currentSiteId={currentSiteId}
                accountStatusLabel={accountStatusLabel}
                panelVisible={visible}
                onAccountSelect={onAccountSelect}
              />
            </div>
          </div>
          <div className="floating-command-actions" aria-label="悬浮面板工具栏">
            <button
              type="button"
              className="floating-menu-refresh"
              onClick={onRefresh}
              aria-label="刷新悬浮面板"
              aria-busy={refreshInProgress}
              title="刷新悬浮面板"
            >
              <RefreshCw size={15} className={refreshInProgress ? "spin" : undefined} />
            </button>
            <button
              type="button"
              className="floating-menu-main-button"
              onClick={() => handleOpenMain(activeMenu.nav)}
              aria-label={`打开${activeMenu.label}`}
              title={`打开${activeMenu.label}`}
            >
              <ExternalLink size={16} />
            </button>
          </div>
        </header>
        <nav className="floating-command-tabs" aria-label="悬浮菜单页面">
          {MENU_ITEMS.map((item) => {
            const Icon = item.icon;
            const selected = item.key === activePanel;
            return (
              <button
                key={item.key}
                type="button"
                className={`floating-command-tab ${selected ? "selected" : ""}`}
                onClick={() => void selectPanel(item.key)}
                aria-label={item.label}
                aria-current={selected ? "page" : undefined}
                title={item.hint}
              >
                <Icon size={14} aria-hidden="true" />
                <span>{item.shortLabel}</span>
              </button>
            );
          })}
        </nav>
        <div className={`floating-command-content panel-${activePanel}`}>{renderPanel()}</div>
      </section>
    </main>
  );
}
