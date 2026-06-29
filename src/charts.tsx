import { useEffect, useRef } from "react";
import { BarChart, HeatmapChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
import { init, use, type EChartsType } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

use([
  BarChart,
  HeatmapChart,
  LineChart,
  PieChart,
  ScatterChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer
]);

export type ChartOption = Record<string, unknown>;

export function EChartCard({ option }: { option: ChartOption | null }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const optionSignatureRef = useRef<string | null>(null);
  const hoverPointRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const chart = init(host);
    chartRef.current = chart;

    const observer = new ResizeObserver(() => {
      chart.resize();
      scheduleRestoreChartTooltip(chart, hoverPointRef.current, chartRef);
    });
    observer.observe(host);

    const handlePointerMove = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      hoverPointRef.current = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };
    };
    const handlePointerLeave = () => {
      hoverPointRef.current = null;
    };
    host.addEventListener("pointermove", handlePointerMove);
    host.addEventListener("pointerleave", handlePointerLeave);

    return () => {
      observer.disconnect();
      host.removeEventListener("pointermove", handlePointerMove);
      host.removeEventListener("pointerleave", handlePointerLeave);
      chart.dispose();
      chartRef.current = null;
      optionSignatureRef.current = null;
      hoverPointRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current) {
      return;
    }
    if (!option) {
      if (optionSignatureRef.current !== null) {
        chartRef.current.clear();
        optionSignatureRef.current = null;
      }
      return;
    }
    const nextSignature = buildChartOptionSignature(option);
    if (optionSignatureRef.current === nextSignature) {
      return;
    }
    chartRef.current.setOption(option as never, { notMerge: true });
    optionSignatureRef.current = nextSignature;
    scheduleRestoreChartTooltip(chartRef.current, hoverPointRef.current, chartRef);
  }, [option]);

  return (
    <div className="echart-card-shell">
      <div ref={hostRef} className="echart-host" />
      {!option && <div className="echart-overlay">当前没有图表数据</div>}
    </div>
  );
}

export interface TrendChartPoint {
  bucket: string;
  actualCost: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cacheHitRate: number;
  totalTokens: number;
}

type TrendMetric =
  | "actualCost"
  | "requests"
  | "totalTokens"
  | "cacheCreationTokens"
  | "cacheReadTokens"
  | "cacheHitRate";

export function normalizeTrendChartData(
  points: Array<{
    bucket?: string;
    date?: string;
    actualCost?: number | null;
    requests?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheCreationTokens?: number | null;
    cacheReadTokens?: number | null;
    totalTokens?: number | null;
  }>
): TrendChartPoint[] {
  return points.map((point) => {
    const inputTokens = point.inputTokens ?? 0;
    const cacheReadTokens = point.cacheReadTokens ?? 0;
    return {
      bucket: point.bucket ?? point.date ?? "",
      actualCost: point.actualCost ?? 0,
      requests: point.requests ?? 0,
      inputTokens,
      outputTokens: point.outputTokens ?? 0,
      cacheCreationTokens: point.cacheCreationTokens ?? 0,
      cacheReadTokens,
      cacheHitRate: computeCacheHitRate(inputTokens, cacheReadTokens),
      totalTokens: point.totalTokens ?? 0
    };
  });
}

