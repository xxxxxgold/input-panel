import {
  ArrowDown,
  ArrowUp,
  BadgeDollarSign,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  LayoutDashboard,
  MonitorDot,
  RefreshCcw,
  Timer
} from "lucide-react";
import type { MutableRefObject, ReactNode } from "react";

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
import { UsageTrendSection } from "../features/usage/components/UsageTrendSection";
import {
  UsageModelRequestDetails,
  UsageTokenMetricDetails
} from "../features/usage/components/UsageMetricDetails";
import { summarizeUsageRowsByModel, type UsageModelSummary } from "../features/usage/model-summary";

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

const USAGE_IMAGE_SIZE_PRESETS = [
  { label: "1K", resolution: "1024×1024", approxOutputTokensPerImage: 4200 },
  { label: "2K", resolution: "2048×2048", approxOutputTokensPerImage: 6500 }
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

function findTopUsageRow(
  rows: UsageRow[],
  valueSelector: (row: UsageRow) => number | null | undefined
) {
  return rows.reduce<UsageRow | null>((best, row) => {
    if (!best) {
      return row;
    }
    const nextValue = Number(valueSelector(row) ?? 0);
    const bestValue = Number(valueSelector(best) ?? 0);
    if (nextValue !== bestValue) {
      return nextValue > bestValue ? row : best;
    }
    const nextCost = Number(row.actualCost ?? 0);
    const bestCost = Number(best.actualCost ?? 0);
    if (nextCost !== bestCost) {
      return nextCost > bestCost ? row : best;
    }
    const nextTokens = Number(row.totalTokens ?? 0);
    const bestTokens = Number(best.totalTokens ?? 0);
    if (nextTokens !== bestTokens) {
      return nextTokens > bestTokens ? row : best;
    }
    return row.createdAt > best.createdAt ? row : best;
  }, null);
}

function formatUsageExtremeContext(row: UsageRow) {
  const keyLabel = row.apiKeyName ?? (row.apiKeyId ? `#${row.apiKeyId}` : "未知 Key");
  return `${keyLabel} / ${row.model}`;
}

function formatUsageApiKeyLabel(row: UsageRow) {
  return row.apiKeyName ?? (row.apiKeyId ? `#${row.apiKeyId}` : "未知 Key");
}

function normalizeReasoningEffort(value?: string | null) {
  return value?.trim().toLowerCase() ?? "";
}

function normalizeUsageBillingMode(value?: string | null) {
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
  if (requestType === "sync") {
    return "同步";
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

function inferUsageImageBilling(row: UsageRow) {
  if (normalizeUsageBillingMode(row.billingMode) !== "image") {
    return null;
  }

  // UsageRow 里没有显式图片尺寸字段, 这里按现有图片请求的输出 Token 档位估算 1K / 2K.
  const outputTokens = Math.max(Number(row.outputTokens ?? 0), 0);
  let bestMatch: {
    count: number;
    error: number;
    label: string;
    resolution: string;
    approxOutputTokensPerImage: number;
  } | null = null;

  for (const preset of USAGE_IMAGE_SIZE_PRESETS) {
    for (let count = 1; count <= 4; count += 1) {
      const predicted = preset.approxOutputTokensPerImage * count;
      const error = Math.abs(predicted - outputTokens);
      if (!bestMatch || error < bestMatch.error) {
        bestMatch = {
          count,
          error,
          label: preset.label,
          resolution: preset.resolution,
          approxOutputTokensPerImage: preset.approxOutputTokensPerImage
        };
      }
    }
  }

  const matched = bestMatch && outputTokens > 0 &&
    bestMatch.error <= Math.max(bestMatch.approxOutputTokensPerImage * 0.32, 600)
    ? bestMatch
    : null;
  const imageCount = matched?.count ?? null;

  return {
    imageCount,
    sizeLabel: matched?.label ?? null,
    resolution: matched?.resolution ?? null,
    sizeSourceLabel: matched ? "输出 Token 估算" : "当前未返回显式尺寸字段",
    unitPrice: imageCount && imageCount > 0 ? row.actualCost / imageCount : null
  };
}

function buildUsageBillingPresentation(row: UsageRow) {
  const imageBilling = inferUsageImageBilling(row);
  if (imageBilling) {
    const secondary = imageBilling.imageCount && imageBilling.sizeLabel
      ? `${imageBilling.imageCount}张 (${imageBilling.sizeLabel})`
      : imageBilling.sizeLabel ?? null;
    return {
      primary: "按次(图片)",
      secondary,
      imageBilling
    };
  }

  return {
    primary: formatBillingMode(row.billingMode, row.billingType),
    secondary: null,
    imageBilling: null
  };
}

function buildUsagePaginationItems(currentPage: number, totalPages: number) {
  if (totalPages <= 1) {
    return [1];
  }

  const pages = new Set<number>([
    1,
    2,
    3,
    totalPages - 2,
    totalPages - 1,
    totalPages,
    currentPage - 1,
    currentPage,
    currentPage + 1
  ]);
  if (currentPage <= 3) {
    pages.add(4);
  }
  if (currentPage >= totalPages - 2) {
    pages.add(totalPages - 3);
  }

  const sorted = [...pages]
    .filter((page) => page >= 1 && page <= totalPages)
    .sort((left, right) => left - right);
  const items: Array<number | "ellipsis"> = [];

  for (const page of sorted) {
    const previous = items[items.length - 1];
    if (typeof previous === "number" && page - previous > 1) {
      items.push("ellipsis");
    }
    items.push(page);
  }

  return items;
}

function UsageDetailSection({
  title,
  children
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="usage-detail-section">
      <div className="usage-detail-section-title">{title}</div>
      <div className="usage-detail-section-grid">{children}</div>
    </section>
  );
}

function UsageExtremeDetail({
  row,
  highlightLabel,
  highlightValue
}: {
  row: UsageRow;
  highlightLabel: string;
  highlightValue: string;
}) {
  const cacheInputTokens = getCacheInputTokens(undefined, row.cacheCreationTokens, row.cacheReadTokens);
  return (
    <>
      <UsageDetailSection title="极值命中">
        <DetailItem label={highlightLabel} value={highlightValue} />
        <DetailItem label="API Key" value={formatUsageApiKeyLabel(row)} />
        <DetailItem label="模型" value={row.model} />
        <DetailItem label="时间" value={formatDateTimeFull(row.createdAt)} />
      </UsageDetailSection>
      <UsageDetailSection title="性能">
        <DetailItem label="首 Token" value={formatDurationSeconds(row.firstTokenMs, 2, "秒")} />
        <DetailItem label="总耗时" value={formatDurationSeconds(row.durationMs, 2, "秒")} />
        <DetailItem label="请求类型" value={formatUsageRequestTypeLabel(row)} />
        <DetailItem label="USER-AGENT" value={row.userAgent ?? "-"} />
      </UsageDetailSection>
      <UsageDetailSection title="成本与 Token">
        <DetailItem label="实际成本" value={formatUsd(row.actualCost, 4)} />
        <DetailItem label="标准成本" value={formatUsd(row.totalCost, 4)} />
        <DetailItem label="输入 Token" value={compact(row.inputTokens)} />
        <DetailItem label="输出 Token" value={compact(row.outputTokens)} />
        <DetailItem label="缓存输入" value={compact(cacheInputTokens)} />
        <DetailItem label="总 Token" value={compact(row.totalTokens)} />
      </UsageDetailSection>
    </>
  );
}

function UsageCostDetail({
  row,
  title = "请求信息",
  highlightLabel = "实际成本",
  highlightValue
}: {
  row: UsageRow;
  title?: string;
  highlightLabel?: string;
  highlightValue?: string;
}) {
  const imageBilling = inferUsageImageBilling(row);
  return (
    <>
      <UsageDetailSection title={title}>
        <DetailItem label={highlightLabel} value={highlightValue ?? formatUsd(row.actualCost, 4)} />
        <DetailItem label="API Key" value={formatUsageApiKeyLabel(row)} />
        <DetailItem label="模型" value={row.model} />
        <DetailItem label="时间" value={formatDateTimeFull(row.createdAt)} />
      </UsageDetailSection>
      {imageBilling ? (
        <UsageDetailSection title="图片价格">
          <DetailItem label="图片张数" value={imageBilling.imageCount ? `${imageBilling.imageCount}张` : "-"} />
          <DetailItem label="计费尺寸" value={imageBilling.sizeLabel ?? "-"} />
          <DetailItem label="尺寸来源" value={imageBilling.sizeSourceLabel} />
          <DetailItem label="估算分辨率" value={imageBilling.resolution ?? "-"} />
          <DetailItem label="单张价格" value={formatUsd(imageBilling.unitPrice)} />
          <DetailItem label="服务档位" value={row.groupName ?? row.subscriptionName ?? "-"} />
        </UsageDetailSection>
      ) : (
        <UsageDetailSection title="模型价格">
          <DetailItem label="输入单价" value={formatUsdPerMillion(row.inputCost, row.inputTokens)} />
          <DetailItem label="输出单价" value={formatUsdPerMillion(row.outputCost, row.outputTokens)} />
          <DetailItem label="缓存写入单价" value={formatUsdPerMillion(row.cacheCreationCost, row.cacheCreationTokens)} />
          <DetailItem label="缓存读取单价" value={formatUsdPerMillion(row.cacheReadCost, row.cacheReadTokens)} />
          <DetailItem label="服务档位" value={row.groupName ?? row.subscriptionName ?? "-"} />
          <DetailItem label="倍率" value={`${Number(row.rateMultiplier ?? 1).toFixed(2)}x`} />
        </UsageDetailSection>
      )}
      <UsageDetailSection title="成本">
        {imageBilling ? (
          <>
            <DetailItem label="图片总价" value={formatUsd(row.actualCost)} />
            <DetailItem label="原始" value={formatUsd(row.totalCost)} />
            <DetailItem label="计费" value={formatUsd(row.actualCost)} />
            <DetailItem label="倍率" value={`${Number(row.rateMultiplier ?? 1).toFixed(2)}x`} />
          </>
        ) : (
          <>
            <DetailItem label="输入成本" value={formatUsd(row.inputCost)} />
            <DetailItem label="输出成本" value={formatUsd(row.outputCost)} />
            <DetailItem label="缓存写入成本" value={formatUsd(row.cacheCreationCost)} />
            <DetailItem label="缓存读取成本" value={formatUsd(row.cacheReadCost)} />
            <DetailItem label="原始" value={formatUsd(row.totalCost)} />
            <DetailItem label="计费" value={formatUsd(row.actualCost)} />
          </>
        )}
      </UsageDetailSection>
      <UsageDetailSection title="Token">
        <DetailItem label="输入 Token" value={compact(row.inputTokens)} />
        <DetailItem label="输出 Token" value={compact(row.outputTokens)} />
        <DetailItem label="缓存写入 Token" value={compact(row.cacheCreationTokens ?? 0)} />
        <DetailItem label="缓存读取 Token" value={compact(row.cacheReadTokens ?? 0)} />
        <DetailItem label="总 Token" value={compact(row.totalTokens)} />
      </UsageDetailSection>
    </>
  );
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
  usagePageSize,
  usagePageSizeOptions,
  usageScopeRows,
  handleUsageSearch,
  handleUsagePageChange,
  handleUsagePageSizeChange,
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
  usagePageSize: number;
  usagePageSizeOptions: number[];
  usageScopeRows: UsageRow[];
  handleUsageSearch: () => Promise<void>;
  handleUsagePageChange: (page: number) => Promise<void>;
  handleUsagePageSizeChange: (pageSize: number) => Promise<void>;
  usageTrend: UsageTrendPayload | null;
  usageModels: DashboardModelsPayload | null;
}) {
  const scopedModelSummaries = usageScopeRows.length > 0
    ? summarizeUsageRowsByModel(usageScopeRows)
    : (usageStats?.totalRequests ?? 0) > 0
      ? usageModelSummaries
      : [];
  const scopedUsageRows = usageScopeRows.length > 0 ? usageScopeRows : (usageRecords?.items ?? []);
  const topRequestModel = findTopUsageModel(scopedModelSummaries, (summary) => summary.requests);
  const topOutputModel = findTopUsageModel(scopedModelSummaries, (summary) => summary.outputTokens);
  const longestFirstTokenRow = findTopUsageRow(scopedUsageRows, (row) => row.firstTokenMs);
  const highestCostRow = findTopUsageRow(scopedUsageRows, (row) => row.actualCost);
  const highestInputRow = findTopUsageRow(scopedUsageRows, (row) => row.inputTokens);
  const highestOutputRow = findTopUsageRow(scopedUsageRows, (row) => row.outputTokens);
  const usagePaginationItems = usageRecords
    ? buildUsagePaginationItems(usageRecords.page, Math.max(usageRecords.pages, 1))
    : [];
  const totalCacheInputTokens = getCacheInputTokens(
    usageStats?.totalCacheTokens,
    usageStats?.totalCacheCreationTokens,
    usageStats?.totalCacheReadTokens
  );

  return (
    <section className="usage-view motion-shell-section">
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
          <div className="field range-field animated-range-field" ref={usageRangePickerRef}>
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
                <div className="range-popover range-popover-visible">
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
          <div className="metric-grid compact-metrics motion-stagger-grid">
            <MetricCard
              label="请求数"
              value={usageStats.totalRequests.toLocaleString()}
              hint={buildUsageModelHint("最多请求", topRequestModel?.model)}
              accent="sky"
              icon={<LayoutDashboard size={18} />}
              detailTitle="模型请求次数"
              detail={<UsageModelRequestDetails models={scopedModelSummaries} loading={usageModelSummariesLoading} />}
              className="motion-stagger-item"
              animationKey={`usage-total-requests:${usageStats.totalRequests}`}
              style={{ ["--motion-order" as string]: 0 }}
            />
            <MetricCard
              label="输入 Tokens"
              value={compact(usageStats.totalInputTokens)}
              hint={`输入 ${compact(usageStats.totalInputTokens)} / 缓存输入 ${compact(totalCacheInputTokens)}`}
              accent="emerald"
              icon={<MonitorDot size={18} />}
              detailTitle="输入 Token 明细"
              detail={<UsageTokenMetricDetails models={scopedModelSummaries} field="input" loading={usageModelSummariesLoading} />}
              className="motion-stagger-item"
              animationKey={`usage-input-tokens:${usageStats.totalInputTokens}`}
              style={{ ["--motion-order" as string]: 1 }}
            />
            <MetricCard
              label="输出 Tokens"
              value={compact(usageStats.totalOutputTokens)}
              hint={buildUsageModelHint("输出最多", topOutputModel?.model)}
              accent="indigo"
              icon={<MonitorDot size={18} />}
              detailTitle="输出 Token 明细"
              detail={<UsageTokenMetricDetails models={scopedModelSummaries} field="output" loading={usageModelSummariesLoading} />}
              className="motion-stagger-item"
              animationKey={`usage-output-tokens:${usageStats.totalOutputTokens}`}
              style={{ ["--motion-order" as string]: 2 }}
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
                  <DetailItem
                    label="RPM"
                    value={usageStats.rpm === null || usageStats.rpm === undefined ? "-" : usageStats.rpm.toFixed(2)}
                  />
                  <DetailItem
                    label="TPM"
                    value={usageStats.tpm === null || usageStats.tpm === undefined ? "-" : compact(usageStats.tpm)}
                  />
                </>
              }
              className="motion-stagger-item"
              animationKey={`usage-actual-cost:${usageStats.totalActualCost}`}
              style={{ ["--motion-order" as string]: 3 }}
            />
          </div>
        )}
        {scopedUsageRows.length > 0 && (
          <div className="metric-grid usage-extreme-grid motion-stagger-grid">
            <MetricCard
              label="最长首 Token"
              value={longestFirstTokenRow ? formatDurationSeconds(longestFirstTokenRow.firstTokenMs, 2, "秒") : "-"}
              hint={longestFirstTokenRow ? formatUsageExtremeContext(longestFirstTokenRow) : "当前没有极值样本"}
              accent="amber"
              icon={<Timer size={18} />}
              detailTitle="最长首 Token 请求"
              detail={
                longestFirstTokenRow ? (
                  <UsageExtremeDetail
                    row={longestFirstTokenRow}
                    highlightLabel="首 Token"
                    highlightValue={formatDurationSeconds(longestFirstTokenRow.firstTokenMs, 2, "秒")}
                  />
                ) : null
              }
              className="motion-stagger-item"
              animationKey={`usage-longest-first-token:${longestFirstTokenRow?.id ?? "none"}`}
              style={{ ["--motion-order" as string]: 0 }}
            />
            <MetricCard
              label="最高消费"
              value={highestCostRow ? formatUsd(highestCostRow.actualCost, 4) : "-"}
              hint={highestCostRow ? formatUsageExtremeContext(highestCostRow) : "当前没有极值样本"}
              accent="rose"
              icon={<BadgeDollarSign size={18} />}
              detailTitle="最高消费请求"
              detail={
                highestCostRow ? (
                  <UsageCostDetail
                    row={highestCostRow}
                    title="极值命中"
                    highlightLabel="最高消费"
                    highlightValue={formatUsd(highestCostRow.actualCost, 4)}
                  />
                ) : null
              }
              className="motion-stagger-item"
              animationKey={`usage-highest-cost:${highestCostRow?.id ?? "none"}`}
              style={{ ["--motion-order" as string]: 1 }}
            />
            <MetricCard
              label="最高输入"
              value={highestInputRow ? compact(highestInputRow.inputTokens) : "-"}
              hint={highestInputRow ? formatUsageExtremeContext(highestInputRow) : "当前没有极值样本"}
              accent="emerald"
              icon={<ArrowDown size={18} />}
              detailTitle="最高输入请求"
              detail={
                highestInputRow ? (
                  <UsageExtremeDetail
                    row={highestInputRow}
                    highlightLabel="输入 Token"
                    highlightValue={compact(highestInputRow.inputTokens)}
                  />
                ) : null
              }
              className="motion-stagger-item"
              animationKey={`usage-highest-input:${highestInputRow?.id ?? "none"}`}
              style={{ ["--motion-order" as string]: 2 }}
            />
            <MetricCard
              label="最高输出"
              value={highestOutputRow ? compact(highestOutputRow.outputTokens) : "-"}
              hint={highestOutputRow ? formatUsageExtremeContext(highestOutputRow) : "当前没有极值样本"}
              accent="indigo"
              icon={<ArrowUp size={18} />}
              detailTitle="最高输出请求"
              detail={
                highestOutputRow ? (
                  <UsageExtremeDetail
                    row={highestOutputRow}
                    highlightLabel="输出 Token"
                    highlightValue={compact(highestOutputRow.outputTokens)}
                  />
                ) : null
              }
              className="motion-stagger-item"
              animationKey={`usage-highest-output:${highestOutputRow?.id ?? "none"}`}
              style={{ ["--motion-order" as string]: 3 }}
            />
          </div>
        )}
        <div className="usage-table-toolbar">
          <div className="usage-table-meta">
            {usageRecords ? (
              <>
                <span>共 {usageRecords.total.toLocaleString()} 条</span>
                <span>第 {usageRecords.page} / {usageRecords.pages} 页</span>
              </>
            ) : (
              <span>当前没有可展示的用量记录</span>
            )}
          </div>
          {usageRecords && usageRecords.items.length > 0 && (
            <label className="field usage-page-size-field">
              <span>每页条数</span>
              <select value={usagePageSize} onChange={(event) => void handleUsagePageSizeChange(Number(event.target.value))}>
                {usagePageSizeOptions.map((option) => (
                  <option key={option} value={option}>
                    {option} 条
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
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
              {usageRecords?.items.map((row, index) => {
                const billingPresentation = buildUsageBillingPresentation(row);
                return (
                <tr key={row.id} className="usage-row-motion" style={{ ["--motion-order" as string]: index }}>
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
                  <td>
                    <div className="usage-cell usage-cell-primary">
                      <strong>{billingPresentation.primary}</strong>
                      {billingPresentation.secondary ? <span>{billingPresentation.secondary}</span> : null}
                    </div>
                  </td>
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
                      <UsageCostDetail row={row} />
                    </UsageDetailPopover>
                  </td>
                  <td>{formatDurationSeconds(row.firstTokenMs, 2, "秒")}</td>
                  <td>{formatDurationSeconds(row.durationMs, 2, "秒")}</td>
                  <td>{formatDateTimeFull(row.createdAt)}</td>
                  <td className="usage-user-agent" title={row.userAgent ?? "-"}>
                    {row.userAgent ?? "-"}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          {(!usageRecords || usageRecords.items.length === 0) && (
            <EmptyState title="当前没有用量明细" detail="修改筛选后重新查询，或先刷新账号数据。" compact />
          )}
        </div>
        {usageRecords && usageRecords.items.length > 0 && (
          <div className="usage-pagination">
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
            <div className="usage-pagination-pages" aria-label="用量页码">
              {usagePaginationItems.map((item, index) =>
                item === "ellipsis" ? (
                  <span key={`ellipsis-${index}`} className="usage-pagination-ellipsis" aria-hidden="true">
                    ...
                  </span>
                ) : (
                  <button
                    key={item}
                    type="button"
                    className={`usage-pagination-page ${item === usageRecords.page ? "active" : ""}`}
                    aria-current={item === usageRecords.page ? "page" : undefined}
                    onClick={() => void handleUsagePageChange(item)}
                  >
                    {item}
                  </button>
                )
              )}
            </div>
            <div className="usage-pagination-jump">
              <label className="field usage-page-jump-field">
                <span>跳转页码</span>
                <input
                  type="number"
                  min={1}
                  max={usageRecords.pages}
                  defaultValue={usageRecords.page}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") {
                      return;
                    }
                    const value = Number((event.currentTarget as HTMLInputElement).value);
                    if (!Number.isFinite(value)) {
                      return;
                    }
                    void handleUsagePageChange(value);
                  }}
                />
              </label>
              <button
                type="button"
                className="ghost-button"
                onClick={(event) => {
                  const container = (event.currentTarget as HTMLButtonElement).closest(".usage-pagination-jump");
                  const input = container?.querySelector("input");
                  const value = Number((input as HTMLInputElement | null)?.value);
                  if (!Number.isFinite(value)) {
                    return;
                  }
                  void handleUsagePageChange(value);
                }}
              >
                跳转
              </button>
            </div>
          </div>
        )}
      </SectionCard>
      <div className="usage-insights-grid">
        <UsageTrendSection
          subtitle="对齐 dashboard/trend 接口的成本、请求与缓存表现"
          points={usageTrend?.trend ?? []}
        />
        <SectionCard title="模型分布" subtitle="对齐 dashboard/models 接口">
          <div className="table-list">
            {usageModels?.models.map((model, index) => (
              <div
                key={model.model}
                className="table-row table-row-motion"
                style={{ ["--motion-order" as string]: index }}
              >
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
