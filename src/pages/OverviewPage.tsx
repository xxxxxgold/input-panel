import { useEffect, useState } from "react";

import {
  BadgeDollarSign,
  CalendarDays,
  ChartColumn,
  KeyRound,
  LayoutDashboard,
  MonitorDot,
  TimerReset
} from "lucide-react";

import type {
  AccountRuntime,
  KeyRecord,
  OverviewModelPoint,
  OverviewPayload,
  OverviewUsageRow,
  PlatformPoint,
  SubscriptionRecord,
  SubscriptionSummaryPayload,
  UsageInsightsPayload,
  UsageRow,
  UsageStatsRecord
} from "../types";
import { EChartCard, type ChartOption } from "../charts";
import { compact, formatDurationSeconds, formatTime, maskEmail } from "../shared/lib/formatters";
import { EmptyState } from "../shared/ui/EmptyState";
import { DetailItem, UsageMetricDetailItem } from "../shared/ui/DetailItem";
import { MetricCard } from "../shared/ui/MetricCard";
import { SectionCard } from "../shared/ui/SectionCard";
import { ApiKeyList, type ApiKeyListRecord } from "../features/keys/components/ApiKeyList";
import { SubscriptionList } from "../features/subscriptions/components/SubscriptionList";
import { UsageTrendSection } from "../features/usage/components/UsageTrendSection";
import type { OverviewAccountBalanceRecord } from "../features/overview/overview-realtime-scope";
import { sortOverviewSubscriptionsByUsage } from "../features/overview/overview-subscription-sort";
import { mergeSubscriptionRecords } from "../subscription-view";

type OverviewMetricDetailKind =
  | "balance"
  | "todayRequests"
  | "todayActualCost"
  | "apiKeys"
  | "todayTokens"
  | "totalTokens";

type OverviewUsageStatsMode = "selected-account" | "all-accounts";
type UsageInsightMetric = "tokens" | "actualCost";
type OverviewUsageInsightRankKind = "model" | "group" | "endpoint";

export type OverviewUsageInsightRange = {
  startDate: string;
  endDate: string;
};

type OverviewUsageStatsRow = {
  accountId: string;
  label: string;
  siteName: string;
  stats: UsageStatsRecord;
  totalStats?: UsageStatsRecord;
};

type OverviewUsageInsightRow = {
  name: string;
  requests: number;
  totalTokens: number;
  actualCost: number;
  totalCost: number;
};

export type OverviewConcurrencyKeyItem = {
  id: string;
  name: string;
  currentConcurrency: number;
  accountLabel: string | null;
};

type OverviewConcurrencyKeyCandidate = OverviewConcurrencyKeyItem & {
  sourceIndex: number;
};

export function buildOverviewConcurrencyKeyItems(
  keys: ApiKeyListRecord[],
  includeAccountLabel: boolean
): OverviewConcurrencyKeyItem[] {
  return keys
    .map<OverviewConcurrencyKeyCandidate | null>((key, sourceIndex) => {
      const currentConcurrency = key.currentConcurrency;
      if (
        typeof currentConcurrency !== "number"
        || !Number.isFinite(currentConcurrency)
        || currentConcurrency <= 0
      ) {
        return null;
      }

      const name = key.name.trim() || "未命名密钥";
      return {
        id: key.id,
        name,
        currentConcurrency,
        accountLabel: includeAccountLabel ? key.accountLabel?.trim() || "未关联账号" : null,
        sourceIndex
      };
    })
    .filter((item): item is OverviewConcurrencyKeyCandidate => item !== null)
    .sort((left, right) => {
      const concurrencyDifference = right.currentConcurrency - left.currentConcurrency;
      if (concurrencyDifference !== 0) {
        return concurrencyDifference;
      }

      const nameDifference = left.name.localeCompare(right.name, "zh-CN");
      return nameDifference !== 0 ? nameDifference : left.sourceIndex - right.sourceIndex;
    })
    .map(({ sourceIndex: _sourceIndex, ...item }) => item);
}

function applyOverviewAccountBalances(
  overview: OverviewPayload,
  balances: readonly OverviewAccountBalanceRecord[]
): OverviewPayload {
  const balanceByAccountId = new Map(
    balances
      .filter((item) => Number.isFinite(item.balance))
      .map((item) => [item.accountId, item] as const)
  );
  const accounts = overview.accounts.map((account) => {
    const balance = balanceByAccountId.get(account.id);
    if (!balance || !account.cacheView) {
      return account;
    }
    return {
      ...account,
      cacheView: {
        ...account.cacheView,
        balance: balance.balance,
        fetchedAt: balance.fetchedAt
      }
    };
  });
  const totalBalance = overview.accounts.reduce(
    (total, account) => total + (balanceByAccountId.get(account.id)?.balance ?? 0),
    0
  );
  return {
    ...overview,
    accounts,
    totals: {
      ...overview.totals,
      balance: totalBalance
    }
  };
}

