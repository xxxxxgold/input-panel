import type { ReactNode } from "react";
import { EChartCard as BaseEChartCard, type ChartOption } from "../../charts";
import type {
  AccountRuntime,
  DailyUsagePoint,
  ManagedKeyRecord,
  OverviewPayload,
  PaginatedResult,
  PlatformQuotaPayload,
  SubscriptionRecord,
  SubscriptionSummaryPayload,
  UsageRow,
  UsageStatsRecord,
  UsageTrendPayload,
  UserIdentityBinding,
  UserProfileRecord,
  DashboardModelsPayload
} from "../../types";

interface AnalyticsLabProps {
  overview: OverviewPayload | null;
  selectedAccount: AccountRuntime | null;
  managedKeys: PaginatedResult<ManagedKeyRecord> | null;
  usageStats: UsageStatsRecord | null;
  usageTrend: UsageTrendPayload | null;
  usageModels: DashboardModelsPayload | null;
  usageRecords: PaginatedResult<UsageRow> | null;
  usageScopeRows: UsageRow[];
  usageScopeMeta: {
    total: number;
    pages: number;
    loadedPages: number;
    pageSize: number;
  } | null;
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

const ANALYTICS_SAMPLE_ROWS = 20;

export function AnalyticsLab(props: AnalyticsLabProps) {
  const {
    overview,
    selectedAccount,
    managedKeys,
    usageStats,
    usageTrend,
    usageModels,
    usageRecords,
    usageScopeRows,
    usageScopeMeta,
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
  const selectedSnapshot = selectedAccount?.snapshot ?? null;
  const keys = managedKeys?.items ?? [];
  const scopedRows = usageScopeRows;
  const effectiveUsageStats = usageStats ?? (scopedRows.length > 0 ? buildUsageStatsFromRows(scopedRows, usageStartDate, usageEndDate) : null);
  const sampleRows = usageRecords?.items ?? scopedRows.slice(0, ANALYTICS_SAMPLE_ROWS);
  const selectedKey = keys.find((item) => item.id === keyUsageKeyId) ?? null;
  const platformSeries = selectedSnapshot?.stats.byPlatform ?? overview?.platformSeries ?? [];
  const scopedTrend = scopedRows.length > 0 ? buildScopedTrendPayload(scopedRows) : usageTrend;
  const scopedModels = scopedRows.length > 0 ? buildScopedModelsPayload(scopedRows) : usageModels;
  const scopedPlatformSeries = buildScopedPlatformRows(scopedRows);
  const endpointUsageRows = buildUsageAggregateRows(scopedRows, (row) => row.endpoint ?? "unknown");
  const modelUsageRows = buildUsageAggregateRows(scopedRows, (row) => row.model || "unknown");
  const keyUsageAggregates = buildUsageAggregateRows(
    scopedRows,
    (row) => row.apiKeyName ?? (row.apiKeyId ? `#${row.apiKeyId}` : "未知 Key")
  );
  const groupUsageAggregates = buildUsageAggregateRows(
    scopedRows,
    (row) => row.groupName ?? row.subscriptionName ?? "未分组"
  );
  const subscriptionUsageAggregates = buildUsageAggregateRows(
    scopedRows,
    (row) => row.subscriptionName ?? row.groupName ?? "未归属订阅"
  );
  const comboRows = buildDimensionRows(
    scopedRows,
    (row) => `${row.stream ? "stream" : row.requestType ?? "standard"} × ${row.reasoningEffort ?? "unknown"}`
  );
  const heatmapRows = buildUsageTimeHeatmapRows(scopedRows);
  const upstreamFlowRows = buildEndpointFlowRows(scopedRows);
  const modelLatencyRows = buildLatencyRows(modelUsageRows);
  const endpointLatencyRows = buildLatencyRows(endpointUsageRows);
  const cacheEfficiencyRows = buildCacheEfficiencyRows(modelUsageRows);
  const efficiencyRows = buildEfficiencyRows(modelUsageRows);
  const costBreakdownRows = buildCostBreakdownRows(scopedRows);
  const premiumRows = buildPremiumRows(groupUsageAggregates);
  const keyCostRankingRows = buildUsageRankingRows(keyUsageAggregates);
  const groupCostRankingRows = buildUsageRankingRows(groupUsageAggregates);
  const subscriptionCostRankingRows = buildUsageRankingRows(subscriptionUsageAggregates);
  const extremeRows = buildExtremeRequestRows(scopedRows);
  const siteRankings = buildSiteRankings(overview);
  const accountRankings = buildAccountRankings(overview);
  const endpointRows = buildDimensionRows(scopedRows, (row) => row.endpoint ?? "unknown");
  const reasoningRows = buildDimensionRows(scopedRows, (row) => row.reasoningEffort ?? "unknown");
  const requestTypeRows = buildDimensionRows(scopedRows, (row) => row.requestType ?? (row.stream ? "stream" : "standard"));
  const userAgentRows = buildDimensionRows(scopedRows, (row) => simplifyUserAgent(row.userAgent));
  const keyStatusRows = buildDimensionRows(keys, (key) => key.status || "unknown");
  const identityRows = buildIdentityRows(profileRecord);
  const quotaRows = platformQuotas?.platformQuotas ?? [];
  const subscriptionRows = buildSubscriptionRows(subscriptionSummary, selectedSnapshot?.subscriptions ?? []);
  const alertSeverityRows = buildAlertSeverityRows(overview);

  const selectedAccountTitle = selectedAccount
    ? `${selectedAccount.label} · ${selectedAccount.site?.name ?? "未命名站点"}`
    : "请先选择账号";
  const sampleFootnote = usageRecords
    ? `当前样本为第 ${usageRecords.page} / ${usageRecords.pages} 页，共 ${usageRecords.total} 条明细。`
    : usageScopeMeta
      ? `当前样本使用筛选范围前 ${ANALYTICS_SAMPLE_ROWS} 条，共 ${usageScopeMeta.total} 条明细。`
      : "尚未加载 usage 明细。";
  const scopedFootnote = usageScopeMeta
    ? `当前筛选范围已聚合 ${usageScopeMeta.loadedPages} / ${usageScopeMeta.pages} 页，共 ${usageScopeMeta.total} 条 usage 明细。`
    : "当前还没有筛选范围聚合数据。";
  const dateLabel = usageStartDate && usageEndDate ? `${usageStartDate} ~ ${usageEndDate}` : "请选择时间范围";

  if (!overview) {
    return (
      <section className="section-card analytics-lab-empty-shell">
        <header className="section-card-header">
          <div>
            <h3>图表实验室</h3>
            <p>等待总览数据就绪后再展示实验页。</p>
          </div>
        </header>
        <AnalyticsEmptyState
          title="当前还没有可分析的数据"
          detail="先让工作台完成一次 overview 加载，再打开这个临时测试页。"
        />
      </section>
    );
  }

  return (
    <div className="analytics-lab-stack">
      <section className="section-card analytics-lab-hero">
        <header className="section-card-header analytics-lab-hero-head">
          <div>
            <h3>图表实验室</h3>
            <p>临时测试页面. 这里把当前能图表化的数据尽量全部展开, 删除时只需回滚这一页即可。</p>
          </div>
          <span className="analytics-lab-badge">TEMP / ECharts</span>
        </header>
        <div className="analytics-lab-meta-grid">
          <div className="analytics-meta-card">
            <span>当前账号</span>
            <strong>{selectedAccountTitle}</strong>
            <p>{selectedSnapshot ? `最后刷新 ${formatDateTimeFull(selectedSnapshot.fetchedAt)}` : "账号还没有快照"}</p>
          </div>
          <div className="analytics-meta-card">
            <span>样本区间</span>
            <strong>{dateLabel}</strong>
            <p>{scopedFootnote}</p>
          </div>
          <div className="analytics-meta-card">
            <span>全局聚合</span>
            <strong>{overview.accounts.length} 个账号 / {overview.sites.length} 个站点</strong>
            <p>今日 {overview.totals.todayRequests.toLocaleString()} 请求, 实际成本 {formatUsd(overview.totals.todayActualCost, 4)}</p>
          </div>
        </div>
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
            <span>Usage Key 筛选</span>
            <select
              value={usageApiKeyFilter}
              onChange={(event) => onUsageApiKeyFilterChange(event.target.value)}
            >
              <option value="">全部 Key</option>
              {keys.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field analytics-filter">
            <span>单 Key 趋势</span>
            <select
              value={keyUsageKeyId}
              onChange={(event) => onKeyUsageSelect(event.target.value)}
            >
              <option value="">请选择 Key</option>
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
            <p>筛选会影响 usage 汇总、全量范围聚合图表和当前页样本明细。散点与明细仍保留当前页样本视角。</p>
          </div>
        </div>
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
          <AnalyticsStatCard label="活跃订阅" value={String(subscriptionSummary?.activeCount ?? selectedSnapshot?.subscriptions.length ?? 0)} hint={`已用 ${formatUsd(subscriptionSummary?.totalUsedUsd ?? 0, 2)}`} />
          <AnalyticsStatCard label="可管理 Key" value={String(keys.length)} hint={`活跃 ${String(keys.filter((item) => item.status === "active").length)}`} />
          <AnalyticsStatCard label="身份绑定" value={`${identityRows.filter((item) => item.bound).length} / ${identityRows.length}`} hint={profileRecord ? maskEmail(profileRecord.email) : "等待资料接口"} />
        </div>
      </section>

      <div className="content-grid analytics-lab-grid">
        <AnalyticsChartCard
          title="成本 / 请求 / Token 趋势"
          subtitle="使用 dashboard/trend 的时间序列, 同时观察成本、请求量、Token 规模。"
          option={buildUsageTrendOption(scopedTrend, palette)}
          footer={scopedTrend ? <AnalyticsFootnote>开始 {scopedTrend.startDate || "-"} · 结束 {scopedTrend.endDate || "-"}</AnalyticsFootnote> : null}
        />
        <AnalyticsChartCard
          title="模型成本排行"
          subtitle="使用 dashboard/models, 看哪几个模型最烧钱。"
          option={buildModelCostOption(scopedModels, palette)}
        />
        <AnalyticsChartCard
          title="模型 Token 构成"
          subtitle="横向堆叠, 同时对比输入、输出、缓存写入、缓存读取。"
          option={buildModelTokenOption(scopedModels, palette)}
        />
        <AnalyticsChartCard
          title="平台全景"
          subtitle="按平台对比实际成本、请求数、Token 数, 一眼看出主力平台。"
          option={buildPlatformOverviewOption(scopedPlatformSeries.length > 0 ? scopedPlatformSeries : platformSeries, palette)}
        />
        <AnalyticsChartCard
          title="延迟分位"
          subtitle="基于当前筛选范围, 看首 Token 与总耗时的 p50 / p90 / p99。"
          option={buildLatencyPercentileOption(scopedRows, palette)}
          footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
        />
        <AnalyticsChartCard
          title="成本拆解"
          subtitle="按输入、输出、缓存写入、缓存读取拆开成本结构。"
          option={buildCostBreakdownOption(costBreakdownRows, palette)}
          footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
        />
        <AnalyticsChartCard
          title="模型溢价分析"
          subtitle="看各模型实际成本相对原始成本的放大倍数。"
          option={buildEfficiencyScatterOption(efficiencyRows, palette)}
          footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
        />
        <AnalyticsChartCard
          title="请求样本散点"
          subtitle="使用当前 usage 样本页: X 轴总 Token, Y 轴实际成本, 气泡大小代表耗时。"
          option={buildRequestScatterOption(sampleRows, palette)}
          footer={<AnalyticsFootnote>{sampleFootnote}</AnalyticsFootnote>}
        />
        <AnalyticsChartCard
          title="端点分布"
          subtitle="基于当前筛选范围的全部 usage 明细聚合, 看哪些 endpoint 最常出现。"
          option={buildDimensionBarOption(endpointRows, palette, "endpoint")}
          footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
        />
        <AnalyticsChartCard
          title="推理强度分布"
          subtitle="基于当前筛选范围的全部 usage 明细, 看 `reasoning_effort` 的占比。"
          option={buildDimensionDonutOption(reasoningRows, palette, "推理强度")}
          footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
        />
        <AnalyticsChartCard
          title="请求类型分布"
          subtitle="基于当前筛选范围的全部 usage 明细, 按 `request_type` 和 stream 标记聚合。"
          option={buildDimensionDonutOption(requestTypeRows, palette, "请求类型")}
          footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
        />
        <AnalyticsChartCard
          title="请求类型 × 推理强度"
          subtitle="看 stream / standard 与 reasoning effort 的组合占比。"
          option={buildDimensionBarOption(comboRows, palette, "组合请求")}
          footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
        />
        <AnalyticsChartCard
          title="时段热力图"
          subtitle="按星期与小时聚合请求强度, 看什么时候最忙。"
          option={buildUsageHeatmapOption(heatmapRows, palette)}
          footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
        />
        <AnalyticsChartCard
          title="Key 状态分布"
          subtitle="当前账号下 Key 的状态占比。"
          option={buildDimensionDonutOption(keyStatusRows, palette, "Key 状态")}
        />
        <AnalyticsChartCard
          title="Key 配额 vs 已用"
          subtitle="横向条形图, 优先展示额度最高或已用最多的 Key。"
          option={buildKeyQuotaOption(keys, palette)}
        />
        <AnalyticsChartCard
          title="Key 限流窗口"
          subtitle="对比 5h / 1d / 7d 的限额与已用量, 找出最接近上限的 Key。"
          option={buildKeyWindowOption(keys, palette)}
        />
        <AnalyticsChartCard
          title="单 Key 每日趋势"
          subtitle={selectedKey ? `${selectedKey.name} · 近 30 天 daily usage` : "请选择一个 Key 以查看最近 30 天趋势"}
          option={buildKeyDailyTrendOption(keyUsageRows, palette)}
          footer={
            selectedKey ? (
              <AnalyticsFootnote>
                状态 {selectedKey.status} · 最近使用 {selectedKey.lastUsedAt ? formatDateTimeFull(selectedKey.lastUsedAt) : "暂无"}
                {keyUsageRows.length === 0 ? " · 当前接口未返回 daily usage 数据" : ""}
              </AnalyticsFootnote>
            ) : null
          }
        />
        <AnalyticsChartCard
          title="订阅额度使用"
          subtitle="优先使用 subscriptions/summary, 没有时回退到 subscriptions 窗口数据。"
          option={buildSubscriptionUsageOption(subscriptionRows, palette)}
        />
        <AnalyticsChartCard
          title="缓存效率"
          subtitle="按模型看缓存读取占全部 Token 的比例与成本。"
          option={buildCacheEfficiencyOption(cacheEfficiencyRows, palette)}
          footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
        />
        <AnalyticsChartCard
          title="Endpoint 上下游映射"
          subtitle="看入口 endpoint 与 upstream endpoint 的主要流向。"
          option={buildEndpointFlowOption(upstreamFlowRows, palette)}
          footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
        />
        <AnalyticsChartCard
          title="平台配额"
          subtitle="对齐 user/platform-quotas, 展示 quota / used / remaining。"
          option={buildPlatformQuotaOption(quotaRows, palette)}
        />
        <AnalyticsChartCard
          title="身份绑定概览"
          subtitle="看邮箱、OIDC、微信、LinuxDo 等身份绑定状态。"
          option={buildIdentityBindingOption(identityRows, palette)}
        />
        <AnalyticsChartCard
          title="告警严重级别"
          subtitle="把 overview 的告警按严重程度做聚合, 方便排优先级。"
          option={buildAlertSeverityOption(alertSeverityRows, palette)}
        />
        <AnalyticsChartCard
          title="站点余额排行"
          subtitle="按站点聚合余额, 快速定位余额最多和异常最多的站点。"
          option={buildRankingOption(siteRankings, palette, "余额")}
        />
        <AnalyticsChartCard
          title="账号余额排行"
          subtitle="把站点下的账号余额、请求数、活跃状态放到一个直观排行里。"
          option={buildRankingOption(accountRankings, palette, "余额")}
        />
        <AnalyticsChartCard
          title="Key 成本排行"
          subtitle="按 Key 聚合请求数、Token 和实际成本。"
          option={buildUsageRankingBarOption(keyCostRankingRows, palette, "Key 成本")}
          footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
        />
        <AnalyticsChartCard
          title="分组成本站位"
          subtitle="按 group / subscription 聚合看谁最烧钱。"
          option={buildUsageRankingBarOption(groupCostRankingRows, palette, "分组成本站位")}
          footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
        />
        <AnalyticsChartCard
          title="订阅成本排行"
          subtitle="按订阅名称聚合当前筛选范围的成本与请求。"
          option={buildUsageRankingBarOption(subscriptionCostRankingRows, palette, "订阅成本")}
          footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
        />
        <AnalyticsChartCard
          title="模型延迟排行"
          subtitle="按模型比较平均首 Token 与平均总耗时。"
          option={buildLatencyComparisonOption(modelLatencyRows, palette, "模型")}
          footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
        />
        <AnalyticsChartCard
          title="Endpoint 延迟排行"
          subtitle="按 endpoint 看哪些路径最慢。"
          option={buildLatencyComparisonOption(endpointLatencyRows, palette, "endpoint")}
          footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
        />
        <AnalyticsChartCard
          title="极值请求榜"
          subtitle="把单次最贵、最长、最大 Token 的请求集中看。"
          option={buildExtremeRowsOption(extremeRows, palette)}
          footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
        />
        <AnalyticsChartCard
          title="分组溢价排行"
          subtitle="按分组看实际成本 / 原始成本 的放大倍数。"
          option={buildPremiumBarOption(premiumRows, palette)}
          footer={<AnalyticsFootnote>{scopedFootnote}</AnalyticsFootnote>}
        />
      </div>

      <section className="content-grid analytics-detail-grid">
        <section className="section-card">
          <header className="section-card-header">
            <div>
              <h3>请求样本明细</h3>
              <p>当前页面样本的高价值字段, 方便和图表互相对照。</p>
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
              <AnalyticsEmptyState title="当前没有 usage 样本" detail="先调整筛选后点击“刷新筛选结果”拉一页 usage 明细。" />
            )}
          </div>
        </section>

        <section className="section-card">
          <header className="section-card-header">
            <div>
              <h3>User-Agent / 身份 / 订阅清单</h3>
              <p>把一些不适合大图但很有价值的直观信息集中展示。</p>
            </div>
          </header>
          <div className="analytics-detail-columns">
            <div className="stack-list">
              <div className="section-mini-title">User-Agent Top</div>
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
                  <AnalyticsEmptyState title="当前没有 User-Agent 聚合" detail="当前筛选范围内没有可用的 user_agent 字段。" />
                )}
              </div>
            </div>
            <div className="stack-list">
              <div className="section-mini-title">身份绑定</div>
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
                  <AnalyticsEmptyState title="当前没有身份绑定数据" detail="先确保 user/profile 已返回 identities 或 identity_bindings。" />
                )}
              </div>
            </div>
            <div className="stack-list">
              <div className="section-mini-title">订阅窗口清单</div>
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
                  <AnalyticsEmptyState title="当前没有订阅数据" detail="站点未返回 summary 或 subscriptions 时这里为空。" />
                )}
              </div>
            </div>
          </div>
        </section>
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
  footer
}: {
  title: string;
  subtitle: string;
  option: ChartOption | null;
  footer?: ReactNode;
}) {
  return (
    <section className="section-card analytics-chart-card">
      <header className="section-card-header">
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
      </header>
      {option ? (
        <div className="chart-wrap tall analytics-chart-shell">
          <BaseEChartCard option={option} />
        </div>
      ) : (
        <AnalyticsEmptyState title="当前图表暂无数据" detail="对应接口还没有返回有效数据, 可以先刷新账号或调整筛选。" />
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
    backgroundColor: "transparent",
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
        splitLine: { lineStyle: { color: palette.grid } },
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
    backgroundColor: "transparent",
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
      splitLine: { lineStyle: { color: palette.grid } }
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
      splitLine: { lineStyle: { color: palette.grid } }
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
        splitLine: { lineStyle: { color: palette.grid } },
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

function buildLatencyPercentileOption(rows: UsageRow[], palette: ChartPalette): ChartOption | null {
  const firstToken = buildLatencyPercentiles(rows, (row) => row.firstTokenMs);
  const duration = buildLatencyPercentiles(rows, (row) => row.durationMs);
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
      splitLine: { lineStyle: { color: palette.grid } }
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
  if (rows.length === 0) {
    return null;
  }
  return {
    color: [palette.indigo],
    tooltip: {
      trigger: "item",
      formatter: (params: { data?: [number, number, number, string] }) => {
        const data = params.data;
        if (!data) return "暂无数据";
        return [
          `<strong>${data[3]}</strong>`,
          `单位请求成本: ${formatUsd(data[1], 6)}`,
          `溢价倍率: ${data[0].toFixed(2)}x`,
          `Tokens: ${compact(data[2])}`
        ].join("<br/>");
      }
    },
    grid: { top: 18, left: 56, right: 20, bottom: 28 },
    xAxis: {
      type: "value",
      name: "溢价倍率",
      axisLabel: { color: palette.textSoft },
      splitLine: { lineStyle: { color: palette.grid } }
    },
    yAxis: {
      type: "value",
      name: "单位请求成本",
      axisLabel: { color: palette.textSoft }
    },
    series: [
      {
        type: "scatter",
        symbolSize: (data: [number, number, number]) => Math.max(12, Math.min(48, (data[2] || 0) / 40000)),
        data: rows.map((row) => [row.premiumRatio || 0, row.costPerRequest || 0, row.totalTokens || 0, row.name])
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
      splitLine: { lineStyle: { color: palette.grid } }
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
      splitLine: { lineStyle: { color: palette.grid } }
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

function buildLatencyComparisonOption(rows: UsageAggregateRow[], palette: ChartPalette, label: string): ChartOption | null {
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
      splitLine: { lineStyle: { color: palette.grid } }
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
      splitLine: { lineStyle: { color: palette.grid } }
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
      splitLine: { lineStyle: { color: palette.grid } }
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
      splitLine: { lineStyle: { color: palette.grid } }
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
      splitLine: { lineStyle: { color: palette.grid } }
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

function buildKeyQuotaOption(keys: ManagedKeyRecord[], palette: ChartPalette): ChartOption | null {
  if (keys.length === 0) {
    return null;
  }
  const sorted = keys
    .slice()
    .sort((left, right) => Math.max(right.quota ?? 0, right.quotaUsed ?? 0) - Math.max(left.quota ?? 0, left.quotaUsed ?? 0))
    .slice(0, 8);
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
      splitLine: { lineStyle: { color: palette.grid } }
    },
    yAxis: {
      type: "category",
      data: sorted.map((item) => item.name),
      axisLabel: { color: palette.textSoft }
    },
    series: [
      { name: "额度", type: "bar", data: sorted.map((item) => item.quota ?? 0) },
      { name: "已用", type: "bar", data: sorted.map((item) => item.quotaUsed ?? 0) }
    ]
  };
}

function buildKeyWindowOption(keys: ManagedKeyRecord[], palette: ChartPalette): ChartOption | null {
  if (keys.length === 0) {
    return null;
  }
  const sorted = keys
    .slice()
    .sort((left, right) => Math.max(right.usage7d ?? 0, right.usage1d ?? 0, right.usage5h ?? 0) - Math.max(left.usage7d ?? 0, left.usage1d ?? 0, left.usage5h ?? 0))
    .slice(0, 8);

  return {
    color: [palette.accent, palette.secondary, palette.warning, palette.rose, palette.indigo, palette.sky],
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
      splitLine: { lineStyle: { color: palette.grid } }
    },
    yAxis: {
      type: "category",
      data: sorted.map((item) => item.name),
      axisLabel: { color: palette.textSoft }
    },
    series: [
      { name: "5h 已用", type: "bar", stack: "usage", data: sorted.map((item) => item.usage5h ?? 0) },
      { name: "1d 已用", type: "bar", stack: "usage", data: sorted.map((item) => item.usage1d ?? 0) },
      { name: "7d 已用", type: "bar", stack: "usage", data: sorted.map((item) => item.usage7d ?? 0) },
      { name: "5h 限额", type: "line", data: sorted.map((item) => item.rateLimit5h ?? 0) },
      { name: "1d 限额", type: "line", data: sorted.map((item) => item.rateLimit1d ?? 0) },
      { name: "7d 限额", type: "line", data: sorted.map((item) => item.rateLimit7d ?? 0) }
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
        splitLine: { lineStyle: { color: palette.grid } }
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
      splitLine: { lineStyle: { color: palette.grid } }
    },
    yAxis: {
      type: "category",
      data: rows.map((item) => item.name),
      axisLabel: { color: palette.textSoft }
    },
    series: [
      { name: "日已用", type: "bar", data: rows.map((item) => item.dailyUsed) },
      { name: "日额度", type: "bar", data: rows.map((item) => item.dailyLimit) },
      { name: "周已用", type: "line", data: rows.map((item) => item.weeklyUsed) },
      { name: "月已用", type: "line", data: rows.map((item) => item.monthlyUsed) }
    ]
  };
}

function buildPlatformQuotaOption(
  rows: PlatformQuotaPayload["platformQuotas"],
  palette: ChartPalette
): ChartOption | null {
  if (rows.length === 0) {
    return null;
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
      splitLine: { lineStyle: { color: palette.grid } }
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
      splitLine: { lineStyle: { color: palette.grid } }
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

function buildAlertSeverityOption(rows: DimensionRow[], palette: ChartPalette): ChartOption | null {
  if (rows.length === 0) {
    return null;
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
      splitLine: { lineStyle: { color: palette.grid } }
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
      splitLine: { lineStyle: { color: palette.grid } }
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

interface ChartPalette {
  accent: string;
  secondary: string;
  tertiary: string;
  warning: string;
  rose: string;
  indigo: string;
  sky: string;
  textStrong: string;
  textSoft: string;
  border: string;
  grid: string;
}

function readChartPalette(): ChartPalette {
  if (typeof window === "undefined") {
    return {
      accent: "#68c4ba",
      secondary: "#5e8cff",
      tertiary: "#53cdb5",
      warning: "#e3a62c",
      rose: "#d6455f",
      indigo: "#8d78ff",
      sky: "#4fc8f0",
      textStrong: "#101826",
      textSoft: "#6a778d",
      border: "rgba(16, 24, 38, 0.12)",
      grid: "rgba(16, 24, 38, 0.08)"
    };
  }
  const style = getComputedStyle(document.documentElement);
  return {
    accent: style.getPropertyValue("--accent").trim() || "#68c4ba",
    secondary: style.getPropertyValue("--chart-2").trim() || "#5e8cff",
    tertiary: style.getPropertyValue("--chart-6").trim() || "#53cdb5",
    warning: style.getPropertyValue("--chart-3").trim() || "#e3a62c",
    rose: style.getPropertyValue("--danger").trim() || "#d6455f",
    indigo: style.getPropertyValue("--chart-5").trim() || "#8d78ff",
    sky: style.getPropertyValue("--chart-4").trim() || "#4fc8f0",
    textStrong: style.getPropertyValue("--text-strong").trim() || "#101826",
    textSoft: style.getPropertyValue("--text-subtle").trim() || "#6a778d",
    border: style.getPropertyValue("--border").trim() || "rgba(16, 24, 38, 0.12)",
    grid: style.getPropertyValue("--border-strong").trim() || "rgba(16, 24, 38, 0.08)"
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

interface LatencyPercentileRow {
  name: string;
  p50: number;
  p90: number;
  p99: number;
}

interface ExtremeRequestRow {
  name: string;
  model: string;
  actualCost: number;
  totalTokens: number;
  durationMs: number;
  firstTokenMs: number;
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

function buildUsageAggregateRows(rows: UsageRow[], getName: (row: UsageRow) => string) {
  const bucket = new Map<
    string,
    UsageAggregateRow & {
      firstTokenCount: number;
      durationCount: number;
      multiplierCount: number;
      multiplierTotal: number;
    }
  >();

  for (const row of rows) {
    const name = getName(row) || "unknown";
    const current =
      bucket.get(name) ??
      {
        name,
        requests: 0,
        actualCost: 0,
        totalCost: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        averageFirstTokenMs: 0,
        averageDurationMs: 0,
        rateMultiplierAverage: 0,
        firstTokenCount: 0,
        durationCount: 0,
        multiplierCount: 0,
        multiplierTotal: 0
      };

    current.requests += 1;
    current.actualCost += row.actualCost ?? 0;
    current.totalCost += row.totalCost ?? 0;
    current.totalTokens += row.totalTokens ?? 0;
    current.inputTokens += row.inputTokens ?? 0;
    current.outputTokens += row.outputTokens ?? 0;
    current.cacheCreationTokens += row.cacheCreationTokens ?? 0;
    current.cacheReadTokens += row.cacheReadTokens ?? 0;

    if ((row.firstTokenMs ?? 0) > 0) {
      current.averageFirstTokenMs += row.firstTokenMs ?? 0;
      current.firstTokenCount += 1;
    }
    if ((row.durationMs ?? 0) > 0) {
      current.averageDurationMs += row.durationMs ?? 0;
      current.durationCount += 1;
    }
    if ((row.rateMultiplier ?? 0) > 0) {
      current.multiplierTotal += row.rateMultiplier ?? 0;
      current.multiplierCount += 1;
    }
    bucket.set(name, current);
  }

  return Array.from(bucket.values())
    .map((item) => ({
      name: item.name,
      requests: item.requests,
      actualCost: item.actualCost,
      totalCost: item.totalCost,
      totalTokens: item.totalTokens,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      cacheCreationTokens: item.cacheCreationTokens,
      cacheReadTokens: item.cacheReadTokens,
      averageFirstTokenMs: item.firstTokenCount > 0 ? item.averageFirstTokenMs / item.firstTokenCount : 0,
      averageDurationMs: item.durationCount > 0 ? item.averageDurationMs / item.durationCount : 0,
      rateMultiplierAverage: item.multiplierCount > 0 ? item.multiplierTotal / item.multiplierCount : 0
    }))
    .sort((left, right) => right.actualCost - left.actualCost);
}

function buildUsageTimeHeatmapRows(rows: UsageRow[]): UsageHeatmapRow[] {
  const bucket = new Map<string, UsageHeatmapRow>();
  for (const row of rows) {
    const date = new Date(row.createdAt);
    if (Number.isNaN(date.getTime())) {
      continue;
    }
    const weekday = (date.getDay() + 6) % 7;
    const hour = date.getHours();
    const key = `${weekday}-${hour}`;
    const current = bucket.get(key) ?? { weekday, hour, requests: 0, actualCost: 0 };
    current.requests += 1;
    current.actualCost += row.actualCost ?? 0;
    bucket.set(key, current);
  }
  return Array.from(bucket.values());
}

function buildEndpointFlowRows(rows: UsageRow[]): EndpointFlowRow[] {
  const bucket = new Map<string, EndpointFlowRow>();
  for (const row of rows) {
    const source = row.endpoint ?? "unknown";
    const target = row.upstreamEndpoint ?? row.model ?? "unknown";
    const key = `${source} -> ${target}`;
    const current = bucket.get(key) ?? { source, target, requests: 0, actualCost: 0 };
    current.requests += 1;
    current.actualCost += row.actualCost ?? 0;
    bucket.set(key, current);
  }
  return Array.from(bucket.values()).sort((left, right) => right.requests - left.requests).slice(0, 12);
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

function buildCostBreakdownRows(rows: UsageRow[]) {
  return [
    {
      name: "输入成本",
      value: rows.reduce((sum, row) => sum + (row.inputCost ?? 0), 0)
    },
    {
      name: "输出成本",
      value: rows.reduce((sum, row) => sum + (row.outputCost ?? 0), 0)
    },
    {
      name: "缓存写入成本",
      value: rows.reduce((sum, row) => sum + (row.cacheCreationCost ?? 0), 0)
    },
    {
      name: "缓存读取成本",
      value: rows.reduce((sum, row) => sum + (row.cacheReadCost ?? 0), 0)
    }
  ].filter((row) => row.value > 0);
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

function buildLatencyPercentiles(rows: UsageRow[], pickValue: (row: UsageRow) => number | null | undefined): LatencyPercentileRow | null {
  const values = rows
    .map((row) => Number(pickValue(row) ?? 0))
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  if (values.length === 0) {
    return null;
  }
  return {
    name: "延迟",
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    p99: percentile(values, 0.99)
  };
}

function buildScopedTrendPayload(rows: UsageRow[]): UsageTrendPayload | null {
  if (rows.length === 0) {
    return null;
  }
  const bucket = new Map<string, DailyUsagePoint>();
  for (const row of rows) {
    const dateKey = row.createdAt.slice(0, 10);
    const current =
      bucket.get(dateKey) ??
      {
        date: dateKey,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        actualCost: 0,
        totalCost: 0
      };
    current.requests += 1;
    current.inputTokens += row.inputTokens ?? 0;
    current.outputTokens += row.outputTokens ?? 0;
    current.cacheReadTokens = (current.cacheReadTokens ?? 0) + (row.cacheReadTokens ?? 0);
    current.cacheWriteTokens = (current.cacheWriteTokens ?? 0) + (row.cacheCreationTokens ?? 0);
    current.totalTokens = (current.totalTokens ?? 0) + (row.totalTokens ?? 0);
    current.actualCost = (current.actualCost ?? 0) + (row.actualCost ?? 0);
    current.totalCost = (current.totalCost ?? 0) + (row.totalCost ?? 0);
    bucket.set(dateKey, current);
  }
  const trend = Array.from(bucket.values()).sort((left, right) => left.date.localeCompare(right.date));
  return {
    startDate: trend[0]?.date ?? "",
    endDate: trend[trend.length - 1]?.date ?? "",
    granularity: "day",
    trend
  };
}

function buildScopedModelsPayload(rows: UsageRow[]): DashboardModelsPayload | null {
  if (rows.length === 0) {
    return null;
  }
  const aggregates = buildUsageAggregateRows(rows, (row) => row.model || "unknown");
  const trend = buildScopedTrendPayload(rows);
  return {
    startDate: trend?.startDate ?? "",
    endDate: trend?.endDate ?? "",
    models: aggregates.map((row) => ({
      model: row.name,
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

function buildUsageStatsFromRows(
  rows: UsageRow[],
  startDate: string,
  endDate: string
): UsageStatsRecord {
  const totalRequests = rows.length;
  const totalInputTokens = rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0);
  const totalOutputTokens = rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0);
  const totalCacheCreationTokens = rows.reduce((sum, row) => sum + (row.cacheCreationTokens ?? 0), 0);
  const totalCacheReadTokens = rows.reduce((sum, row) => sum + (row.cacheReadTokens ?? 0), 0);
  const totalTokens = rows.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0);
  const totalCost = rows.reduce((sum, row) => sum + (row.totalCost ?? 0), 0);
  const totalActualCost = rows.reduce((sum, row) => sum + (row.actualCost ?? 0), 0);
  const durations = rows.map((row) => row.durationMs ?? 0).filter((value) => value > 0);
  const averageDurationMs = durations.length > 0
    ? durations.reduce((sum, value) => sum + value, 0) / durations.length
    : 0;
  const windowMinutes = inferUsageWindowMinutes(startDate, endDate);

  return {
    totalRequests,
    totalInputTokens,
    totalOutputTokens,
    totalCacheTokens: totalCacheCreationTokens + totalCacheReadTokens,
    totalCacheCreationTokens,
    totalCacheReadTokens,
    totalTokens,
    totalCost,
    totalActualCost,
    averageDurationMs,
    rpm: totalRequests / windowMinutes,
    tpm: totalTokens / windowMinutes
  };
}

function buildScopedPlatformRows(rows: UsageRow[]) {
  return buildUsageAggregateRows(rows, (row) => row.platform ?? "unknown").map((row) => ({
    platform: row.name,
    totalActualCost: row.actualCost,
    totalRequests: row.requests,
    totalTokens: row.totalTokens
  }));
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

function percentile(values: number[], ratio: number) {
  if (values.length === 0) {
    return 0;
  }
  const index = Math.min(values.length - 1, Math.max(0, Math.round((values.length - 1) * ratio)));
  return values[index] ?? 0;
}

function inferUsageWindowMinutes(startDate: string, endDate: string, now: Date = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const start = new Date(`${startDate}T00:00:00`);
  const end = endDate >= today ? now : new Date(`${endDate}T23:59:59`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() < start.getTime()) {
    return 1;
  }
  return Math.max((end.getTime() - start.getTime()) / 60000, 1);
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
        balance: siteAccounts.reduce((sum, item) => sum + (item.snapshot?.balance ?? 0), 0),
        requests: siteAccounts.reduce((sum, item) => sum + (item.snapshot?.stats.totalRequests ?? 0), 0),
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
      balance: account.snapshot?.balance ?? 0,
      requests: account.snapshot?.stats.totalRequests ?? 0,
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
  fallbackSubscriptions: SubscriptionRecord[]
): SubscriptionChartRow[] {
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
    dailyUsed: item.daily?.current ?? 0,
    dailyLimit: item.daily?.limit ?? 0,
    weeklyUsed: item.weekly?.current ?? 0,
    monthlyUsed: item.monthly?.current ?? 0,
    expiresAt: item.expiresAt
  }));
}

function simplifyUserAgent(value?: string | null) {
  if (!value) {
    return "unknown";
  }
  const normalized = value.trim();
  if (!normalized) {
    return "unknown";
  }
  if (normalized.includes("Codex Desktop")) {
    return "Codex Desktop";
  }
  if (normalized.includes("Mozilla")) {
    return "Browser";
  }
  return normalized.length > 48 ? `${normalized.slice(0, 45)}...` : normalized;
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
