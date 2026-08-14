import { useState, type KeyboardEvent, type ReactNode } from "react";
import "../../charts-runtime-lab";
import {
  EChartCard as BaseEChartCard,
  readChartPalette,
  type ChartOption,
  type ChartPalette
} from "../../charts";
import type {
  AccountRuntime,
  DailyUsagePoint,
  KeyRecord,
  ManagedKeyRecord,
  OverviewPayload,
  PaginatedResult,
  PlatformQuotaPayload,
  SubscriptionRecord,
  SubscriptionSummaryPayload,
  UsageAnalyticsAggregatePoint,
  UsageAnalyticsLatencyPercentiles,
  UsageAnalyticsPayload,
  UsageRow,
  UsageTrendPayload,
  UserIdentityBinding,
  UserProfileRecord,
  DashboardModelsPayload
} from "../../types";
import { TitleHint } from "../../shared/ui/TitleHint";

interface AnalyticsLabProps {
  overview: OverviewPayload | null;
  selectedAccount: AccountRuntime | null;
  loading?: boolean;
  managedKeys: PaginatedResult<ManagedKeyRecord> | null;
  usageAnalytics: UsageAnalyticsPayload | null;
  subscriptionSummary: SubscriptionSummaryPayload | null;
  profileRecord: UserProfileRecord | null;
  platformQuotas: PlatformQuotaPayload | null;
  keyUsageRows: DailyUsagePoint[];
  keyUsageKeyId: string;
  usageApiKeyFilter: string;
  usageStartDate: string;
  usageEndDate: string;
  onUsageApiKeyFilterChange: (value: string) => void;
  onUsageStartDateChange: (value: string) => void;
  onUsageEndDateChange: (value: string) => void;
  onUsageSearch: () => void;
  onKeyUsageSelect: (keyId: string) => void;
}

const ANALYTICS_VIEWS = [
  { id: "overview", label: "核心概览", chartCount: 4 },
  { id: "cost-models", label: "成本与模型", chartCount: 7 },
  { id: "performance-requests", label: "性能与请求", chartCount: 11 },
  { id: "accounts-assets", label: "账号与资产", chartCount: 10 }
] as const;

type AnalyticsViewId = (typeof ANALYTICS_VIEWS)[number]["id"];

function resolveAnalyticsViewFromKey(currentView: AnalyticsViewId, key: string): AnalyticsViewId | null {
  const currentIndex = ANALYTICS_VIEWS.findIndex((view) => view.id === currentView);
  if (currentIndex < 0) {
    return null;
  }
  if (key === "Home") {
    return ANALYTICS_VIEWS[0].id;
  }
  if (key === "End") {
    return ANALYTICS_VIEWS[ANALYTICS_VIEWS.length - 1].id;
  }
  if (key === "ArrowLeft") {
    return ANALYTICS_VIEWS[(currentIndex - 1 + ANALYTICS_VIEWS.length) % ANALYTICS_VIEWS.length].id;
  }
  if (key === "ArrowRight") {
    return ANALYTICS_VIEWS[(currentIndex + 1) % ANALYTICS_VIEWS.length].id;
  }
  return null;
}