export function buildTrendAreaChartOption(input: {
  data: TrendChartPoint[];
  series: TrendMetric[];
}): ChartOption | null {
  if (input.data.length === 0 || input.series.length === 0) {
    return null;
  }

  const palette = readChartPalette();
  const seriesPalette: Record<TrendMetric, string> = {
    actualCost: palette.accent,
    requests: palette.secondary,
    totalTokens: palette.indigo,
    cacheCreationTokens: palette.warning,
    cacheReadTokens: palette.sky,
    cacheHitRate: palette.rose
  };
  const labels: Record<TrendMetric, string> = {
    actualCost: "实际成本",
    requests: "请求数",
    totalTokens: "总 Tokens",
    cacheCreationTokens: "缓存写入",
    cacheReadTokens: "缓存读取",
    cacheHitRate: "缓存率"
  };
  const metricByLabel = Object.fromEntries(
    Object.entries(labels).map(([metric, label]) => [label, metric as TrendMetric])
  ) as Record<string, TrendMetric>;

  return {
    backgroundColor: "transparent",
    color: input.series.map((key) => seriesPalette[key]),
    tooltip: {
      trigger: "axis",
      formatter: (params: unknown) => {
        const rows = Array.isArray(params) ? params : [params];
        const head = rows[0] && typeof rows[0] === "object" && rows[0] && "axisValueLabel" in rows[0]
          ? String((rows[0] as { axisValueLabel?: unknown }).axisValueLabel ?? "")
          : "";
        const lines = rows.flatMap((row) => {
          if (!row || typeof row !== "object") {
            return [];
          }
          const seriesName = String((row as { seriesName?: unknown }).seriesName ?? "");
          const metric = metricByLabel[seriesName];
          const rawValue = (row as { value?: unknown; marker?: unknown }).value;
          const value =
            typeof rawValue === "number"
              ? rawValue
              : Array.isArray(rawValue)
                ? Number(rawValue[rawValue.length - 1] ?? 0)
                : Number(rawValue ?? 0);
          return `${String((row as { marker?: unknown }).marker ?? "")}${seriesName} ${formatTrendMetricValue(metric, value)}`;
        });
        return [head, ...lines].filter(Boolean).join("<br/>");
      }
    },
    legend: {
      top: 0,
      type: "scroll",
      textStyle: { color: palette.textSoft }
    },
    grid: {
      top: 50,
      left: 52,
      right: 78,
      bottom: 24
    },
    xAxis: {
      type: "category",
      data: input.data.map((item) => item.bucket),
      axisLabel: { color: palette.textSoft },
      axisLine: { lineStyle: { color: palette.border } }
    },
    yAxis: [
      {
        type: "value",
        name: "成本 / 请求",
        axisLabel: { color: palette.textSoft },
        splitLine: { lineStyle: { color: palette.grid } }
      },
      {
        type: "value",
        show: false,
        splitLine: { show: false }
      },
      {
        type: "value",
        name: "缓存率",
        position: "right",
        min: 0,
        max: 100,
        offset: 8,
        axisLabel: {
          color: palette.textSoft,
          formatter: (value: number) => `${value}%`
        },
        splitLine: { show: false }
      }
    ],
    series: input.series.map((metric, index) => ({
      name: labels[metric],
      type: metric === "requests" ? "bar" : "line",
      smooth: metric !== "requests",
      yAxisIndex:
        metric === "cacheHitRate"
          ? 2
          : metric === "actualCost" || metric === "requests"
            ? 0
            : 1,
      barMaxWidth: 18,
      areaStyle:
        metric === "actualCost"
          ? {
              color: `color-mix(in srgb, ${seriesPalette[metric]} 22%, transparent)`
            }
          : undefined,
      lineStyle: {
        width: metric === "actualCost" ? 2.5 : 2,
        type: metric === "cacheHitRate" ? "dashed" : "solid"
      },
      showSymbol: metric === "requests",
      z: input.series.length - index,
      data: input.data.map((item) => item[metric])
    }))
  };
}

export function buildPlatformDonutChartOption(
  rows: Array<{ platform: string; totalActualCost: number }>
): ChartOption | null {
  if (rows.length === 0) {
    return null;
  }
  const palette = readChartPalette();
  return {
    color: [palette.accent, palette.secondary, palette.warning, palette.rose, palette.indigo, palette.sky],
    tooltip: { trigger: "item" },
    legend: {
      orient: "vertical",
      right: 8,
      top: 12,
      textStyle: { color: palette.textSoft }
    },
    series: [
      {
        type: "pie",
        radius: ["45%", "72%"],
        center: ["36%", "50%"],
        label: { color: palette.textSoft },
        data: rows.map((item) => ({
          name: item.platform,
          value: item.totalActualCost
        }))
      }
    ]
  };
}

