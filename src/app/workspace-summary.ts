import { compact, toDateValue } from "../shared/lib/formatters";
import type { AccountRuntime, AccountSyncStatusRecord, OverviewPayload } from "../types";

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
  syncStatuses = [],
  now = new Date()
}: {
  overview: OverviewPayload | null;
  accounts: AccountRuntime[];
  syncStatuses?: AccountSyncStatusRecord[];
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
      buildTextItem("sync", "未同步")
    ];
  }

  const todayInputTokens = accounts.reduce(
    (sum, account) => sum + (account.cacheView?.stats.todayInputTokens ?? 0),
    0
  );
  const todayOutputTokens = accounts.reduce(
    (sum, account) => sum + (account.cacheView?.stats.todayOutputTokens ?? 0),
    0
  );
  const todayCacheInputTokens = accounts.reduce(
    (sum, account) => sum + getTodayCacheReadTokens(account, now),
    0
  );

  return [
    buildTextItem("sites", `${overview.totals.totalSites} 个站点`),
    buildTextItem("accounts", `${overview.totals.totalAccounts} 个账号`),
    buildTextItem("requests", `今日 ${compact(overview.totals.todayRequests)} 请求`),
    buildTokenGroupItem("tokens", [
      { key: "input", label: "输入", value: compact(todayInputTokens) },
      { key: "cache", label: "缓存", value: compact(todayCacheInputTokens) },
      { key: "output", label: "输出", value: compact(todayOutputTokens) }
    ]),
    buildTextItem("totalTokens", `总 Token ${compact(overview.totals.todayTokens)}`),
    buildTextItem("sync", buildSyncSummary(syncStatuses, overview.generatedAt))
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

function buildSyncSummary(syncStatuses: AccountSyncStatusRecord[], generatedAt?: string | null) {
  if (syncStatuses.length === 0) {
    const overviewSync = formatSyncTimeLabel(generatedAt);
    return overviewSync ?? "未同步";
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
  return formatSyncTimeLabel(resolveLatestSyncSource(latestSuccess, generatedAt)) ?? "已同步";
}

function formatSyncTimeLabel(value?: string | null) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return `最近同步 ${date.toLocaleTimeString("zh-CN", { hour12: false })}`;
}

function resolveLatestSyncSource(syncStatusTime?: string | null, overviewGeneratedAt?: string | null) {
  const syncStatusDate = syncStatusTime ? new Date(syncStatusTime) : null;
  const overviewDate = overviewGeneratedAt ? new Date(overviewGeneratedAt) : null;

  const syncStatusMs = syncStatusDate && !Number.isNaN(syncStatusDate.getTime())
    ? syncStatusDate.getTime()
    : Number.NEGATIVE_INFINITY;
  const overviewMs = overviewDate && !Number.isNaN(overviewDate.getTime())
    ? overviewDate.getTime()
    : Number.NEGATIVE_INFINITY;

  if (overviewMs > syncStatusMs) {
    return overviewGeneratedAt;
  }
  return syncStatusTime ?? overviewGeneratedAt;
}
