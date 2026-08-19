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
  RotateCcw,
  Search,
  SlidersHorizontal,
  Timer
} from "lucide-react";
import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from "react";

import type {
  DashboardModelsPayload,
  PaginatedResult,
  UsageCursorPage,
  UsageExtremesPayload,
  UsageFacetField,
  UsageFacetPage,
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
  formatUsd,
  formatUsdPerMillion,
  formatUsageServiceTier
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
import type {
  UsageBooleanDraft,
  UsageFilterDraft,
  UsageRangeDraft,
  UsageTextFilterDraft
} from "../features/usage/usage-filter-draft";

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

function formatUsageExtremeContext(row: UsageRow) {
  const keyLabel = row.apiKeyName ?? (row.apiKeyId ? `#${row.apiKeyId}` : "未知 Key");
  return `${keyLabel} / ${row.model}`;
}

function formatUsageApiKeyLabel(row: UsageRow) {
  return row.apiKeyName ?? (row.apiKeyId ? `#${row.apiKeyId}` : "未知 Key");
}

function formatLongContextBillingState(value?: boolean | null) {
  if (value === null || value === undefined) {
    return "未知";
  }
  return value ? "已应用" : "未应用";
}

function normalizeReasoningEffort(value?: string | null) {
  return value?.trim().toLowerCase() ?? "";
}

function normalizeUsageBillingMode(value?: string | null) {
  return value?.trim().toLowerCase() ?? "";
}

function normalizeUsageImageSize(value?: string | null) {
  return value?.trim().toUpperCase() ?? "";
}

function normalizeUsageRequestTypeValue(value?: string | null, stream?: boolean | null) {
  const requestType = value?.trim().toLowerCase() ?? "";
  if (stream || requestType === "stream") {
    return "stream";
  }
  if (requestType === "sync") {
    return "sync";
  }
  if (!requestType || requestType === "standard" || requestType === "default") {
    return "standard";
  }
  if (requestType === "batch") {
    return "batch";
  }
  return requestType;
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
  const requestType = normalizeUsageRequestTypeValue(row.requestType, row.stream);
  if (requestType === "stream") {
    return "流式";
  }
  if (requestType === "sync") {
    return "同步";
  }
  if (requestType === "standard") {
    return "标准";
  }
  if (requestType === "batch") {
    return "批量";
  }
  return row.requestType ?? "-";
}

function getUsageRequestTypeTone(row: UsageRow) {
  const requestType = normalizeUsageRequestTypeValue(row.requestType, row.stream);
  if (requestType === "stream") {
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

  const explicitImageCount = row.imageCount && row.imageCount > 0 ? row.imageCount : null;
  const explicitSizeLabel = normalizeUsageImageSize(row.imageSize);
  const explicitResolution = row.imageOutputSize ?? row.imageInputSize ?? null;
  if (explicitImageCount || explicitSizeLabel || explicitResolution || row.imageSizeSource) {
    return {
      imageCount: explicitImageCount,
      sizeLabel: explicitSizeLabel || null,
      resolution: explicitResolution,
      sizeSourceLabel: row.imageSizeSource === "input"
        ? "请求入参"
        : row.imageSizeSource === "default"
          ? "上游默认值"
          : row.imageSizeSource ?? "上游返回",
      unitPrice: explicitImageCount && explicitImageCount > 0 ? row.actualCost / explicitImageCount : null
    };
  }

  // 旧缓存没有显式图片尺寸字段时, 退回输出 Token 估算.
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
  const serviceTier = row.serviceTier?.trim();
  const hasImageInputCost =
    typeof row.imageInputCost === "number" &&
    Number.isFinite(row.imageInputCost) &&
    row.imageInputCost !== 0;
  const hasCacheCreationCost =
    typeof row.cacheCreationCost === "number" &&
    Number.isFinite(row.cacheCreationCost) &&
    row.cacheCreationCost !== 0;
  return (
    <>
      <UsageDetailSection title={title}>
        <DetailItem label={highlightLabel} value={highlightValue ?? formatUsd(row.actualCost, 4)} />
        <DetailItem label="API Key" value={formatUsageApiKeyLabel(row)} />
        <DetailItem label="模型" value={row.model} />
        <DetailItem label="时间" value={formatDateTimeFull(row.createdAt)} />
        <DetailItem label="长上下文计费" value={formatLongContextBillingState(row.longContextBillingApplied)} />
      </UsageDetailSection>
      {imageBilling ? (
        <UsageDetailSection title="图片价格">
          <DetailItem label="图片张数" value={imageBilling.imageCount ? `${imageBilling.imageCount}张` : "-"} />
          <DetailItem label="计费尺寸" value={imageBilling.sizeLabel ?? "-"} />
          <DetailItem label="尺寸来源" value={imageBilling.sizeSourceLabel} />
          <DetailItem label="估算分辨率" value={imageBilling.resolution ?? "-"} />
          <DetailItem label="单张价格" value={formatUsd(imageBilling.unitPrice)} />
          {serviceTier ? (
            <DetailItem label="服务档位" value={formatUsageServiceTier(serviceTier)} />
          ) : null}
        </UsageDetailSection>
      ) : (
        <UsageDetailSection title="模型价格">
          <DetailItem label="输入单价" value={formatUsdPerMillion(row.inputCost, row.inputTokens)} />
          <DetailItem label="输出单价" value={formatUsdPerMillion(row.outputCost, row.outputTokens)} />
          <DetailItem label="缓存写入单价" value={formatUsdPerMillion(row.cacheCreationCost, row.cacheCreationTokens)} />
          <DetailItem label="缓存读取单价" value={formatUsdPerMillion(row.cacheReadCost, row.cacheReadTokens)} />
          {serviceTier ? (
            <DetailItem label="服务档位" value={formatUsageServiceTier(serviceTier)} />
          ) : null}
          <DetailItem label="倍率" value={`${Number(row.rateMultiplier ?? 1).toFixed(2)}x`} />
        </UsageDetailSection>
      )}
      <UsageDetailSection title="成本">
        {imageBilling ? (
          <>
            <DetailItem label="图片总价" value={formatUsd(row.actualCost)} />
            {hasImageInputCost ? (
              <DetailItem label="图片输入费用" value={formatUsd(row.imageInputCost)} />
            ) : null}
            <DetailItem label="图片输出 Token" value={compact(row.imageOutputTokens ?? row.outputTokens)} />
            <DetailItem label="原始" value={formatUsd(row.totalCost)} />
            <DetailItem label="计费" value={formatUsd(row.actualCost)} />
            <DetailItem label="倍率" value={`${Number(row.rateMultiplier ?? 1).toFixed(2)}x`} />
          </>
        ) : (
          <>
            <DetailItem label="输入成本" value={formatUsd(row.inputCost)} />
            {hasImageInputCost ? (
              <DetailItem label="图片输入费用" value={formatUsd(row.imageInputCost)} />
            ) : null}
            <DetailItem label="输出成本" value={formatUsd(row.outputCost)} />
            {hasCacheCreationCost ? (
              <DetailItem label="缓存写入成本" value={formatUsd(row.cacheCreationCost)} />
            ) : null}
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

type UsageTextDraftField = {
  [Key in keyof UsageFilterDraft]: UsageFilterDraft[Key] extends UsageTextFilterDraft ? Key : never;
}[keyof UsageFilterDraft];

type UsageRangeDraftField = {
  [Key in keyof UsageFilterDraft]: UsageFilterDraft[Key] extends UsageRangeDraft ? Key : never;
}[keyof UsageFilterDraft];

function UsageTextFilterField({
  id,
  label,
  value,
  placeholder,
  facetField,
  facetPage,
  facetLoading,
  showMatchMode = false,
  onChange,
  onLoadFacet
}: {
  id: string;
  label: string;
  value: UsageTextFilterDraft;
  placeholder?: string;
  facetField?: UsageFacetField;
  facetPage?: UsageFacetPage;
  facetLoading?: boolean;
  showMatchMode?: boolean;
  onChange: (value: UsageTextFilterDraft) => void;
  onLoadFacet?: (field: UsageFacetField, search?: string, force?: boolean) => void;
}) {
  const listId = facetField ? `${id}-options` : undefined;
  return (
    <label className="field usage-text-filter-field" htmlFor={id}>
      <span>{label}{facetLoading ? " · 加载中" : ""}</span>
      <div className="usage-filter-control-row">
        <input
          id={id}
          list={listId}
          value={value.value}
          placeholder={placeholder}
          onFocus={() => facetField && onLoadFacet?.(facetField)}
          onChange={(event) => onChange({ ...value, value: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter" && facetField) {
              event.preventDefault();
              onLoadFacet?.(facetField, value.value, true);
            }
          }}
        />
        {showMatchMode ? (
          <select
            value={value.mode}
            aria-label={`${label}匹配方式`}
            onChange={(event) => onChange({ ...value, mode: event.target.value as UsageTextFilterDraft["mode"] })}
          >
            <option value="exact">精确</option>
            <option value="prefix">前缀</option>
            </select>
          ) : null}
        {facetField ? (
          <button
            type="button"
            className="icon-button usage-facet-search-button"
            aria-label={`搜索${label}候选`}
            title={`搜索${label}候选`}
            onClick={(event) => {
              event.preventDefault();
              onLoadFacet?.(facetField, value.value, true);
            }}
          >
            <Search size={15} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {listId ? (
        <datalist id={listId}>
          {(facetPage?.items ?? []).map((item) => (
            <option key={item.value} value={item.label}>{item.count.toLocaleString()} 条</option>
          ))}
        </datalist>
      ) : null}
    </label>
  );
}

function UsageScalarFilterField({
  id,
  label,
  value,
  placeholder,
  facetField,
  facetPage,
  facetLoading,
  fallbackOptions = [],
  onChange,
  onLoadFacet
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  facetField?: UsageFacetField;
  facetPage?: UsageFacetPage;
  facetLoading?: boolean;
  fallbackOptions?: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  onLoadFacet?: (field: UsageFacetField, search?: string, force?: boolean) => void;
}) {
  const listId = facetField ? `${id}-options` : undefined;
  const options = buildFacetSelectOptions(facetPage, fallbackOptions, value)
    .filter((item) => /^\d+$/.test(item.value));
  return (
    <label className="field usage-scalar-filter-field" htmlFor={id}>
      <span>{label}{facetLoading ? " · 加载中" : ""}</span>
      <div className="usage-filter-control-row">
        <input
          id={id}
          type="number"
          min="0"
          step="1"
          inputMode="numeric"
          list={listId}
          value={value}
          placeholder={placeholder}
          onFocus={() => facetField && onLoadFacet?.(facetField)}
          onChange={(event) => onChange(event.target.value)}
        />
        {facetField ? (
          <button
            type="button"
            className="icon-button usage-facet-search-button"
            aria-label={`加载${label}候选`}
            title={`加载${label}候选`}
            onClick={(event) => {
              event.preventDefault();
              onLoadFacet?.(facetField, "", true);
            }}
          >
            <Search size={15} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {listId ? (
        <datalist id={listId}>
          {options.map((item) => (
            <option key={item.value} value={item.value}>{item.label}</option>
          ))}
        </datalist>
      ) : null}
    </label>
  );
}

function UsageRangeFilterField({
  label,
  value,
  step = "1",
  onChange
}: {
  label: string;
  value: UsageRangeDraft;
  step?: string;
  onChange: (value: UsageRangeDraft) => void;
}) {
  return (
    <fieldset className="field usage-range-filter-field">
      <legend>{label}</legend>
      <div className="usage-filter-control-row usage-range-control-row">
        <input
          type="number"
          min="0"
          step={step}
          inputMode="decimal"
          value={value.min}
          aria-label={`${label}下限`}
          placeholder="最小"
          onChange={(event) => onChange({ ...value, min: event.target.value })}
        />
        <span aria-hidden="true">至</span>
        <input
          type="number"
          min="0"
          step={step}
          inputMode="decimal"
          value={value.max}
          aria-label={`${label}上限`}
          placeholder="最大"
          onChange={(event) => onChange({ ...value, max: event.target.value })}
        />
      </div>
    </fieldset>
  );
}

function UsageTriStateField({
  label,
  value,
  onChange
}: {
  label: string;
  value: UsageBooleanDraft;
  onChange: (value: UsageBooleanDraft) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as UsageBooleanDraft)}>
        <option value="">全部</option>
        <option value="true">是</option>
        <option value="false">否</option>
      </select>
    </label>
  );
}

function UsageFilterGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="usage-filter-group">
      <h3>{title}</h3>
      <div className="filter-grid usage-filter-grid">{children}</div>
    </section>
  );
}

function buildFacetSelectOptions(
  page: UsageFacetPage | undefined,
  fallback: Array<{ value: string; label: string }> = [],
  selectedValue = ""
) {
  const options = new Map<string, string>();
  fallback.forEach((item) => item.value && options.set(item.value, item.label));
  page?.items.forEach((item) => options.set(item.value, `${item.label} (${item.count.toLocaleString()})`));
  if (selectedValue && !options.has(selectedValue)) {
    options.set(selectedValue, `#${selectedValue}`);
  }
  return [...options].map(([value, label]) => ({ value, label }));
}

type UsageTextFilterDefinition = {
  field: UsageTextDraftField;
  label: string;
  placeholder?: string;
  facetField?: UsageFacetField;
};

type UsageRangeFilterDefinition = {
  field: UsageRangeDraftField;
  label: string;
  step?: string;
};

const USAGE_IDENTITY_TEXT_FILTERS: UsageTextFilterDefinition[] = [
  { field: "usageId", label: "Usage ID", placeholder: "输入 Usage ID" },
  { field: "requestId", label: "Request ID", placeholder: "输入 Request ID" },
  { field: "apiKeyName", label: "API Key 名称", placeholder: "输入或搜索名称", facetField: "apiKey" }
];

const USAGE_ROUTING_TEXT_FILTERS: UsageTextFilterDefinition[] = [
  { field: "model", label: "模型", placeholder: "输入或搜索模型", facetField: "model" },
  { field: "platform", label: "平台", placeholder: "输入或搜索平台", facetField: "platform" },
  { field: "endpoint", label: "端点", placeholder: "输入或搜索端点", facetField: "endpoint" },
  { field: "upstreamEndpoint", label: "上游端点", placeholder: "输入或搜索上游端点", facetField: "upstreamEndpoint" },
  { field: "groupName", label: "分组名称", placeholder: "输入或搜索分组", facetField: "group" },
  { field: "subscriptionName", label: "订阅名称", placeholder: "输入或搜索订阅", facetField: "subscription" },
  { field: "subscriptionType", label: "订阅类型", placeholder: "输入或搜索类型", facetField: "subscriptionType" },
  { field: "serviceTier", label: "服务档位", placeholder: "输入或搜索档位", facetField: "serviceTier" }
];

const USAGE_REQUEST_TEXT_FILTERS: UsageTextFilterDefinition[] = [
  { field: "reasoningEffort", label: "推理档位", placeholder: "例如 high", facetField: "reasoningEffort" },
  { field: "requestType", label: "请求类型", placeholder: "例如 stream", facetField: "requestType" },
  { field: "billingMode", label: "计费模式", placeholder: "例如 token", facetField: "billingMode" }
];

const USAGE_MEDIA_TEXT_FILTERS: UsageTextFilterDefinition[] = [
  { field: "mediaType", label: "媒体类型", placeholder: "输入或搜索类型", facetField: "mediaType" },
  { field: "imageSize", label: "图片尺寸", placeholder: "输入或搜索尺寸", facetField: "imageSize" },
  { field: "imageInputSize", label: "图片输入尺寸", placeholder: "输入或搜索尺寸", facetField: "imageInputSize" },
  { field: "imageOutputSize", label: "图片输出尺寸", placeholder: "输入或搜索尺寸", facetField: "imageOutputSize" },
  { field: "imageSizeSource", label: "图片尺寸来源", placeholder: "输入或搜索来源", facetField: "imageSizeSource" },
  { field: "imageSizeBreakdown", label: "图片尺寸明细", placeholder: "输入或搜索明细", facetField: "imageSizeBreakdown" },
  { field: "ipAddress", label: "IP 地址", placeholder: "输入 IP 地址" }
];

const USAGE_TOKEN_RANGE_FILTERS: UsageRangeFilterDefinition[] = [
  { field: "inputTokens", label: "输入 Token" },
  { field: "outputTokens", label: "输出 Token" },
  { field: "totalTokens", label: "总 Token" },
  { field: "cacheCreationTokens", label: "缓存写入 Token" },
  { field: "cacheReadTokens", label: "缓存读取 Token" },
  { field: "cacheCreation5mTokens", label: "5 分钟缓存 Token" },
  { field: "cacheCreation1hTokens", label: "1 小时缓存 Token" },
  { field: "imageInputTokens", label: "图片输入 Token" },
  { field: "imageOutputTokens", label: "图片输出 Token" }
];

const USAGE_COST_RANGE_FILTERS: UsageRangeFilterDefinition[] = [
  { field: "actualCost", label: "实际成本", step: "0.000001" },
  { field: "totalCost", label: "标准成本", step: "0.000001" },
  { field: "inputCost", label: "输入成本", step: "0.000001" },
  { field: "outputCost", label: "输出成本", step: "0.000001" },
  { field: "cacheCreationCost", label: "缓存写入成本", step: "0.000001" },
  { field: "cacheReadCost", label: "缓存读取成本", step: "0.000001" },
  { field: "imageInputCost", label: "图片输入成本", step: "0.000001" },
  { field: "imageOutputCost", label: "图片输出成本", step: "0.000001" },
  { field: "rateMultiplier", label: "倍率", step: "0.01" }
];

const USAGE_PERFORMANCE_RANGE_FILTERS: UsageRangeFilterDefinition[] = [
  { field: "durationMs", label: "总耗时 (ms)" },
  { field: "firstTokenMs", label: "首 Token (ms)" },
  { field: "imageCount", label: "图片数量" }
];

export function UsagePage({
  managedKeys,
  usageFilterDraft,
  setUsageFilterDraft,
  usageFacetPages,
  usageFacetLoadingFields,
  loadUsageFacet,
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
  usageExtremes,
  usageModelSummaries,
  usageModelSummariesLoading,
  usageRecords,
  usagePageSize,
  usagePageSizeOptions,
  handleUsageSearch,
  handleUsageFilterReset,
  handleUsagePreviousPage,
  handleUsageNextPage,
  handleUsagePageSizeChange,
  usageCursorDepth,
  usageTrend,
  usageModels
}: {
  managedKeys: PaginatedResult<ManagedKeyRecord> | null;
  usageFilterDraft: UsageFilterDraft;
  setUsageFilterDraft: Dispatch<SetStateAction<UsageFilterDraft>>;
  usageFacetPages: Partial<Record<UsageFacetField, UsageFacetPage>>;
  usageFacetLoadingFields: UsageFacetField[];
  loadUsageFacet: (field: UsageFacetField, search?: string, force?: boolean) => Promise<UsageFacetPage | null>;
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
  usageExtremes: UsageExtremesPayload | null;
  usageModelSummaries: UsageModelSummary[];
  usageModelSummariesLoading: boolean;
  usageRecords: UsageCursorPage<UsageRow> | null;
  usagePageSize: number;
  usagePageSizeOptions: number[];
  handleUsageSearch: () => Promise<void>;
  handleUsageFilterReset: () => Promise<void>;
  handleUsagePreviousPage: () => Promise<void>;
  handleUsageNextPage: () => Promise<void>;
  handleUsagePageSizeChange: (pageSize: number) => Promise<void>;
  usageCursorDepth: number;
  usageTrend: UsageTrendPayload | null;
  usageModels: DashboardModelsPayload | null;
}) {
  const currentPageRows = usageRecords?.items ?? [];
  const currentPageModelSummaries = usageModelSummaries.length > 0
    ? usageModelSummaries
    : currentPageRows.length > 0
      ? summarizeUsageRowsByModel(currentPageRows)
      : [];
  const topRequestModel = findTopUsageModel(currentPageModelSummaries, (summary) => summary.requests);
  const topOutputModel = findTopUsageModel(currentPageModelSummaries, (summary) => summary.outputTokens);
  const longestFirstTokenRow = usageExtremes?.longestFirstToken ?? null;
  const highestCostRow = usageExtremes?.highestActualCost ?? null;
  const highestInputRow = usageExtremes?.highestInputTokens ?? null;
  const highestOutputRow = usageExtremes?.highestOutputTokens ?? null;
  const hasUsageRows = (usageRecords?.items.length ?? 0) > 0;
  const totalCacheInputTokens = getCacheInputTokens(
    usageStats?.totalCacheTokens,
    usageStats?.totalCacheCreationTokens,
    usageStats?.totalCacheReadTokens
  );
  const usageTableMeta = usageRecords ? (
    <>
      <span>本次加载 {usageRecords.items.length.toLocaleString()} 条</span>
      {usageRecords.total !== null && usageRecords.total !== undefined ? (
        <span>共 {usageRecords.total.toLocaleString()} 条</span>
      ) : null}
      <span>游标深度 {usageCursorDepth}</span>
    </>
  ) : (
    <span>当前没有可展示的用量记录</span>
  );
  const usagePageSizeControl = usageRecords ? (
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
  ) : null;
  const apiKeyFallbackOptions = (managedKeys?.items ?? [])
    .filter((key) => key.apiKeyId !== null && key.apiKeyId !== undefined)
    .map((key) => ({ value: String(key.apiKeyId), label: key.name }));

  const updateDraftField = <Key extends keyof UsageFilterDraft>(
    field: Key,
    value: UsageFilterDraft[Key]
  ) => {
    setUsageFilterDraft((draft) => ({ ...draft, [field]: value }));
  };
  const updateTextDraft = (field: UsageTextDraftField, value: UsageTextFilterDraft) => {
    updateDraftField(field, value);
  };
  const updateRangeDraft = (field: UsageRangeDraftField, value: UsageRangeDraft) => {
    updateDraftField(field, value);
  };
  const requestFacet = (field: UsageFacetField, search = "", force = false) => {
    void loadUsageFacet(field, search, force);
  };
  const renderTextFilters = (definitions: UsageTextFilterDefinition[]) => definitions.map((definition) => (
    <UsageTextFilterField
      key={definition.field}
      id={`usage-filter-${definition.field}`}
      label={definition.label}
      value={usageFilterDraft[definition.field]}
      placeholder={definition.placeholder}
      facetField={definition.facetField}
      facetPage={definition.facetField ? usageFacetPages[definition.facetField] : undefined}
      facetLoading={definition.facetField ? usageFacetLoadingFields.includes(definition.facetField) : false}
      showMatchMode
      onChange={(value) => updateTextDraft(definition.field, value)}
      onLoadFacet={requestFacet}
    />
  ));
  const renderRangeFilters = (definitions: UsageRangeFilterDefinition[]) => definitions.map((definition) => (
    <UsageRangeFilterField
      key={definition.field}
      label={definition.label}
      value={usageFilterDraft[definition.field]}
      step={definition.step}
      onChange={(value) => updateRangeDraft(definition.field, value)}
    />
  ));

  return (
    <section className="usage-view motion-shell-section">
      <SectionCard
        title="用量明细"
        subtitle="逐条查看用了什么、花了多少、耗时多久"
        actions={
          <div className="usage-filter-actions">
            <button className="ghost-button" onClick={() => void handleUsageFilterReset()}>
              <RotateCcw size={16} />
              重置筛选
            </button>
            <button className="primary-button" onClick={() => void handleUsageSearch()}>
              <RefreshCcw size={16} />
              查询
            </button>
          </div>
        }
        >
        <details className="usage-filter-drawer">
          <summary className="usage-filter-drawer-toggle">
            <span className="usage-filter-drawer-toggle-copy">
              <SlidersHorizontal size={16} aria-hidden="true" />
              筛选条件
            </span>
            <ChevronDown size={16} className="usage-filter-drawer-toggle-chevron" aria-hidden="true" />
          </summary>
          <div className="usage-filter-drawer-panel">
            <UsageFilterGroup title="时间与身份">
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
              <UsageScalarFilterField
                id="usage-filter-apiKeyId"
                label="API Key ID"
                value={usageFilterDraft.apiKeyId}
                placeholder="输入或选择 ID"
                facetField="apiKey"
                facetPage={usageFacetPages.apiKey}
                facetLoading={usageFacetLoadingFields.includes("apiKey")}
                fallbackOptions={apiKeyFallbackOptions}
                onChange={(value) => updateDraftField("apiKeyId", value)}
                onLoadFacet={requestFacet}
              />
              {renderTextFilters(USAGE_IDENTITY_TEXT_FILTERS)}
              <UsageScalarFilterField
                id="usage-filter-upstreamUserId"
                label="上游用户 ID"
                value={usageFilterDraft.upstreamUserId}
                placeholder="输入用户 ID"
                onChange={(value) => updateDraftField("upstreamUserId", value)}
              />
              <UsageScalarFilterField
                id="usage-filter-upstreamAccountId"
                label="上游账号 ID"
                value={usageFilterDraft.upstreamAccountId}
                placeholder="输入账号 ID"
                onChange={(value) => updateDraftField("upstreamAccountId", value)}
              />
            </UsageFilterGroup>

            <UsageFilterGroup title="路由与归属">
              <UsageScalarFilterField
                id="usage-filter-groupId"
                label="分组 ID"
                value={usageFilterDraft.groupId}
                placeholder="输入或选择 ID"
                facetField="group"
                facetPage={usageFacetPages.group}
                facetLoading={usageFacetLoadingFields.includes("group")}
                onChange={(value) => updateDraftField("groupId", value)}
                onLoadFacet={requestFacet}
              />
              <UsageScalarFilterField
                id="usage-filter-subscriptionId"
                label="订阅 ID"
                value={usageFilterDraft.subscriptionId}
                placeholder="输入或选择 ID"
                facetField="subscription"
                facetPage={usageFacetPages.subscription}
                facetLoading={usageFacetLoadingFields.includes("subscription")}
                onChange={(value) => updateDraftField("subscriptionId", value)}
                onLoadFacet={requestFacet}
              />
              {renderTextFilters(USAGE_ROUTING_TEXT_FILTERS)}
            </UsageFilterGroup>

            <UsageFilterGroup title="请求与计费">
              <UsageScalarFilterField
                id="usage-filter-billingType"
                label="计费类型"
                value={usageFilterDraft.billingType}
                placeholder="输入或选择类型"
                facetField="billingType"
                facetPage={usageFacetPages.billingType}
                facetLoading={usageFacetLoadingFields.includes("billingType")}
                onChange={(value) => updateDraftField("billingType", value)}
                onLoadFacet={requestFacet}
              />
              {renderTextFilters(USAGE_REQUEST_TEXT_FILTERS)}
              <UsageTriStateField
                label="流式请求"
                value={usageFilterDraft.stream}
                onChange={(value) => updateDraftField("stream", value)}
              />
              <UsageTriStateField
                label="WebSocket 模式"
                value={usageFilterDraft.openaiWsMode}
                onChange={(value) => updateDraftField("openaiWsMode", value)}
              />
              <UsageTriStateField
                label="长上下文计费"
                value={usageFilterDraft.longContextBillingApplied}
                onChange={(value) => updateDraftField("longContextBillingApplied", value)}
              />
              <UsageTriStateField
                label="缓存 TTL 覆盖"
                value={usageFilterDraft.cacheTtlOverridden}
                onChange={(value) => updateDraftField("cacheTtlOverridden", value)}
              />
            </UsageFilterGroup>

            <UsageFilterGroup title="Token 范围">
              {renderRangeFilters(USAGE_TOKEN_RANGE_FILTERS)}
            </UsageFilterGroup>

            <UsageFilterGroup title="成本与性能">
              {renderRangeFilters(USAGE_COST_RANGE_FILTERS)}
              {renderRangeFilters(USAGE_PERFORMANCE_RANGE_FILTERS)}
            </UsageFilterGroup>

            <UsageFilterGroup title="客户端与媒体">
              {renderTextFilters(USAGE_MEDIA_TEXT_FILTERS)}
              <label className="field" htmlFor="usage-filter-userAgentQuery">
                <span>User-Agent</span>
                <input
                  id="usage-filter-userAgentQuery"
                  value={usageFilterDraft.userAgentQuery}
                  placeholder="输入 Token 或前缀"
                  onChange={(event) => updateDraftField("userAgentQuery", event.target.value)}
                />
              </label>
            </UsageFilterGroup>
          </div>
        </details>
        {usageStats && (
          <div className="metric-grid compact-metrics motion-stagger-grid">
            <MetricCard
              label="请求数"
              value={usageStats.totalRequests.toLocaleString()}
              hint={buildUsageModelHint("最多请求", topRequestModel?.model)}
              accent="sky"
              icon={<LayoutDashboard size={18} />}
              detailTitle="模型请求次数"
              detail={<UsageModelRequestDetails models={currentPageModelSummaries} loading={usageModelSummariesLoading} />}
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
              detail={<UsageTokenMetricDetails models={currentPageModelSummaries} field="input" loading={usageModelSummariesLoading} />}
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
              detail={<UsageTokenMetricDetails models={currentPageModelSummaries} field="output" loading={usageModelSummariesLoading} />}
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
        {hasUsageRows && (
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
        {hasUsageRows ? (
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
                <col style={{ width: "10%" }} />
                <col style={{ width: "11%" }} />
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
                  <th>IP</th>
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
                          <DetailItem
                            label="图片输入 Token"
                            value={row.imageInputTokens === null || row.imageInputTokens === undefined
                              ? "-"
                              : compact(row.imageInputTokens)}
                          />
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
                      <td className="usage-user-agent" title={row.ipAddress?.trim() || "-"}>
                        {row.ipAddress?.trim() || "-"}
                      </td>
                      <td className="usage-user-agent" title={row.userAgent ?? "-"}>
                        {row.userAgent ?? "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="当前没有用量明细" detail="修改筛选后重新查询，或先刷新账号数据。" compact />
        )}
        {!usageRecords && (
          <div className="usage-table-toolbar">
            <div className="usage-table-meta">{usageTableMeta}</div>
          </div>
        )}
        {usageRecords && (
          <div className="usage-pagination">
            <div className="usage-pagination-compact">
              <div className="usage-table-meta">{usageTableMeta}</div>
              {usagePageSizeControl}
              <div className="usage-pagination-actions">
                <button
                  className="ghost-button"
                  disabled={!usageRecords.hasPrevious || usageCursorDepth <= 0}
                  onClick={() => void handleUsagePreviousPage()}
                >
                  上一页
                </button>
                <button
                  className="ghost-button"
                  disabled={!usageRecords.hasNext}
                  onClick={() => void handleUsageNextPage()}
                >
                  下一页
                </button>
              </div>
            </div>
          </div>
        )}
      </SectionCard>
      <div className="usage-insights-grid">
        <UsageTrendSection
          subtitle="查看最近一段时间的用量和花费变化"
          points={usageTrend?.trend ?? []}
        />
        <SectionCard title="模型分布" subtitle="看看不同模型的使用次数和花费">
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