export function buildPlatformBarChartOption(
  rows: Array<{ platform: string; totalActualCost: number; totalTokens: number; totalRequests: number }>
): ChartOption | null {
  if (rows.length === 0) {
    return null;
  }
  const palette = readChartPalette();
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
      { name: "实际成本", type: "bar", data: rows.map((item) => item.totalActualCost) },
      { name: "请求数", type: "bar", data: rows.map((item) => item.totalRequests) },
      { name: "总 Tokens", type: "line", yAxisIndex: 1, smooth: true, data: rows.map((item) => item.totalTokens) }
    ]
  };
}

function readChartPalette() {
  if (typeof window === "undefined") {
    return {
      accent: "#68c4ba",
      secondary: "#5e8cff",
      warning: "#e3a62c",
      rose: "#d6455f",
      indigo: "#8d78ff",
      sky: "#4fc8f0",
      textSoft: "#6a778d",
      border: "rgba(16, 24, 38, 0.12)",
      grid: "rgba(148, 163, 184, 0.18)",
      chartBg: "transparent",
      chartGrid: "rgba(148, 163, 184, 0.18)"
    };
  }
  const style = getComputedStyle(document.documentElement);
  return {
    accent: style.getPropertyValue("--accent").trim() || "#68c4ba",
    secondary: style.getPropertyValue("--chart-2").trim() || "#5e8cff",
    warning: style.getPropertyValue("--chart-3").trim() || "#e3a62c",
    rose: style.getPropertyValue("--danger").trim() || "#d6455f",
    indigo: style.getPropertyValue("--chart-5").trim() || "#8d78ff",
    sky: style.getPropertyValue("--chart-4").trim() || "#4fc8f0",
    textSoft: style.getPropertyValue("--text-subtle").trim() || "#6a778d",
    border: style.getPropertyValue("--border").trim() || "rgba(16, 24, 38, 0.12)",
    grid: style.getPropertyValue("--chart-grid").trim() || "rgba(148, 163, 184, 0.18)",
    chartBg: style.getPropertyValue("--chart-bg").trim() || "transparent",
    chartGrid: style.getPropertyValue("--chart-grid").trim() || "rgba(148, 163, 184, 0.18)"
  };
}

export function buildChartOptionSignature(option: ChartOption | null) {
  if (!option) {
    return "__empty__";
  }
  return JSON.stringify(option, chartOptionSignatureReplacer);
}

function scheduleRestoreChartTooltip(
  chart: EChartsType,
  hoverPoint: { x: number; y: number } | null,
  chartRef: { current: EChartsType | null }
) {
  if (!hoverPoint) {
    return;
  }
  const restore = () => {
    if (chartRef.current !== chart) {
      return;
    }
    chart.dispatchAction({
      type: "showTip",
      x: hoverPoint.x,
      y: hoverPoint.y
    } as never);
  };
  if (typeof window !== "undefined") {
    window.requestAnimationFrame(restore);
    return;
  }
  restore();
}

function chartOptionSignatureReplacer(_key: string, value: unknown) {
  if (typeof value === "function") {
    return `__fn__:${Function.prototype.toString.call(value)}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return `__num__:${String(value)}`;
  }
  if (value instanceof Date) {
    return `__date__:${value.toISOString()}`;
  }
  if (Array.isArray(value) || value == null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
  );
}

function computeCacheHitRate(inputTokens: number, cacheReadTokens: number) {
  const denominator = inputTokens + cacheReadTokens;
  if (denominator <= 0) {
    return 0;
  }
  return Number(((cacheReadTokens / denominator) * 100).toFixed(2));
}

function formatTrendMetricValue(metric: TrendMetric | undefined, value: number) {
  if (metric === "actualCost") {
    return `$${value.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
  }
  if (metric === "cacheHitRate") {
    return `${value.toFixed(2)}%`;
  }
  return Math.round(value).toLocaleString();
}
