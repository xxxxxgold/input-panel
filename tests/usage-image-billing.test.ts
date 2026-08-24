import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createEmptyUsageFilterDraft } from "../src/features/usage/usage-filter-draft";
import { UsagePage } from "../src/pages/UsagePage";

describe("UsagePage image billing presentation", () => {
  it("renders chinese sync label and inferred image billing details", () => {
    const html = renderToStaticMarkup(
      createElement(UsagePage, {
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
        usageDraftRange: { startDate: "2026-06-28", endDate: "2026-06-28" },
        setUsageDraftRange: () => ({ startDate: "2026-06-28", endDate: "2026-06-28" }),
        applyUsageRange: async () => {},
        usageStats: null,
        usageExtremes: null,
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
              imageCount: 4,
              imageSize: "2K",
              imageInputSize: "2048x2048",
              imageOutputSize: null,
              imageOutputTokens: 26000,
              imageOutputCost: 0,
              imageInputCost: 0,
              imageSizeSource: "input",
              imageSizeBreakdown: null,
              mediaType: null,
              rateMultiplier: 1,
              userAgent: "node",
              apiKeyName: "image",
              platform: "openai",
              subscriptionName: "CodeX Plus 月度",
              groupName: "CodeX Plus 月度"
            }
          ],
          pageSize: 20,
          nextCursor: null,
          previousCursor: null,
          hasNext: false,
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
    expect(html).toContain("2048x2048");
    expect(html).toContain(">尺寸来源<");
    expect(html).toContain("请求入参");
    expect(html).toContain(">单张价格<");
    expect(html).toContain("$0.201000");
    expect(html).toContain(">图片总价<");
    expect(html).toContain("$0.804000");
    expect(html).toContain(">图片输出 Token<");
    expect(html).toContain("26.0K");
    expect(html).not.toContain('<div class="detail-item"><span>服务档位</span>');
    expect(html).not.toContain(">图片输入费用<");
  });
});
