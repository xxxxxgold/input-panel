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

export function AnalyticsLab(props: AnalyticsLabProps) {
  const {
    overview,
    selectedAccount,
    managedKeys,
    usageStats,
    usageTrend,
    usageModels,
    usageRecords,
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
  const sampleRows = usageRecords?.items ?? [];
  const selectedKey = keys.find((item) => item.id === keyUsageKeyId) ?? null;
  const platformSeries = selectedSnapshot?.stats.byPlatform ?? overview?.platformSeries ?? [];
  const siteRankings = buildSiteRankings(overview);
  const accountRankings = buildAccountRankings(overview);
  const endpointRows = buildDimensionRows(sampleRows, (row) => row.endpoint ?? "unknown");
  const reasoningRows = buildDimensionRows(sampleRows, (row) => row.reasoningEffort ?? "unknown");
  const requestTypeRows = buildDimensionRows(sampleRows, (row) => row.requestType ?? (row.stream ? "stream" : "standard"));
  const userAgentRows = buildDimensionRows(sampleRows, (row) => simplifyUserAgent(row.userAgent));
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
    : "尚未加载 usage 明细。";
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
            <p>{sampleFootnote}</p>
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
            <p>筛选会影响 usage 汇总、样本散点、端点分布、模型效率和请求明细。</p>
          </div>
        </div>
        <div className="analytics-kpi-grid">
          <AnalyticsStatCard label="当前总请求" value={usageStats?.totalRequests.toLocaleString() ?? "-"} hint="基于当前筛选条件" />
          <AnalyticsStatCard label="当前实际成本" value={formatUsd(usageStats?.totalActualCost, 4)} hint={formatUsdPerMillion(usageStats?.totalActualCost, usageStats?.totalTokens)} />
          <AnalyticsStatCard label="当前总 Tokens" value={usageStats ? compact(usageStats.totalTokens) : "-"} hint={`输入 ${compact(usageStats?.totalInputTokens ?? 0)} / 输出 ${compact(usageStats?.totalOutputTokens ?? 0)}`} />
          <AnalyticsStatCard label="缓存命中" value={usageStats ? compact((usageStats.totalCacheReadTokens ?? 0) + (usageStats.totalCacheCreationTokens ?? 0)) : "-"} hint={`读取 ${compact(usageStats?.totalCacheReadTokens ?? 0)} / 写入 ${compact(usageStats?.totalCacheCreationTokens ?? 0)}`} />
          <AnalyticsStatCard label="平均耗时" value={formatDurationSeconds(usageStats?.averageDurationMs)} hint={`RPM ${formatNumber(usageStats?.rpm)} / TPM ${usageStats?.tpm ? compact(usageStats.tpm) : "-"}`} />
          <AnalyticsStatCard label="活跃订阅" value={String(subscriptionSummary?.activeCount ?? selectedSnapshot?.subscriptions.length ?? 0)} hint={`已用 ${formatUsd(subscriptionSummary?.totalUsedUsd ?? 0, 2)}`} />
          <AnalyticsStatCard label="可管理 Key" value={String(keys.length)} hint={`活跃 ${String(keys.filter((item) => item.status === "active").length)}`} />
          <AnalyticsStatCard label="身份绑定" value={`${identityRows.filter((item) => item.bound).length} / ${identityRows.length}`} hint={profileRecord ? maskEmail(profileRecord.email) : "等待资料接口"} />
        </div>
      </section>

      <div className="content-grid analytics-lab-grid">
        <AnalyticsChartCard
          title="成本 / 请求 / Token 趋势"
          subtitle="使用 dashboard/trend 的时间序列, 同时观察成本、请求量、Token 规模。"
          option={buildUsageTrendOption(usageTrend, palette)}
          footer={usageTrend ? <AnalyticsFootnote>开始 {usageTrend.startDate || "-"} · 结束 {usageTrend.endDate || "-"}</AnalyticsFootnote> : null}
        />
        <AnalyticsChartCard
          title="模型成本排行"
          subtitle="使用 dashboard/models, 看哪几个模型最烧钱。"
          option={buildModelCostOption(usageModels, palette)}
        />
        <AnalyticsChartCard
          title="模型 Token 构成"
          subtitle="横向堆叠, 同时对比输入、输出、缓存写入、缓存读取。"
          option={buildModelTokenOption(usageModels, palette)}
        />
        <AnalyticsChartCard
          title="平台全景"
          subtitle="按平台对比实际成本、请求数、Token 数, 一眼看出主力平台。"
          option={buildPlatformOverviewOption(platformSeries, palette)}
        />
        <AnalyticsChartCard
          title="请求样本散点"
          subtitle="使用当前 usage 样本页: X 轴总 Token, Y 轴实际成本, 气泡大小代表耗时。"
          option={buildRequestScatterOption(sampleRows, palette)}
          footer={<AnalyticsFootnote>{sampleFootnote}</AnalyticsFootnote>}
        />
        <AnalyticsChartCard
          title="端点分布"
          subtitle="看哪些 endpoint 在当前筛选区间内最常出现。"
          option={buildDimensionBarOption(endpointRows, palette, "endpoint")}
        />
        <AnalyticsChartCard
          title="推理强度分布"
          subtitle="从 usage 样本里看 `reasoning_effort` 的占比。"
          option={buildDimensionDonutOption(reasoningRows, palette, "推理强度")}
        />
        <AnalyticsChartCard
          title="请求类型分布"
          subtitle="基于 `request_type` 和 stream 标记整理的调用类型视图。"
          option={buildDimensionDonutOption(requestTypeRows, palette, "请求类型")}
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
                  <AnalyticsEmptyState title="当前没有 User-Agent 样本" detail="样本页没有 user_agent 字段时这里会为空。" />
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
        <div className="analytics-chart-shell">
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
      secondary: "#7aa2ff",
      tertiary: "#53cdb5",
      warning: "#eab308",
      rose: "#d6455f",
      indigo: "#7c3aed",
      sky: "#0ea5e9",
      textStrong: "#101826",
      textSoft: "#6a778d",
      border: "rgba(16, 24, 38, 0.12)",
      grid: "rgba(16, 24, 38, 0.08)"
    };
  }
  const style = getComputedStyle(document.documentElement);
  return {
    accent: style.getPropertyValue("--accent").trim() || "#68c4ba",
    secondary: "#7aa2ff",
    tertiary: "#53cdb5",
    warning: "#eab308",
    rose: style.getPropertyValue("--danger").trim() || "#d6455f",
    indigo: "#7c3aed",
    sky: "#0ea5e9",
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
