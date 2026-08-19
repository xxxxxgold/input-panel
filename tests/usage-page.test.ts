import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createEmptyUsageFilterDraft } from "../src/features/usage/usage-filter-draft";
import { UsagePage } from "../src/pages/UsagePage";
import type { UsageRow, UsageStatsRecord } from "../src/types";

const usageRow: UsageRow = {
  id: "usage-1",
  apiKeyId: 3641,
  createdAt: "2026-06-14T14:21:16.000Z",
  model: "gpt-5.4",
  reasoningEffort: "xhigh",
  endpoint: "/responses",
  upstreamEndpoint: "/v1/responses",
  actualCost: 0.21145,
  totalCost: 0.21145,
  inputTokens: 3700,
  outputTokens: 367,
  cacheCreationTokens: 365_300,
  cacheReadTokens: 3700,
  totalTokens: 373_100,
  firstTokenMs: 8009,
  durationMs: 15_840,
  billingMode: "token",
  requestType: "stream",
  stream: true,
  billingType: 1,
  rateMultiplier: 1,
  userAgent: "Codex Desktop",
  apiKeyName: "codex",
  platform: "openai",
  subscriptionName: "CodeX Plus",
  groupName: "CodeX Plus"
};

const usageStats: UsageStatsRecord = {
  totalRequests: 2216,
  totalInputTokens: 53_600_000,
  totalOutputTokens: 2_500_000,
  totalCacheTokens: 6_800_000,
  totalCacheCreationTokens: 3_100_000,
  totalCacheReadTokens: 3_700_000,
  totalTokens: 62_900_000,
  totalCost: 646.6594,
  totalActualCost: 646.6594,
  averageDurationMs: 36_700,
  rpm: 84.1,
  tpm: 1_540_000
};

function buildUsagePageProps(
  overrides: Partial<ComponentProps<typeof UsagePage>> = {}
): ComponentProps<typeof UsagePage> {
  return {
    managedKeys: null,
    usageFilterDraft: createEmptyUsageFilterDraft(),
    setUsageFilterDraft: () => {},
    usageFacetPages: {},
    usageFacetLoadingFields: [],
    loadUsageFacet: async () => null,
    usageRangePickerRef: { current: null },
    usageRangePickerOpen: false,
    toggleUsageRangePicker: () => {},
    usageRangeLabel: "今天",
    usageRangePreset: "today",
    applyUsagePreset: () => {},
    usageDraftRange: { startDate: "2026-06-14", endDate: "2026-06-14" },
    setUsageDraftRange: () => {},
    applyUsageRange: async () => {},
    usageStats,
    usageExtremes: {
      longestFirstToken: usageRow,
      highestActualCost: usageRow,
      highestInputTokens: usageRow,
      highestOutputTokens: usageRow
    },
    usageModelSummaries: [],
    usageModelSummariesLoading: false,
    usageRecords: {
      items: [usageRow],
      pageSize: 20,
      nextCursor: "next-usage-page",
      previousCursor: null,
      hasNext: true,
      hasPrevious: false,
      total: 1
    },
    usagePageSize: 20,
    usagePageSizeOptions: [10, 20, 50, 100],
    handleUsageSearch: async () => {},
    handleUsageFilterReset: async () => {},
    handleUsagePreviousPage: async () => {},
    handleUsageNextPage: async () => {},
    handleUsagePageSizeChange: async () => {},
    usageCursorDepth: 0,
    usageTrend: null,
    usageModels: null,
    ...overrides
  };
}

function renderUsagePage(overrides: Partial<ComponentProps<typeof UsagePage>> = {}) {
  return renderToStaticMarkup(createElement(UsagePage, buildUsagePageProps(overrides)));
}

describe("UsagePage", () => {
  it("renders current usage highlights, row details, and second-based timings", () => {
    const html = renderUsagePage();

    expect(html).toContain("最多请求: gpt-5.4");
    expect(html).toContain("输入 53.6M / 缓存输入 6.8M");
    expect(html).toContain("输出最多: gpt-5.4");
    expect(html).toContain("最长首 Token");
    expect(html).toContain("最高消费");
    expect(html).toContain("最高输入");
    expect(html).toContain("最高输出");
    expect(html).toContain("codex / gpt-5.4");
    expect(html).toContain("$0.2114");
    expect(html).toContain("373.1K");
    expect(html).toContain("当前没有趋势数据");
    expect(html).toContain(">最高消费<");
    expect(html).toContain(">请求信息<");
    expect(html).toContain("status-pill neutral usage-pill usage-pill-reasoning reasoning-xhigh");
    expect(html).toContain(">流式<");
    expect(html).toContain("输入 3.7K");
    expect(html).toContain("输出 367");
    expect(html).toContain("缓存输入 369.0K");
    expect(html).toContain("总和 373.1K");
    expect(html).toContain("usage-detail-section-title");
    expect(html).toContain(">模型价格<");
    expect(html).toContain(">成本<");
    expect(html).toContain(">Token<");
    expect(html).toContain("缓存写入单价");
    expect(html).toContain("缓存读取单价");
    expect(html).toContain("8.01 秒");
    expect(html).toContain("15.84 秒");
    expect(html).toContain("每页条数");
    expect(html).toContain(">20 条<");
  });

  it("renders cursor pagination with previous and next controls", () => {
    const html = renderUsagePage({
      usageStats: null,
      usageExtremes: null,
      usageRangeLabel: "近 30 天",
      usageRangePreset: "last30Days",
      usageDraftRange: { startDate: "2026-05-16", endDate: "2026-06-14" },
      usageRecords: {
        items: [usageRow],
        pageSize: 20,
        nextCursor: "next-usage-page",
        previousCursor: "previous-usage-page",
        hasNext: true,
        hasPrevious: true,
        total: 1286
      },
      usagePageSize: 50,
      usageCursorDepth: 9
    });

    expect(html).toContain("共 1,286 条");
    expect(html).toContain("游标深度 9");
    expect(html).toContain("usage-pagination-compact");
    expect(html).toContain(">上一页<");
    expect(html).toContain(">下一页<");
    expect(html).toContain(">50 条<");
    expect(html).not.toContain("跳转页码");
  });
});
