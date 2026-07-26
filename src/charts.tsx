import { useEffect, useRef } from "react";

type ChartInstance = {
  clear: () => void;
  dispatchAction: (payload: unknown) => void;
  dispose: () => void;
  resize: () => void;
  setOption: (option: unknown, options?: { notMerge?: boolean }) => void;
};

type ChartRuntime = {
  init: (host: HTMLElement) => ChartInstance;
};

let chartRuntimePromise: Promise<ChartRuntime> | null = null;

async function loadChartRuntime() {
  if (!chartRuntimePromise) {
    chartRuntimePromise = (async () => {
      const runtimeModule = await import("./charts-runtime");
      return {
        init: runtimeModule.init as ChartRuntime["init"]
      };
    })();
  }
  return chartRuntimePromise;
}

export type ChartOption = Record<string, unknown>;

const FALLBACK_CHART_DATA_FONT_FAMILY =
  '"JetBrains Mono", "Fira Code", "Cascadia Mono", Consolas, monospace';

export function withChartDataTypography(option: ChartOption): ChartOption {
  const fontFamily = readChartDataFontFamily();
  return {
    ...option,
    tooltip: mapChartOptionParts(option.tooltip, (tooltip) => ({
      ...tooltip,
      textStyle: mergeChartTextStyle(tooltip.textStyle, fontFamily)
    })),
    legend: mapChartOptionParts(option.legend, (legend) => ({
      ...legend,
      textStyle: mergeChartTextStyle(legend.textStyle, fontFamily)
    })),
    xAxis: mapChartOptionParts(option.xAxis, (axis) => withChartAxisTypography(axis, fontFamily)),
    yAxis: mapChartOptionParts(option.yAxis, (axis) => withChartAxisTypography(axis, fontFamily)),
    visualMap: mapChartOptionParts(option.visualMap, (visualMap) => ({
      ...visualMap,
      textStyle: mergeChartTextStyle(visualMap.textStyle, fontFamily)
    })),
    series: mapChartOptionParts(option.series, (series) => withChartSeriesTypography(series, fontFamily))
  };
}

export function EChartCard({ option }: { option: ChartOption | null }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ChartInstance | null>(null);
  const optionSignatureRef = useRef<string | null>(null);
  const hoverPointRef = useRef<{ x: number; y: number } | null>(null);
  const latestOptionRef = useRef<ChartOption | null>(option);
  latestOptionRef.current = option;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    let disposed = false;
    let layoutFrame: number | null = null;
    let layoutSettleTimer: number | null = null;

    const resizeChart = () => {
      const chart = chartRef.current;
      if (!chart || !hasChartHostSize(host)) {
        return;
      }
      chart.resize();
      scheduleRestoreChartTooltip(chart, hoverPointRef.current, chartRef);
    };
    const clearLayoutSync = () => {
      if (typeof window === "undefined") {
        return;
      }
      if (layoutFrame !== null) {
        window.cancelAnimationFrame(layoutFrame);
        layoutFrame = null;
      }
      if (layoutSettleTimer !== null) {
        window.clearTimeout(layoutSettleTimer);
        layoutSettleTimer = null;
      }
    };
    const scheduleLayoutSync = () => {
      if (typeof window === "undefined") {
        return;
      }
      clearLayoutSync();
      layoutFrame = window.requestAnimationFrame(() => {
        layoutFrame = null;
        resizeChart();
        layoutSettleTimer = window.setTimeout(() => {
          layoutSettleTimer = null;
          resizeChart();
        }, 120);
      });
    };

    const tryMountChart = async () => {
      if (disposed || chartRef.current || !hasChartHostSize(host)) {
        return;
      }
      const runtime = await loadChartRuntime();
      if (disposed || chartRef.current || !hasChartHostSize(host)) {
        return;
      }
      chartRef.current = runtime.init(host);
      const currentOption = latestOptionRef.current;
      if (currentOption) {
        const typedOption = withChartDataTypography(currentOption);
        chartRef.current.setOption(typedOption, { notMerge: true });
        optionSignatureRef.current = buildChartOptionSignature(typedOption);
      }
      scheduleLayoutSync();
    };
    const observer = new ResizeObserver(() => {
      void tryMountChart();
      scheduleLayoutSync();
    });
    observer.observe(host);
    const visibilityObserver = typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            void tryMountChart();
            scheduleLayoutSync();
          }
        });
    visibilityObserver?.observe(host);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void tryMountChart();
        scheduleLayoutSync();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void tryMountChart();

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
      disposed = true;
      observer.disconnect();
      visibilityObserver?.disconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearLayoutSync();
      host.removeEventListener("pointermove", handlePointerMove);
      host.removeEventListener("pointerleave", handlePointerLeave);
      chartRef.current?.dispose();
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
    const typedOption = withChartDataTypography(option);
    const nextSignature = buildChartOptionSignature(typedOption);
    if (optionSignatureRef.current === nextSignature) {
      return;
    }
    chartRef.current.setOption(typedOption, { notMerge: true });
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

function hasChartHostSize(host: HTMLElement) {
  const rect = host.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function readChartDataFontFamily() {
  if (typeof window === "undefined") {
    return FALLBACK_CHART_DATA_FONT_FAMILY;
  }
  return (
    getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
    FALLBACK_CHART_DATA_FONT_FAMILY
  );
}

function mapChartOptionParts(
  value: unknown,
  transform: (part: ChartOption) => ChartOption
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (isChartOption(item) ? transform(item) : item));
  }
  return isChartOption(value) ? transform(value) : value;
}