export function AnalyticsLab(props: AnalyticsLabProps) {
  const [activeView, setActiveView] = useState<AnalyticsViewId>("overview");
  const {
    overview,
    selectedAccount,
    loading = false,
    managedKeys,
    usageAnalytics,
    subscriptionSummary,
    profileRecord,
    platformQuotas,
    keyUsageRows,
    keyUsageKeyId,
    usageApiKeyFilter,
    usageStartDate,
    usageEndDate,
    onUsageApiKeyFilterChange,
    onUsageStartDateChange,
    onUsageEndDateChange,
    onUsageSearch,
    onKeyUsageSelect
  } = props;

  const palette = readChartPalette();
  const selectedAccountCache = selectedAccount?.cacheView ?? null;
  const keys = managedKeys?.items?.length ? managedKeys.items : coerceManagedKeys(selectedAccountCache?.keys ?? []);
  const sampleRows = usageAnalytics?.sampleRows ?? [];
  const aggregateReady = Boolean(usageAnalytics);
  const sampleReady = Boolean(usageAnalytics);
  const effectiveUsageStats = usageAnalytics?.totals ?? null;
  const selectedKey = keys.find((item) => item.id === keyUsageKeyId) ?? null;
  const platformSeries = selectedAccountCache?.stats.byPlatform ?? overview?.platformSeries ?? [];
  const scopedTrend = usageAnalytics ? buildAnalyticsTrendPayload(usageAnalytics) : null;
  const scopedModels = usageAnalytics ? buildAnalyticsModelsPayload(usageAnalytics) : null;
  const scopedPlatformSeries = (usageAnalytics?.platforms ?? []).map((row) => ({
    platform: row.label,
    totalActualCost: row.actualCost,
    totalRequests: row.requests,
    totalTokens: row.totalTokens
  }));
  const endpointUsageRows = mapAnalyticsAggregateRows(usageAnalytics?.endpoints ?? []);
  const modelUsageRows = mapAnalyticsAggregateRows(usageAnalytics?.models ?? []);
  const keyUsageAggregates = mapAnalyticsAggregateRows(usageAnalytics?.apiKeys ?? []);
  const groupUsageAggregates = mapAnalyticsAggregateRows(usageAnalytics?.groups ?? []);
  const subscriptionUsageAggregates = mapAnalyticsAggregateRows(usageAnalytics?.subscriptions ?? []);
  const comboRows = mapAnalyticsDimensionRows(usageAnalytics?.reasoningRequestCombinations ?? []);
  const heatmapRows = usageAnalytics?.hourlyHeatmap ?? [];
  const upstreamFlowRows = usageAnalytics?.endpointFlows ?? [];
  const modelLatencyRows = buildLatencyRows(modelUsageRows);
  const endpointLatencyRows = buildLatencyRows(endpointUsageRows);
  const cacheEfficiencyRows = buildCacheEfficiencyRows(modelUsageRows);
  const efficiencyRows = buildEfficiencyRows(modelUsageRows);
  const costBreakdownRows = (usageAnalytics?.costBreakdown ?? []).map((row) => ({ name: row.label, value: row.value }));
  const premiumRows = buildPremiumRows(groupUsageAggregates);
  const keyUsageSummaryRows = buildKeyUsageSummaryRows(keys, keyUsageAggregates);
  const keyCostRankingRows = buildUsageRankingRows(keyUsageAggregates);
  const groupCostRankingRows = buildUsageRankingRows(groupUsageAggregates);
  const subscriptionCostRankingRows = buildUsageRankingRows(subscriptionUsageAggregates);
  const extremeRows = buildExtremeRequestRows(usageAnalytics?.extremes ?? []);
  const siteRankings = buildSiteRankings(overview);
  const accountRankings = buildAccountRankings(overview);
  const endpointRows = mapAnalyticsDimensionRows(usageAnalytics?.endpoints ?? []);
  const reasoningRows = mapAnalyticsDimensionRows(usageAnalytics?.reasoningEfforts ?? []);
  const requestTypeRows = mapAnalyticsDimensionRows(usageAnalytics?.requestTypes ?? []);
  const userAgentRows = mapAnalyticsDimensionRows(usageAnalytics?.userAgents ?? []);
  const keyStatusRows = buildDimensionRows(keys, (key) => key.status || "unknown");
  const identityRows = buildIdentityRows(profileRecord);
  const quotaRows = platformQuotas?.platformQuotas ?? [];
  const subscriptionRows = buildSubscriptionRows(
    subscriptionSummary,
    selectedAccountCache?.subscriptions ?? [],
    subscriptionUsageAggregates
  );
  const alertSeverityRows = buildAlertSeverityRows(overview);
  const platformQuotaFallbackRows = buildPlatformQuotaFallbackRows(
    mapAnalyticsAggregateRows(usageAnalytics?.platforms ?? [])
  );
  const accountHealthRows = buildAccountHealthRows(overview);

  const selectedAccountTitle = selectedAccount
    ? `${selectedAccount.label} · ${selectedAccount.site?.name ?? "未命名站点"}`
    : "请先选择账号";
  const sampleFootnote = usageAnalytics
    ? `当前展示最新 ${sampleRows.length} 条样本，筛选范围共 ${usageAnalytics.matchedRows.toLocaleString()} 条明细。`
    : "尚未加载 usage 样本。";
  const scopedFootnote = usageAnalytics
    ? usageAnalytics.matchedRows > 0
      ? `当前筛选范围共 ${usageAnalytics.matchedRows.toLocaleString()} 条本地明细。`
      : "当前筛选范围没有用量明细。"
    : aggregateReady
      ? "当前聚合结果已加载。"
      : "当前还没有筛选范围聚合数据。";
  const dateLabel = usageStartDate && usageEndDate ? `${usageStartDate} ~ ${usageEndDate}` : "请选择时间范围";

  const handleViewKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentView: AnalyticsViewId) => {
    const nextView = resolveAnalyticsViewFromKey(currentView, event.key);
    if (!nextView) {
      return;
    }
    event.preventDefault();
    setActiveView(nextView);
    event.currentTarget
      .closest<HTMLElement>("[role=tablist]")
      ?.querySelector<HTMLButtonElement>(`#analytics-view-tab-${nextView}`)
      ?.focus();
  };

  if (!overview) {
    return (
      <section className="section-card analytics-lab-empty-shell" aria-live="polite">
        <AnalyticsEmptyState
          title="当前还没有可分析的数据"
          detail="先刷新首页数据, 再来这里查看更详细的分析。"
        />
      </section>
    );
  }

  return (
    <div className="analytics-lab-stack">
      <section className="analytics-scope-band" aria-label="当前分析范围">
        <div className="analytics-scope-grid">
          <div className="analytics-scope-item">
            <span>当前账号</span>
            <strong>{selectedAccountTitle}</strong>
            <p>{selectedAccountCache ? `最后更新 ${formatDateTimeFull(selectedAccountCache.fetchedAt)}` : "这个账号还没有可分析的数据"}</p>
          </div>
          <div className="analytics-scope-item">
            <span>样本区间</span>
            <strong>{dateLabel}</strong>
            <p>{scopedFootnote}</p>
          </div>
          <div className="analytics-scope-item">
            <span>整体情况</span>
            <strong>{overview.accounts.length} 个账号 / {overview.sites.length} 个站点</strong>
            <p>今日 {overview.totals.todayRequests.toLocaleString()} 请求, 实际成本 {formatUsd(overview.totals.todayActualCost, 4)}</p>
          </div>
        </div>
      </section>

      <div className="analytics-kpi-grid">
        <AnalyticsStatCard label="当前总请求" value={effectiveUsageStats?.totalRequests.toLocaleString() ?? "-"} hint="基于当前筛选条件" />
        <AnalyticsStatCard label="当前实际成本" value={formatUsd(effectiveUsageStats?.totalActualCost, 4)} hint={formatUsdPerMillion(effectiveUsageStats?.totalActualCost, effectiveUsageStats?.totalTokens)} />
        <AnalyticsStatCard label="当前总 Tokens" value={effectiveUsageStats ? compact(effectiveUsageStats.totalTokens) : "-"} hint={`输入 ${compact(effectiveUsageStats?.totalInputTokens ?? 0)} / 输出 ${compact(effectiveUsageStats?.totalOutputTokens ?? 0)}`} />
        <AnalyticsStatCard label="缓存命中" value={effectiveUsageStats ? compact((effectiveUsageStats.totalCacheReadTokens ?? 0) + (effectiveUsageStats.totalCacheCreationTokens ?? 0)) : "-"} hint={`读取 ${compact(effectiveUsageStats?.totalCacheReadTokens ?? 0)} / 写入 ${compact(effectiveUsageStats?.totalCacheCreationTokens ?? 0)}`} />
        <AnalyticsStatCard
          label="平均耗时"
          value={formatDurationSeconds(effectiveUsageStats?.averageDurationMs)}
          hint={`RPM ${formatNumber(effectiveUsageStats?.rpm)} / TPM ${effectiveUsageStats?.tpm === null || effectiveUsageStats?.tpm === undefined ? "-" : compact(effectiveUsageStats.tpm)}`}
        />
        <AnalyticsStatCard label="活跃订阅" value={String(subscriptionSummary?.activeCount ?? selectedAccountCache?.subscriptions.length ?? 0)} hint={`已用 ${formatUsd(subscriptionSummary?.totalUsedUsd ?? 0, 2)}`} />
        <AnalyticsStatCard label="可管理 Key" value={String(keys.length)} hint={`活跃 ${String(keys.filter((item) => item.status === "active").length)}`} />
        <AnalyticsStatCard label="身份绑定" value={`${identityRows.filter((item) => item.bound).length} / ${identityRows.length}`} hint={profileRecord ? maskEmail(profileRecord.email) : "等待账号资料"} />
      </div>

      <section className="analytics-filter-band" aria-label="分析筛选">
        <div className="analytics-toolbar">
          <label className="field analytics-filter">
            <span>开始日期</span>
            <input
              type="date"
              value={usageStartDate}
              onChange={(event) => onUsageStartDateChange(event.target.value)}
            />
          </label>
          <label className="field analytics-filter">
            <span>结束日期</span>
            <input
              type="date"
              value={usageEndDate}
              onChange={(event) => onUsageEndDateChange(event.target.value)}
            />
          </label>
          <label className="field analytics-filter">
            <span>按密钥筛选</span>
            <select
              value={usageApiKeyFilter}
              onChange={(event) => onUsageApiKeyFilterChange(event.target.value)}
            >
              <option value="">全部密钥</option>
              {keys.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field analytics-filter">
            <span>按密钥筛选</span>
            <select
              value={keyUsageKeyId}
              onChange={(event) => onKeyUsageSelect(event.target.value)}
            >
              <option value="">请选择密钥</option>
              {keys.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <div className="analytics-toolbar-actions">
            <button className="primary-button" type="button" onClick={onUsageSearch}>
              刷新筛选结果
            </button>
            <p>当前筛选会同步更新四个分析视图中的指标、图表和明细。</p>
          </div>
        </div>
      </section>

      <section className="analytics-view-section" aria-labelledby="analytics-view-heading">
        <div className="analytics-view-heading">
          <div className="title-with-hint">
            <h3 id="analytics-view-heading">分析视图</h3>
            <TitleHint content="围绕当前筛选范围切换不同的分析重点。" label="查看分析视图说明" />
          </div>
          <span className="analytics-view-current" aria-live="polite">
            {ANALYTICS_VIEWS.find((view) => view.id === activeView)?.chartCount ?? 0} 张图表
          </span>
        </div>
        <div className="analytics-view-tablist" role="tablist" aria-label="数据分析视图">
          {ANALYTICS_VIEWS.map((view) => {
            const selected = view.id === activeView;
            return (
              <button
                key={view.id}
                id={`analytics-view-tab-${view.id}`}
                className={`analytics-view-tab ${selected ? "is-active" : ""}`.trim()}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`analytics-view-panel-${view.id}`}
                aria-label={`${view.label}, ${view.chartCount} 张图表`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActiveView(view.id)}
                onKeyDown={(event) => handleViewKeyDown(event, view.id)}
              >
                <span>{view.label}</span>
                <small>{view.chartCount}</small>
              </button>
            );
          })}
        </div>

        <div
          id={`analytics-view-panel-${activeView}`}
          className="analytics-view-panel"
          role="tabpanel"
          aria-labelledby={`analytics-view-tab-${activeView}`}
        >
          {activeView === "overview" && (
            <div className="content-grid analytics-lab-grid">
              <AnalyticsChartCard
                title="成本 / 请求 / Token 趋势"
                subtitle="同时查看花费、请求数和用量的变化趋势"
                option={buildUsageTrendOption(scopedTrend, palette)}
                footer={scopedTrend ? <AnalyticsFootnote>开始 {scopedTrend.startDate || "-"} · 结束 {scopedTrend.endDate || "-"}</AnalyticsFootnote> : null}
              />
              <AnalyticsChartCard
                title="模型成本排行"
                subtitle="看看哪些模型花费最高"
                option={buildModelCostOption(scopedModels, palette)}
              />
              <AnalyticsChartCard
                title="平台全景"
                subtitle="按平台对比用量和花费, 一眼看出主力平台"
                option={buildPlatformOverviewOption(scopedPlatformSeries.length > 0 ? scopedPlatformSeries : platformSeries, palette)}
              />
              <AnalyticsChartCard
                title="缓存效率"
                subtitle="看看缓存帮你节省了多少用量和花费"
                option={buildCacheEfficiencyOption(cacheEfficiencyRows, palette)}
                loading={loading && !sampleReady}
                footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
              />
            </div>
          )}

          {activeView === "cost-models" && (
            <div className="content-grid analytics-lab-grid">
              <AnalyticsChartCard
                title="模型 Token 构成"
                subtitle="对比输入、输出和缓存带来的用量差异"
                option={buildModelTokenOption(scopedModels, palette)}
              />
              <AnalyticsChartCard
                title="成本拆解"
                subtitle="把花费拆开看, 更容易知道钱花在了哪里"
                option={buildCostBreakdownOption(costBreakdownRows, palette)}
                loading={loading && !sampleReady}
                footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
              />
              <AnalyticsChartCard
                title="模型溢价分析"
                subtitle="换成柱线组合, 更直观看不同模型的单次成本和溢价倍率"
                option={buildEfficiencyScatterOption(efficiencyRows, palette)}
                loading={loading && !sampleReady}
                footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
              />
              <AnalyticsChartCard
                title="密钥花费排行"
                subtitle="看看哪些密钥用得最多, 花费最高"
                option={buildUsageRankingBarOption(keyCostRankingRows, palette, "密钥花费")}
                footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
              />
              <AnalyticsChartCard
                title="分组花费排行"
                subtitle="看看哪个分组或订阅花费最高"
                option={buildUsageRankingBarOption(groupCostRankingRows, palette, "分组花费")}
                footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
              />
              <AnalyticsChartCard
                title="订阅成本排行"
                subtitle="看看哪个订阅花费最高"
                option={buildUsageRankingBarOption(subscriptionCostRankingRows, palette, "订阅成本")}
                footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
              />
              <AnalyticsChartCard
                title="分组溢价排行"
                subtitle="看看哪些分组的实际花费更高"
                option={buildPremiumBarOption(premiumRows, palette)}
                footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
              />
            </div>
          )}

          {activeView === "performance-requests" && (
            <>
              <div className="content-grid analytics-lab-grid">
                <AnalyticsChartCard
                  title="延迟分位"
                  subtitle="看看常见请求和较慢请求分别有多快"
                  option={buildLatencyPercentileOption(usageAnalytics?.latencyPercentiles ?? null, palette)}
                  loading={loading && !sampleReady}
                  footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
                />
                <AnalyticsChartCard
                  title="请求样本散点"
                  subtitle="把单次请求的大小、花费和耗时放在一起看"
                  option={buildRequestScatterOption(sampleRows, palette)}
                  loading={loading && !usageAnalytics}
                  footer={<AnalyticsFootnote>{sampleFootnote}</AnalyticsFootnote>}
                />
                <AnalyticsChartCard
                  title="端点分布"
                  subtitle="看看最常出现的是哪些请求入口"
                  option={buildDimensionBarOption(endpointRows, palette, "endpoint")}
                  loading={loading && !sampleReady}
                  footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
                />
                <AnalyticsChartCard
                  title="推理强度分布"
                  subtitle="看看不同推理强度各占多少"
                  option={buildDimensionDonutOption(reasoningRows, palette, "推理强度")}
                  loading={loading && !sampleReady}
                  footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
                />
                <AnalyticsChartCard
                  title="请求类型分布"
                  subtitle="看看不同请求类型各占多少"
                  option={buildDimensionDonutOption(requestTypeRows, palette, "请求类型")}
                  loading={loading && !sampleReady}
                  footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
                />
                <AnalyticsChartCard
                  title="请求类型 × 推理强度"
                  subtitle="把请求类型和推理强度放在一起比较"
                  option={buildDimensionBarOption(comboRows, palette, "组合请求")}
                  loading={loading && !sampleReady}
                  footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
                />
                <AnalyticsChartCard
                  title="时段热力图"
                  subtitle="看看一周里哪些时段最忙"
                  option={buildUsageHeatmapOption(heatmapRows, palette)}
                  loading={loading && !sampleReady}
                  footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
                />
                <AnalyticsChartCard
                  title="请求路径分布"
                  subtitle="看看请求通常是从哪里进入、流向哪里"
                  option={buildEndpointFlowOption(upstreamFlowRows, palette)}
                  loading={loading && !sampleReady}
                  footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
                />
                <AnalyticsChartCard
                  title="模型延迟排行"
                  subtitle="看看哪些模型响应更快, 哪些更慢"
                  option={buildLatencyComparisonOption(modelLatencyRows, palette)}
                  footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
                />
                <AnalyticsChartCard
                  title="请求路径耗时排行"
                  subtitle="看看哪些请求路径最慢"
                  option={buildLatencyComparisonOption(endpointLatencyRows, palette)}
                  footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
                />
                <AnalyticsChartCard
                  title="极值请求榜"
                  subtitle="把最贵、最长、最大的一些请求集中看"
                  option={buildExtremeRowsOption(extremeRows, palette)}
                  footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
                />
              </div>

              <section className="content-grid analytics-detail-grid">
                <section className="section-card analytics-detail-card">
                  <header className="section-card-header">
                    <div className="title-with-hint">
                      <h3>请求样本明细</h3>
                      <TitleHint content="从代表性请求中核对模型、入口、成本、Token 和耗时。" label="查看请求样本明细说明" />
                    </div>
                  </header>
                  <div className="table-list">
                    {sampleRows.slice(0, 10).map((row) => (
                      <div key={row.id} className="table-row wide analytics-rich-row">
                        <div className="row-main">
                          <strong>{row.model}</strong>
                          <p>{row.apiKeyName ?? "未知 Key"} / {row.endpoint ?? "-"}</p>
                          <small>{formatDateTimeFull(row.createdAt)} · {formatBillingMode(row.billingMode, row.billingType)}</small>
                        </div>
                        <div className="row-meta analytics-rich-meta">
                          <span>{formatUsd(row.actualCost, 6)}</span>
                          <span>{compact(row.totalTokens)} tokens</span>
                          <span>{formatMilliseconds(row.firstTokenMs)} / {formatDurationSeconds(row.durationMs)}</span>
                        </div>
                      </div>
                    ))}
                    {sampleRows.length === 0 && (
                      <AnalyticsEmptyState title="当前没有样本记录" detail="先调整筛选条件, 再点击“刷新筛选结果”查看记录。" />
                    )}
                  </div>
                </section>

                <section className="section-card analytics-detail-card">
                  <header className="section-card-header">
                    <div className="title-with-hint">
                      <h3>来源信息</h3>
                      <TitleHint content="查看当前筛选范围内的主要调用来源。" label="查看来源信息说明" />
                    </div>
                  </header>
                  <div className="table-list">
                    {userAgentRows.slice(0, 8).map((item) => (
                      <div key={item.name} className="table-row">
                        <div>
                          <strong>{item.name}</strong>
                          <p>{item.count.toLocaleString()} 次</p>
                        </div>
                        <div className="table-numbers">
                          <span>{formatUsd(item.actualCost, 4)}</span>
                        </div>
                      </div>
                    ))}
                    {userAgentRows.length === 0 && (
                      <AnalyticsEmptyState title="当前没有来源信息" detail="当前筛选范围内还没有可展示的来源信息。" />
                    )}
                  </div>
                </section>
              </section>
            </>
          )}

          {activeView === "accounts-assets" && (
            <>
              <div className="content-grid analytics-lab-grid">
                <AnalyticsChartCard
                  title="密钥状态分布"
                  subtitle="看看当前账号下各类密钥各有多少"
                  option={buildDimensionDonutOption(keyStatusRows, palette, "密钥状态")}
                />
                <AnalyticsChartCard
                  title="密钥额度与已用"
                  subtitle="有额度时看额度, 没配额度时回退看花费最高的密钥"
                  option={buildKeyQuotaOption(keyUsageSummaryRows, palette)}
                />
                <AnalyticsChartCard
                  title="密钥限额窗口"
                  subtitle="如果配置了 5h / 1d / 7d 限额, 这里会看谁最接近上限"
                  option={buildKeyWindowOption(keys, palette)}
                  emptyTitle="当前密钥没有配置周期限额"
                  emptyDetail="这些密钥都没有 5h / 1d / 7d 限额, 所以这里暂时无法计算接近上限的程度。"
                />
                <AnalyticsChartCard
                  title="单个密钥趋势"
                  subtitle={selectedKey ? `${selectedKey.name} · 最近 30 天变化` : "请选择一个密钥查看最近 30 天变化"}
                  option={buildKeyDailyTrendOption(keyUsageRows, palette)}
                  footer={
                    selectedKey ? (
                      <AnalyticsFootnote>
                        状态 {selectedKey.status} · 最近使用 {selectedKey.lastUsedAt ? formatDateTimeFull(selectedKey.lastUsedAt) : "暂无"}
                        {keyUsageRows.length === 0 ? " · 最近 30 天还没有可展示的记录" : ""}
                      </AnalyticsFootnote>
                    ) : null
                  }
                />
                <AnalyticsChartCard
                  title="订阅额度使用"
                  subtitle="换成额度进度条, 更直观看每个订阅今天用了多少"
                  option={buildSubscriptionUsageOption(subscriptionRows, palette)}
                />
                <AnalyticsChartCard
                  title="平台额度"
                  subtitle="有上游平台额度时看剩余额度, 否则回退成平台效率对比"
                  option={buildPlatformQuotaOption(quotaRows, platformQuotaFallbackRows, palette)}
                  emptyTitle={loading ? "平台效率正在聚合中" : "当前图表暂无数据"}
                  emptyDetail={loading ? "等筛选范围聚合完成后, 这里会优先显示平台额度或平台效率对比。" : "刷新账号或调整筛选后, 这里会显示对应图表。"}
                />
                <AnalyticsChartCard
                  title="身份绑定概览"
                  subtitle="看看当前账号都绑定了哪些身份方式"
                  option={buildIdentityBindingOption(identityRows, palette)}
                />
                <AnalyticsChartCard
                  title="告警严重级别"
                  subtitle="有告警看严重级别, 没告警时回退成账号健康分布"
                  option={buildAlertSeverityOption(alertSeverityRows, accountHealthRows, palette)}
                />
                <AnalyticsChartCard
                  title="站点余额排行"
                  subtitle="快速找出余额最多的站点"
                  option={buildRankingOption(siteRankings, palette, "余额")}
                />
                <AnalyticsChartCard
                  title="账号余额排行"
                  subtitle="把账号余额排个序, 更快找到重点账号"
                  option={buildRankingOption(accountRankings, palette, "余额")}
                />
              </div>

              <section className="content-grid analytics-detail-grid">
                <section className="section-card analytics-detail-card">
                  <header className="section-card-header">
                    <div className="title-with-hint">
                      <h3>身份绑定</h3>
                      <TitleHint content="集中核对当前账号已连接的身份方式。" label="查看身份绑定说明" />
                    </div>
                  </header>
                  <div className="table-list">
                    {identityRows.map((binding) => (
                      <div key={binding.provider} className="table-row">
                        <div>
                          <strong>{binding.provider}</strong>
                          <p>{binding.displayName ?? binding.subjectHint ?? "未绑定"}</p>
                        </div>
                        <div className="table-numbers">
                          <span>{binding.bound ? "已绑定" : "未绑定"}</span>
                          <span>{binding.canBind ? "可绑定" : "不可绑定"}</span>
                        </div>
                      </div>
                    ))}
                    {identityRows.length === 0 && (
                      <AnalyticsEmptyState title="当前没有身份绑定数据" detail="登录并刷新账号后, 这里会显示身份绑定情况。" />
                    )}
                  </div>
                </section>

                <section className="section-card analytics-detail-card">
                  <header className="section-card-header">
                    <div className="title-with-hint">
                      <h3>订阅窗口清单</h3>
                      <TitleHint content="查看订阅用量、限额与到期状态。" label="查看订阅窗口清单说明" />
                    </div>
                  </header>
                  <div className="table-list">
                    {subscriptionRows.slice(0, 8).map((item) => (
                      <div key={item.name} className="table-row">
                        <div>
                          <strong>{item.name}</strong>
                          <p>{item.status}</p>
                        </div>
                        <div className="table-numbers">
                          <span>{formatUsd(item.dailyUsed, 2)} / {formatUsd(item.dailyLimit, 2)}</span>
                          <span>{item.expiresAt ? formatRemainingDaysLabel(item.expiresAt) : "无到期时间"}</span>
                        </div>
                      </div>
                    ))}
                    {subscriptionRows.length === 0 && (
                      <AnalyticsEmptyState title="当前没有订阅数据" detail="刷新账号后, 这里会显示订阅列表。" />
                    )}
                  </div>
                </section>
              </section>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function AnalyticsStatCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <article className="analytics-stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{hint}</p>
    </article>
  );
}

function AnalyticsEmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="analytics-empty-state">
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function AnalyticsFootnote({ children }: { children: ReactNode }) {
  return <p className="analytics-footnote">{children}</p>;
}

function AnalyticsChartCard({
  title,
  subtitle,
  option,
  footer,
  loading = false,
  emptyTitle = "当前图表暂无数据",
  emptyDetail = "刷新账号或调整筛选后, 这里会显示对应图表。"
}: {
  title: string;
  subtitle: string;
  option: ChartOption | null;
  footer?: ReactNode;
  loading?: boolean;
  emptyTitle?: string;
  emptyDetail?: string;
}) {
  return (
    <section className="section-card analytics-chart-card">
      <header className="section-card-header">
        <div className="title-with-hint">
          <h3>{title}</h3>
          <TitleHint content={subtitle} label={`查看${title}说明`} />
        </div>
      </header>
      {option ? (
        <div className="chart-wrap tall analytics-chart-shell">
          <BaseEChartCard option={option} />
        </div>
      ) : (
        <AnalyticsEmptyState
          title={loading ? "当前图表正在聚合中" : emptyTitle}
          detail={loading ? "筛选范围还在加载更多 usage 明细, 稍等就会更新成完整图表。" : emptyDetail}
        />
      )}
      {footer}
    </section>
  );
}

function buildUsageTrendOption(trend: UsageTrendPayload | null, palette: ChartPalette): ChartOption | null {
  if (!trend || trend.trend.length === 0) {
    return null;
  }

  return {
    backgroundColor: palette.chartBg,
    color: [palette.accent, palette.secondary, palette.tertiary],
    tooltip: {
      trigger: "axis"
    },
    legend: {
      top: 0,
      textStyle: { color: palette.textSoft }
    },
    grid: {
      top: 48,
      left: 46,
      right: 18,
      bottom: 28
    },
    xAxis: {
      type: "category",
      data: trend.trend.map((item) => item.date),
      axisLine: { lineStyle: { color: palette.border } },
      axisLabel: { color: palette.textSoft }
    },
    yAxis: [
      {
        type: "value",
        name: "成本 / 请求",
        axisLine: { show: false },
        splitLine: { lineStyle: { color: palette.chartGrid } },
        axisLabel: { color: palette.textSoft }
      },
      {
        type: "value",
        name: "Tokens",
        axisLine: { show: false },
        splitLine: { show: false },
        axisLabel: { color: palette.textSoft }
      }
    ],
    series: [
      {
        name: "实际成本",
        type: "line",
        smooth: true,
        data: trend.trend.map((item) => Number(item.actualCost ?? item.totalCost ?? 0).toFixed(4))
      },
      {
        name: "请求数",
        type: "bar",
        barMaxWidth: 18,
        data: trend.trend.map((item) => item.requests)
      },
      {
        name: "总 Tokens",
        type: "line",
        smooth: true,
        yAxisIndex: 1,
        data: trend.trend.map((item) => item.totalTokens ?? 0)
      }
    ]
  };
}

function buildModelCostOption(models: DashboardModelsPayload | null, palette: ChartPalette): ChartOption | null {
  const rows = (models?.models ?? []).slice().sort((left, right) => (right.actualCost ?? 0) - (left.actualCost ?? 0));
  if (rows.length === 0) {
    return null;
  }
  return {
    backgroundColor: palette.chartBg,
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" }
    },
    grid: {
      top: 18,
      left: 130,
      right: 26,
      bottom: 26
    },
    xAxis: {
      type: "value",
      axisLabel: { color: palette.textSoft },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    yAxis: {
      type: "category",
      data: rows.map((item) => item.model),
      axisLabel: { color: palette.textSoft }
    },
    series: [
      {
        type: "bar",
        barMaxWidth: 18,
        itemStyle: { color: palette.accent },
        data: rows.map((item) => item.actualCost ?? item.cost ?? 0)
      }
    ]
  };
}

function buildModelTokenOption(models: DashboardModelsPayload | null, palette: ChartPalette): ChartOption | null {
  const rows = (models?.models ?? []).slice().sort((left, right) => (right.totalTokens ?? 0) - (left.totalTokens ?? 0)).slice(0, 8);
  if (rows.length === 0) {
    return null;
  }
  return {
    color: [palette.accent, palette.secondary, palette.warning, palette.rose],
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: {
      top: 0,
      textStyle: { color: palette.textSoft }
    },
    grid: {
      top: 48,
      left: 120,
      right: 20,
      bottom: 24
    },
    xAxis: {
      type: "value",
      axisLabel: { color: palette.textSoft },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    yAxis: {
      type: "category",
      data: rows.map((item) => item.model),
      axisLabel: { color: palette.textSoft }
    },
    series: [
      { name: "输入", type: "bar", stack: "tokens", data: rows.map((item) => item.inputTokens) },
      { name: "输出", type: "bar", stack: "tokens", data: rows.map((item) => item.outputTokens) },
      { name: "缓存写入", type: "bar", stack: "tokens", data: rows.map((item) => item.cacheCreationTokens ?? 0) },
      { name: "缓存读取", type: "bar", stack: "tokens", data: rows.map((item) => item.cacheReadTokens ?? 0) }
    ]
  };
}

function buildPlatformOverviewOption(
  rows: Array<{ platform: string; totalActualCost: number; totalRequests: number; totalTokens: number }>,
  palette: ChartPalette
): ChartOption | null {
  if (rows.length === 0) {
    return null;
  }
  return {
    color: [palette.accent, palette.secondary, palette.warning],
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: {
      top: 0,
      textStyle: { color: palette.textSoft }
    },
    grid: {
      top: 44,
      left: 58,
      right: 18,
      bottom: 24
    },
    xAxis: {
      type: "category",
      data: rows.map((item) => item.platform),
      axisLabel: { color: palette.textSoft }
    },
    yAxis: [
      {
        type: "value",
        name: "成本 / 请求",
        splitLine: { lineStyle: { color: palette.chartGrid } },
        axisLabel: { color: palette.textSoft }
      },
      {
        type: "value",
        name: "Tokens",
        splitLine: { show: false },
        axisLabel: { color: palette.textSoft }
      }
    ],
    series: [
      { name: "实际成本", type: "bar", data: rows.map((item) => item.totalActualCost) },
      { name: "请求数", type: "bar", data: rows.map((item) => item.totalRequests) },
      { name: "总 Tokens", type: "line", yAxisIndex: 1, smooth: true, data: rows.map((item) => item.totalTokens) }
    ]
  };
}

function buildLatencyPercentileOption(
  percentiles: UsageAnalyticsLatencyPercentiles | null,
  palette: ChartPalette
): ChartOption | null {
  const firstToken = percentiles?.firstToken ?? null;
  const duration = percentiles?.duration ?? null;
  if (!firstToken && !duration) {
    return null;
  }
  const labels = ["P50", "P90", "P99"];
  return {
    color: [palette.accent, palette.rose],
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: { top: 0, textStyle: { color: palette.textSoft } },
    grid: { top: 42, left: 56, right: 20, bottom: 24 },
    xAxis: {
      type: "category",
      data: labels,
      axisLabel: { color: palette.textSoft }
    },
    yAxis: {
      type: "value",
      axisLabel: { color: palette.textSoft },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    series: [
      {
        name: "首 Token",
        type: "bar",
        data: firstToken ? [firstToken.p50, firstToken.p90, firstToken.p99] : [0, 0, 0]
      },
      {
        name: "总耗时",
        type: "bar",
        data: duration ? [duration.p50, duration.p90, duration.p99] : [0, 0, 0]
      }
    ]
  };
}

function buildCostBreakdownOption(rows: Array<{ name: string; value: number }>, palette: ChartPalette): ChartOption | null {
  if (rows.length === 0) {
    return null;
  }
  return {
    color: [palette.accent, palette.secondary, palette.warning, palette.rose],
    tooltip: { trigger: "item" },
    legend: { orient: "vertical", right: 8, top: 20, textStyle: { color: palette.textSoft } },
    series: [
      {
        type: "pie",
        radius: ["45%", "72%"],
        center: ["36%", "52%"],
        label: { color: palette.textSoft },
        data: rows.map((row) => ({ name: row.name, value: row.value }))
      }
    ]
  };
}

function buildEfficiencyScatterOption(rows: EfficiencyRow[], palette: ChartPalette): ChartOption | null {
  const sorted = rows
    .filter((row) => row.actualCost > 0 || row.costPerRequest > 0 || row.premiumRatio > 0)
    .sort((left, right) => {
      if (right.costPerRequest !== left.costPerRequest) {
        return right.costPerRequest - left.costPerRequest;
      }
      return right.premiumRatio - left.premiumRatio;
    })
    .slice(0, 10);
  if (sorted.length === 0) {
    return null;
  }
  return {
    color: [palette.indigo, palette.warning],
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: Array<{ dataIndex: number }>) => {
        const row = sorted[params[0]?.dataIndex ?? 0];
        if (!row) {
          return "暂无数据";
        }
        return [
          `<strong>${row.name}</strong>`,
          `单次成本: ${formatUsd(row.costPerRequest, 6)}`,
          `溢价倍率: ${row.premiumRatio.toFixed(2)}x`,
          `总花费: ${formatUsd(row.actualCost, 4)}`,
          `总 Tokens: ${compact(row.totalTokens)}`
        ].join("<br/>");
      }
    },
    legend: {
      top: 0,
      textStyle: { color: palette.textSoft }
    },
    grid: { top: 46, left: 56, right: 72, bottom: 56 },
    xAxis: {
      type: "category",
      data: sorted.map((row) => row.name),
      axisLabel: {
        color: palette.textSoft,
        interval: 0,
        rotate: sorted.length > 5 ? 24 : 0
      },
      axisLine: { lineStyle: { color: palette.border } }
    },
    yAxis: [
      {
        type: "value",
        name: "单次成本",
        axisLabel: { color: palette.textSoft },
        splitLine: { lineStyle: { color: palette.chartGrid } }
      },
      {
        type: "value",
        name: "溢价倍率",
        axisLabel: {
          color: palette.textSoft,
          formatter: (value: number) => `${value.toFixed(2)}x`
        },
        splitLine: { show: false }
      }
    ],
    series: [
      {
        name: "单次成本",
        type: "bar",
        barMaxWidth: 26,
        data: sorted.map((row) => Number(row.costPerRequest.toFixed(6)))
      },
      {
        name: "溢价倍率",
        type: "line",
        yAxisIndex: 1,
        smooth: true,
        data: sorted.map((row) => Number(row.premiumRatio.toFixed(3)))
      }
    ]
  };
}

function buildUsageHeatmapOption(rows: UsageHeatmapRow[], palette: ChartPalette): ChartOption | null {
  if (rows.length === 0) {
    return null;
  }
  const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const hours = Array.from({ length: 24 }, (_, index) => `${index}:00`);
  return {
    tooltip: {
      position: "top",
      formatter: (params: { data?: [number, number, number, number] }) => {
        const data = params.data;
        if (!data) return "暂无数据";
        return `${weekdays[data[0]]} ${hours[data[1]]}<br/>请求 ${data[2]}<br/>成本 ${formatUsd(data[3], 4)}`;
      }
    },
    grid: { top: 24, left: 56, right: 24, bottom: 32 },
    xAxis: {
      type: "category",
      data: weekdays,
      axisLabel: { color: palette.textSoft }
    },
    yAxis: {
      type: "category",
      data: hours,
      axisLabel: { color: palette.textSoft }
    },
    visualMap: {
      min: 0,
      max: Math.max(...rows.map((row) => row.requests), 1),
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      inRange: {
        color: [palette.border, palette.secondary, palette.accent]
      }
    },
    series: [
      {
        type: "heatmap",
        data: rows.map((row) => [row.weekday, row.hour, row.requests, row.actualCost]),
        label: { show: false }
      }
    ]
  };
}

function buildCacheEfficiencyOption(
  rows: Array<{ name: string; cacheRatio: number; cacheReadTokens: number; totalTokens: number; actualCost: number }>,
  palette: ChartPalette
): ChartOption | null {
  if (rows.length === 0) {
    return null;
  }
  const topRows = rows.slice(0, 10);
  return {
    color: [palette.sky, palette.warning],
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: { top: 0, textStyle: { color: palette.textSoft } },
    grid: { top: 48, left: 120, right: 20, bottom: 24 },
    xAxis: {
      type: "value",
      axisLabel: { color: palette.textSoft },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    yAxis: {
      type: "category",
      data: topRows.map((row) => row.name),
      axisLabel: { color: palette.textSoft }
    },
    series: [
      { name: "缓存读取 Token", type: "bar", data: topRows.map((row) => row.cacheReadTokens) },
      { name: "缓存占比", type: "line", data: topRows.map((row) => Number((row.cacheRatio * 100).toFixed(2))) }
    ]
  };
}

function buildEndpointFlowOption(rows: EndpointFlowRow[], palette: ChartPalette): ChartOption | null {
  if (rows.length === 0) {
    return null;
  }
  return {
    color: [palette.accent],
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" }
    },
    grid: { top: 18, left: 180, right: 20, bottom: 24 },
    xAxis: {
      type: "value",
      axisLabel: { color: palette.textSoft },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    yAxis: {
      type: "category",
      data: rows.map((row) => `${row.source} -> ${row.target}`),
      axisLabel: { color: palette.textSoft }
    },
    series: [
      {
        type: "bar",
        data: rows.map((row) => row.requests)
      }
    ]
  };
}

function buildUsageRankingBarOption(rows: RankingRow[], palette: ChartPalette, label: string): ChartOption | null {
  return buildRankingOption(rows, palette, label);
}

function buildLatencyComparisonOption(rows: UsageAggregateRow[], palette: ChartPalette): ChartOption | null {
  if (rows.length === 0) {
    return null;
  }
  return {
    color: [palette.rose, palette.secondary],
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: { top: 0, textStyle: { color: palette.textSoft } },
    grid: { top: 48, left: 120, right: 20, bottom: 24 },
    xAxis: {
      type: "value",
      axisLabel: { color: palette.textSoft },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    yAxis: {
      type: "category",
      data: rows.map((row) => row.name),
      axisLabel: { color: palette.textSoft }
    },
    series: [
      { name: "平均首 Token ms", type: "bar", data: rows.map((row) => Number(row.averageFirstTokenMs.toFixed(2))) },
      { name: "平均总耗时 ms", type: "bar", data: rows.map((row) => Number(row.averageDurationMs.toFixed(2))) }
    ]
  };
}

function buildExtremeRowsOption(rows: ExtremeRequestRow[], palette: ChartPalette): ChartOption | null {
  if (rows.length === 0) {
    return null;
  }
  return {
    color: [palette.warning],
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: Array<{ dataIndex: number }>) => {
        const row = rows[params[0]?.dataIndex ?? 0];
        if (!row) return "暂无数据";
        return [
          `<strong>${row.model}</strong>`,
          `归属: ${row.name}`,
          `成本: ${formatUsd(row.actualCost, 6)}`,
          `Tokens: ${compact(row.totalTokens)}`,
          `耗时: ${formatDurationSeconds(row.durationMs)}`,
          `首 Token: ${formatMilliseconds(row.firstTokenMs)}`
        ].join("<br/>");
      }
    },
    grid: { top: 18, left: 120, right: 20, bottom: 24 },
    xAxis: {
      type: "value",
      axisLabel: { color: palette.textSoft },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    yAxis: {
      type: "category",
      data: rows.map((row) => row.model),
      axisLabel: { color: palette.textSoft }
    },
    series: [
      { type: "bar", data: rows.map((row) => row.actualCost) }
    ]
  };
}

function buildPremiumBarOption(rows: PremiumRow[], palette: ChartPalette): ChartOption | null {
  if (rows.length === 0) {
    return null;
  }
  return {
    color: [palette.indigo],
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" }
    },
    grid: { top: 18, left: 120, right: 20, bottom: 24 },
    xAxis: {
      type: "value",
      axisLabel: {
        color: palette.textSoft,
        formatter: (value: number) => `${value.toFixed(2)}x`
      },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    yAxis: {
      type: "category",
      data: rows.map((row) => row.name),
      axisLabel: { color: palette.textSoft }
    },
    series: [
      {
        type: "bar",
        data: rows.map((row) => Number(row.premiumRatio.toFixed(3)))
      }
    ]
  };
}

function buildRequestScatterOption(rows: UsageRow[], palette: ChartPalette): ChartOption | null {
  if (rows.length === 0) {
    return null;
  }
  return {
    color: [palette.accent],
    tooltip: {
      trigger: "item",
      formatter: (params: { data?: [number, number, number, string, string] }) => {
        const data = params.data;
        if (!data) {
          return "暂无数据";
        }
        return [
          `<strong>${data[3]}</strong>`,
          `成本: ${formatUsd(data[1], 6)}`,
          `Tokens: ${compact(data[0])}`,
          `耗时: ${formatDurationSeconds(data[2])}`,
          `Key: ${data[4]}`
        ].join("<br/>");
      }
    },
    grid: {
      top: 18,
      left: 56,
      right: 20,
      bottom: 28
    },
    xAxis: {
      type: "value",
      name: "总 Tokens",
      axisLabel: { color: palette.textSoft },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    yAxis: {
      type: "value",
      name: "实际成本",
      axisLabel: { color: palette.textSoft }
    },
    series: [
      {
        type: "scatter",
        symbolSize: (data: [number, number, number]) => Math.max(12, Math.min(46, (data[2] || 0) / 450)),
        itemStyle: {
          opacity: 0.75
        },
        data: rows.map((row) => [
          row.totalTokens ?? 0,
          row.actualCost ?? 0,
          row.durationMs ?? 0,
          row.model,
          row.apiKeyName ?? "未知 Key"
        ])
      }
    ]
  };
}

function buildDimensionBarOption(rows: DimensionRow[], palette: ChartPalette, name: string): ChartOption | null {
  if (rows.length === 0) {
    return null;
  }
  const sorted = rows.slice().sort((left, right) => right.count - left.count).slice(0, 10);
  return {
    color: [palette.secondary],
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    grid: {
      top: 18,
      left: 120,
      right: 20,
      bottom: 24
    },
    xAxis: {
      type: "value",
      axisLabel: { color: palette.textSoft },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    yAxis: {
      type: "category",
      data: sorted.map((item) => item.name),
      axisLabel: { color: palette.textSoft }
    },
    series: [
      {
        name,
        type: "bar",
        barMaxWidth: 18,
        data: sorted.map((item) => item.count)
      }
    ]
  };
}

function buildDimensionDonutOption(rows: DimensionRow[], palette: ChartPalette, label: string): ChartOption | null {
  if (rows.length === 0) {
    return null;
  }
  return {
    color: [palette.accent, palette.secondary, palette.warning, palette.rose, palette.indigo, palette.sky],
    tooltip: { trigger: "item" },
    legend: {
      orient: "vertical",
      right: 8,
      top: 24,
      textStyle: { color: palette.textSoft }
    },
    series: [
      {
        name: label,
        type: "pie",
        radius: ["45%", "72%"],
        center: ["36%", "52%"],
        label: { color: palette.textSoft },
        data: rows.map((item) => ({
          name: item.name,
          value: item.count
        }))
      }
    ]
  };
}

type KeyUsageSummaryRow = {
  id: string;
  name: string;
  quota: number;
  quotaUsed: number;
  rateLimit5h: number;
  rateLimit1d: number;
  rateLimit7d: number;
  usage5h: number;
  usage1d: number;
  usage7d: number;
  actualCost: number;
  requests: number;
  totalTokens: number;
  lastUsedAt?: string | null;
};

function buildKeyUsageSummaryRows(keys: ManagedKeyRecord[], rows: UsageAggregateRow[]) {
  const bucket = new Map<string, KeyUsageSummaryRow>();
  for (const key of keys) {
    bucket.set(key.id, {
      id: key.id,
      name: key.name,
      quota: Number(key.quota ?? 0),
      quotaUsed: Number(key.quotaUsed ?? 0),
      rateLimit5h: Number(key.rateLimit5h ?? 0),
      rateLimit1d: Number(key.rateLimit1d ?? 0),
      rateLimit7d: Number(key.rateLimit7d ?? 0),
      usage5h: Number(key.usage5h ?? 0),
      usage1d: Number(key.usage1d ?? 0),
      usage7d: Number(key.usage7d ?? 0),
      actualCost: 0,
      requests: 0,
      totalTokens: 0,
      lastUsedAt: key.lastUsedAt
    });
  }
  for (const row of rows) {
    const matchedById = bucket.get(row.key);
    const matched =
      matchedById ??
      Array.from(bucket.values()).find((item) => item.name === row.name);
    if (!matched) {
      continue;
    }
    matched.actualCost += row.actualCost;
    matched.requests += row.requests;
    matched.totalTokens += row.totalTokens;
  }
  return Array.from(bucket.values());
}

function buildKeyQuotaOption(rows: KeyUsageSummaryRow[], palette: ChartPalette): ChartOption | null {
  if (rows.length === 0) {
    return null;
  }
  const quotaConfigured = rows.some((row) => row.quota > 0 || row.quotaUsed > 0);
  const sorted = quotaConfigured
    ? rows
        .slice()
        .sort((left, right) => Math.max(right.quota, right.quotaUsed) - Math.max(left.quota, left.quotaUsed))
        .slice(0, 8)
    : rows
        .slice()
        .sort((left, right) => {
          if (right.actualCost !== left.actualCost) {
            return right.actualCost - left.actualCost;
          }
          if (right.requests !== left.requests) {
            return right.requests - left.requests;
          }
          const leftTime = left.lastUsedAt ? Date.parse(left.lastUsedAt) : Number.NEGATIVE_INFINITY;
          const rightTime = right.lastUsedAt ? Date.parse(right.lastUsedAt) : Number.NEGATIVE_INFINITY;
          return rightTime - leftTime;
        })
        .slice(0, 8);

  if (!quotaConfigured) {
    return {
      color: [palette.warning],
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (params: Array<{ dataIndex: number }>) => {
          const row = sorted[params[0]?.dataIndex ?? 0];
          if (!row) {
            return "暂无数据";
          }
          return [
            `<strong>${row.name}</strong>`,
            `实际成本: ${formatUsd(row.actualCost, 6)}`,
            `请求数: ${row.requests.toLocaleString()}`,
            `总 Tokens: ${compact(row.totalTokens)}`,
            `最近使用: ${row.lastUsedAt ? formatDateTimeFull(row.lastUsedAt) : "暂无"}`
          ].join("<br/>");
        }
      },
      grid: {
        top: 18,
        left: 120,
        right: 20,
        bottom: 24
      },
      xAxis: {
        type: "value",
        axisLabel: { color: palette.textSoft },
        splitLine: { lineStyle: { color: palette.chartGrid } }
      },
      yAxis: {
        type: "category",
        data: sorted.map((item) => item.name),
        axisLabel: { color: palette.textSoft }
      },
      series: [
        { name: "实际成本", type: "bar", data: sorted.map((item) => Number(item.actualCost.toFixed(6))) }
      ]
    };
  }

  return {
    color: [palette.secondary, palette.warning],
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: {
      top: 0,
      textStyle: { color: palette.textSoft }
    },
    grid: {
      top: 48,
      left: 120,
      right: 20,
      bottom: 24
    },
    xAxis: {
      type: "value",
      axisLabel: { color: palette.textSoft },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    yAxis: {
      type: "category",
      data: sorted.map((item) => item.name),
      axisLabel: { color: palette.textSoft }
    },
    series: [
      { name: "额度", type: "bar", data: sorted.map((item) => item.quota) },
      { name: "已用", type: "bar", data: sorted.map((item) => item.quotaUsed) }
    ]
  };
}

function buildKeyWindowOption(keys: ManagedKeyRecord[], palette: ChartPalette): ChartOption | null {
  const configuredRows = keys
    .map((item) => {
      const utilization5h = item.rateLimit5h && item.rateLimit5h > 0 ? ((item.usage5h ?? 0) / item.rateLimit5h) * 100 : 0;
      const utilization1d = item.rateLimit1d && item.rateLimit1d > 0 ? ((item.usage1d ?? 0) / item.rateLimit1d) * 100 : 0;
      const utilization7d = item.rateLimit7d && item.rateLimit7d > 0 ? ((item.usage7d ?? 0) / item.rateLimit7d) * 100 : 0;
      return {
        ...item,
        utilization5h,
        utilization1d,
        utilization7d,
        peakUtilization: Math.max(utilization5h, utilization1d, utilization7d)
      };
    })
    .filter((item) => item.peakUtilization > 0);

  if (configuredRows.length === 0) {
    return null;
  }
  const sorted = configuredRows
    .slice()
    .sort((left, right) => right.peakUtilization - left.peakUtilization)
    .slice(0, 8);

  return {
    color: [palette.accent, palette.secondary, palette.warning, palette.rose, palette.indigo, palette.sky],
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: Array<{ dataIndex: number }>) => {
        const row = sorted[params[0]?.dataIndex ?? 0];
        if (!row) {
          return "暂无数据";
        }
        return [
          `<strong>${row.name}</strong>`,
          `5h: ${row.usage5h ?? 0} / ${row.rateLimit5h ?? 0} (${row.utilization5h.toFixed(1)}%)`,
          `1d: ${row.usage1d ?? 0} / ${row.rateLimit1d ?? 0} (${row.utilization1d.toFixed(1)}%)`,
          `7d: ${row.usage7d ?? 0} / ${row.rateLimit7d ?? 0} (${row.utilization7d.toFixed(1)}%)`
        ].join("<br/>");
      }
    },
    legend: {
      top: 0,
      textStyle: { color: palette.textSoft }
    },
    grid: {
      top: 48,
      left: 120,
      right: 20,
      bottom: 24
    },
    xAxis: {
      type: "value",
      axisLabel: {
        color: palette.textSoft,
        formatter: (value: number) => `${Math.round(value)}%`
      },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    yAxis: {
      type: "category",
      data: sorted.map((item) => item.name),
      axisLabel: { color: palette.textSoft }
    },
    series: [
      { name: "5h 占用率", type: "bar", data: sorted.map((item) => Number(item.utilization5h.toFixed(2))) },
      { name: "1d 占用率", type: "bar", data: sorted.map((item) => Number(item.utilization1d.toFixed(2))) },
      { name: "7d 占用率", type: "bar", data: sorted.map((item) => Number(item.utilization7d.toFixed(2))) }
    ]
  };
}

function buildKeyDailyTrendOption(rows: DailyUsagePoint[], palette: ChartPalette): ChartOption | null {
  if (rows.length === 0) {
    return null;
  }
  return {
    color: [palette.accent, palette.secondary, palette.warning],
    tooltip: { trigger: "axis" },
    legend: {
      top: 0,
      textStyle: { color: palette.textSoft }
    },
    grid: {
      top: 44,
      left: 56,
      right: 20,
      bottom: 24
    },
    xAxis: {
      type: "category",
      data: rows.map((item) => item.date),
      axisLabel: { color: palette.textSoft }
    },
    yAxis: [
      {
        type: "value",
        axisLabel: { color: palette.textSoft },
        splitLine: { lineStyle: { color: palette.chartGrid } }
      },
      {
        type: "value",
        axisLabel: { color: palette.textSoft },
        splitLine: { show: false }
      }
    ],
    series: [
      { name: "实际成本", type: "line", smooth: true, data: rows.map((item) => item.actualCost ?? item.totalCost ?? 0) },
      { name: "请求数", type: "bar", data: rows.map((item) => item.requests) },
      { name: "总 Tokens", type: "line", yAxisIndex: 1, smooth: true, data: rows.map((item) => item.totalTokens ?? 0) }
    ]
  };
}

function buildSubscriptionUsageOption(rows: SubscriptionChartRow[], palette: ChartPalette): ChartOption | null {
  if (rows.length === 0) {
    return null;
  }
  const sorted = rows
    .slice()
    .sort((left, right) => {
      const leftRatio = left.dailyLimit > 0 ? left.dailyUsed / left.dailyLimit : 0;
      const rightRatio = right.dailyLimit > 0 ? right.dailyUsed / right.dailyLimit : 0;
      if (rightRatio !== leftRatio) {
        return rightRatio - leftRatio;
      }
      return right.monthlyUsed - left.monthlyUsed;
    });
  return {
    color: [palette.accent, palette.border],
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: Array<{ dataIndex: number }>) => {
        const row = sorted[params[0]?.dataIndex ?? 0];
        if (!row) {
          return "暂无数据";
        }
        const utilization = row.dailyLimit > 0 ? `${((row.dailyUsed / row.dailyLimit) * 100).toFixed(1)}%` : "未配置";
        return [
          `<strong>${row.name}</strong>`,
          `状态: ${row.status}`,
          `今日已用: ${formatUsd(row.dailyUsed, 2)}`,
          `今日额度: ${row.dailyLimit > 0 ? formatUsd(row.dailyLimit, 2) : "未配置"}`,
          `今日使用率: ${utilization}`,
          `7 日已用: ${formatUsd(row.weeklyUsed, 2)}`,
          `30 日已用: ${formatUsd(row.monthlyUsed, 2)}`,
          `到期: ${row.expiresAt ? formatDateTimeFull(row.expiresAt) : "暂无"}`
        ].join("<br/>");
      }
    },
    legend: {
      top: 0,
      textStyle: { color: palette.textSoft }
    },
    grid: {
      top: 48,
      left: 120,
      right: 20,
      bottom: 24
    },
    xAxis: {
      type: "value",
      axisLabel: { color: palette.textSoft },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    yAxis: {
      type: "category",
      data: sorted.map((item) => item.name),
      axisLabel: { color: palette.textSoft }
    },
    series: [
      { name: "今日已用", type: "bar", stack: "daily", data: sorted.map((item) => item.dailyUsed) },
      { name: "今日剩余", type: "bar", stack: "daily", data: sorted.map((item) => Math.max(item.dailyLimit - item.dailyUsed, 0)) }
    ]
  };
}

function buildPlatformQuotaOption(
  rows: PlatformQuotaPayload["platformQuotas"],
  fallbackRows: Array<{ platform: string; requests: number; actualCost: number; totalTokens: number }>,
  palette: ChartPalette
): ChartOption | null {
  if (rows.length === 0) {
    if (fallbackRows.length === 0) {
      return null;
    }
    const sorted = fallbackRows
      .slice()
      .sort((left, right) => right.actualCost - left.actualCost)
      .slice(0, 8);
    return {
      color: [palette.secondary, palette.warning],
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (params: Array<{ dataIndex: number }>) => {
          const row = sorted[params[0]?.dataIndex ?? 0];
          if (!row) {
            return "暂无数据";
          }
          return [
            `<strong>${row.platform}</strong>`,
            `实际成本: ${formatUsd(row.actualCost, 4)}`,
            `请求数: ${row.requests.toLocaleString()}`,
            `总 Tokens: ${compact(row.totalTokens)}`
          ].join("<br/>");
        }
      },
      legend: {
        top: 0,
        textStyle: { color: palette.textSoft }
      },
      grid: {
        top: 48,
        left: 80,
        right: 20,
        bottom: 24
      },
      xAxis: {
        type: "category",
        data: sorted.map((item) => item.platform),
        axisLabel: { color: palette.textSoft }
      },
      yAxis: [
        {
          type: "value",
          axisLabel: { color: palette.textSoft },
          splitLine: { lineStyle: { color: palette.chartGrid } }
        },
        {
          type: "value",
          axisLabel: { color: palette.textSoft },
          splitLine: { show: false }
        }
      ],
      series: [
        { name: "实际成本", type: "bar", data: sorted.map((item) => Number(item.actualCost.toFixed(4))) },
        { name: "请求数", type: "line", yAxisIndex: 1, smooth: true, data: sorted.map((item) => item.requests) }
      ]
    };
  }
  return {
    color: [palette.secondary, palette.warning, palette.accent],
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: {
      top: 0,
      textStyle: { color: palette.textSoft }
    },
    grid: {
      top: 48,
      left: 80,
      right: 20,
      bottom: 24
    },
    xAxis: {
      type: "category",
      data: rows.map((item) => item.platform ?? "unknown"),
      axisLabel: { color: palette.textSoft }
    },
    yAxis: {
      type: "value",
      axisLabel: { color: palette.textSoft },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    series: [
      { name: "总额度", type: "bar", data: rows.map((item) => Number(item.quota ?? 0)) },
      { name: "已用", type: "bar", data: rows.map((item) => Number(item.used ?? 0)) },
      { name: "剩余", type: "bar", data: rows.map((item) => Number(item.remaining ?? 0)) }
    ]
  };
}

function buildIdentityBindingOption(rows: IdentityRow[], palette: ChartPalette): ChartOption | null {
  if (rows.length === 0) {
    return null;
  }
  return {
    color: [palette.accent, palette.rose],
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    grid: {
      top: 18,
      left: 92,
      right: 20,
      bottom: 24
    },
    xAxis: {
      type: "value",
      axisLabel: { color: palette.textSoft },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    yAxis: {
      type: "category",
      data: rows.map((item) => item.provider),
      axisLabel: { color: palette.textSoft }
    },
    series: [
      {
        type: "bar",
        data: rows.map((item) => (item.bound ? 1 : 0)),
        label: {
          show: true,
          position: "right",
          color: palette.textStrong,
          formatter: ({ dataIndex }: { dataIndex: number }) => {
            const item = rows[dataIndex];
            return item?.bound ? "已绑定" : "未绑定";
          }
        }
      }
    ]
  };
}

function buildAlertSeverityOption(
  rows: DimensionRow[],
  fallbackRows: Array<{ name: string; count: number; tone: string }>,
  palette: ChartPalette
): ChartOption | null {
  if (rows.length === 0 && fallbackRows.length === 0) {
    return null;
  }
  if (rows.length === 0) {
    return {
      color: [palette.accent, palette.secondary, palette.warning, palette.rose],
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      grid: {
        top: 18,
        left: 64,
        right: 20,
        bottom: 24
      },
      xAxis: {
        type: "category",
        data: fallbackRows.map((item) => item.name),
        axisLabel: { color: palette.textSoft }
      },
      yAxis: {
        type: "value",
        axisLabel: { color: palette.textSoft },
        splitLine: { lineStyle: { color: palette.chartGrid } }
      },
      series: [
        {
          type: "bar",
          barMaxWidth: 28,
          data: fallbackRows.map((item) => item.count)
        }
      ]
    };
  }
  return {
    color: [palette.rose],
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    grid: {
      top: 18,
      left: 64,
      right: 20,
      bottom: 24
    },
    xAxis: {
      type: "category",
      data: rows.map((item) => item.name),
      axisLabel: { color: palette.textSoft }
    },
    yAxis: {
      type: "value",
      axisLabel: { color: palette.textSoft },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    series: [
      {
        type: "bar",
        barMaxWidth: 28,
        data: rows.map((item) => item.count)
      }
    ]
  };
}

function buildRankingOption(
  rows: RankingRow[],
  palette: ChartPalette,
  valueLabel: string
): ChartOption | null {
  if (rows.length === 0) {
    return null;
  }
  const topRows = rows.slice(0, 8);
  return {
    color: [palette.indigo],
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: Array<{ dataIndex: number }>) => {
        const row = topRows[params[0]?.dataIndex ?? 0];
        if (!row) {
          return "暂无数据";
        }
        return [
          `<strong>${row.name}</strong>`,
          `${valueLabel}: ${formatUsd(row.balance, 2)}`,
          `请求: ${row.requests.toLocaleString()}`,
          `活跃: ${row.activeCount.toLocaleString()}`,
          row.detail
        ].join("<br/>");
      }
    },
    grid: {
      top: 18,
      left: 120,
      right: 20,
      bottom: 24
    },
    xAxis: {
      type: "value",
      axisLabel: { color: palette.textSoft },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    yAxis: {
      type: "category",
      data: topRows.map((item) => item.name),
      axisLabel: { color: palette.textSoft }
    },
    series: [
      {
        type: "bar",
        data: topRows.map((item) => item.balance)
      }
    ]
  };
}

interface DimensionRow {
  name: string;
  count: number;
  actualCost: number;
}

interface IdentityRow extends UserIdentityBinding {
  provider: string;
}

interface SubscriptionChartRow {
  name: string;
  status: string;
  dailyUsed: number;
  dailyLimit: number;
  weeklyUsed: number;
  monthlyUsed: number;
  expiresAt?: string | null;
}

interface RankingRow {
  name: string;
  balance: number;
  requests: number;
  activeCount: number;
  detail: string;
}

interface UsageAggregateRow {
  key: string;
  name: string;
  requests: number;
  actualCost: number;
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  averageFirstTokenMs: number;
  averageDurationMs: number;
  rateMultiplierAverage: number;
}

interface UsageHeatmapRow {
  weekday: number;
  hour: number;
  requests: number;
  actualCost: number;
}

interface EndpointFlowRow {
  source: string;
  target: string;
  requests: number;
  actualCost: number;
}

interface EfficiencyRow {
  name: string;
  requests: number;
  totalTokens: number;
  actualCost: number;
  totalCost: number;
  costPerRequest: number;
  costPerMillion: number;
  premiumRatio: number;
}

interface PremiumRow {
  name: string;
  premiumRatio: number;
  actualCost: number;
  totalCost: number;
}

interface ExtremeRequestRow {
  name: string;
  model: string;
  actualCost: number;
  totalTokens: number;
  durationMs: number;
  firstTokenMs: number;
}

function mapAnalyticsAggregateRows(rows: UsageAnalyticsAggregatePoint[]): UsageAggregateRow[] {
  return rows.map((row) => ({
    key: row.key,
    name: row.label,
    requests: row.requests,
    actualCost: row.actualCost,
    totalCost: row.totalCost,
    totalTokens: row.totalTokens,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    cacheReadTokens: row.cacheReadTokens,
    averageFirstTokenMs: row.averageFirstTokenMs,
    averageDurationMs: row.averageDurationMs,
    rateMultiplierAverage: row.averageRateMultiplier
  }));
}

function mapAnalyticsDimensionRows(rows: UsageAnalyticsAggregatePoint[]): DimensionRow[] {
  return rows.map((row) => ({
    name: row.label,
    count: row.requests,
    actualCost: row.actualCost
  }));
}

function buildAnalyticsTrendPayload(payload: UsageAnalyticsPayload): UsageTrendPayload {
  return {
    startDate: payload.startDate,
    endDate: payload.endDate,
    granularity: "day",
    trend: payload.trend
  };
}

function buildAnalyticsModelsPayload(payload: UsageAnalyticsPayload): DashboardModelsPayload {
  return {
    startDate: payload.startDate,
    endDate: payload.endDate,
    models: payload.models.map((row) => ({
      model: row.label,
      requests: row.requests,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheCreationTokens: row.cacheCreationTokens,
      cacheReadTokens: row.cacheReadTokens,
      totalTokens: row.totalTokens,
      cost: row.totalCost,
      actualCost: row.actualCost
    }))
  };
}

function buildDimensionRows<T>(rows: T[], getName: (row: T) => string) {
  const bucket = new Map<string, DimensionRow>();
  for (const row of rows) {
    const name = getName(row) || "unknown";
    const current = bucket.get(name) ?? { name, count: 0, actualCost: 0 };
    current.count += 1;
    if (typeof row === "object" && row && "actualCost" in (row as Record<string, unknown>)) {
      current.actualCost += Number((row as { actualCost?: number | null }).actualCost ?? 0);
    }
    bucket.set(name, current);
  }
  return Array.from(bucket.values()).sort((left, right) => {
    if (right.count !== left.count) {
      return right.count - left.count;
    }
    return right.actualCost - left.actualCost;
  });
}

function buildEfficiencyRows(rows: UsageAggregateRow[]): EfficiencyRow[] {
  return rows
    .map((row) => ({
      name: row.name,
      requests: row.requests,
      totalTokens: row.totalTokens,
      actualCost: row.actualCost,
      totalCost: row.totalCost,
      costPerRequest: row.requests > 0 ? row.actualCost / row.requests : 0,
      costPerMillion: row.totalTokens > 0 ? (row.actualCost / row.totalTokens) * 1_000_000 : 0,
      premiumRatio: row.totalCost > 0 ? row.actualCost / row.totalCost : row.rateMultiplierAverage || 0
    }))
    .sort((left, right) => right.actualCost - left.actualCost)
    .slice(0, 12);
}

function buildCacheEfficiencyRows(rows: UsageAggregateRow[]) {
  return rows
    .map((row) => ({
      name: row.name,
      cacheRatio: row.totalTokens > 0 ? row.cacheReadTokens / row.totalTokens : 0,
      cacheReadTokens: row.cacheReadTokens,
      totalTokens: row.totalTokens,
      actualCost: row.actualCost
    }))
    .sort((left, right) => right.cacheReadTokens - left.cacheReadTokens)
    .slice(0, 12);
}

function buildPremiumRows(rows: UsageAggregateRow[]): PremiumRow[] {
  return rows
    .map((row) => ({
      name: row.name,
      premiumRatio: row.totalCost > 0 ? row.actualCost / row.totalCost : row.rateMultiplierAverage || 0,
      actualCost: row.actualCost,
      totalCost: row.totalCost
    }))
    .filter((row) => row.actualCost > 0)
    .sort((left, right) => right.premiumRatio - left.premiumRatio)
    .slice(0, 12);
}

function buildLatencyRows(rows: UsageAggregateRow[]) {
  return rows
    .filter((row) => row.averageDurationMs > 0 || row.averageFirstTokenMs > 0)
    .sort((left, right) => right.averageDurationMs - left.averageDurationMs)
    .slice(0, 12);
}

function buildExtremeRequestRows(rows: UsageRow[]): ExtremeRequestRow[] {
  return rows
    .map((row) => ({
      name: row.apiKeyName ?? row.endpoint ?? row.model,
      model: row.model,
      actualCost: row.actualCost ?? 0,
      totalTokens: row.totalTokens ?? 0,
      durationMs: row.durationMs ?? 0,
      firstTokenMs: row.firstTokenMs ?? 0
    }))
    .sort((left, right) => {
      if (right.actualCost !== left.actualCost) {
        return right.actualCost - left.actualCost;
      }
      if (right.totalTokens !== left.totalTokens) {
        return right.totalTokens - left.totalTokens;
      }
      return right.durationMs - left.durationMs;
    })
    .slice(0, 12);
}

function buildUsageRankingRows(rows: UsageAggregateRow[]) {
  return rows.slice(0, 12).map((row) => ({
    name: row.name,
    balance: row.actualCost,
    requests: row.requests,
    activeCount: Math.round(row.totalTokens),
    detail: `${compact(row.totalTokens)} tokens · ${formatUsdPerMillion(row.actualCost, row.totalTokens)}`
  }));
}

function buildSiteRankings(overview: OverviewPayload | null): RankingRow[] {
  if (!overview) {
    return [];
  }
  return overview.sites
    .map((site) => {
      const siteAccounts = overview.accounts.filter((item) => item.siteId === site.id);
      return {
        name: site.name,
        balance: siteAccounts.reduce((sum, item) => sum + (item.cacheView?.balance ?? 0), 0),
        requests: siteAccounts.reduce((sum, item) => sum + (item.cacheView?.stats.totalRequests ?? 0), 0),
        activeCount: siteAccounts.filter((item) => item.sessionState === "ready").length,
        detail: `${siteAccounts.length} 个账号 · ${site.baseUrl}`
      };
    })
    .sort((left, right) => right.balance - left.balance);
}

function buildAccountRankings(overview: OverviewPayload | null): RankingRow[] {
  if (!overview) {
    return [];
  }
  return overview.accounts
    .map((account) => ({
      name: account.label,
      balance: account.cacheView?.balance ?? 0,
      requests: account.cacheView?.stats.totalRequests ?? 0,
      activeCount: account.sessionState === "ready" ? 1 : 0,
      detail: `${account.site?.name ?? "未知站点"} · ${maskEmail(account.email)}`
    }))
    .sort((left, right) => {
      if (right.balance !== left.balance) {
        return right.balance - left.balance;
      }
      return right.requests - left.requests;
    });
}

function buildAlertSeverityRows(overview: OverviewPayload | null) {
  return buildDimensionRows(overview?.alerts ?? [], (item) => item.severity);
}

function buildPlatformQuotaFallbackRows(rows: UsageAggregateRow[]) {
  return rows.map((row) => ({
    platform: row.name,
    requests: row.requests,
    actualCost: row.actualCost,
    totalTokens: row.totalTokens
  }));
}

function buildAccountHealthRows(overview: OverviewPayload | null) {
  if (!overview) {
    return [];
  }
  const counts = new Map<string, number>([
    ["正常", 0],
    ["需关注", 0],
    ["离线", 0]
  ]);

  for (const account of overview.accounts) {
    const alerts = account.cacheView?.alerts ?? [];
    const online = account.cacheView?.online ?? false;
    let bucket = "正常";
    if (!online) {
      bucket = "离线";
    } else if (alerts.length > 0 || account.lastError) {
      bucket = "需关注";
    }
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count, tone: name }))
    .filter((item) => item.count > 0);
}

function buildIdentityRows(profileRecord: UserProfileRecord | null): IdentityRow[] {
  if (!profileRecord) {
    return [];
  }
  const source =
    Object.keys(profileRecord.identityBindings).length > 0
      ? profileRecord.identityBindings
      : Object.keys(profileRecord.identities).length > 0
        ? profileRecord.identities
        : profileRecord.authBindings;
  return Object.entries(source).map(([provider, binding]) => ({
    ...binding,
    provider
  }));
}

function buildSubscriptionRows(
  summary: SubscriptionSummaryPayload | null,
  fallbackSubscriptions: SubscriptionRecord[],
  usageRows: UsageAggregateRow[]
): SubscriptionChartRow[] {
  const aggregateMap = new Map(
    usageRows.map((item) => [item.name, item])
  );

  if (summary?.subscriptions.length) {
    return summary.subscriptions.map((item) => ({
      name: item.groupName,
      status: item.status,
      dailyUsed: item.dailyUsedUsd,
      dailyLimit: item.dailyLimitUsd,
      weeklyUsed: item.weeklyUsedUsd,
      monthlyUsed: item.monthlyUsedUsd,
      expiresAt: item.expiresAt
    }));
  }

  return fallbackSubscriptions.map((item) => ({
    name: item.groupName ?? item.name,
    status: item.status,
    dailyUsed: item.daily?.current ?? aggregateMap.get(item.groupName ?? item.name)?.actualCost ?? 0,
    dailyLimit: item.daily?.limit ?? 0,
    weeklyUsed: item.weekly?.current ?? aggregateMap.get(item.groupName ?? item.name)?.actualCost ?? 0,
    monthlyUsed: item.monthly?.current ?? aggregateMap.get(item.groupName ?? item.name)?.actualCost ?? 0,
    expiresAt: item.expiresAt
  }));
}

function coerceManagedKeys(keys: KeyRecord[]): ManagedKeyRecord[] {
  return keys.map((item) => ({
    ...item,
    apiKeyId: item.id ? Number(item.id) : null
  }));
}

function formatUsd(value?: number | null, digits = 6) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return `$${Number(value).toFixed(digits)}`;
}

function formatUsdPerMillion(cost?: number | null, tokens?: number | null) {
  if (!cost || !tokens || tokens <= 0) {
    return "-";
  }
  return `${formatUsd((cost / tokens) * 1_000_000, 4)} / 1M Token`;
}

function formatNumber(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return Number(value).toFixed(2);
}

function formatDateTimeFull(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function formatDurationSeconds(value?: number | null) {
  if (value === null || value === undefined || value <= 0) {
    return "-";
  }
  return `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} s`;
}

function formatMilliseconds(value?: number | null) {
  if (value === null || value === undefined || value <= 0) {
    return "-";
  }
  return `${Math.round(value)} ms`;
}

function formatRemainingDaysLabel(value?: string | null) {
  if (!value) {
    return "暂无到期时间";
  }
  const target = new Date(value);
  if (Number.isNaN(target.getTime())) {
    return value;
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const remainingDays = Math.ceil((target.getTime() - Date.now()) / dayMs);
  if (remainingDays < 0) {
    return "已到期";
  }
  if (remainingDays === 0) {
    return "今天到期";
  }
  return `剩余 ${remainingDays} 天`;
}

function formatBillingMode(mode?: string | null, billingType?: number | null) {
  if (mode && billingType) {
    return `${mode} / #${billingType}`;
  }
  if (mode) {
    return mode;
  }
  if (billingType) {
    return `#${billingType}`;
  }
  return "-";
}

function compact(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  if (local.length <= 3) {
    return `${local.charAt(0) || "*"}***@${domain}`;
  }
  return `${local.slice(0, 3)}***@${domain}`;
}
