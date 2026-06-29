import {
  BadgeDollarSign,
  ChartColumn,
  KeyRound,
  LayoutDashboard,
  MonitorDot,
  TimerReset
} from "lucide-react";

import type {
  AccountRuntime,
  KeyRecord,
  OverviewPayload,
  SubscriptionRecord,
  SubscriptionSummaryPayload,
  UsageRow,
  UsageStatsRecord
} from "../types";
import { compact, formatDurationSeconds, formatTime } from "../shared/lib/formatters";
import { EmptyState } from "../shared/ui/EmptyState";
import { DetailItem, UsageMetricDetailItem } from "../shared/ui/DetailItem";
import { MetricCard } from "../shared/ui/MetricCard";
import { SectionCard } from "../shared/ui/SectionCard";
import { ApiKeyList } from "../features/keys/components/ApiKeyList";
import { SubscriptionList } from "../features/subscriptions/components/SubscriptionList";
import { UsageTrendSection } from "../features/usage/components/UsageTrendSection";
import { mergeSubscriptionRecords } from "../subscription-view";

type OverviewMetricDetailKind =
  | "balance"
  | "todayRequests"
  | "todayActualCost"
  | "activeApiKeys"
  | "todayTokens";

export function OverviewPage({
  overview,
  currentAccountStats,
  currentAccountSubscriptions,
  subscriptionSummary,
  currentAccountKeys,
  currentAccountRecentUsage,
  usageStats
}: {
  overview: OverviewPayload;
  currentAccountStats: NonNullable<AccountRuntime["cacheView"]>["stats"] | null;
  currentAccountSubscriptions: SubscriptionRecord[];
  subscriptionSummary: SubscriptionSummaryPayload | null;
  currentAccountKeys: KeyRecord[];
  currentAccountRecentUsage: UsageRow[];
  usageStats: UsageStatsRecord | null;
}) {
  const effectiveUsageStats = usageStats ?? buildOverviewUsageStatsFromStats(currentAccountStats);
  const mergedCurrentAccountSubscriptions = mergeSubscriptionRecords(
    currentAccountSubscriptions,
    subscriptionSummary
  );
  const balanceHint = buildOverviewBalanceHint(overview);
  const performanceValue = buildOverviewPerformanceValue(effectiveUsageStats);
  const performanceHint = buildOverviewPerformanceHint(effectiveUsageStats);
  const platformCards = overview.platformSeries
    .slice()
    .sort((left, right) => {
      const costDiff = right.totalActualCost - left.totalActualCost;
      if (costDiff !== 0) {
        return costDiff;
      }
      return left.platform.localeCompare(right.platform, "zh-CN");
    });

  function renderPlatformDistributionCard() {
    return (
      <SectionCard title="平台分布" subtitle="按平台汇总实际成本与 tokens">
        {platformCards.length > 0 ? (
          <div className="platform-distribution-grid motion-stagger-grid">
            {platformCards.map((item, index) => (
              <article
                key={item.platform}
                className="platform-distribution-card motion-stagger-item"
                style={{ ["--motion-order" as string]: index }}
              >
                <div className="platform-distribution-head">
                  <div className="platform-distribution-copy">
                    <span className="platform-distribution-rank">TOP {index + 1}</span>
                    <strong>{item.platform}</strong>
                    <p>{item.totalRequests.toLocaleString()} 请求</p>
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
            ))}
          </div>
        ) : (
          <EmptyState title="当前没有平台汇总数据" detail="刷新账号后, 这里会按平台展示成本与 tokens 摘要。" compact />
        )}
      </SectionCard>
    );
  }

  function renderSubscriptionsCard() {
    return (
      <SectionCard title="全部订阅" subtitle="当前账号返回的全部套餐与额度窗口">
        {mergedCurrentAccountSubscriptions.length > 0 ? (
          <SubscriptionList subscriptions={mergedCurrentAccountSubscriptions} />
        ) : (
          <EmptyState title="当前没有订阅数据" detail="该账号未返回有效订阅或套餐信息。" compact />
        )}
      </SectionCard>
    );
  }

  function renderApiKeysCard() {
    return (
      <SectionCard title="全部 API Keys" subtitle="状态、最近使用、额度与限流摘要">
        {currentAccountKeys.length > 0 ? (
          <ApiKeyList keys={currentAccountKeys} />
        ) : (
          <EmptyState title="还没有 Key 数据" detail="登录并刷新后这里会展示 key 列表。" compact />
        )}
      </SectionCard>
    );
  }

  function renderRecentUsageCard() {
    return (
      <SectionCard title="最近使用" subtitle="当前选中账号的近期调用">
        <div className="table-list">
          {currentAccountRecentUsage.slice(0, 8).map((row, index) => (
            <div
              key={row.id}
              className="table-row table-row-motion"
              style={{ ["--motion-order" as string]: index }}
            >
              <div className="recent-usage-copy">
                <strong>{row.model}</strong>
                <div className="recent-usage-meta">
                  <span className="recent-usage-pill">{row.apiKeyName ?? "未知 Key"}</span>
                  <span className="recent-usage-pill recent-usage-pill-endpoint">{row.endpoint ?? "-"}</span>
                </div>
              </div>
              <div className="table-numbers recent-usage-numbers">
                <strong>${row.actualCost.toFixed(5)}</strong>
                <span>{compact(row.totalTokens)} tokens</span>
                <small>时间 {formatTime(row.createdAt)}</small>
              </div>
            </div>
          ))}
          {currentAccountRecentUsage.length === 0 && (
            <EmptyState title="还没有账号数据" detail="先登录账号并刷新数据。" compact />
          )}
        </div>
      </SectionCard>
    );
  }

  return (
    <>
      <section className="metric-grid motion-stagger-grid overview-metric-grid">
        <MetricCard
          label="总余额"
          value={`$${overview.totals.balance.toFixed(2)}`}
          accent="emerald"
          icon={<BadgeDollarSign size={18} />}
          hint={balanceHint}
          detailTitle="各账号余额"
          detail={renderOverviewMetricDetails(overview, "balance")}
          className="motion-stagger-item"
          animationKey={`overview-balance:${overview.totals.balance}`}
          style={{ ["--motion-order" as string]: 0 }}
        />
        <MetricCard
          label="今日请求"
          value={overview.totals.todayRequests.toLocaleString()}
          accent="sky"
          icon={<LayoutDashboard size={18} />}
          hint={`累计 ${overview.totals.totalRequests.toLocaleString()}`}
          detailTitle="各账号今日请求"
          detail={renderOverviewMetricDetails(overview, "todayRequests")}
          className="motion-stagger-item"
          animationKey={`overview-requests:${overview.totals.todayRequests}`}
          style={{ ["--motion-order" as string]: 1 }}
        />
        <MetricCard
          label="今日实际成本"
          value={`$${overview.totals.todayActualCost.toFixed(4)}`}
          accent="violet"
          icon={<ChartColumn size={18} />}
          hint={`累计 $${overview.totals.totalActualCost.toFixed(4)}`}
          detailTitle="各账号今日实际成本"
          detail={renderOverviewMetricDetails(overview, "todayActualCost")}
          detailPanelAlign="end"
          className="motion-stagger-item"
          animationKey={`overview-actual-cost:${overview.totals.todayActualCost}`}
          style={{ ["--motion-order" as string]: 2 }}
        />
        <MetricCard
          label="活跃 Keys"
          value={`${overview.totals.activeApiKeys}`}
          accent="amber"
          icon={<KeyRound size={18} />}
          hint={`总数 ${overview.totals.totalApiKeys}`}
          detailTitle="各账号 Key 状态"
          detail={renderOverviewMetricDetails(overview, "activeApiKeys")}
          className="motion-stagger-item"
          animationKey={`overview-active-keys:${overview.totals.activeApiKeys}`}
          style={{ ["--motion-order" as string]: 3 }}
        />
        <MetricCard
          label="今日 Tokens"
          value={compact(overview.totals.todayTokens)}
          accent="indigo"
          icon={<MonitorDot size={18} />}
          hint={`累计 ${compact(overview.totals.totalTokens)}`}
          detailTitle="各账号今日 Tokens"
          detail={renderOverviewMetricDetails(overview, "todayTokens")}
          className="motion-stagger-item"
          animationKey={`overview-tokens:${overview.totals.todayTokens}`}
          style={{ ["--motion-order" as string]: 4 }}
        />
        <MetricCard
          label="性能指标"
          value={performanceValue}
          accent="sky"
          icon={<TimerReset size={18} />}
          hint={performanceHint}
          detailTitle="当前账号性能指标"
          detail={renderOverviewPerformanceDetails(effectiveUsageStats)}
          detailPanelAlign="end"
          className="motion-stagger-item"
          animationKey={`overview-performance:${performanceValue}`}
          style={{ ["--motion-order" as string]: 5 }}
        />
      </section>

      <section className="overview-layout overview-layout-desktop">
        <div className="overview-column">
          <div className="overview-layout-card overview-layout-card--trend">
            <UsageTrendSection
              title="近 7 天趋势"
              subtitle="对齐 dashboard/trend 接口, 聚合全部账号的成本、请求与缓存表现"
              points={overview.trend}
              emptyTitle="当前没有总览趋势数据"
              emptyDetail="至少刷新一个账号后, 这里才会出现全部账号的聚合趋势。"
            />
          </div>
          <div className="overview-layout-card overview-layout-card--subscriptions">{renderSubscriptionsCard()}</div>
          <div className="overview-layout-card overview-layout-card--recent">{renderRecentUsageCard()}</div>
        </div>
        <div className="overview-column">
          <div className="overview-layout-card overview-layout-card--platforms">{renderPlatformDistributionCard()}</div>
          <div className="overview-layout-card overview-layout-card--keys">{renderApiKeysCard()}</div>
        </div>
      </section>

      <section className="overview-layout-mobile">
        <div className="overview-layout-card overview-layout-card--trend">
          <UsageTrendSection
            title="近 7 天趋势"
            subtitle="对齐 dashboard/trend 接口, 聚合全部账号的成本、请求与缓存表现"
            points={overview.trend}
            emptyTitle="当前没有总览趋势数据"
            emptyDetail="至少刷新一个账号后, 这里才会出现全部账号的聚合趋势。"
          />
        </div>
        <div className="overview-layout-card overview-layout-card--platforms">{renderPlatformDistributionCard()}</div>
        <div className="overview-layout-card overview-layout-card--subscriptions">{renderSubscriptionsCard()}</div>
        <div className="overview-layout-card overview-layout-card--keys">{renderApiKeysCard()}</div>
        <div className="overview-layout-card overview-layout-card--recent">{renderRecentUsageCard()}</div>
      </section>
    </>
  );
}

