import { compact, formatUsd, toDateValue } from "../shared/lib/formatters";
import type { AccountRuntime, AccountSyncStatusRecord, OverviewPayload, UsageStatsRecord } from "../types";
import type { AccountSyncStatusPresentation } from "./account-sync-status-presentation";

export type WorkspaceSummaryItem =
  | {
      key: string;
      label: string;
      tone?: "default" | "token-group";
    }
  | {
      key: string;
      tone: "token-group";
      segments: Array<{
        key: string;
        label: string;
        value: string;
      }>;
    };

type WorkspaceSummaryTokenSegment = {
  key: string;
  label: string;
  value: string;
};

export function buildWorkspaceSummaryTexts({
  overview,
  accounts,
  usageStats,
  syncStatuses = [],
  syncStatusPresentation,
  now = new Date()
}: {
  overview: OverviewPayload | null;
  accounts: AccountRuntime[];
  usageStats?: UsageStatsRecord | null;
  syncStatuses?: AccountSyncStatusRecord[];
  syncStatusPresentation?: AccountSyncStatusPresentation;
  now?: Date;
}) {
  if (!overview) {
    return [
      buildTextItem("sites", "等待同步站点"),
      buildTextItem("accounts", "等待同步账号"),
      buildTextItem("requests", "暂无今日请求数据"),
      buildTokenGroupItem("tokens", [
        { key: "input", label: "输入", value: "-" },
        { key: "cache", label: "缓存", value: "-" },
        { key: "output", label: "输出", value: "-" }
      ]),
      buildTextItem("totalTokens", "暂无今日总 Token"),
      buildTextItem("todayActualCost", "暂无今日消费"),
      buildTextItem("sync", buildSyncSummary({
        syncStatuses,
        syncStatusPresentation,
        generatedAt: null,
        now
      }))
    ];
  }

  const todayUsage = buildWorkspaceTodayUsageSummary(overview, accounts, usageStats, now);

  return [
    buildTextItem("sites", `${overview.totals.totalSites} 个站点`),
    buildTextItem("accounts", `${overview.totals.totalAccounts} 个账号`),
    buildTextItem("requests", `今日 ${compact(todayUsage.requests)} 请求`),
    buildTokenGroupItem("tokens", [
      { key: "input", label: "输入", value: compact(todayUsage.inputTokens) },
      { key: "cache", label: "缓存", value: compact(todayUsage.cacheReadTokens) },
      { key: "output", label: "输出", value: compact(todayUsage.outputTokens) }
    ]),
    buildTextItem("totalTokens", `总 Token ${compact(todayUsage.totalTokens)}`),
    buildTextItem("todayActualCost", `今日消费 ${formatUsd(todayUsage.actualCost, 4)}`),
    buildTextItem("sync", buildSyncSummary({
      syncStatuses,
      syncStatusPresentation,
      generatedAt: overview.generatedAt,
      now
    }))
  ];
}

function buildTextItem(key: string, label: string): WorkspaceSummaryItem {
  return {
    key,
    label
  };
}

function buildTokenGroupItem(
  key: string,
  segments: WorkspaceSummaryTokenSegment[]
): WorkspaceSummaryItem {
  return {
    key,
    tone: "token-group",
    segments
  };
}

function getTodayCacheReadTokens(account: AccountRuntime, now: Date) {
  const todayBucket = toDateValue(now);
  return (
    account.cacheView?.trend.find((point) => point.bucket === todayBucket)?.cacheReadTokens ?? 0
  );
}

function buildWorkspaceTodayUsageSummary(
  overview: OverviewPayload,
  accounts: AccountRuntime[],
  usageStats: UsageStatsRecord | null | undefined,
  now: Date
) {
  if (usageStats) {
    return {
      requests: usageStats.totalRequests,
      inputTokens: usageStats.totalInputTokens,
      cacheReadTokens: usageStats.totalCacheReadTokens ?? usageStats.totalCacheTokens ?? 0,
      outputTokens: usageStats.totalOutputTokens,
      totalTokens: usageStats.totalTokens,
      actualCost: usageStats.totalActualCost
    };
  }

  return {
    requests: overview.totals.todayRequests,
    inputTokens: accounts.reduce(
      (sum, account) => sum + (account.cacheView?.stats.todayInputTokens ?? 0),
      0
    ),
    cacheReadTokens: accounts.reduce(
      (sum, account) => sum + getTodayCacheReadTokens(account, now),
      0
    ),
    outputTokens: accounts.reduce(
      (sum, account) => sum + (account.cacheView?.stats.todayOutputTokens ?? 0),
      0
    ),
    totalTokens: overview.totals.todayTokens,
    actualCost: overview.totals.todayActualCost
  };
}

function buildSyncSummary(input: {
  syncStatuses: AccountSyncStatusRecord[];
  syncStatusPresentation?: AccountSyncStatusPresentation;
  generatedAt: string | null | undefined;
  now: Date;
}) {
  const presentation = input.syncStatusPresentation;
  if (presentation && !presentation.hasSnapshot) {
    if (presentation.lastError) {
      return "同步状态暂不可读取";
    }
    return presentation.initialLoading ? "正在读取同步状态" : "未同步";
  }

  const syncStatuses = presentation?.statuses ?? input.syncStatuses;
  const summary = buildSyncSummaryFromStatuses(syncStatuses, input.generatedAt, input.now);
  return presentation?.lastError ? `${summary}（状态刷新失败）` : summary;
}

function buildSyncSummaryFromStatuses(
  syncStatuses: AccountSyncStatusRecord[],
  generatedAt: string | null | undefined,
  now: Date
) {
  if (syncStatuses.length === 0) {
    return formatTimestampLabel(generatedAt, "快照生成", now) ?? "未同步";
  }
  const running = syncStatuses.filter((item) => item.state === "running").length;
  if (running > 0) {
    return `${running} 项同步中`;
  }
  const failed = syncStatuses.find((item) => item.state === "failed");
  if (failed) {
    return `同步失败: ${failed.scope}`;
  }
  const latestSuccess = syncStatuses
    .map((item) => item.lastSuccessAt)
    .filter((item): item is string => Boolean(item))
    .sort()
    .at(-1);
  return formatTimestampLabel(latestSuccess, "最近同步", now) ?? "已同步";
}

function formatTimestampLabel(value: string | null | undefined, prefix: string, now: Date) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const time = date.toLocaleTimeString("zh-CN", {
    hour12: false,
    timeZone: "Asia/Shanghai"
  });
  if (shanghaiDateKey(date) === shanghaiDateKey(now)) {
    return `${prefix} ${time}`;
  }
  const parts = new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    timeZone: "Asia/Shanghai"
  }).formatToParts(date);
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return month && day ? `${prefix} ${month}月${day}日 ${time}` : `${prefix} ${time}`;
}

function shanghaiDateKey(value: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Shanghai"
  }).format(value);
}
