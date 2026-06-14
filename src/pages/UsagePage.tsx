import {
  BadgeDollarSign,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  LayoutDashboard,
  MonitorDot,
  RefreshCcw
} from "lucide-react";
import type { MutableRefObject } from "react";

import type {
  DashboardModelsPayload,
  PaginatedResult,
  UsageRow,
  UsageStatsRecord,
  UsageTrendPayload,
  ManagedKeyRecord
} from "../types";
import {
  compact,
  formatBillingMode,
  formatDateTimeFull,
  formatDurationSeconds,
  formatMilliseconds,
  formatUsd,
  formatUsdPerMillion
} from "../shared/lib/formatters";
import { DetailItem } from "../shared/ui/DetailItem";
import { EmptyState } from "../shared/ui/EmptyState";
import { MetricCard } from "../shared/ui/MetricCard";
import { SectionCard } from "../shared/ui/SectionCard";
import { UsageDetailPopover } from "../shared/ui/UsageDetailPopover";
import {
  UsageModelRequestDetails,
  UsageTokenMetricDetails
} from "../features/usage/components/UsageMetricDetails";
import { summarizeUsageRowsByModel, type UsageModelSummary } from "../features/usage/model-summary";
import {
  buildTrendAreaChartOption,
  EChartCard,
  normalizeTrendChartData
} from "../charts";

const USAGE_RANGE_PRESETS = [
  { key: "today", label: "今天" },
  { key: "yesterday", label: "昨天" },
  { key: "last24Hours", label: "近24小时" },
  { key: "last7Days", label: "近 7 天" },
  { key: "last14Days", label: "近 14 天" },
  { key: "last30Days", label: "近 30 天" },
  { key: "thisMonth", label: "本月" },
  { key: "lastMonth", label: "上月" }
] as const;

function getCacheInputTokens(
  totalCacheTokens?: number | null,
  cacheCreationTokens?: number | null,
  cacheReadTokens?: number | null
) {
  if (totalCacheTokens !== null && totalCacheTokens !== undefined && Number.isFinite(totalCacheTokens)) {
    return totalCacheTokens;
  }
  return (cacheCreationTokens ?? 0) + (cacheReadTokens ?? 0);
}

function findTopUsageModel(
  summaries: UsageModelSummary[],
  valueSelector: (summary: UsageModelSummary) => number
) {
  return summaries.reduce<UsageModelSummary | null>((best, summary) => {
    if (!best) {
      return summary;
    }
    const nextValue = valueSelector(summary);
    const bestValue = valueSelector(best);
    if (nextValue !== bestValue) {
      return nextValue > bestValue ? summary : best;
    }
    return summary.totalTokens > best.totalTokens ? summary : best;
  }, null);
}

function buildUsageModelHint(prefix: string, model?: string | null) {
  return model ? `${prefix}: ${model}` : "当前没有模型数据";
}

function normalizeReasoningEffort(value?: string | null) {
  return value?.trim().toLowerCase() ?? "";
}

function formatUsageReasoningLabel(value?: string | null) {
  const normalized = normalizeReasoningEffort(value);
  return normalized || "-";
}

function getUsageReasoningTone(value?: string | null) {
  switch (normalizeReasoningEffort(value)) {
    case "xhigh":
      return "reasoning-xhigh";
    case "high":
      return "reasoning-high";
    case "medium":
      return "reasoning-medium";
    case "low":
      return "reasoning-low";
    default:
      return "reasoning-default";
  }
}

function formatUsageRequestTypeLabel(row: UsageRow) {
  const requestType = row.requestType?.trim().toLowerCase() ?? "";
  if (row.stream || requestType === "stream") {
    return "流式";
  }
  if (!requestType || requestType === "standard" || requestType === "default") {
    return "标准";
  }
  if (requestType === "batch") {
    return "批量";
  }
  return row.requestType ?? "-";
}

