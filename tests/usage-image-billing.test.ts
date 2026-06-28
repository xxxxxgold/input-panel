import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UsagePage } from "../src/pages/UsagePage";

describe("UsagePage image billing presentation", () => {
  it("renders chinese sync label and inferred image billing details", () => {
    const html = renderToStaticMarkup(
      createElement(UsagePage, {
        managedKeys: null,
        usageApiKeyFilter: "",
        setUsageApiKeyFilter: () => {},
        usageRangePickerRef: createRef<HTMLDivElement>(),
        usageRangePickerOpen: false,
        toggleUsageRangePicker: () => {},
        usageRangeLabel: "今天",
        usageRangePreset: "today",
        applyUsagePreset: () => {},
        usageDraftRange: { startDate: "2026-06-28", endDate: "2026-06-28" },
        setUsageDraftRange: () => ({ startDate: "2026-06-28", endDate: "2026-06-28" }),
        applyUsageRange: async () => {},
        usageStats: null,
        usageModelSummaries: [],
        usageModelSummariesLoading: false,
        usageRecords: {
          items: [
            {
              id: "usage-image-1",
              apiKeyId: 3335,
              createdAt: "2026-06-28T10:06:46.000Z",
              model: "gpt-image-2",
              reasoningEffort: null,
              endpoint: "/v1/images/generations",
              upstreamEndpoint: "/v1/images/generations",
              actualCost: 0.804,
              totalCost: 0.804,
              inputTokens: 84,
              outputTokens: 26000,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              totalTokens: 26084,
              firstTokenMs: null,
              durationMs: 53820,
              billingMode: "image",
              requestType: "sync",
              stream: false,
              billingType: 1,
              rateMultiplier: 1,
              userAgent: "node",
              apiKeyName: "image",
              platform: "openai",
              subscriptionName: "CodeX Plus 月度",
              groupName: "CodeX Plus 月度"
            }
          ],
          page: 1,
          pageSize: 20,
          total: 1,
          pages: 1
        },
        usagePageSize: 20,
        usagePageSizeOptions: [10, 20, 50, 100],
        usageScopeRows: [],
        handleUsageSearch: async () => {},
        handleUsagePageChange: async () => {},
        handleUsagePageSizeChange: async () => {},
        usageTrend: null,
        usageModels: null
      })
    );

    expect(html).toContain(">同步<");
    expect(html).toContain(">按次(图片)<");
    expect(html).toContain(">4张 (2K)<");
    expect(html).toContain(">图片价格<");
    expect(html).toContain(">图片张数<");
    expect(html).toContain(">4张<");
    expect(html).toContain(">计费尺寸<");
    expect(html).toContain(">2K<");
    expect(html).toContain(">估算分辨率<");
    expect(html).toContain("2048×2048");
    expect(html).toContain(">尺寸来源<");
    expect(html).toContain("输出 Token 估算");
    expect(html).toContain(">单张价格<");
    expect(html).toContain("$0.201000");
    expect(html).toContain(">图片总价<");
    expect(html).toContain("$0.804000");
  });
});
