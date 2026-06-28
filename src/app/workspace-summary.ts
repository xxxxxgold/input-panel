import { compact, toDateValue } from "../shared/lib/formatters";
import type { AccountRuntime, AccountSyncStatusRecord, OverviewPayload } from "../types";

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
      "等待同步站点",
      "等待同步账号",
      "暂无今日请求数据",
      "暂无 Token 摘要",
      "暂无今日总 Token",
      "未同步"
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
    `${overview.totals.totalSites} 个站点`,
    `${overview.totals.totalAccounts} 个账号`,
    `今日 ${compact(overview.totals.todayRequests)} 请求`,
    `入 ${compact(todayInputTokens)} / 缓存 ${compact(todayCacheInputTokens)} / 出 ${compact(todayOutputTokens)}`,
    `总 Token ${compact(overview.totals.todayTokens)}`,
    buildSyncSummary(syncStatuses, overview.generatedAt)
  ];
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
  return formatSyncTimeLabel(latestSuccess ?? generatedAt) ?? "已同步";
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
