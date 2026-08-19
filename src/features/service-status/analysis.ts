import type { ChartOption, ChartPalette } from "../../charts";
import type { ServiceStatusServiceRecord } from "../../types";

export const SERVICE_STATUS_ANALYSIS_WINDOW_SIZE = 60;

export type ServiceStatusAnalysisRow = {
  model: string;
  currentOk: boolean | null;
  uptimePct: number;
  windowUptimePct: number | null;
  latestLatencyMs: number | null;
  averageLatencyMs: number | null;
  p95LatencyMs: number | null;
  failedSamples: number;
  sampleCount: number;
};

export function buildServiceStatusAnalysisRows(
  services: ServiceStatusServiceRecord[]
): ServiceStatusAnalysisRow[] {
  return services.map((service) => {
    const history = service.history.slice(-SERVICE_STATUS_ANALYSIS_WINDOW_SIZE);
    const successfulLatencies = history
      .filter((probe) => probe.ok && isFiniteLatency(probe.latencyMs))
      .map((probe) => probe.latencyMs as number);
    const successfulSamples = history.filter((probe) => probe.ok).length;

    return {
      model: service.model,
      currentOk: service.last?.ok ?? null,
      uptimePct: service.uptimePct,
      windowUptimePct: history.length > 0 ? (successfulSamples / history.length) * 100 : null,
      latestLatencyMs: isFiniteLatency(service.last?.latencyMs) ? service.last?.latencyMs ?? null : null,
      averageLatencyMs: computeAverage(successfulLatencies),
      p95LatencyMs: computePercentile(successfulLatencies, 0.95),
      failedSamples: history.filter((probe) => !probe.ok).length,
      sampleCount: history.length
    };
  });
}

export function buildServiceLatencyTrendOption(
  services: ServiceStatusServiceRecord[],
  palette: ChartPalette
): ChartOption | null {
  const series = services.map((service, index) => ({
    name: service.model,
    type: "line",
    data: service.history
      .slice(-SERVICE_STATUS_ANALYSIS_WINDOW_SIZE)
      .sort((left, right) => left.ts - right.ts)
      .map((probe): [number, number] => [
        probe.ts * 1000,
        probe.ok && isFiniteLatency(probe.latencyMs) ? probe.latencyMs : 0
      ]),
    showSymbol: false,
    connectNulls: true,
    smooth: 0.16,
    lineStyle: { width: index === 0 ? 2.4 : 1.8 },
    emphasis: { focus: "series" }
  }));
  if (series.every((item) => item.data.length === 0)) {
    return null;
  }

  return {
    animationDuration: 320,
    color: getChartColors(palette),
    grid: { left: 52, right: 18, top: 76, bottom: 34 },
    tooltip: {
      trigger: "axis",
      backgroundColor: palette.chartBg,
      borderColor: palette.border,
      textStyle: { color: palette.textStrong },
      formatter: formatLatencyTrendTooltip,
      position: positionLatencyTrendTooltip
    },
    legend: {
      type: "scroll",
      width: "100%",
      top: 0,
      right: 0,
      itemWidth: 16,
      itemHeight: 8,
      itemGap: 12,
      pageIconColor: palette.textStrong,
      pageIconInactiveColor: palette.border,
      pageTextStyle: { color: palette.textSoft, fontSize: 10 },
      textStyle: { color: palette.textSoft, fontSize: 12, fontWeight: 600 }
    },
    xAxis: {
      type: "time",
      boundaryGap: false,
      axisLine: { lineStyle: { color: palette.border } },
      axisTick: { show: false },
      axisLabel: {
        color: palette.textSoft,
        hideOverlap: true,
        fontSize: 10,
        formatter: formatProbeTime
      }
    },
    yAxis: {
      type: "value",
      min: 0,
      name: "ms",
      nameTextStyle: { color: palette.textSoft },
      axisLabel: { color: palette.textSoft },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    series
  };
}

export function buildServiceUptimeRankingOption(
  rows: ServiceStatusAnalysisRow[],
  palette: ChartPalette
): ChartOption | null {
  if (rows.length === 0) {
    return null;
  }

  const sortedRows = [...rows].sort((left, right) => right.uptimePct - left.uptimePct);

  return {
    animationDuration: 280,
    grid: { left: 112, right: 42, top: 8, bottom: 24 },
    tooltip: {
      trigger: "item",
      backgroundColor: palette.chartBg,
      borderColor: palette.border,
      textStyle: { color: palette.textStrong },
      valueFormatter: formatChartPercent
    },
    xAxis: {
      type: "value",
      min: 0,
      max: 100,
      axisLabel: { color: palette.textSoft, formatter: "{value}%" },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: sortedRows.map((row) => row.model),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: palette.textSoft, width: 100, overflow: "truncate" }
    },
    series: [
      {
        name: "可用率",
        type: "bar",
        barMaxWidth: 18,
        data: sortedRows.map((row) => ({
          value: Number(row.uptimePct.toFixed(2)),
          itemStyle: { color: getUptimeColor(row.uptimePct, palette), borderRadius: [0, 3, 3, 0] }
        })),
        label: {
          show: true,
          position: "right",
          color: palette.textStrong,
          formatter: "{c}%"
        }
      }
    ]
  };
}

