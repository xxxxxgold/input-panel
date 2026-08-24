import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildChartOptionSignature,
  buildOverviewModelDonutChartOption,
  buildPlatformBarChartOption,
  buildPlatformDonutChartOption,
  buildTrendAreaChartOption,
  normalizeTrendChartData,
  withChartDataTypography
} from "../src/charts";

type AxisConfig = {
  type?: string;
  data?: string[];
};

type SeriesConfig = {
  name?: string;
  type?: string;
  yAxisIndex?: number;
  data?: unknown[];
};

type PieDataPoint = {
  name: string;
  value: number;
};

type LegendConfig = {
  orient?: string;
};

type TooltipConfig = {
  formatter?: (payload: unknown) => unknown;
};

type BasicChartOption = {
  xAxis?: AxisConfig;
  legend?: LegendConfig;
  tooltip?: TooltipConfig;
  series?: SeriesConfig[];
};

describe("charts helpers", () => {
  it("defers guarded layout synchronization after mount and visibility recovery", () => {
    const source = readFileSync(resolve(process.cwd(), "src/charts.tsx"), "utf8");

    expect(source).toContain("const scheduleLayoutSync");
    expect(source).toContain("hasChartHostSize(host)");
    expect(source).toContain("window.requestAnimationFrame");
    expect(source).toContain("window.setTimeout");
    expect(source).toContain("IntersectionObserver");
    expect(source).toContain('document.addEventListener("visibilitychange", handleVisibilityChange)');
    expect(source).toContain("scheduleLayoutSync();");
  });

  it("normalizes trend points with bucket fallback and numeric defaults", () => {
    const normalized = normalizeTrendChartData([
      {
        date: "2026-06-09",
        actualCost: 1.25,
        requests: 9,
        inputTokens: 600,
        outputTokens: 800,
        cacheCreationTokens: 100,
        cacheReadTokens: 400,
        totalTokens: 1900
      },
      { bucket: "2026-06-10", actualCost: null, requests: null, totalTokens: null }
    ]);

    expect(normalized).toEqual([
      {
        bucket: "2026-06-09",
        actualCost: 1.25,
        requests: 9,
        inputTokens: 600,
        outputTokens: 800,
        cacheCreationTokens: 100,
        cacheReadTokens: 400,
        cacheHitRate: 40,
        totalTokens: 1900
      },
      {
        bucket: "2026-06-10",
        actualCost: 0,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        cacheHitRate: 0,
        totalTokens: 0
      }
    ]);
  });

  it("builds trend area chart option with cache metrics and hit rate", () => {
    const option = buildTrendAreaChartOption({
      data: [
        {
          bucket: "06-08",
          actualCost: 0.52,
          requests: 18,
          inputTokens: 2400,
          outputTokens: 3400,
          cacheCreationTokens: 800,
          cacheReadTokens: 1200,
          cacheHitRate: 33.33,
          totalTokens: 7800
        },
        {
          bucket: "06-09",
          actualCost: 0.88,
          requests: 31,
          inputTokens: 4200,
          outputTokens: 5200,
          cacheCreationTokens: 1500,
          cacheReadTokens: 2100,
          cacheHitRate: 33.33,
          totalTokens: 13000
        }
      ],
      series: ["actualCost", "requests", "cacheCreationTokens", "cacheReadTokens", "cacheHitRate"]
    }) satisfies BasicChartOption | null;

    expect(option?.xAxis?.type).toBe("category");
    expect(Array.isArray(option?.series)).toBe(true);
    expect(option?.series).toHaveLength(5);
    expect(option?.series?.map((item) => item.name)).toEqual([
      "实际成本",
      "请求数",
      "缓存写入",
      "缓存读取",
      "缓存率"
    ]);
    expect(option?.series?.[4]?.yAxisIndex).toBe(2);
  });

  it("builds platform donut option from cost-based platform data", () => {
    const option = buildPlatformDonutChartOption([
      { platform: "openai", totalActualCost: 1.23 },
      { platform: "anthropic", totalActualCost: 0.88 }
    ]) satisfies BasicChartOption | null;

    const seriesData = option?.series?.[0]?.data as PieDataPoint[] | undefined;

    expect(option?.legend?.orient).toBe("vertical");
    expect(option?.series?.[0]?.type).toBe("pie");
    expect(seriesData).toEqual([
      { name: "openai", value: 1.23 },
      { name: "anthropic", value: 0.88 }
    ]);
  });

  it("builds platform bar option sorted by actual cost descending", () => {
    const option = buildPlatformBarChartOption([
      { platform: "azure", totalActualCost: 0.44, totalRequests: 40, totalTokens: 4000 },
      { platform: "openai", totalActualCost: 1.22, totalRequests: 100, totalTokens: 13000 }
    ]) satisfies BasicChartOption | null;

    expect(option?.xAxis?.type).toBe("category");
    expect(option?.xAxis?.data).toEqual(["azure", "openai"]);
    expect(option?.series?.[0]?.type).toBe("bar");
    expect(option?.series?.[0]?.data).toEqual([0.44, 1.22]);
  });

  it("builds overview model donut tooltip with request token and cost details", () => {
    const option = buildOverviewModelDonutChartOption([
      {
        model: "gpt-5.4",
        actualCost: 86.8297,
        totalCost: 86.8297,
        requests: 847,
        totalTokens: 80800000
      }
    ]) satisfies BasicChartOption | null;

    const tooltip = option?.tooltip?.formatter?.({
      name: "gpt-5.4",
      value: 86.8297,
      percent: 100
    });

    expect(option?.series?.[0]?.type).toBe("pie");
    expect(String(tooltip)).toContain("请求 847");
    expect(String(tooltip)).toContain("Token 80,800,000");
    expect(String(tooltip)).toContain("实际 $86.8297");
    expect(String(tooltip)).toContain("标准 $86.8297");
  });

  it("builds a stable signature for semantically identical chart options", () => {
    const formatter = (value: number) => `${value}%`;
    const left = {
      tooltip: {
        trigger: "axis",
        formatter
      },
      yAxis: {
        axisLabel: {
          formatter
        }
      },
      series: [
        { name: "请求数", type: "bar", data: [1, 2, 3] }
      ]
    };
    const right = {
      series: [
        { data: [1, 2, 3], type: "bar", name: "请求数" }
      ],
      yAxis: {
        axisLabel: {
          formatter
        }
      },
      tooltip: {
        formatter,
        trigger: "axis"
      }
    };

    expect(buildChartOptionSignature(left)).toBe(buildChartOptionSignature(right));
  });

  it("uses JetBrains Mono for chart data text without mutating the source option", () => {
    const source = {
      tooltip: { trigger: "axis", textStyle: { color: "#f8fafc" } },
      legend: [{ textStyle: { color: "#94a3b8" } }],
      xAxis: { axisLabel: { color: "#94a3b8" } },
      yAxis: [{ axisLabel: { color: "#94a3b8" } }],
      visualMap: { textStyle: { color: "#94a3b8" } },
      series: [{ label: { show: true }, emphasis: { label: { color: "#ffffff" } } }]
    };

    const option = withChartDataTypography(source) as {
      tooltip: { textStyle: { fontFamily: string } };
      legend: Array<{ textStyle: { fontFamily: string } }>;
      xAxis: { axisLabel: { fontFamily: string }; nameTextStyle: { fontFamily: string } };
      yAxis: Array<{ axisLabel: { fontFamily: string }; nameTextStyle: { fontFamily: string } }>;
      visualMap: { textStyle: { fontFamily: string } };
      series: Array<{ label: { fontFamily: string }; emphasis: { label: { fontFamily: string } } }>;
    };

    expect(option.tooltip.textStyle.fontFamily).toContain("JetBrains Mono");
    expect(option.legend[0].textStyle.fontFamily).toContain("JetBrains Mono");
    expect(option.xAxis.axisLabel.fontFamily).toContain("JetBrains Mono");
    expect(option.xAxis.nameTextStyle.fontFamily).toContain("JetBrains Mono");
    expect(option.yAxis[0].axisLabel.fontFamily).toContain("JetBrains Mono");
    expect(option.visualMap.textStyle.fontFamily).toContain("JetBrains Mono");
    expect(option.series[0].label.fontFamily).toContain("JetBrains Mono");
    expect(option.series[0].emphasis.label.fontFamily).toContain("JetBrains Mono");
    expect((source.tooltip.textStyle as { fontFamily?: string }).fontFamily).toBeUndefined();
  });

  it("does not emit an unregistered visualMap option for regular charts", () => {
    const option = withChartDataTypography({
      tooltip: { trigger: "axis" },
      series: [{ type: "line", data: [1, 2, 3] }]
    });

    expect(option).not.toHaveProperty("visualMap");
  });
});