function withChartAxisTypography(axis: ChartOption, fontFamily: string): ChartOption {
  return {
    ...axis,
    axisLabel: mergeChartTextStyle(axis.axisLabel, fontFamily),
    nameTextStyle: mergeChartTextStyle(axis.nameTextStyle, fontFamily)
  };
}

function withChartSeriesTypography(series: ChartOption, fontFamily: string): ChartOption {
  return {
    ...series,
    label: mergeChartTextStyle(series.label, fontFamily),
    emphasis: isChartOption(series.emphasis)
      ? {
          ...series.emphasis,
          label: mergeChartTextStyle(series.emphasis.label, fontFamily)
        }
      : series.emphasis
  };
}

function mergeChartTextStyle(value: unknown, fontFamily: string): ChartOption {
  return {
    ...(isChartOption(value) ? value : {}),
    fontFamily
  };
}

function isChartOption(value: unknown): value is ChartOption {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

export function buildOverviewModelDonutChartOption(
  rows: Array<{ model: string; actualCost: number; totalCost: number; requests: number; totalTokens: number }>
): ChartOption | null {
  if (rows.length === 0) {
    return null;
  }
  const palette = readChartPalette();
  return {
    color: [palette.accent, palette.secondary, palette.warning, palette.rose, palette.indigo, palette.sky],
    tooltip: {
      trigger: "item",
      formatter: (params: unknown) => {
        const payload = (params ?? {}) as { name?: unknown; value?: unknown; percent?: unknown };
        const value = Number(payload.value ?? 0);
        const percent = Number(payload.percent ?? 0);
        const item = rows.find((row) => row.model === String(payload.name ?? ""));
        if (!item) {
          return `${String(payload.name ?? "")}<br/>实际成本 ${formatTrendMetricValue("actualCost", value)}<br/>占比 ${percent.toFixed(1)}%`;
        }
        return [
          String(payload.name ?? ""),
          `请求 ${item.requests.toLocaleString()}`,
          `Token ${Math.round(item.totalTokens).toLocaleString()}`,
          `实际 ${formatTrendMetricValue("actualCost", item.actualCost)}`,
          `标准 ${formatTrendMetricValue("actualCost", item.totalCost)}`,
          `占比 ${percent.toFixed(1)}%`
        ].join("<br/>");
      }
    },
    legend: {
      orient: "vertical",
      right: 0,
      top: "middle",
      textStyle: { color: palette.textSoft }
    },
    series: [
      {
        type: "pie",
        radius: ["44%", "72%"],
        center: ["32%", "50%"],
        minAngle: 3,
        avoidLabelOverlap: true,
        label: { show: false },
        labelLine: { show: false },
        data: rows.map((item) => ({
          name: item.model,
          value: item.actualCost
        }))
      }
    ]
  };
}

export interface ChartPalette {
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
  chartBg: string;
  chartGrid: string;
}

export function readChartPalette(): ChartPalette {
  if (typeof window === "undefined") {
    return {
      accent: "#7ec6ff",
      secondary: "#66ddd3",
      tertiary: "#7fe6af",
      warning: "#f3bb62",
      rose: "#ff7d99",
      indigo: "#9e8cff",
      sky: "#66ddd3",
      textStrong: "#eef4ff",
      textSoft: "#8492a8",
      border: "rgba(171, 189, 212, 0.1)",
      grid: "rgba(130, 150, 176, 0.14)",
      chartBg: "rgba(10, 16, 26, 0.94)",
      chartGrid: "rgba(130, 150, 176, 0.14)"
    };
  }
  const style = getComputedStyle(document.documentElement);
  return {
    accent: style.getPropertyValue("--accent").trim() || "#7ec6ff",
    secondary: style.getPropertyValue("--chart-2").trim() || "#66ddd3",
    tertiary: style.getPropertyValue("--chart-6").trim() || "#7fe6af",
    warning: style.getPropertyValue("--chart-3").trim() || "#f3bb62",
    rose: style.getPropertyValue("--danger").trim() || "#ff7d99",
    indigo: style.getPropertyValue("--chart-5").trim() || "#9e8cff",
    sky: style.getPropertyValue("--chart-4").trim() || "#66ddd3",
    textStrong: style.getPropertyValue("--text-strong").trim() || "#eef4ff",
    textSoft: style.getPropertyValue("--text-subtle").trim() || "#8492a8",
    border: style.getPropertyValue("--border").trim() || "rgba(171, 189, 212, 0.1)",
    grid: style.getPropertyValue("--chart-grid").trim() || "rgba(130, 150, 176, 0.14)",
    chartBg: style.getPropertyValue("--chart-bg").trim() || "rgba(10, 16, 26, 0.94)",
    chartGrid: style.getPropertyValue("--chart-grid").trim() || "rgba(130, 150, 176, 0.14)"
  };
}

export function buildChartOptionSignature(option: ChartOption | null) {
  if (!option) {
    return "__empty__";
  }
  return JSON.stringify(option, chartOptionSignatureReplacer);
}

function scheduleRestoreChartTooltip(
  chart: ChartInstance,
  hoverPoint: { x: number; y: number } | null,
  chartRef: { current: ChartInstance | null }
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
    });
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