function getUsageRequestTypeTone(row: UsageRow) {
  const requestType = row.requestType?.trim().toLowerCase() ?? "";
  if (row.stream || requestType === "stream") {
    return "usage-pill-stream";
  }
  if (requestType === "batch") {
    return "usage-pill-batch";
  }
  return "usage-pill-standard";
}

export function UsagePage({
  managedKeys,
  usageApiKeyFilter,
  setUsageApiKeyFilter,
  usageRangePickerRef,
  usageRangePickerOpen,
  toggleUsageRangePicker,
  usageRangeLabel,
  usageRangePreset,
  applyUsagePreset,
  usageDraftRange,
  setUsageDraftRange,
  applyUsageRange,
  usageStats,
  usageModelSummaries,
  usageModelSummariesLoading,
  usageRecords,
  usageScopeRows,
  handleUsageSearch,
  handleUsagePageChange,
  usageTrend,
  usageModels
}: {
  managedKeys: PaginatedResult<ManagedKeyRecord> | null;
  usageApiKeyFilter: string;
  setUsageApiKeyFilter: (value: string) => void;
  usageRangePickerRef: MutableRefObject<HTMLDivElement | null>;
  usageRangePickerOpen: boolean;
  toggleUsageRangePicker: () => void;
  usageRangeLabel: string;
  usageRangePreset: (typeof USAGE_RANGE_PRESETS)[number]["key"];
  applyUsagePreset: (preset: (typeof USAGE_RANGE_PRESETS)[number]["key"]) => void;
  usageDraftRange: { startDate: string; endDate: string };
  setUsageDraftRange: (updater: (prev: { startDate: string; endDate: string }) => { startDate: string; endDate: string }) => void;
  applyUsageRange: () => Promise<void>;
  usageStats: UsageStatsRecord | null;
  usageModelSummaries: UsageModelSummary[];
  usageModelSummariesLoading: boolean;
  usageRecords: PaginatedResult<UsageRow> | null;
  usageScopeRows: UsageRow[];
  handleUsageSearch: () => Promise<void>;
  handleUsagePageChange: (page: number) => Promise<void>;
  usageTrend: UsageTrendPayload | null;
  usageModels: DashboardModelsPayload | null;
}) {
  const scopedModelSummaries = usageScopeRows.length > 0
    ? summarizeUsageRowsByModel(usageScopeRows)
    : (usageStats?.totalRequests ?? 0) > 0
      ? usageModelSummaries
      : [];
  const topRequestModel = findTopUsageModel(scopedModelSummaries, (summary) => summary.requests);
  const topOutputModel = findTopUsageModel(scopedModelSummaries, (summary) => summary.outputTokens);
  const totalCacheInputTokens = getCacheInputTokens(
    usageStats?.totalCacheTokens,
    usageStats?.totalCacheCreationTokens,
    usageStats?.totalCacheReadTokens
  );

  return (
    <section className="usage-view">
      <SectionCard
        title="用量明细"
        subtitle="按真实 usage 单条记录展示 API Key、模型、计费、耗时与 USER-AGENT"
        actions={
          <button className="ghost-button" onClick={() => void handleUsageSearch()}>
            <RefreshCcw size={16} />
            重新查询
          </button>
        }
      >
        <div className="filter-grid">
          <label className="field">
            <span>API Key</span>
            <select value={usageApiKeyFilter} onChange={(event) => setUsageApiKeyFilter(event.target.value)}>
              <option value="">全部</option>
              {(managedKeys?.items ?? []).map((key) => (
                <option
                  key={key.id || String(key.apiKeyId ?? key.name)}
                  value={key.apiKeyId !== null && key.apiKeyId !== undefined ? String(key.apiKeyId) : ""}
                  disabled={key.apiKeyId === null || key.apiKeyId === undefined}
                >
                  {key.apiKeyId === null || key.apiKeyId === undefined ? `${key.name} (无可筛选 ID)` : key.name}
                </option>
              ))}
            </select>
          </label>
          <div className="field range-field" ref={usageRangePickerRef}>
            <span>时间范围</span>
            <div className="range-picker-shell">
              <button
                type="button"
                className={`range-trigger ${usageRangePickerOpen ? "open" : ""}`}
                onClick={toggleUsageRangePicker}
              >
                <CalendarDays size={16} />
                <span>{usageRangeLabel}</span>
                <ChevronDown size={16} className={`range-trigger-chevron ${usageRangePickerOpen ? "open" : ""}`} />
              </button>
              {usageRangePickerOpen && (
                <div className="range-popover">
                  <div className="range-presets">
                    {USAGE_RANGE_PRESETS.map((preset) => (
                      <button
                        key={preset.key}
                        type="button"
                        className={`range-preset ${usageRangePreset === preset.key ? "active" : ""}`}
                        onClick={() => applyUsagePreset(preset.key)}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  <div className="range-custom-grid">
                    <label className="field">
                      <span>开始日期</span>
                      <input
                        type="date"
                        value={usageDraftRange.startDate}
                        onChange={(event) =>
                          setUsageDraftRange((prev) => ({ ...prev, startDate: event.target.value }))
                        }
                      />
                    </label>
                    <div className="range-arrow">
                      <ChevronRight size={16} />
                    </div>
                    <label className="field">
                      <span>结束日期</span>
                      <input
                        type="date"
                        value={usageDraftRange.endDate}
                        onChange={(event) =>
                          setUsageDraftRange((prev) => ({ ...prev, endDate: event.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <div className="range-popover-footer">
                    <button type="button" className="primary-button" onClick={() => void applyUsageRange()}>
                      应用
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        {usageStats && (
          <div className="metric-grid compact-metrics">
            <MetricCard
              label="请求数"
              value={usageStats.totalRequests.toLocaleString()}
              hint={buildUsageModelHint("最多请求", topRequestModel?.model)}
              accent="sky"
              icon={<LayoutDashboard size={18} />}
              detailTitle="模型请求次数"
              detail={<UsageModelRequestDetails models={scopedModelSummaries} loading={usageModelSummariesLoading} />}
            />
            <MetricCard
              label="输入 Tokens"
              value={compact(usageStats.totalInputTokens)}
              hint={`输入 ${compact(usageStats.totalInputTokens)} / 缓存输入 ${compact(totalCacheInputTokens)}`}
              accent="emerald"
              icon={<MonitorDot size={18} />}
              detailTitle="输入 Token 明细"
              detail={<UsageTokenMetricDetails models={scopedModelSummaries} field="input" loading={usageModelSummariesLoading} />}
            />
            <MetricCard
              label="输出 Tokens"
              value={compact(usageStats.totalOutputTokens)}
              hint={buildUsageModelHint("输出最多", topOutputModel?.model)}
              accent="indigo"
              icon={<MonitorDot size={18} />}
              detailTitle="输出 Token 明细"
              detail={<UsageTokenMetricDetails models={scopedModelSummaries} field="output" loading={usageModelSummariesLoading} />}
            />
            <MetricCard
              label="实际成本"
              value={`$${usageStats.totalActualCost.toFixed(4)}`}
              hint={`平均耗时 ${formatDurationSeconds(usageStats.averageDurationMs)}`}
              accent="violet"
              icon={<BadgeDollarSign size={18} />}
              detailTitle="筛选结果概览"
              detail={
                <>
                  <DetailItem label="实际成本" value={formatUsd(usageStats.totalActualCost, 4)} />
                  <DetailItem label="标准成本" value={formatUsd(usageStats.totalCost, 4)} />
                  <DetailItem label="平均耗时" value={formatDurationSeconds(usageStats.averageDurationMs)} />
                  <DetailItem label="缓存总 Token" value={compact(usageStats.totalCacheTokens ?? 0)} />
                  <DetailItem label="缓存写入 Token" value={compact(usageStats.totalCacheCreationTokens ?? 0)} />
                  <DetailItem label="缓存读取 Token" value={compact(usageStats.totalCacheReadTokens ?? 0)} />
                  <DetailItem label="RPM" value={usageStats.rpm ? usageStats.rpm.toFixed(2) : "-"} />
                  <DetailItem label="TPM" value={usageStats.tpm ? compact(usageStats.tpm) : "-"} />
                </>
              }
            />
          </div>
        )}
        <div className="usage-table-wrap">
          <table className="usage-table">
            <colgroup>
              <col style={{ width: "9%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "6%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "5%" }} />
              <col style={{ width: "7%" }} />
              <col style={{ width: "13%" }} />
              <col style={{ width: "9%" }} />
              <col style={{ width: "6%" }} />
              <col style={{ width: "6%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "13%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>API 密钥</th>
                <th>模型</th>
                <th>推理强度</th>
                <th>端点</th>
                <th>类型</th>
                <th>计费模式</th>
                <th>TOKEN</th>
                <th>费用</th>
                <th>首 Token</th>
                <th>耗时</th>
                <th>时间</th>
                <th>USER-AGENT</th>
              </tr>
            </thead>
            <tbody>
              {usageRecords?.items.map((row) => (
                <tr key={row.id}>
                  <td>
                    <div className="usage-cell usage-cell-primary">
                      <strong>{row.apiKeyName ?? "未知 Key"}</strong>
                      <span>{row.apiKeyId ? `#${row.apiKeyId}` : "未返回 Key ID"}</span>
                    </div>
                  </td>
                  <td>
                    <div className="usage-cell usage-cell-primary">
                      <strong>{row.model}</strong>
                      <span>{row.platform ?? row.subscriptionName ?? "unknown"}</span>
                    </div>
                  </td>
                  <td>
                    {row.reasoningEffort ? (
                      <span className={`status-pill neutral usage-pill usage-pill-reasoning ${getUsageReasoningTone(row.reasoningEffort)}`}>
                        {formatUsageReasoningLabel(row.reasoningEffort)}
                      </span>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td>
                    <div className="usage-cell">
                      <strong>{row.endpoint ?? "-"}</strong>
                      <span>{row.upstreamEndpoint ?? "-"}</span>
                    </div>
                  </td>
                  <td>
                    <span className={`status-pill neutral usage-pill usage-pill-request ${getUsageRequestTypeTone(row)}`}>
                      {formatUsageRequestTypeLabel(row)}
                    </span>
                  </td>
                  <td>{formatBillingMode(row.billingMode, row.billingType)}</td>
                  <td>
                    <UsageDetailPopover
                      trigger={(
                        <div className="usage-cell usage-cell-number usage-token-summary">
                          <div className="usage-token-lines">
                            <span>输入 {compact(row.inputTokens)}</span>
                            <span>输出 {compact(row.outputTokens)}</span>
                          </div>
                          <div className="usage-token-lines usage-token-lines-secondary">
                            <span>缓存输入 {compact(getCacheInputTokens(undefined, row.cacheCreationTokens, row.cacheReadTokens))}</span>
                          </div>
                          <strong>总和 {compact(row.totalTokens)}</strong>
                        </div>
                      )}
                      title="Token 明细"
                    >
                      <DetailItem label="输入 Token" value={compact(row.inputTokens)} />
                      <DetailItem label="输出 Token" value={compact(row.outputTokens)} />
                      <DetailItem label="缓存写入 Token" value={compact(row.cacheCreationTokens ?? 0)} />
                      <DetailItem label="缓存读取 Token" value={compact(row.cacheReadTokens ?? 0)} />
                      <DetailItem label="总 Token" value={compact(row.totalTokens)} />
                    </UsageDetailPopover>
                  </td>
                  <td>
                    <UsageDetailPopover
                      trigger={(
                        <div className="usage-cell usage-cell-number">
                          <strong>{formatUsd(row.actualCost)}</strong>
                          <span>标准 {formatUsd(row.totalCost)}</span>
                        </div>
                      )}
                      title="成本明细"
                    >
                      <DetailItem label="输入成本" value={formatUsd(row.inputCost)} />
                      <DetailItem label="输出成本" value={formatUsd(row.outputCost)} />
                      <DetailItem label="缓存写入成本" value={formatUsd(row.cacheCreationCost)} />
                      <DetailItem label="缓存读取成本" value={formatUsd(row.cacheReadCost)} />
                      <DetailItem label="输入 Token" value={compact(row.inputTokens)} />
                      <DetailItem label="输出 Token" value={compact(row.outputTokens)} />
                      <DetailItem label="缓存写入 Token" value={compact(row.cacheCreationTokens ?? 0)} />
                      <DetailItem label="缓存读取 Token" value={compact(row.cacheReadTokens ?? 0)} />
                      <DetailItem label="总 Token" value={compact(row.totalTokens)} />
                      <DetailItem label="输入单价" value={formatUsdPerMillion(row.inputCost, row.inputTokens)} />
                      <DetailItem label="输出单价" value={formatUsdPerMillion(row.outputCost, row.outputTokens)} />
                      <DetailItem label="缓存读单价" value={formatUsdPerMillion(row.cacheReadCost, row.cacheReadTokens)} />
                      <DetailItem label="服务档位" value={row.groupName ?? row.subscriptionName ?? "-"} />
                      <DetailItem label="倍率" value={`${Number(row.rateMultiplier ?? 1).toFixed(2)}x`} />
                      <DetailItem label="原始" value={formatUsd(row.totalCost)} />
                      <DetailItem label="计费" value={formatUsd(row.actualCost)} />
                    </UsageDetailPopover>
                  </td>
                  <td>{formatDurationSeconds(row.firstTokenMs, 2, "秒")}</td>
                  <td>{formatDurationSeconds(row.durationMs, 2, "秒")}</td>
                  <td>{formatDateTimeFull(row.createdAt)}</td>
                  <td className="usage-user-agent" title={row.userAgent ?? "-"}>
                    {row.userAgent ?? "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(!usageRecords || usageRecords.items.length === 0) && (
            <EmptyState title="当前没有用量明细" detail="修改筛选后重新查询，或先刷新账号数据。" compact />
          )}
        </div>
        {usageRecords && usageRecords.items.length > 0 && (
          <div className="usage-pagination">
            <div className="usage-pagination-meta">
              <span>共 {usageRecords.total.toLocaleString()} 条</span>
              <span>第 {usageRecords.page} / {usageRecords.pages} 页</span>
            </div>
            <div className="usage-pagination-actions">
              <button
                className="ghost-button"
                disabled={usageRecords.page <= 1}
                onClick={() => void handleUsagePageChange(usageRecords.page - 1)}
              >
                上一页
              </button>
              <button
                className="ghost-button"
                disabled={usageRecords.page >= usageRecords.pages}
                onClick={() => void handleUsagePageChange(usageRecords.page + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        )}
      </SectionCard>
      <div className="usage-insights-grid">
        <SectionCard title="趋势" subtitle="对齐 dashboard/trend 接口的成本、请求与缓存表现">
          {usageTrend?.trend?.length ? (
            <div className="chart-wrap tall">
              <EChartCard
                option={buildTrendAreaChartOption({
                  data: normalizeTrendChartData(usageTrend.trend),
                  series: ["actualCost", "requests", "cacheCreationTokens", "cacheReadTokens", "cacheHitRate"]
                })}
              />
            </div>
          ) : (
            <EmptyState title="当前没有趋势数据" detail="站点未返回 dashboard/trend 数据。" compact />
          )}
        </SectionCard>
        <SectionCard title="模型分布" subtitle="对齐 dashboard/models 接口">
          <div className="table-list">
            {usageModels?.models.map((model) => (
              <div key={model.model} className="table-row">
                <div>
                  <strong>{model.model}</strong>
                  <p>{model.requests.toLocaleString()} 请求 / {compact(model.totalTokens)} tokens</p>
                </div>
                <div className="table-numbers">
                  <strong>${Number(model.actualCost ?? model.cost ?? 0).toFixed(4)}</strong>
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>
    </section>
  );
}