function formatOverviewAccountSource(account: AccountRuntime) {
  return `${account.site?.name ?? account.cacheView?.siteName ?? "未命名站点"} / ${account.label}`;
}

function buildOverviewBalanceHint(overview: OverviewPayload) {
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

function formatOverviewPerformanceNumber(value?: number | null, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) {
    return "-";
  }
  return digits > 0 ? Number(value).toFixed(digits) : Math.round(value).toLocaleString();
}

function buildOverviewPerformanceValue(usageStats: UsageStatsRecord | null) {
  if (usageStats?.rpm === null || usageStats?.rpm === undefined || !Number.isFinite(usageStats.rpm) || usageStats.rpm < 0) {
    return "- RPM";
  }
  return `${formatOverviewPerformanceNumber(usageStats.rpm)} RPM`;
}

function buildOverviewPerformanceHint(usageStats: UsageStatsRecord | null) {
  if (usageStats?.tpm === null || usageStats?.tpm === undefined || !Number.isFinite(usageStats.tpm) || usageStats.tpm < 0) {
    return "TPM -";
  }
  return `${compact(usageStats.tpm)} TPM`;
}

function renderOverviewPerformanceDetails(usageStats: UsageStatsRecord | null) {
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
        label="平均耗时"
        value={usageStats ? formatDurationSeconds(usageStats.averageDurationMs) : "-"}
      />
      <DetailItem
        label="今日请求"
        value={usageStats ? usageStats.totalRequests.toLocaleString() : "-"}
      />
      <DetailItem
        label="今日总 Tokens"
        value={usageStats ? compact(usageStats.totalTokens) : "-"}
      />
    </>
  );
}

