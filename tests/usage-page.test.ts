import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UsagePage } from "../src/pages/UsagePage";

describe("UsagePage", () => {
  it("renders scoped usage highlights, badges, and second-based timings", () => {
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
        usageDraftRange: { startDate: "2026-06-14", endDate: "2026-06-14" },
        setUsageDraftRange: () => ({ startDate: "2026-06-14", endDate: "2026-06-14" }),
        applyUsageRange: async () => {},
        usageStats: {
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
        },
        usageModelSummaries: [],
        usageModelSummariesLoading: false,
        usageRecords: {
          items: [
            {
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
            }
          ],
          page: 1,
          pageSize: 20,
          total: 1,
          pages: 1
        },
        usageScopeRows: [
          {
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
          },
          {
            id: "usage-2",
            apiKeyId: 3641,
            createdAt: "2026-06-14T14:22:16.000Z",
            model: "gpt-5.4",
            reasoningEffort: "high",
            endpoint: "/responses",
            upstreamEndpoint: "/v1/responses",
            actualCost: 0.192,
            totalCost: 0.192,
            inputTokens: 1500,
            outputTokens: 2100,
            cacheCreationTokens: 1200,
            cacheReadTokens: 800,
            totalTokens: 5600,
            firstTokenMs: 6100,
            durationMs: 12_400,
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
          },
          {
            id: "usage-3",
            apiKeyId: 3641,
            createdAt: "2026-06-14T14:23:16.000Z",
            model: "gpt-5.4-mini",
            reasoningEffort: "medium",
            endpoint: "/chat/completions",
            upstreamEndpoint: "/v1/chat/completions",
            actualCost: 0.081,
            totalCost: 0.081,
            inputTokens: 900,
            outputTokens: 200,
            cacheCreationTokens: 400,
            cacheReadTokens: 300,
            totalTokens: 1800,
            firstTokenMs: 2200,
            durationMs: 9800,
            billingMode: "token",
            requestType: "standard",
            stream: false,
            billingType: 1,
            rateMultiplier: 1,
            userAgent: "Browser",
            apiKeyName: "codex",
            platform: "openai",
            subscriptionName: "CodeX Lite",
            groupName: "CodeX Lite"
          }
        ],
        handleUsageSearch: async () => {},
        handleUsagePageChange: async () => {},
        usageTrend: null,
        usageModels: null
      })
    );

    expect(html).toContain("最多请求: gpt-5.4");
    expect(html).toContain("输入 53.6M / 缓存输入 6.8M");
    expect(html).toContain("输出最多: gpt-5.4");
    expect(html).toContain("最长首 Token");
    expect(html).toContain("最高消费");
    expect(html).toContain("最高输入");
    expect(html).toContain("最高输出");
    expect(html).toContain("codex / gpt-5.4");
    expect(html).toContain("$0.2114");
    expect(html).toContain("2.1K");
    expect(html).toContain("对齐 dashboard/trend 接口的成本、请求与缓存表现");
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
  });
});