export function buildServiceLatencyComparisonOption(
  rows: ServiceStatusAnalysisRow[],
  palette: ChartPalette
): ChartOption | null {
  const chartRows = rows.filter((row) => row.averageLatencyMs !== null || row.p95LatencyMs !== null);

  if (chartRows.length === 0) {
    return null;
  }

  return {
    animationDuration: 280,
    color: [palette.secondary, palette.warning],
    grid: { left: 112, right: 24, top: 42, bottom: 24 },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      backgroundColor: palette.chartBg,
      borderColor: palette.border,
      textStyle: { color: palette.textStrong }
    },
    legend: {
      top: 0,
      right: 0,
      itemWidth: 12,
      itemHeight: 8,
      textStyle: { color: palette.textSoft, fontSize: 10 }
    },
    xAxis: {
      type: "value",
      min: 0,
      axisLabel: { color: palette.textSoft },
      splitLine: { lineStyle: { color: palette.chartGrid } }
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: chartRows.map((row) => row.model),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: palette.textSoft, width: 100, overflow: "truncate" }
    },
    series: [
      {
        name: "平均延迟",
        type: "bar",
        barMaxWidth: 13,
        data: chartRows.map((row) => row.averageLatencyMs),
        tooltip: { valueFormatter: formatChartLatency }
      },
      {
        name: "P95 延迟",
        type: "bar",
        barMaxWidth: 13,
        data: chartRows.map((row) => row.p95LatencyMs),
        tooltip: { valueFormatter: formatChartLatency }
      }
    ]
  };
}

function computeAverage(values: number[]) {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function computePercentile(values: number[], percentile: number) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentile) - 1));
  return sorted[index];
}

function isFiniteLatency(value?: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function getChartColors(palette: ChartPalette) {
  return [palette.accent, palette.secondary, palette.warning, palette.rose, palette.indigo, palette.sky];
}

function getUptimeColor(value: number, palette: ChartPalette) {
  if (value >= 99.9) {
    return palette.tertiary;
  }
  if (value >= 95) {
    return palette.warning;
  }
  return palette.rose;
}

function formatProbeTime(timestamp: number) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    return "-";
  }
  return date.toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function formatProbeTimeWithSeconds(timestamp: number) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    return "-";
  }
  return date.toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function positionLatencyTrendTooltip(
  point: [number, number],
  _params: unknown,
  _element: unknown,
  _rect: unknown,
  size: { contentSize: [number, number]; viewSize: [number, number] }
) {
  const gap = 12;
  const [pointX, pointY] = point;
  const [contentWidth, contentHeight] = size.contentSize;
  const [viewWidth, viewHeight] = size.viewSize;
  const tooltipElement =
    typeof HTMLElement !== "undefined" && _element instanceof HTMLElement ? _element : null;
  const chartLeft = tooltipElement?.parentElement?.getBoundingClientRect().left ?? 0;
  const viewportWidth = tooltipElement?.ownerDocument.documentElement.clientWidth ?? viewWidth;
  const viewportPadding = tooltipElement ? 8 : 0;
  const minX = chartLeft > viewportPadding ? viewportPadding - chartLeft : 0;
  const maxX = Math.max(
    minX,
    viewportWidth - chartLeft - contentWidth - viewportPadding
  );
  const maxY = Math.max(0, viewHeight - contentHeight);
  const preferredX =
    contentWidth > viewWidth
      ? maxX
      : pointX + gap + contentWidth <= viewWidth
        ? pointX + gap
        : pointX - gap - contentWidth;

  return [
    Math.max(minX, Math.min(preferredX, maxX)),
    Math.max(0, Math.min(pointY + gap, maxY))
  ];
}

function formatLatencyTrendTooltip(params: unknown) {
  const rows = Array.isArray(params) ? params : [params];
  const points = rows.flatMap((row) => {
    if (!row || typeof row !== "object") {
      return [];
    }
    const value = (row as { value?: unknown }).value;
    if (!Array.isArray(value)) {
      return [];
    }
    return [{
      timestamp: Number(value[0]),
      latency: value[value.length - 1],
      marker: String((row as { marker?: unknown }).marker ?? ""),
      seriesName: String((row as { seriesName?: unknown }).seriesName ?? "")
    }];
  });
  if (points.length === 0) {
    return "";
  }

  // Axis tooltip 可能聚合相邻秒级点，时间统一放在首行，延迟值使用独立右对齐列。
  const timestamps = [...new Set(
    points.map((point) => point.timestamp).filter(Number.isFinite)
  )].sort((left, right) => left - right);
  const firstTimestamp = timestamps[0];
  const lastTimestamp = timestamps.at(-1);
  const timeLabel =
    firstTimestamp === undefined || lastTimestamp === undefined
      ? "-"
      : firstTimestamp === lastTimestamp
        ? formatProbeTimeWithSeconds(firstTimestamp)
        : `${formatProbeTimeWithSeconds(firstTimestamp)} - ${formatProbeTimeWithSeconds(lastTimestamp)}`;
  const modelRows = points
    .map(
      (point) =>
        `<span>${point.marker}${point.seriesName}</span>` +
        `<span style="text-align:right;font-variant-numeric:tabular-nums">${formatChartLatency(point.latency)}</span>`
    )
    .join("");

  return [
    `<div style="margin-bottom:4px">${timeLabel}</div>`,
    '<div style="display:grid;grid-template-columns:max-content minmax(72px,max-content);column-gap:12px;row-gap:2px">',
    modelRows,
    "</div>"
  ].join("");
}

function formatChartLatency(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number).toLocaleString()} ms` : "-";
}

function formatChartPercent(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(2)}%` : "-";
}