function buildOverviewUsageStatsFromStats(
  stats: NonNullable<AccountRuntime["cacheView"]>["stats"] | null
): UsageStatsRecord | null {
  if (!stats) {
    return null;
  }

  const windowMinutes = Math.max(inferOverviewTodayWindowMinutes(), 1);
  const totalRequests = stats.todayRequests;
  const totalTokens = stats.todayTokens;

  return {
    totalRequests,
    totalInputTokens: stats.todayInputTokens,
    totalOutputTokens: stats.todayOutputTokens,
    totalCacheTokens: null,
    totalCacheCreationTokens: null,
    totalCacheReadTokens: null,
    totalTokens,
    totalCost: stats.todayCost,
    totalActualCost: stats.todayActualCost,
    averageDurationMs: stats.averageDurationMs,
    rpm: totalRequests / windowMinutes,
    tpm: totalTokens / windowMinutes
  };
}

function inferOverviewTodayWindowMinutes(now: Date = new Date()) {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  return Math.max((now.getTime() - startOfDay.getTime()) / 60000, 1);
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
          description: `${source} · 当前没有可展示的聚合数据`
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
        case "activeApiKeys":
          return {
            accountId: account.id,
            label: account.label,
            value: String(cacheView.stats.activeApiKeys),
            description: `${source} · 总数 ${cacheView.stats.totalApiKeys}`
          };
        case "todayTokens":
          return {
            accountId: account.id,
            label: account.label,
            value: compact(cacheView.stats.todayTokens),
            description: `${source} · 累计 ${compact(cacheView.stats.totalTokens)} tokens`
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

function renderOverviewMetricDetails(overview: OverviewPayload, kind: OverviewMetricDetailKind) {
  const rows = buildOverviewMetricDetails(overview, kind);
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
