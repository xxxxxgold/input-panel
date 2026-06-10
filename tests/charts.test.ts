import { describe, expect, it } from "vitest";
import {
  buildPlatformBarChartOption,
  buildPlatformDonutChartOption,
  buildTrendAreaChartOption,
  normalizeTrendChartData
} from "../src/charts";

describe("charts helpers", () => {
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
    }) as any;

    expect(option?.xAxis?.type).toBe("category");
    expect(Array.isArray(option.series)).toBe(true);
    expect(option.series).toHaveLength(5);
    expect(option.series?.map((item: { name?: string }) => item.name)).toEqual([
      "实际成本",
      "请求数",
      "缓存写入",
      "缓存读取",
      "缓存率"
    ]);
    expect(option.series?.[4]?.yAxisIndex).toBe(2);
  });

  it("builds platform donut option from cost-based platform data", () => {
    const option = buildPlatformDonutChartOption([
      { platform: "openai", totalActualCost: 1.23 },
      { platform: "anthropic", totalActualCost: 0.88 }
    ]) as any;

    expect(option?.legend?.orient).toBe("vertical");
    expect(option.series?.[0]?.type).toBe("pie");
    expect(option.series?.[0]?.data).toEqual([
      { name: "openai", value: 1.23 },
      { name: "anthropic", value: 0.88 }
    ]);
  });

  it("builds platform bar option sorted by actual cost descending", () => {
    const option = buildPlatformBarChartOption([
      { platform: "azure", totalActualCost: 0.44, totalRequests: 40, totalTokens: 4000 },
      { platform: "openai", totalActualCost: 1.22, totalRequests: 100, totalTokens: 13000 }
    ]) as any;

    expect(option.xAxis?.type).toBe("category");
    expect(option.xAxis?.data).toEqual(["azure", "openai"]);
    expect(option.series?.[0]?.type).toBe("bar");
    expect(option.series?.[0]?.data).toEqual([0.44, 1.22]);
  });
});