export function OverviewPage({
  overview,
  currentAccount,
  currentAccountBalance,
  currentAccountStats,
  currentAccountSubscriptions,
  subscriptionSummary,
  currentAccountKeys = null,
  allAccountKeys = null,
  allAccountKeysLoading = false,
  allAccountBalances,
  allAccountBalancesLoading = false,
  currentAccountRecentUsage = [],
  usageStats,
  totalUsageStats,
  platformSeries,
  trendPoints,
  modelSeries,
  overviewRealtimeChartsLoading = false,
  usageStatsMode = "selected-account",
  usageStatsRows = [],
  usageInsightRange,
  onUsageInsightRangeChange = () => {},
  usageInsights = null
}: {
  overview: OverviewPayload;
  currentAccount?: AccountRuntime | null;
  currentAccountBalance?: number | null;
  currentAccountStats: NonNullable<AccountRuntime["cacheView"]>["stats"] | null;
  currentAccountSubscriptions: SubscriptionRecord[];
  subscriptionSummary: SubscriptionSummaryPayload | null;
  currentAccountKeys?: ApiKeyListRecord[] | null;
  allAccountKeys?: ApiKeyListRecord[] | null;
  allAccountKeysLoading?: boolean;
  allAccountBalances?: OverviewAccountBalanceRecord[] | null;
  allAccountBalancesLoading?: boolean;
  currentAccountRecentUsage: UsageRow[];
  usageStats: UsageStatsRecord | null;
  totalUsageStats?: UsageStatsRecord | null;
  platformSeries?: PlatformPoint[] | null;
  trendPoints?: NonNullable<NonNullable<AccountRuntime["cacheView"]>["trend"]> | null;
  modelSeries?: OverviewModelPoint[] | null;
  overviewRealtimeChartsLoading?: boolean;
  usageStatsMode?: OverviewUsageStatsMode;
  onUsageStatsModeChange?: (mode: OverviewUsageStatsMode) => void;
  usageStatsRows?: OverviewUsageStatsRow[];
  usageInsightRange?: OverviewUsageInsightRange;
  onUsageInsightRangeChange?: (range: OverviewUsageInsightRange) => void;
  usageInsights?: UsageInsightsPayload | null;
}) {
  const selectedAccountScopeUnavailable =
    usageStatsMode === "selected-account"
    && currentAccount !== undefined
    && currentAccount?.sessionState !== "ready";
  const resolvedUsageStatsMode = usageStatsMode;
  const scopedCurrentAccount = selectedAccountScopeUnavailable ? null : currentAccount;
  const currentAccountCache = scopedCurrentAccount?.cacheView ?? null;
  const scopedCurrentAccountStats = selectedAccountScopeUnavailable ? null : currentAccountStats;
  const scopedCurrentAccountKeys = selectedAccountScopeUnavailable ? null : currentAccountKeys;
  const scopedCurrentAccountSubscriptions = selectedAccountScopeUnavailable ? [] : currentAccountSubscriptions;
  const scopedSubscriptionSummary = selectedAccountScopeUnavailable ? null : subscriptionSummary;
  const scopedCurrentAccountRecentUsage = selectedAccountScopeUnavailable ? [] : currentAccountRecentUsage;
  const scopedPlatformSeries = selectedAccountScopeUnavailable ? null : platformSeries;
  const scopedTrendPoints = selectedAccountScopeUnavailable ? null : trendPoints;
  const scopedModelSeries = selectedAccountScopeUnavailable ? null : modelSeries;
  const scopedUsageInsights = selectedAccountScopeUnavailable ? null : usageInsights;
  const selectedAccountScopeEmptyTitle = currentAccount
    ? "当前账号尚未就绪"
    : "尚未选择可用账号";
  const selectedAccountScopeEmptyDetail = currentAccount
    ? `“${currentAccount.label}”尚未登录或会话未就绪, 暂时不能展示这个账号的数据。`
    : "请选择一个已登录且已就绪的账号后查看当前账号数据。";
  const [usageInsightMetric, setUsageInsightMetric] = useState<UsageInsightMetric>("tokens");
  const [usageInsightRangeDraft, setUsageInsightRangeDraft] = useState<OverviewUsageInsightRange>(
    usageInsightRange ?? { startDate: "", endDate: "" }
  );
  useEffect(() => {
    if (usageInsightRange) {
      setUsageInsightRangeDraft(usageInsightRange);
    }
  }, [usageInsightRange?.startDate, usageInsightRange?.endDate]);
  const effectiveUsageStats = selectedAccountScopeUnavailable ? null : usageStats;
  const effectiveTotalUsageStats = selectedAccountScopeUnavailable ? null : totalUsageStats;
  const effectiveUsageStatsRows = selectedAccountScopeUnavailable ? [] : usageStatsRows;
  const resolvedCurrentAccountSubscriptions = resolveOverviewSubscriptionPlatforms(
    scopedCurrentAccountSubscriptions,
    scopedCurrentAccountKeys ?? []
  );
  const accountDisplayLabelById = new Map(
    overview.accounts.map((account) => [account.id, resolveOverviewAccountDisplayLabel(account)])
  );
  const selectedAccountKeysUnavailable =
    resolvedUsageStatsMode === "selected-account" && scopedCurrentAccountKeys === null;
  const allAccountKeysUnavailable =
    resolvedUsageStatsMode === "all-accounts" && allAccountKeys === null;
  const scopedApiKeysUnavailable = selectedAccountKeysUnavailable || allAccountKeysUnavailable;
  const scopedApiKeyRecords =
    resolvedUsageStatsMode === "selected-account"
      ? scopedCurrentAccountKeys ?? []
      : allAccountKeys ?? [];
  const scopedApiKeyRecordsWithContext = scopedApiKeyRecords.map((key) =>
    withOverviewApiKeyAccountLabel(key, resolvedUsageStatsMode, scopedCurrentAccount, accountDisplayLabelById)
  );
  const currentConcurrencyKeyItems = buildOverviewConcurrencyKeyItems(
    scopedApiKeyRecordsWithContext,
    resolvedUsageStatsMode === "all-accounts"
  );
  const currentConcurrencyLoading =
    resolvedUsageStatsMode === "all-accounts"
    && allAccountKeysLoading
    && scopedApiKeyRecordsWithContext.length === 0;
  const apiKeyDetailsByAccount = new Map<
    string,
    { label: string; totalApiKeys: number; activeApiKeys: number }
  >();
  if (!scopedApiKeysUnavailable) {
    for (const key of scopedApiKeyRecordsWithContext) {
      const accountId =
        resolvedUsageStatsMode === "selected-account"
          ? scopedCurrentAccount?.id ?? "selected-account"
          : readApiKeyAccountId(key) ?? key.accountLabel?.trim() ?? "unassigned";
      const label =
        resolvedUsageStatsMode === "selected-account"
          ? resolveOverviewAccountDisplayLabel(scopedCurrentAccount) ?? "当前账号"
          : key.accountLabel?.trim() || "未关联账号";
      const existing = apiKeyDetailsByAccount.get(accountId);
      if (existing) {
        existing.totalApiKeys += 1;
        if (key.status === "active") {
          existing.activeApiKeys += 1;
        }
        continue;
      }
      apiKeyDetailsByAccount.set(accountId, {
        label,
        totalApiKeys: 1,
        activeApiKeys: key.status === "active" ? 1 : 0
      });
    }
  }
  const apiKeyDetailRows = [...apiKeyDetailsByAccount.entries()]
    .map(([accountId, detail]) => ({ accountId, ...detail }))
    .sort((left, right) => {
      if (right.totalApiKeys !== left.totalApiKeys) {
        return right.totalApiKeys - left.totalApiKeys;
      }
      return left.label.localeCompare(right.label, "zh-CN");
    });
  const mergedCurrentAccountSubscriptions = mergeSubscriptionRecords(
    resolvedCurrentAccountSubscriptions,
    scopedSubscriptionSummary
  );
  const sortedCurrentAccountSubscriptions = sortOverviewSubscriptionsByUsage(
    mergedCurrentAccountSubscriptions
  );
  const balanceOverview = resolvedUsageStatsMode === "all-accounts" && allAccountBalances
    ? applyOverviewAccountBalances(overview, allAccountBalances)
    : overview;
  const balanceHint = selectedAccountScopeUnavailable
    ? selectedAccountScopeEmptyTitle
    : resolvedUsageStatsMode === "all-accounts" && allAccountBalances === null
      ? allAccountBalancesLoading
        ? "正在读取全部账号余额"
        : "全部账号余额暂不可用"
      : buildOverviewBalanceHint(balanceOverview, scopedCurrentAccount, currentAccountBalance, resolvedUsageStatsMode);
  const selectedAccountApiKeyStats =
    resolvedUsageStatsMode === "selected-account" && scopedCurrentAccountKeys !== null
      ? {
          totalApiKeys: scopedCurrentAccountKeys.length,
          activeApiKeys: scopedCurrentAccountKeys.filter((key) => key.status === "active").length
        }
      : null;
  const allAccountApiKeyStats =
    resolvedUsageStatsMode === "all-accounts" && allAccountKeys !== null
      ? {
          totalApiKeys: allAccountKeys.length,
          activeApiKeys: allAccountKeys.filter((key) => key.status === "active").length
        }
      : null;
  const scopedApiKeyStats =
    resolvedUsageStatsMode === "selected-account" ? selectedAccountApiKeyStats : allAccountApiKeyStats;
  const apiKeyHint = scopedApiKeyStats
    ? `正常 ${scopedApiKeyStats.activeApiKeys.toLocaleString()} / 总 ${scopedApiKeyStats.totalApiKeys.toLocaleString()}`
    : selectedAccountScopeUnavailable
      ? selectedAccountScopeEmptyTitle
    : resolvedUsageStatsMode === "all-accounts"
      ? allAccountKeysLoading
        ? "正在读取全部账号密钥"
        : "全部账号密钥暂不可用"
      : "当前账号密钥暂不可用";
  const todayTokenHint = selectedAccountScopeUnavailable
    ? selectedAccountScopeEmptyTitle
    : buildOverviewTodayTokenHint(overview);
  const totalTokenHint = effectiveTotalUsageStats
    ? `累计请求 ${effectiveTotalUsageStats.totalRequests.toLocaleString()} 次`
    : resolvedUsageStatsMode === "selected-account"
      ? "当前账号还没有可展示的数据"
      : "当前还没有可展示的数据";
  const averageResponseValue = buildOverviewAverageResponseValue(effectiveUsageStats);
  const averageResponseHint = buildOverviewAverageResponseHint(effectiveUsageStats);
  const recentUsageRows: Array<UsageRow | OverviewUsageRow> =
    resolvedUsageStatsMode === "selected-account" ? scopedCurrentAccountRecentUsage : overview.recentUsage;
  const effectiveTrendPoints =
    resolvedUsageStatsMode === "selected-account"
      ? scopedTrendPoints !== undefined
        ? scopedTrendPoints ?? []
        : currentAccountCache?.trend ?? (currentAccount === undefined ? overview.trend : [])
      : scopedTrendPoints !== undefined
        ? scopedTrendPoints ?? []
        : overview.trend;
  const trendEmptyTitle =
    selectedAccountScopeUnavailable
      ? selectedAccountScopeEmptyTitle
      : resolvedUsageStatsMode === "selected-account"
      ? "当前账号最近 7 天还没有趋势数据"
      : "当前没有总览趋势数据";
  const trendEmptyDetail =
    selectedAccountScopeUnavailable
      ? selectedAccountScopeEmptyDetail
      : resolvedUsageStatsMode === "selected-account"
      ? "先刷新这个账号后, 这里会显示最近 7 天的变化趋势。"
      : "至少刷新一个账号后, 这里才会显示最近 7 天的变化趋势。";
  const scopedBalance = selectedAccountScopeUnavailable
    ? null
    : resolvedUsageStatsMode === "selected-account"
    ? currentAccountBalance !== undefined
      ? currentAccountBalance
      : currentAccountCache?.balance ?? null
    : allAccountBalances === null
      ? null
      : balanceOverview.totals.balance;
  const currentAccountBalanceDetails =
    resolvedUsageStatsMode === "selected-account" && currentAccountBalance !== undefined
      ? currentAccountBalance !== null && scopedCurrentAccount
        ? (
            <UsageMetricDetailItem
              label={scopedCurrentAccount.label}
              value={`$${currentAccountBalance.toFixed(2)}`}
              description={`${formatOverviewAccountSource(scopedCurrentAccount)} · 账户资料余额`}
            />
          )
        : (
            <EmptyState
              title="当前账号余额暂不可用"
              detail="暂时无法读取当前账号的账户资料余额, 请稍后手动刷新。"
              compact
            />
          )
      : null;
  const scopedApiKeys = scopedApiKeyStats?.totalApiKeys ?? null;
  const apiKeyMetricDetails =
    selectedAccountScopeUnavailable
      ? (
          <EmptyState
            title={selectedAccountScopeEmptyTitle}
            detail={selectedAccountScopeEmptyDetail}
            compact
          />
        )
      : scopedApiKeysUnavailable
      ? (
          <EmptyState
            title={
              resolvedUsageStatsMode === "selected-account"
                ? "当前账号密钥暂不可用"
                : allAccountKeysLoading
                  ? "正在读取全部账号密钥"
                  : "全部账号密钥暂不可用"
            }
            detail={
              resolvedUsageStatsMode === "selected-account"
                ? "暂时无法读取当前账号的完整密钥列表, 请稍后手动刷新。"
                : "暂时无法读取完整的全部账号密钥列表, 请稍后手动刷新。"
            }
            compact
          />
        )
      : apiKeyDetailRows.length > 0
        ? (
            <>
              {apiKeyDetailRows.map((row) => (
                <UsageMetricDetailItem
                  key={`${resolvedUsageStatsMode}-api-keys-${row.accountId}`}
                  label={row.label}
                  value={row.totalApiKeys.toLocaleString()}
                  description={`${row.activeApiKeys.toLocaleString()} 启用 / ${row.totalApiKeys.toLocaleString()} 密钥`}
                />
              ))}
            </>
          )
        : (
            <EmptyState
              title={resolvedUsageStatsMode === "selected-account" ? "当前没有密钥" : "全部账号当前没有密钥"}
              detail={
                resolvedUsageStatsMode === "selected-account"
                  ? "已读取当前账号, 暂时没有可展示的密钥列表。"
                  : "已读取全部账号, 暂时没有可展示的密钥列表。"
              }
              compact
            />
          );
  const scopedTotalTokens = effectiveTotalUsageStats?.totalTokens ?? null;
  const platformCards = (
    resolvedUsageStatsMode === "selected-account"
      ? scopedPlatformSeries !== undefined
        ? scopedPlatformSeries ?? []
        : scopedCurrentAccountStats?.byPlatform
          ?? currentAccountCache?.stats.byPlatform
          ?? (currentAccount === undefined ? overview.platformSeries : [])
      : scopedPlatformSeries !== undefined
        ? scopedPlatformSeries ?? []
        : overview.platformSeries
  )
    .slice()
    .sort((left, right) => {
      const costDiff = right.totalActualCost - left.totalActualCost;
      if (costDiff !== 0) {
        return costDiff;
      }
      return left.platform.localeCompare(right.platform, "zh-CN");
    });
  const modelRows = (
    resolvedUsageStatsMode === "selected-account"
      ? scopedModelSeries !== undefined
        ? scopedModelSeries ?? []
        : scopedCurrentAccountStats?.byModel
          ?? currentAccountCache?.stats.byModel
          ?? (currentAccount === undefined ? overview.modelSeries ?? [] : [])
      : scopedModelSeries !== undefined
        ? scopedModelSeries ?? []
        : overview.modelSeries ?? []
  );
  const usageInsightSortLabel = usageInsightMetric === "tokens" ? "Token" : "实际消费";
  const usageInsightSampleHint = selectedAccountScopeUnavailable
    ? selectedAccountScopeEmptyTitle
    : scopedUsageInsights
    ? `${scopedUsageInsights.totalRequests.toLocaleString()} 条请求`
    : recentUsageRows.length > 0
      ? `${recentUsageRows.length.toLocaleString()} 条请求`
      : "暂无请求";
  const modelDistributionRows = sortOverviewUsageInsightRows(
    modelRows.map((row) => ({
      name: row.model,
      requests: row.requests,
      totalTokens: row.totalTokens,
      actualCost: row.actualCost,
      totalCost: row.totalCost
    })),
    usageInsightMetric
  ).slice(0, 6);
  const groupDistributionRows = sortOverviewUsageInsightRows(
    scopedUsageInsights?.groups ?? buildOverviewUsageInsightRows(recentUsageRows, (row) =>
      normalizeOverviewUsageInsightLabel(row.groupName, "未分组")
    ),
    usageInsightMetric
  ).slice(0, 6);
  const endpointDistributionRows = sortOverviewUsageInsightRows(
    scopedUsageInsights?.endpoints ?? buildOverviewUsageInsightRows(recentUsageRows, (row) =>
      normalizeOverviewUsageInsightLabel(row.endpoint ?? row.upstreamEndpoint, "未标记端点")
    ),
    usageInsightMetric
  ).slice(0, 6);

  function renderPlatformDistributionCard() {
    const platformLoading =
      !selectedAccountScopeUnavailable
      && overviewRealtimeChartsLoading
      && scopedPlatformSeries === null
      && platformCards.length === 0;
    const platformLoadingTitle =
      resolvedUsageStatsMode === "selected-account" ? "正在刷新当前账号平台分布" : "正在刷新全部账号平台分布";
    const platformLoadingDetail =
      resolvedUsageStatsMode === "selected-account"
        ? "请稍等, 这里会更新为当前账号的最新平台用量。"
        : "请稍等, 这里会更新为全部账号的最新平台用量。";
    return (
      <SectionCard title="平台分布" subtitle="看看不同平台各用了多少, 花了多少">
        {platformLoading ? (
          <EmptyState title={platformLoadingTitle} detail={platformLoadingDetail} compact />
        ) : platformCards.length > 0 ? (
          <div className="platform-distribution-grid motion-stagger-grid">
            {platformCards.map((item, index) => {
              const platformLabel = formatOverviewPlatformLabel(item.platform);
              const platformTone = toOverviewPlatformTone(item.platform);
              return (
                <article
                  key={item.platform}
                  className="platform-distribution-card motion-stagger-item"
                  style={{ ["--motion-order" as string]: index }}
                >
                  <div className="platform-distribution-head">
                    <div className="platform-distribution-copy">
                      <span className="platform-distribution-rank">TOP {index + 1}</span>
                      <strong className={`platform-distribution-name ${platformTone}`}>{platformLabel}</strong>
                    </div>
                    <div className="platform-distribution-cost">
                      <span>累计实际成本</span>
                      <strong>${item.totalActualCost.toFixed(4)}</strong>
                    </div>
                  </div>
                  <div className="platform-distribution-metrics">
                    <div className="summary-stat compact-stat">
                      <span>今日成本</span>
                      <strong>${item.todayActualCost.toFixed(4)}</strong>
                    </div>
                    <div className="summary-stat compact-stat">
                      <span>总 Tokens</span>
                      <strong>{compact(item.totalTokens)}</strong>
                    </div>
                    <div className="summary-stat compact-stat">
                      <span>总请求</span>
                      <strong>{item.totalRequests.toLocaleString()}</strong>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title={selectedAccountScopeUnavailable ? selectedAccountScopeEmptyTitle : "暂时没有平台数据"}
            detail={selectedAccountScopeUnavailable ? selectedAccountScopeEmptyDetail : "刷新账号后, 这里会按平台展示用量和花费。"}
            compact
          />
        )}
      </SectionCard>
    );
  }

  function renderUsageInsightDistributionCard({
    title,
    subtitle,
    rows,
    emptyTitle,
    emptyDetail,
    loading = false,
    loadingTitle,
    loadingDetail,
    rankKind = "model"
  }: {
    title: string;
    subtitle: string;
    rows: OverviewUsageInsightRow[];
    emptyTitle: string;
    emptyDetail: string;
    loading?: boolean;
    loadingTitle?: string;
    loadingDetail?: string;
    rankKind?: OverviewUsageInsightRankKind;
  }) {
    const chartOption = buildOverviewUsageInsightDonutOption(rows, usageInsightMetric, rankKind);
    const rankSummary = rows
      .map(
        (row) =>
          `${row.name}: ${row.requests.toLocaleString()} 请求, ${compact(row.totalTokens)} Token, 实际 $${row.actualCost.toFixed(4)}, 标准 $${row.totalCost.toFixed(4)}`
      )
      .join("；");
    return (
      <SectionCard title={title} subtitle={subtitle}>
        <div
          className="overview-usage-insight-rank-shell"
          role={rows.length > 0 ? "img" : undefined}
          aria-label={rows.length > 0 ? `${title}: ${rankSummary}` : undefined}
          aria-busy={loading}
        >
          {loading ? (
            <EmptyState
              title={loadingTitle ?? "正在刷新用量洞察"}
              detail={loadingDetail ?? "请稍等, 这里会更新为最新的用量分析。"}
              compact
            />
          ) : rows.length > 0 ? (
            <EChartCard option={chartOption} />
          ) : (
            <EmptyState title={emptyTitle} detail={emptyDetail} compact />
          )}
        </div>
      </SectionCard>
    );
  }

  function renderModelDistributionCard() {
    const modelLoading =
      !selectedAccountScopeUnavailable
      && overviewRealtimeChartsLoading
      && scopedModelSeries === null
      && modelRows.length === 0;
    const modelLoadingTitle =
      resolvedUsageStatsMode === "selected-account" ? "正在刷新当前账号模型分布" : "正在刷新全部账号模型分布";
    const modelLoadingDetail =
      resolvedUsageStatsMode === "selected-account"
        ? "请稍等, 这里会更新为当前账号的最新模型使用情况。"
        : "请稍等, 这里会更新为全部账号的最新模型使用情况。";
    const modelEmptyTitle =
      selectedAccountScopeUnavailable
        ? selectedAccountScopeEmptyTitle
        : resolvedUsageStatsMode === "selected-account"
        ? "当前账号还没有模型数据"
        : "暂时没有模型数据";
    const modelEmptyDetail =
      selectedAccountScopeUnavailable
        ? selectedAccountScopeEmptyDetail
        : resolvedUsageStatsMode === "selected-account"
        ? "先刷新这个账号后, 这里会展示当前账号的模型使用情况。"
        : "刷新账号后, 这里会展示不同模型的使用情况。";
    return renderUsageInsightDistributionCard({
      title: "模型排行",
      subtitle: `模型${usageInsightMetric === "tokens" ? "Token" : "实际消费"}用量`,
      rows: modelDistributionRows,
      emptyTitle: modelEmptyTitle,
      emptyDetail: modelEmptyDetail,
      loading: modelLoading,
      loadingTitle: modelLoadingTitle,
      loadingDetail: modelLoadingDetail
    });
  }

  function renderSubscriptionsCard() {
    return (
      <SectionCard title="全部订阅" subtitle="这里会列出当前账号可用的订阅和额度情况">
        {selectedAccountScopeUnavailable ? (
          <EmptyState title={selectedAccountScopeEmptyTitle} detail={selectedAccountScopeEmptyDetail} compact />
        ) : sortedCurrentAccountSubscriptions.length > 0 ? (
          <SubscriptionList subscriptions={sortedCurrentAccountSubscriptions} />
        ) : (
          <EmptyState title="当前没有订阅信息" detail="这个账号暂时没有可展示的订阅内容。" compact />
        )}
      </SectionCard>
    );
  }

  function renderApiKeysCard() {
    const apiKeysSubtitle =
      resolvedUsageStatsMode === "selected-account"
        ? "这里会显示当前账号每个密钥的状态和最近使用情况"
        : "这里会显示全部账号每个密钥的状态和最近使用情况";
    return (
      <SectionCard title="全部密钥" subtitle={apiKeysSubtitle}>
        {selectedAccountScopeUnavailable ? (
          <EmptyState title={selectedAccountScopeEmptyTitle} detail={selectedAccountScopeEmptyDetail} compact />
        ) : scopedApiKeysUnavailable ? (
          <EmptyState
            title={
              resolvedUsageStatsMode === "selected-account"
                ? "当前账号密钥暂不可用"
                : allAccountKeysLoading
                  ? "正在读取全部账号密钥"
                  : "全部账号密钥暂不可用"
            }
            detail={
              resolvedUsageStatsMode === "selected-account"
                ? "暂时无法读取当前账号的完整密钥列表, 请稍后手动刷新。"
                : allAccountKeysLoading
                  ? "请稍等, 这里会读取完整的全部账号密钥列表。"
                  : "暂时无法读取完整的全部账号密钥列表, 请稍后手动刷新。"
            }
            compact
          />
        ) : scopedApiKeyRecordsWithContext.length > 0 ? (
          <ApiKeyList keys={scopedApiKeyRecordsWithContext} />
        ) : (
          <EmptyState
            title={resolvedUsageStatsMode === "selected-account" ? "当前没有密钥" : "全部账号当前没有密钥"}
            detail={
              resolvedUsageStatsMode === "selected-account"
                ? "登录并刷新后, 这里会显示当前账号的可用密钥列表。"
                : "至少刷新一个账号后, 这里会显示全部账号的可用密钥列表。"
            }
            compact
          />
        )}
      </SectionCard>
    );
  }

  return (
    <>
      <section className="metric-grid motion-stagger-grid overview-metric-grid">
        <MetricCard
          label={resolvedUsageStatsMode === "selected-account" ? "当前账号余额" : "总余额"}
          value={scopedBalance === null ? "-" : `$${scopedBalance.toFixed(2)}`}
          accent="emerald"
          icon={<BadgeDollarSign size={18} />}
          hint={balanceHint}
          detailTitle={resolvedUsageStatsMode === "selected-account" ? "当前账号余额" : "各账号余额"}
          detail={
            selectedAccountScopeUnavailable
              ? <EmptyState title={selectedAccountScopeEmptyTitle} detail={selectedAccountScopeEmptyDetail} compact />
              : resolvedUsageStatsMode === "selected-account" && currentAccountBalance !== undefined
                ? currentAccountBalanceDetails
              : resolvedUsageStatsMode === "all-accounts" && allAccountBalances === null
                ? (
                    <EmptyState
                      title={allAccountBalancesLoading ? "正在读取全部账号余额" : "全部账号余额暂不可用"}
                      detail={allAccountBalancesLoading ? "请稍等, 正在汇总各账号的实时余额。" : "请稍后手动刷新总览。"}
                      compact
                    />
                  )
              : renderScopedOverviewMetricDetails(balanceOverview, scopedCurrentAccount, "balance", resolvedUsageStatsMode)
          }
          className="overview-metric-card motion-stagger-item"
          animationKey={`overview-balance:${scopedBalance ?? "missing"}:${resolvedUsageStatsMode}`}
          style={{ ["--motion-order" as string]: 0 }}
        />
        <MetricCard
          label="API 密钥"
          value={scopedApiKeys === null ? "-" : scopedApiKeys.toLocaleString()}
          accent="amber"
          icon={<KeyRound size={18} />}
          hint={apiKeyHint}
          detailTitle={resolvedUsageStatsMode === "selected-account" ? "当前账号 Key 状态" : "各账号 Key 状态"}
          detail={apiKeyMetricDetails}
          className="overview-metric-card motion-stagger-item"
          animationKey={`overview-api-keys:${scopedApiKeys ?? "unknown"}:${resolvedUsageStatsMode}`}
          style={{ ["--motion-order" as string]: 1 }}
        />
        <MetricCard
          label="今日请求"
          value={effectiveUsageStats ? effectiveUsageStats.totalRequests.toLocaleString() : "-"}
          accent="sky"
          icon={<LayoutDashboard size={18} />}
          hint={buildOverviewRequestsHint(effectiveUsageStats, resolvedUsageStatsMode)}
          detailTitle={resolvedUsageStatsMode === "selected-account" ? "当前账号今日请求" : "全部账号今日请求"}
          detail={renderOverviewUsageStatsRows(effectiveUsageStatsRows, resolvedUsageStatsMode, (row) => row.stats.totalRequests.toLocaleString(), (row) => `累计 ${row.stats.totalRequests.toLocaleString()} 请求`)}
          className="overview-metric-card motion-stagger-item"
          animationKey={`overview-requests:${effectiveUsageStats?.totalRequests ?? "missing"}:${resolvedUsageStatsMode}`}
          style={{ ["--motion-order" as string]: 2 }}
        />
        <MetricCard
          label="今日消费"
          value={effectiveUsageStats ? `$${effectiveUsageStats.totalActualCost.toFixed(4)}` : "-"}
          accent="violet"
          icon={<ChartColumn size={18} />}
          hint={buildOverviewActualCostHint(effectiveUsageStats, resolvedUsageStatsMode)}
          detailTitle={resolvedUsageStatsMode === "selected-account" ? "当前账号今日实际成本" : "全部账号今日实际成本"}
          detail={renderOverviewUsageStatsRows(effectiveUsageStatsRows, resolvedUsageStatsMode, (row) => `$${row.stats.totalActualCost.toFixed(4)}`, (row) => `请求 ${row.stats.totalRequests.toLocaleString()} / Tokens ${compact(row.stats.totalTokens)}`)}
          detailPanelAlign="end"
          className="overview-metric-card motion-stagger-item"
          animationKey={`overview-actual-cost:${effectiveUsageStats?.totalActualCost ?? "missing"}:${resolvedUsageStatsMode}`}
          style={{ ["--motion-order" as string]: 3 }}
        />
        <MetricCard
          label="今日 Tokens"
          value={effectiveUsageStats ? compact(effectiveUsageStats.totalTokens) : "-"}
          accent="indigo"
          icon={<MonitorDot size={18} />}
          hint={buildOverviewTodayTokensHint(effectiveUsageStats, resolvedUsageStatsMode, todayTokenHint)}
          detailTitle={resolvedUsageStatsMode === "selected-account" ? "当前账号今日 Tokens" : "全部账号今日 Tokens"}
          detail={renderOverviewUsageStatsRows(effectiveUsageStatsRows, resolvedUsageStatsMode, (row) => compact(row.stats.totalTokens), (row) => `输入 ${compact(row.stats.totalInputTokens)} / 输出 ${compact(row.stats.totalOutputTokens)}`)}
          className="overview-metric-card motion-stagger-item"
          animationKey={`overview-tokens:${effectiveUsageStats?.totalTokens ?? "missing"}:${resolvedUsageStatsMode}`}
          style={{ ["--motion-order" as string]: 4 }}
        />
        <MetricCard
          label="累计 Tokens"
          value={scopedTotalTokens === null ? "-" : compact(scopedTotalTokens)}
          accent="indigo"
          icon={<MonitorDot size={18} />}
          hint={totalTokenHint}
          detailTitle={resolvedUsageStatsMode === "selected-account" ? "当前账号累计 Tokens" : "各账号累计 Tokens"}
          detail={renderOverviewUsageStatsRows(
            effectiveUsageStatsRows,
            resolvedUsageStatsMode,
            (row) => compact((row.totalStats ?? row.stats).totalTokens),
            (row) => `累计 ${(row.totalStats ?? row.stats).totalRequests.toLocaleString()} 请求`
          )}
          className="overview-metric-card motion-stagger-item"
          animationKey={`overview-total-tokens:${scopedTotalTokens ?? "missing"}:${resolvedUsageStatsMode}`}
          style={{ ["--motion-order" as string]: 5 }}
        />
        <MetricCard
          label="性能指标"
          value={buildOverviewStatsPerformanceValue(effectiveUsageStats)}
          accent="sky"
          icon={<TimerReset size={18} />}
          hint={buildOverviewStatsPerformanceHint(effectiveUsageStats, resolvedUsageStatsMode)}
          detailTitle={resolvedUsageStatsMode === "selected-account" ? "当前账号性能指标" : "全部账号性能指标"}
          detail={renderOverviewUsageStatsPerformanceDetails(
            effectiveUsageStats,
            effectiveUsageStatsRows,
            resolvedUsageStatsMode
          )}
          className="overview-metric-card motion-stagger-item"
          animationKey={`overview-performance:${effectiveUsageStats?.rpm ?? "missing"}:${effectiveUsageStats?.tpm ?? "missing"}:${resolvedUsageStatsMode}:stats`}
          style={{ ["--motion-order" as string]: 6 }}
        />
        <MetricCard
          label="平均响应"
          value={averageResponseValue}
          accent="rose"
          icon={<TimerReset size={18} />}
          hint={buildOverviewAverageResponseModeHint(averageResponseHint, resolvedUsageStatsMode)}
          detailTitle={resolvedUsageStatsMode === "selected-account" ? "当前账号响应摘要" : "全部账号响应摘要"}
          detail={renderOverviewAverageResponseDetails(effectiveUsageStats, effectiveUsageStatsRows, resolvedUsageStatsMode)}
          detailPanelAlign="end"
          className="overview-metric-card motion-stagger-item"
          animationKey={`overview-average-response:${averageResponseValue}:${resolvedUsageStatsMode}`}
          style={{ ["--motion-order" as string]: 7 }}
        />
      </section>

      <section className="overview-concurrency-band" aria-labelledby="overview-concurrency-band-title">
        <div className="overview-concurrency-band-head">
          <h2 id="overview-concurrency-band-title">密钥实时状态</h2>
        </div>
        <div className="overview-concurrency-band-content">
          {currentConcurrencyLoading ? (
            <p className="overview-concurrency-band-empty" role="status">正在读取全部账号密钥并发。</p>
          ) : selectedAccountScopeUnavailable ? (
            <p className="overview-concurrency-band-empty">{selectedAccountScopeEmptyTitle}。</p>
          ) : scopedApiKeysUnavailable ? (
            <p className="overview-concurrency-band-empty">
              {resolvedUsageStatsMode === "selected-account"
                ? "当前账号密钥暂不可用。"
                : allAccountKeysLoading
                  ? "正在读取全部账号密钥并发。"
                  : "全部账号密钥暂不可用。"}
            </p>
          ) : currentConcurrencyKeyItems.length > 0 ? (
            <div className="overview-concurrency-key-list" role="list" aria-label="当前并发密钥列表">
              {currentConcurrencyKeyItems.map((item) => (
                <article key={item.id} className="overview-concurrency-key-item" role="listitem">
                  <div className="overview-concurrency-key-copy">
                    <strong title={item.name}>{item.name}</strong>
                    {item.accountLabel ? <span title={item.accountLabel}>{item.accountLabel}</span> : null}
                  </div>
                  <div className="overview-concurrency-key-value">
                    <span>当前并发</span>
                    <strong>{item.currentConcurrency.toLocaleString()}</strong>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="overview-concurrency-band-empty">当前没有正在并发的密钥。</p>
          )}
        </div>
      </section>

      <section className="overview-usage-insights-section">
        <div className="overview-usage-insights-toolbar">
          <div className="overview-usage-insights-copy">
            <h2>用量洞察</h2>
          </div>
          <div className="overview-usage-insights-actions">
            <div className="overview-usage-insight-metric-toggle" role="tablist" aria-label="用量洞察排序口径">
              <button
                type="button"
                role="tab"
                aria-selected={usageInsightMetric === "tokens"}
                className={usageInsightMetric === "tokens" ? "primary-button" : "ghost-button"}
                onClick={() => setUsageInsightMetric("tokens")}
              >
                Token
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={usageInsightMetric === "actualCost"}
                className={usageInsightMetric === "actualCost" ? "primary-button" : "ghost-button"}
                onClick={() => setUsageInsightMetric("actualCost")}
              >
                实际消费
              </button>
            </div>
            <div className="overview-usage-insights-range" aria-label="用量洞察时间范围">
              <CalendarDays size={15} aria-hidden="true" />
              <input
                type="date"
                aria-label="开始日期"
                value={usageInsightRangeDraft.startDate}
                onChange={(event) => setUsageInsightRangeDraft((range) => ({ ...range, startDate: event.target.value }))}
              />
              <span aria-hidden="true">至</span>
              <input
                type="date"
                aria-label="结束日期"
                value={usageInsightRangeDraft.endDate}
                onChange={(event) => setUsageInsightRangeDraft((range) => ({ ...range, endDate: event.target.value }))}
              />
              <button
                type="button"
                className="ghost-button overview-usage-insights-range-apply"
                disabled={!usageInsightRangeDraft.startDate || !usageInsightRangeDraft.endDate}
                onClick={() => onUsageInsightRangeChange(usageInsightRangeDraft)}
              >
                应用
              </button>
            </div>
            <span className="overview-usage-insights-tag">{usageInsightSampleHint}</span>
          </div>
        </div>
        <div className="overview-usage-insights-grid">
          <div className="overview-layout-card overview-layout-card--trend overview-usage-insights-trend-card">
            {!selectedAccountScopeUnavailable
              && overviewRealtimeChartsLoading
              && scopedTrendPoints === null
              && effectiveTrendPoints.length === 0 ? (
              <SectionCard title="Token 使用趋势">
                <EmptyState
                  title={resolvedUsageStatsMode === "selected-account" ? "正在刷新当前账号趋势" : "正在刷新全部账号趋势"}
                  detail="请稍等, 这里会更新为所选时间范围内的最新趋势数据。"
                  compact
                />
              </SectionCard>
            ) : (
              <UsageTrendSection
                title="Token 使用趋势"
                points={effectiveTrendPoints}
                emptyTitle={trendEmptyTitle}
                emptyDetail={trendEmptyDetail}
              />
            )}
          </div>
          <div className="overview-layout-card overview-layout-card--models overview-usage-insight-rank-card">{renderModelDistributionCard()}</div>
          <div className="overview-layout-card overview-layout-card--groups overview-usage-insight-rank-card">
            {renderUsageInsightDistributionCard({
              title: "分组排行",
              subtitle: `${usageInsightSampleHint} · ${usageInsightSortLabel} 排序`,
              rows: groupDistributionRows,
              rankKind: "group",
              emptyTitle: selectedAccountScopeUnavailable ? selectedAccountScopeEmptyTitle : "最近还没有分组样本",
              emptyDetail: selectedAccountScopeUnavailable
                ? selectedAccountScopeEmptyDetail
                : "有请求记录后, 这里会显示最近样本里的分组使用情况。"
            })}
          </div>
          <div className="overview-layout-card overview-layout-card--endpoints overview-usage-insight-rank-card">
            {renderUsageInsightDistributionCard({
              title: "端点排行",
              subtitle: `${usageInsightSampleHint} · ${usageInsightSortLabel} 排序`,
              rows: endpointDistributionRows,
              rankKind: "endpoint",
              emptyTitle: selectedAccountScopeUnavailable ? selectedAccountScopeEmptyTitle : "最近还没有端点样本",
              emptyDetail: selectedAccountScopeUnavailable
                ? selectedAccountScopeEmptyDetail
                : "有请求记录后, 这里会显示最近样本里的端点使用情况。"
            })}
          </div>
        </div>
      </section>

      <section className="overview-layout overview-layout-desktop">
        <div className="overview-column">
          <div className="overview-layout-card overview-layout-card--platforms">{renderPlatformDistributionCard()}</div>
          <div className="overview-layout-card overview-layout-card--subscriptions">{renderSubscriptionsCard()}</div>
        </div>
        <div className="overview-column">
          <div className="overview-layout-card overview-layout-card--keys">{renderApiKeysCard()}</div>
        </div>
      </section>

      <section className="overview-layout-mobile">
        <div className="overview-layout-card overview-layout-card--platforms">{renderPlatformDistributionCard()}</div>
        <div className="overview-layout-card overview-layout-card--subscriptions">{renderSubscriptionsCard()}</div>
        <div className="overview-layout-card overview-layout-card--keys">{renderApiKeysCard()}</div>
      </section>
    </>
  );
}

function withOverviewApiKeyAccountLabel(
  key: ApiKeyListRecord,
  mode: OverviewUsageStatsMode,
  currentAccount: AccountRuntime | null | undefined,
  accountDisplayLabelById: ReadonlyMap<string, string | null>
): ApiKeyListRecord {
  const existingLabel = key.accountLabel?.trim();
  if (existingLabel) {
    return key;
  }

  const accountId = readApiKeyAccountId(key);
  const accountLabel = mode === "selected-account"
    ? resolveOverviewAccountDisplayLabel(currentAccount)
    : accountId
      ? accountDisplayLabelById.get(accountId) ?? null
      : null;

  return accountLabel ? { ...key, accountLabel } : key;
}

// 账号备注可为空，展示时回退到脱敏邮箱，避免把已关联账号误报为未关联。
function resolveOverviewAccountDisplayLabel(account: AccountRuntime | null | undefined) {
  if (!account) {
    return null;
  }

  return account.label.trim() || maskEmail(account.email.trim()) || null;
}

function formatOverviewUsageInsightAxisValue(value: number | string) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "-";
  }

  const absoluteValue = Math.abs(numericValue);
  if (absoluteValue >= 1_000_000_000) {
    return `${(numericValue / 1_000_000_000).toFixed(absoluteValue >= 10_000_000_000 ? 0 : 1)}B`;
  }
  if (absoluteValue >= 1_000_000) {
    return `${(numericValue / 1_000_000).toFixed(absoluteValue >= 10_000_000 ? 0 : 1)}M`;
  }
  if (absoluteValue >= 1_000) {
    return `${(numericValue / 1_000).toFixed(absoluteValue >= 10_000 ? 0 : 1)}K`;
  }
  return Number.isInteger(numericValue) ? String(numericValue) : numericValue.toFixed(2);
}

function buildOverviewUsageInsightDonutOption(
  rows: OverviewUsageInsightRow[],
  metric: UsageInsightMetric,
  rankKind: OverviewUsageInsightRankKind = "model"
): ChartOption | null {
  if (rows.length === 0) {
    return null;
  }

  const metricLabel = metric === "tokens" ? "Token" : "实际消费";
  const rankLayout = rankKind === "endpoint"
    ? { top: 16, left: 166, labelWidth: 148, labelFontSize: 10, barMaxWidth: 18 }
    : rankKind === "group"
      ? { top: 16, left: 142, labelWidth: 124, labelFontSize: 11, barMaxWidth: 18 }
      : { top: 10, left: 112, labelWidth: 96, labelFontSize: 12, barMaxWidth: 22 };

  return {
    backgroundColor: "transparent",
    color: ["#5e8cff"],
    tooltip: {
      trigger: "axis",
      confine: true,
      axisPointer: { type: "shadow" },
      formatter: (params: unknown) => {
        const payload = Array.isArray(params) ? params[0] : params;
        const index = Number((payload as { dataIndex?: unknown } | null)?.dataIndex ?? -1);
        const item = Number.isInteger(index) ? rows[index] : null;
        if (!item) {
          return "";
        }
        const metricValue =
          metric === "tokens" ? compact(item.totalTokens) : `$${item.actualCost.toFixed(4)}`;
        return [
          item.name,
          `排序 ${metricLabel} ${metricValue}`,
          `请求 ${item.requests.toLocaleString()}`,
          `Token ${compact(item.totalTokens)}`,
          `实际 $${item.actualCost.toFixed(4)}`,
          `标准 $${item.totalCost.toFixed(4)}`
        ].join("<br/>");
      }
    },
    grid: {
      top: rankLayout.top,
      left: rankLayout.left,
      right: 14,
      bottom: 30
    },
    xAxis: {
      type: "value",
      splitNumber: 3,
      axisLabel: {
        color: "#94a3b8",
        fontSize: 10,
        margin: 10,
        hideOverlap: true,
        formatter: formatOverviewUsageInsightAxisValue
      },
      axisLine: { lineStyle: { color: "rgba(148, 163, 184, 0.24)" } },
      splitLine: { lineStyle: { color: "rgba(148, 163, 184, 0.14)" } }
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: rows.map((item) => item.name),
      axisLabel: {
        color: "#94a3b8",
        width: rankLayout.labelWidth,
        overflow: "truncate",
        fontSize: rankLayout.labelFontSize,
        lineHeight: 16,
        margin: 12
      },
      axisTick: { show: false },
      axisLine: { show: false }
    },
    series: [
      {
        name: metricLabel,
        type: "bar",
        barMaxWidth: rankLayout.barMaxWidth,
        itemStyle: { borderRadius: [0, 5, 5, 0] },
        data: rows.map((item) => (metric === "tokens" ? item.totalTokens : item.actualCost))
      }
    ]
  };
}

function buildOverviewUsageInsightRows(
  rows: Array<Pick<UsageRow, "actualCost" | "totalCost" | "totalTokens" | "groupName" | "endpoint" | "upstreamEndpoint">>,
  resolveName: (row: Pick<UsageRow, "groupName" | "endpoint" | "upstreamEndpoint">) => string
) {
  const aggregates = new Map<string, OverviewUsageInsightRow>();
  for (const row of rows) {
    const name = resolveName(row);
    const current = aggregates.get(name);
    if (current) {
      current.requests += 1;
      current.totalTokens += row.totalTokens ?? 0;
      current.actualCost += row.actualCost ?? 0;
      current.totalCost += row.totalCost ?? 0;
      continue;
    }
    aggregates.set(name, {
      name,
      requests: 1,
      totalTokens: row.totalTokens ?? 0,
      actualCost: row.actualCost ?? 0,
      totalCost: row.totalCost ?? 0
    });
  }
  return [...aggregates.values()];
}

function sortOverviewUsageInsightRows(rows: OverviewUsageInsightRow[], metric: UsageInsightMetric) {
  return rows.slice().sort((left, right) => {
    const metricDiff =
      metric === "tokens"
        ? right.totalTokens - left.totalTokens
        : right.actualCost - left.actualCost;
    if (metricDiff !== 0) {
      return metricDiff;
    }
    if (right.requests !== left.requests) {
      return right.requests - left.requests;
    }
    return left.name.localeCompare(right.name, "zh-CN");
  });
}

function normalizeOverviewUsageInsightLabel(value: string | null | undefined, fallback: string) {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

function readApiKeyAccountId(key: ApiKeyListRecord) {
  const value = (key as ApiKeyListRecord & { accountId?: unknown }).accountId;
  return typeof value === "string" && value.trim() ? value : null;
}

function resolveOverviewSubscriptionPlatforms(
  subscriptions: SubscriptionRecord[],
  keys: KeyRecord[]
) {
  if (subscriptions.length === 0 || keys.length === 0) {
    return subscriptions;
  }

  const accountFallbackPlatform = resolveSinglePlatform(
    keys.map((key) => normalizePlatformValue(key.platform))
  );
  const platformByGroupId = new Map<number, string | null>();
  const platformByGroupName = new Map<string, string | null>();

  for (const key of keys) {
    const normalizedPlatform = normalizePlatformValue(key.platform);
    if (!normalizedPlatform) {
      continue;
    }
    if (typeof key.groupId === "number" && key.groupId > 0) {
      recordUniquePlatform(platformByGroupId, key.groupId, normalizedPlatform);
    }
    const normalizedGroupName = normalizeOverviewPlatformLookupKey(key.groupName);
    if (normalizedGroupName) {
      recordUniquePlatform(platformByGroupName, normalizedGroupName, normalizedPlatform);
    }
  }

  return subscriptions.map((subscription) => {
    if (normalizePlatformValue(subscription.platform)) {
      return subscription;
    }

    const groupIdPlatform =
      typeof subscription.groupId === "number" && subscription.groupId > 0
        ? platformByGroupId.get(subscription.groupId)
        : undefined;
    const normalizedSubscriptionGroupName = normalizeOverviewPlatformLookupKey(
      subscription.groupName ?? subscription.name
    );
    const groupNamePlatform = normalizedSubscriptionGroupName
      ? platformByGroupName.get(normalizedSubscriptionGroupName)
      : undefined;
    const resolvedPlatform = groupIdPlatform ?? groupNamePlatform ?? accountFallbackPlatform;

    if (!resolvedPlatform) {
      return subscription;
    }

    return {
      ...subscription,
      platform: resolvedPlatform
    };
  });
}

function recordUniquePlatform<TKey>(
  target: Map<TKey, string | null>,
  key: TKey,
  platform: string
) {
  const current = target.get(key);
  if (current === undefined) {
    target.set(key, platform);
    return;
  }
  if (current !== platform) {
    target.set(key, null);
  }
}

function resolveSinglePlatform(platforms: Array<string | null>) {
  const distinct = Array.from(new Set(platforms.filter((value): value is string => Boolean(value))));
  return distinct.length === 1 ? distinct[0] : null;
}

function normalizeOverviewPlatformLookupKey(value?: string | null) {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

function normalizePlatformValue(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function formatOverviewPlatformLabel(value?: string | null) {
  const normalized = normalizePlatformValue(value);
  if (!normalized) {
    return "未知平台";
  }
  return `${normalized.slice(0, 1).toLocaleUpperCase("en-US")}${normalized.slice(1)}`;
}

function toOverviewPlatformTone(value?: string | null) {
  return (normalizePlatformValue(value) ?? "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function formatOverviewAccountSource(account: AccountRuntime) {
  return `${account.site?.name ?? account.cacheView?.siteName ?? "未命名站点"} / ${account.label}`;
}

function buildOverviewBalanceHint(
  overview: OverviewPayload,
  currentAccount: AccountRuntime | null | undefined,
  currentAccountBalance: number | null | undefined,
  mode: OverviewUsageStatsMode
) {
  if (mode === "selected-account") {
    if (!currentAccount || currentAccountBalance === null || currentAccountBalance === undefined) {
      return "当前账号没有余额快照";
    }
    return `${currentAccount.label} $${currentAccountBalance.toFixed(2)}`;
  }

  const richestAccount = overview.accounts
    .filter((account) => account.cacheView)
    .sort((left, right) => {
      const balanceDiff = (right.cacheView?.balance ?? Number.NEGATIVE_INFINITY) - (left.cacheView?.balance ?? Number.NEGATIVE_INFINITY);
      if (balanceDiff !== 0) {
        return balanceDiff;
      }
      return left.label.localeCompare(right.label, "zh-CN");
    })[0];

  if (!richestAccount?.cacheView) {
    return "当前没有可展示的账号余额";
  }

  return `${richestAccount.label} $${richestAccount.cacheView.balance.toFixed(2)}`;
}

function buildOverviewTodayTokenHint(overview: OverviewPayload) {
  const tokenSplit = overview.accounts.reduce(
    (result, account) => {
      if (!account.cacheView) {
        return result;
      }
      result.input += account.cacheView.stats.todayInputTokens;
      result.output += account.cacheView.stats.todayOutputTokens;
      return result;
    },
    { input: 0, output: 0 }
  );

  if (tokenSplit.input <= 0 && tokenSplit.output <= 0) {
    return `总计 ${compact(overview.totals.totalTokens)}`;
  }

  return `输入 ${compact(tokenSplit.input)} / 输出 ${compact(tokenSplit.output)}`;
}

function buildOverviewRequestsHint(
  usageStats: UsageStatsRecord | null,
  mode: OverviewUsageStatsMode
) {
  if (!usageStats) {
    return mode === "selected-account" ? "当前账号还没有可展示的数据" : "当前还没有可展示的数据";
  }
  return mode === "selected-account" ? "当前账号最新数据" : "全部账号汇总数据";
}

function buildOverviewActualCostHint(
  usageStats: UsageStatsRecord | null,
  mode: OverviewUsageStatsMode
) {
  if (!usageStats) {
    return mode === "selected-account" ? "当前账号还没有可展示的数据" : "当前还没有可展示的数据";
  }
  return `总 Tokens ${compact(usageStats.totalTokens)}`;
}

function buildOverviewTodayTokensHint(
  usageStats: UsageStatsRecord | null,
  mode: OverviewUsageStatsMode,
  fallbackHint: string
) {
  if (!usageStats) {
    return fallbackHint;
  }
  return `输入 ${compact(usageStats.totalInputTokens)} / 输出 ${compact(usageStats.totalOutputTokens)}`;
}

function formatOverviewPerformanceNumber(value?: number | null, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) {
    return "-";
  }
  return digits > 0 ? Number(value).toFixed(digits) : Math.round(value).toLocaleString();
}

function buildOverviewAverageResponseValue(usageStats: UsageStatsRecord | null) {
  return formatDurationSeconds(usageStats?.averageDurationMs, 2);
}

function buildOverviewAverageResponseHint(usageStats: UsageStatsRecord | null) {
  if (!usageStats || usageStats.totalRequests <= 0) {
    return "当前没有响应样本";
  }
  return `基于 ${usageStats.totalRequests.toLocaleString()} 次请求`;
}

function buildOverviewAverageResponseModeHint(
  hint: string,
  mode: OverviewUsageStatsMode
) {
  if (hint === "当前没有响应样本") {
    return mode === "selected-account" ? "当前账号没有响应样本" : "全部账号没有响应样本";
  }
  return hint;
}

function buildOverviewStatsPerformanceValue(usageStats: UsageStatsRecord | null) {
  if (usageStats?.rpm === null || usageStats?.rpm === undefined || !Number.isFinite(usageStats.rpm) || usageStats.rpm < 0) {
    return "- RPM";
  }
  return `${formatOverviewPerformanceNumber(usageStats.rpm)} RPM`;
}

function buildOverviewStatsPerformanceHint(
  usageStats: UsageStatsRecord | null,
  mode: OverviewUsageStatsMode
) {
  if (usageStats?.tpm === null || usageStats?.tpm === undefined || !Number.isFinite(usageStats.tpm) || usageStats.tpm < 0) {
    return mode === "selected-account" ? "当前账号还没有速度数据" : "当前还没有速度数据";
  }
  return `${compact(usageStats.tpm)} TPM`;
}

function renderOverviewUsageStatsPerformanceDetails(
  usageStats: UsageStatsRecord | null,
  usageStatsRows: OverviewUsageStatsRow[],
  mode: OverviewUsageStatsMode
) {
  return (
    <>
      <DetailItem
        label="RPM"
        value={usageStats ? formatOverviewPerformanceNumber(usageStats.rpm) : "-"}
      />
      <DetailItem
        label="TPM"
        value={usageStats?.tpm === null || usageStats?.tpm === undefined ? "-" : compact(usageStats.tpm)}
      />
      <DetailItem
        label="今日请求"
        value={usageStats ? usageStats.totalRequests.toLocaleString() : "-"}
      />
      <DetailItem
        label="今日总 Tokens"
        value={usageStats ? compact(usageStats.totalTokens) : "-"}
      />
      {usageStatsRows.length > 0 && (
        <DetailItem
          label={mode === "selected-account" ? "查看范围" : "覆盖账号"}
          value={mode === "selected-account" ? "当前账号" : `${usageStatsRows.length} 个账号`}
        />
      )}
    </>
  );
}

function renderOverviewAverageResponseDetails(
  usageStats: UsageStatsRecord | null,
  usageStatsRows: OverviewUsageStatsRow[],
  mode: OverviewUsageStatsMode
) {
  return (
    <>
      <DetailItem
        label="平均耗时"
        value={formatDurationSeconds(usageStats?.averageDurationMs, 2)}
      />
      <DetailItem
        label="今日请求"
        value={usageStats ? usageStats.totalRequests.toLocaleString() : "-"}
      />
      <DetailItem
        label="今日输入"
        value={usageStats ? compact(usageStats.totalInputTokens) : "-"}
      />
      <DetailItem
        label="今日输出"
        value={usageStats ? compact(usageStats.totalOutputTokens) : "-"}
      />
      <DetailItem
        label="今日总 Tokens"
        value={usageStats ? compact(usageStats.totalTokens) : "-"}
      />
      {usageStatsRows.length > 0 && (
        <DetailItem
          label={mode === "selected-account" ? "查看范围" : "覆盖账号"}
          value={mode === "selected-account" ? "当前账号" : `${usageStatsRows.length} 个账号`}
        />
      )}
    </>
  );
}

function renderOverviewUsageStatsRows(
  rows: OverviewUsageStatsRow[],
  mode: OverviewUsageStatsMode,
  value: (row: OverviewUsageStatsRow) => string,
  description: (row: OverviewUsageStatsRow) => string
) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title={mode === "selected-account" ? "当前账号还没有统计数据" : "当前还没有统计数据"}
        detail="刷新数据后, 这里会按账号展示统计结果。"
        compact
      />
    );
  }

  return (
    <>
      {rows.map((row) => (
        <UsageMetricDetailItem
          key={`usage-stats-${row.accountId}`}
          label={row.label}
          value={value(row)}
          description={`${row.siteName} / ${row.label} · ${description(row)}`}
        />
      ))}
    </>
  );
}

function renderScopedOverviewMetricDetails(
  overview: OverviewPayload,
  currentAccount: AccountRuntime | null | undefined,
  kind: OverviewMetricDetailKind,
  mode: OverviewUsageStatsMode
) {
  const sourceAccounts =
    mode === "selected-account" && currentAccount
      ? [currentAccount]
      : overview.accounts;
  const rows = buildOverviewMetricDetails({
    ...overview,
    accounts: sourceAccounts
  }, kind);

  return (
    <>
      {rows.map((row) => (
        <UsageMetricDetailItem
          key={`${kind}-${row.accountId}`}
          label={row.label}
          value={row.value}
          description={row.description}
        />
      ))}
    </>
  );
}

function buildOverviewMetricDetails(overview: OverviewPayload, kind: OverviewMetricDetailKind) {
  return overview.accounts
    .map((account) => {
      const source = formatOverviewAccountSource(account);
      const cacheView = account.cacheView;
      const unavailableLabel = account.lastError ? "同步失败" : account.sessionState === "expired" ? "会话失效" : "未登录";

      if (!cacheView) {
        return {
          accountId: account.id,
          label: account.label,
          value: unavailableLabel,
          description: `${source} · 当前没有可展示的数据`
        };
      }

      switch (kind) {
        case "balance":
          return {
            accountId: account.id,
            label: account.label,
            value: `$${cacheView.balance.toFixed(2)}`,
            description: `${source} · 更新时间 ${formatTime(cacheView.fetchedAt)}`
          };
        case "todayRequests":
          return {
            accountId: account.id,
            label: account.label,
            value: cacheView.stats.todayRequests.toLocaleString(),
            description: `${source} · 累计 ${cacheView.stats.totalRequests.toLocaleString()} 请求`
          };
        case "todayActualCost":
          return {
            accountId: account.id,
            label: account.label,
            value: `$${cacheView.stats.todayActualCost.toFixed(4)}`,
            description: `${source} · 累计 $${cacheView.stats.totalActualCost.toFixed(4)}`
          };
        case "apiKeys":
          return {
            accountId: account.id,
            label: account.label,
            value: String(cacheView.stats.totalApiKeys),
            description: `${source} · ${cacheView.stats.activeApiKeys} 启用`
          };
        case "todayTokens":
          return {
            accountId: account.id,
            label: account.label,
            value: compact(cacheView.stats.todayTokens),
            description: `${source} · 输入 ${compact(cacheView.stats.todayInputTokens)} / 输出 ${compact(cacheView.stats.todayOutputTokens)}`
          };
        case "totalTokens":
          return {
            accountId: account.id,
            label: account.label,
            value: compact(cacheView.stats.totalTokens),
            description: `${source} · 累计 ${cacheView.stats.totalRequests.toLocaleString()} 请求`
          };
      }
    })
    .sort((left, right) => {
      const leftNumeric = Number(left.value.replace(/[^\d.-]/g, ""));
      const rightNumeric = Number(right.value.replace(/[^\d.-]/g, ""));
      if (Number.isFinite(leftNumeric) && Number.isFinite(rightNumeric) && rightNumeric !== leftNumeric) {
        return rightNumeric - leftNumeric;
      }
      return left.label.localeCompare(right.label, "zh-CN");
    });
}
