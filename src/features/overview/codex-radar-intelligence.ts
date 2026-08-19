import type { ChartOption, ChartPalette } from "../../charts";
import type {
  CodexRadarIntelligenceDetailItem,
  CodexRadarIntelligenceEfficiencyPoint,
  CodexRadarIntelligenceHistoryPoint,
  CodexRadarIntelligencePayload
} from "../../types";
import { formatPercent, formatTime, formatUsd } from "../../shared/lib/formatters";
import { getCodexRadarEffortPresentation } from "./codex-radar-presentation";

export const CODEX_RADAR_TREND_METRICS = [
  "iq",
  "cost",
  "duration",
  "tokens",
  "passRate",
  "cacheHitRate"
] as const;

export type CodexRadarTrendMetric = (typeof CODEX_RADAR_TREND_METRICS)[number];

export type CodexRadarIntelligenceRow = {
  point: CodexRadarIntelligenceEfficiencyPoint;
  detail: CodexRadarIntelligenceDetailItem | null;
};

const CODEX_RADAR_EFFORT_ORDER: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
  ultra: 5
};

const CODEX_RADAR_MODEL_FAMILY_ORDER = ["sol", "terra", "luna"] as const;

export function buildCodexRadarIntelligenceRows(
  payload: CodexRadarIntelligencePayload | null
): CodexRadarIntelligenceRow[] {
  if (!payload) {
    return [];
  }
  const detailByModelEffort = new Map(
    payload.detailItems.map((item) => [buildModelEffortKey(item.model, item.reasoningEffort), item])
  );
  return [...payload.efficiencyPoints].sort(compareCodexRadarEfficiencyPoints).map((point) => ({
    point,
    detail: detailByModelEffort.get(buildModelEffortKey(point.model, point.reasoningEffort)) ?? null
  }));
}

export function compareCodexRadarEfficiencyPoints(
  left: CodexRadarIntelligenceEfficiencyPoint,
  right: CodexRadarIntelligenceEfficiencyPoint
) {
  return compareCodexRadarModelFamilies(left.model, right.model)
    || compareCodexRadarEfforts(left.reasoningEffort, right.reasoningEffort)
    || left.id.localeCompare(right.id);
}

export function compareCodexRadarModelFamilies(left: string, right: string) {
  const leftVersion = parseModelVersion(left);
  const rightVersion = parseModelVersion(right);
  const maximumLength = Math.max(leftVersion.length, rightVersion.length);
  for (let index = 0; index < maximumLength; index += 1) {
    const leftPart = leftVersion[index] ?? -1;
    const rightPart = rightVersion[index] ?? -1;
    if (leftPart !== rightPart) {
      return rightPart - leftPart;
    }
  }
  return getCodexRadarModelFamilyPriority(left) - getCodexRadarModelFamilyPriority(right)
    || left.localeCompare(right);
}

export function compareCodexRadarEfforts(left: string, right: string) {
  const leftNormalized = left.trim().toLowerCase();
  const rightNormalized = right.trim().toLowerCase();
  return (CODEX_RADAR_EFFORT_ORDER[leftNormalized] ?? Number.MAX_SAFE_INTEGER)
    - (CODEX_RADAR_EFFORT_ORDER[rightNormalized] ?? Number.MAX_SAFE_INTEGER)
    || leftNormalized.localeCompare(rightNormalized);
}

