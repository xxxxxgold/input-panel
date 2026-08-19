import { describe, expect, it } from "vitest";
import {
  buildChartOptionSignature,
  buildPlatformBarChartOption,
  buildPlatformDonutChartOption,
  buildTrendAreaChartOption,
  normalizeTrendChartData
} from "../src/charts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireRecordArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }

  const records: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      throw new Error(`${label} must only contain objects.`);
    }
    records.push(item);
  }
  return records;
}

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
    const option = requireRecord(
      buildTrendAreaChartOption({
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
      }),
      "trend chart option"
    );
    const xAxis = requireRecord(option.xAxis, "trend chart xAxis");
    const series = requireRecordArray(option.series, "trend chart series");

    expect(xAxis.type).toBe("category");
    expect(series).toHaveLength(5);
    expect(series.map((item) => item.name)).toEqual([
      "实际成本",
      "请求数",
      "缓存写入",
      "缓存读取",
      "缓存率"
    ]);
    expect(series[4]?.yAxisIndex).toBe(2);
  });

  it("builds platform donut option from cost-based platform data", () => {
    const option = requireRecord(
      buildPlatformDonutChartOption([
        { platform: "openai", totalActualCost: 1.23 },
        { platform: "anthropic", totalActualCost: 0.88 }
      ]),
      "platform donut option"
    );
    const legend = requireRecord(option.legend, "platform donut legend");
    const series = requireRecordArray(option.series, "platform donut series");
    const donutSeries = requireRecord(series[0], "platform donut series item");

    expect(legend.orient).toBe("vertical");
    expect(donutSeries.type).toBe("pie");
    expect(donutSeries.data).toEqual([
      { name: "openai", value: 1.23 },
      { name: "anthropic", value: 0.88 }
    ]);
  });

  it("builds platform bar option sorted by actual cost descending", () => {
    const option = requireRecord(
      buildPlatformBarChartOption([
        { platform: "azure", totalActualCost: 0.44, totalRequests: 40, totalTokens: 4000 },
        { platform: "openai", totalActualCost: 1.22, totalRequests: 100, totalTokens: 13000 }
      ]),
      "platform bar option"
    );
    const xAxis = requireRecord(option.xAxis, "platform bar xAxis");
    const series = requireRecordArray(option.series, "platform bar series");
    const barSeries = requireRecord(series[0], "platform bar series item");

    expect(xAxis.type).toBe("category");
    expect(xAxis.data).toEqual(["azure", "openai"]);
    expect(barSeries.type).toBe("bar");
    expect(barSeries.data).toEqual([0.44, 1.22]);
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
});