export function buildCodexRadarCostIqOption(
  points: CodexRadarIntelligenceEfficiencyPoint[],
  palette: ChartPalette
): ChartOption | null {
  const families = new Map<string, CodexRadarIntelligenceEfficiencyPoint[]>();
  for (const point of [...points].sort(compareCodexRadarEfficiencyPoints)) {
    if (!isPositiveFinite(point.combinedCostIndex)) {
      continue;
    }
    const entries = families.get(point.model) ?? [];
    entries.push(point);
    families.set(point.model, entries);
  }
  if (families.size === 0) {
    return null;
  }
  const colors = [palette.warning, palette.accent, palette.rose, palette.tertiary];
  const series = [...families.entries()].map(([model, values], index) => {
    const color = colors[index % colors.length];
    return {
      name: formatModelFamily(model),
      type: "line",
      showSymbol: true,
      symbol: "circle",
      symbolSize: 10,
      smooth: false,
      connectNulls: false,
      itemStyle: { color },
      lineStyle: { color, width: 2, opacity: 0.72 },
      data: values.sort(compareCodexRadarEfficiencyPoints).map((point) => [
      point.combinedCostIndex,
      point.score,
      point.label,
      point.reasoningEffort,
      point.averageCostUsd,
      point.averageMinutes
      ])
    };
  });

  return {
    backgroundColor: "transparent",
    legend: {
      top: 2,
      textStyle: { color: palette.textSoft },
      data: series.map((item) => item.name)
    },
    grid: { top: 46, right: 22, bottom: 44, left: 62 },
    tooltip: {
      trigger: "item",
      backgroundColor: palette.chartBg,
      borderColor: palette.border,
      textStyle: { color: palette.textStrong },
      formatter: (params: unknown) => formatCostIqTooltip(params)
    },
    xAxis: {
      type: "log",
      name: "综合成本指数",
      nameLocation: "middle",
      nameGap: 30,
      logBase: 10,
      axisLabel: { color: palette.textSoft },
      nameTextStyle: { color: palette.textSoft },
      axisLine: { lineStyle: { color: palette.border } },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    yAxis: {
      type: "value",
      name: "IQ",
      axisLabel: { color: palette.textSoft },
      nameTextStyle: { color: palette.textSoft },
      axisLine: { lineStyle: { color: palette.border } },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    series
  };
}

export function buildCodexRadarTrendOption(
  detailItems: CodexRadarIntelligenceDetailItem[],
  metric: CodexRadarTrendMetric,
  palette: ChartPalette
): ChartOption | null {
  const entries = [...detailItems]
    .sort((left, right) => (
      compareCodexRadarModelFamilies(left.model, right.model)
      || compareCodexRadarEfforts(left.reasoningEffort, right.reasoningEffort)
      || left.id.localeCompare(right.id)
    ))
    .map((item) => ({
      item,
      history: [...item.history]
        .filter((point) => trendValue(point, metric) !== null)
        .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
    }))
    .filter((entry) => entry.history.length > 0);
  if (entries.length === 0) {
    return null;
  }
  const timestamps = [...new Set(entries.flatMap((entry) => entry.history.map((point) => point.observedAt)))].sort(
    (left, right) => Date.parse(left) - Date.parse(right)
  );
  if (timestamps.length === 0) {
    return null;
  }
  const colors = [palette.warning, palette.accent, palette.rose, palette.tertiary, palette.indigo, palette.sky];
  const series = entries.map(({ item, history }, index) => {
    const byTimestamp = new Map(history.map((point) => [point.observedAt, trendValue(point, metric)]));
    return {
      name: item.label,
      type: "line",
      showSymbol: true,
      symbolSize: 6,
      smooth: true,
      connectNulls: false,
      itemStyle: { color: colors[index % colors.length] },
      lineStyle: { width: 2 },
      data: timestamps.map((timestamp) => byTimestamp.get(timestamp) ?? null)
    };
  });

  return {
    backgroundColor: "transparent",
    legend: {
      type: "scroll",
      top: 2,
      textStyle: { color: palette.textSoft },
      data: series.map((item) => item.name)
    },
    grid: { top: 50, right: 22, bottom: 48, left: 62 },
    tooltip: {
      trigger: "axis",
      backgroundColor: palette.chartBg,
      borderColor: palette.border,
      textStyle: { color: palette.textStrong },
      valueFormatter: (value: unknown) => formatTrendValue(Number(value), metric)
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: timestamps.map(formatTime),
      axisLabel: { color: palette.textSoft, hideOverlap: true },
      axisLine: { lineStyle: { color: palette.border } }
    },
    yAxis: {
      type: "value",
      name: trendMetricMeta(metric).axisLabel,
      axisLabel: { color: palette.textSoft },
      nameTextStyle: { color: palette.textSoft },
      axisLine: { lineStyle: { color: palette.border } },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    series
  };
}

export function getCodexRadarTrendWindow(detailItems: CodexRadarIntelligenceDetailItem[]) {
  const timestamps = [
    ...new Set(
      detailItems
        .flatMap((item) => item.history.map((point) => point.observedAt))
        .map((value) => Date.parse(value))
        .filter(Number.isFinite)
    )
  ].sort((left, right) => left - right);
  if (timestamps.length === 0) {
    return null;
  }
  return {
    start: new Date(timestamps[0]).toISOString(),
    end: new Date(timestamps[timestamps.length - 1]).toISOString(),
    count: timestamps.length
  };
}

export function getCodexRadarTrendMetricMeta(metric: CodexRadarTrendMetric) {
  return trendMetricMeta(metric);
}

export function formatCodexRadarEffort(value: string) {
  return getCodexRadarEffortPresentation(value).label;
}

export function formatCodexRadarOptionalNumber(value: number | null | undefined) {
  return value === null || value === undefined ? "-" : value.toLocaleString();
}

export function formatCodexRadarNumber(value: number, digits = 1) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  return value
    .toFixed(digits)
    .replace(/(?:\.0+|(\.\d*?[1-9])0+)$/, "$1");
}

export function getCodexRadarCacheHitRate(
  inputTokens: number | null | undefined,
  cachedInputTokens: number | null | undefined
) {
  if (!isPositiveFinite(inputTokens) || cachedInputTokens === null || cachedInputTokens === undefined) {
    return null;
  }
  return (cachedInputTokens / inputTokens) * 100;
}

function buildModelEffortKey(model: string, effort: string) {
  return `${model.trim().toLowerCase()}::${effort.trim().toLowerCase()}`;
}

function parseModelVersion(model: string) {
  const match = model.trim().toLowerCase().match(/^gpt-(\d+(?:\.\d+)*)/);
  return match ? match[1].split(".").map(Number) : [];
}

function getCodexRadarModelFamilyPriority(model: string) {
  const tokens = model.trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const priority = CODEX_RADAR_MODEL_FAMILY_ORDER.findIndex((family) => tokens.includes(family));
  return priority === -1 ? CODEX_RADAR_MODEL_FAMILY_ORDER.length : priority;
}

function formatModelFamily(model: string) {
  return model.replace(/^gpt-/i, "GPT-").replace(/-/g, " ");
}

function trendMetricMeta(metric: CodexRadarTrendMetric) {
  const meta: Record<CodexRadarTrendMetric, { label: string; axisLabel: string }> = {
    iq: { label: "IQ", axisLabel: "IQ" },
    cost: { label: "平均费用", axisLabel: "美元 / 任务" },
    duration: { label: "平均耗时", axisLabel: "分钟 / 任务" },
    tokens: { label: "每任务 Token", axisLabel: "Token / 任务" },
    passRate: { label: "通过率", axisLabel: "通过率 (%)" },
    cacheHitRate: { label: "缓存命中率", axisLabel: "缓存命中率 (%)" }
  };
  return meta[metric];
}

function trendValue(point: CodexRadarIntelligenceHistoryPoint, metric: CodexRadarTrendMetric) {
  switch (metric) {
    case "iq":
      return Number.isFinite(point.score) ? point.score : null;
    case "cost":
      return isFiniteValue(point.averageCostUsd) ? point.averageCostUsd : null;
    case "duration":
      return isFiniteValue(point.averageTaskSeconds) ? point.averageTaskSeconds / 60 : null;
    case "tokens":
      return isPositiveFinite(point.totalTokens) && isPositiveFinite(point.tasks)
        ? point.totalTokens / point.tasks
        : null;
    case "passRate":
      return isPositiveFinite(point.tasks) ? (point.passed / point.tasks) * 100 : null;
    case "cacheHitRate":
      return getCodexRadarCacheHitRate(point.inputTokens, point.cachedInputTokens);
  }
}

function formatTrendValue(value: number, metric: CodexRadarTrendMetric) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  if (metric === "cost") {
    return formatUsd(value, 2);
  }
  if (metric === "duration") {
    return `${formatCodexRadarNumber(value)} 分钟`;
  }
  if (metric === "tokens") {
    return `${Math.round(value).toLocaleString()} Token`;
  }
  if (metric === "passRate" || metric === "cacheHitRate") {
    return formatPercent(value, 1);
  }
  return formatCodexRadarNumber(value);
}

function formatCostIqTooltip(params: unknown) {
  const data = (params as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) {
    return "";
  }
  const [, score, label, effort, averageCostUsd, averageMinutes] = data;
  return [
    String(label ?? ""),
    `IQ ${formatCodexRadarNumber(Number(score))}`,
    `强度 ${formatCodexRadarEffort(String(effort ?? ""))}`,
    `平均费用 ${isFiniteValue(averageCostUsd) ? formatUsd(averageCostUsd, 2) : "-"}`,
    `平均耗时 ${isFiniteValue(averageMinutes) ? `${formatCodexRadarNumber(Number(averageMinutes))} 分钟` : "-"}`
  ].join("<br/>");
}

function isFiniteValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFinite(value: unknown): value is number {
  return isFiniteValue(value) && value > 0;
}
