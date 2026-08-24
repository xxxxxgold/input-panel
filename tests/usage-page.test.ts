import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createEmptyUsageFilterDraft } from "../src/features/usage/usage-filter-draft";
import { UsagePage } from "../src/pages/UsagePage";
import type { UsageRow } from "../src/types";

type UsagePageProps = ComponentProps<typeof UsagePage>;

function createUsageRow(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
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
    ipAddress: "2001:db8:85a3::8a2e:370:7334",
    userAgent: "Codex Desktop",
    apiKeyName: "codex",
    platform: "openai",
    subscriptionName: "CodeX Plus",
    groupName: "CodeX Plus",
    ...overrides
  };
}

function createUsagePageProps(overrides: Partial<UsagePageProps> = {}): UsagePageProps {
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
    usageStats: null,
    usageExtremes: null,
    usageModelSummaries: [],
    usageModelSummariesLoading: false,
    usageRecords: null,
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

function renderUsagePage(overrides: Partial<UsagePageProps> = {}) {
  return renderToStaticMarkup(createElement(UsagePage, createUsagePageProps(overrides)));
}

describe("UsagePage", () => {
  it("renders scoped usage highlights, badges, and second-based timings", () => {
    const row = createUsageRow();
    const html = renderUsagePage({
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
      usageExtremes: {
        longestFirstToken: row,
        highestActualCost: row,
        highestInputTokens: row,
        highestOutputTokens: createUsageRow({ id: "usage-2", outputTokens: 2100 })
      },
      usageModelSummaries: [
        {
          model: "aggregate-model",
          requests: 88,
          totalTokens: 53_600_000,
          inputTokens: 53_100_000,
          outputTokens: 500_000,
          cacheCreationTokens: 0,
          cacheReadTokens: 6_800_000,
          actualCost: 646.6594
        }
      ],
      usageRecords: {
        items: [row],
        pageSize: 20,
        nextCursor: null,
        previousCursor: null,
        hasNext: false,
        hasPrevious: false,
        total: 1
      }
    });

    expect(html).toContain("最多请求: aggregate-model");
    expect(html).not.toContain("最多请求: gpt-5.4");
    expect(html).toContain("输入 53.6M / 缓存输入 6.8M");
    expect(html).toContain("输出最多: aggregate-model");
    expect(html).toContain("最长首 Token");
    expect(html).toContain("最高消费");
    expect(html).toContain("codex / gpt-5.4");
    expect(html).toContain("status-pill neutral usage-pill usage-pill-reasoning reasoning-xhigh");
    expect(html).toContain(">流式<");
    expect(html).toContain("输入 3.7K");
    expect(html).toContain("缓存输入 369.0K");
    expect(html).toContain("总和 373.1K");
    expect(html).toContain("8.01 秒");
    expect(html).toContain("15.84 秒");
    expect(html).toContain("2001:db8:85a3::8a2e:370:7334");
    expect(html).toContain("每页条数");
  });

  it("hides missing service tiers and zero optional costs without fallback values", () => {
    const baseRow = createUsageRow({
      id: "usage-priority",
      createdAt: "2026-07-28T10:00:00+08:00",
      actualCost: 0.5,
      totalCost: 0.6,
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 1200,
      groupName: "group-fallback-must-not-be-tier",
      subscriptionName: "subscription-fallback-must-not-be-tier"
    });
    const rows = [
      createUsageRow({
        ...baseRow,
        serviceTier: "priority",
        imageInputTokens: 42,
        imageInputCost: 0.25,
        longContextBillingApplied: true
      }),
      createUsageRow({
        ...baseRow,
        id: "usage-no-tier",
        serviceTier: null,
        imageInputTokens: null,
        imageInputCost: null,
        cacheCreationCost: null,
        longContextBillingApplied: false
      }),
      createUsageRow({
        ...baseRow,
        id: "usage-blank-tier",
        serviceTier: "   ",
        imageInputCost: 0,
        cacheCreationCost: 0
      }),
      createUsageRow({ ...baseRow, id: "usage-undefined-tier" }),
      createUsageRow({
        ...baseRow,
        id: "usage-standard-tier",
        serviceTier: "standard",
        cacheCreationCost: 0.125,
        longContextBillingApplied: null
      })
    ];
    const html = renderUsagePage({
      usageRecords: {
        items: rows,
        pageSize: 20,
        nextCursor: null,
        previousCursor: null,
        hasNext: false,
        hasPrevious: false,
        total: rows.length
      }
    });

    expect(html).toContain("<span>服务档位</span><strong>Fast</strong>");
    expect(html).toContain("<span>服务档位</span><strong>standard</strong>");
    expect(html.match(/class="detail-item"><span>服务档位<\/span>/g)).toHaveLength(2);
    expect(html).not.toContain("<span>服务档位</span><strong>group-fallback-must-not-be-tier</strong>");
    expect(html).not.toContain("<span>服务档位</span><strong>subscription-fallback-must-not-be-tier</strong>");
    expect(html).toContain("<span>图片输入费用</span><strong>$0.250000</strong>");
    expect(html.match(/<span>图片输入费用<\/span>/g)).toHaveLength(1);
    expect(html).toContain("<span>缓存写入成本</span><strong>$0.125000</strong>");
    expect(html.match(/<span>缓存写入成本<\/span>/g)).toHaveLength(1);
    expect(html).toContain("<span>长上下文计费</span><strong>已应用</strong>");
    expect(html).toContain("<span>长上下文计费</span><strong>未应用</strong>");
    expect(html).toContain("<span>长上下文计费</span><strong>未知</strong>");
  });

  it("renders cursor controls without page numbers, ellipsis, jump, or fake totals", () => {
    const html = renderUsagePage({
      usageRangeLabel: "近 30 天",
      usageRangePreset: "last30Days",
      usageDraftRange: { startDate: "2026-05-16", endDate: "2026-06-14" },
      usagePageSize: 50,
      usageCursorDepth: 4,
      usageRecords: {
        items: [createUsageRow()],
        pageSize: 50,
        nextCursor: "opaque-next",
        previousCursor: "opaque-previous",
        hasNext: true,
        hasPrevious: true,
        total: null
      }
    });

    const tableIndex = html.indexOf('class="usage-table-wrap"');
    const paginationIndex = html.indexOf('class="usage-pagination"');
    expect(paginationIndex).toBeGreaterThan(tableIndex);
    expect(html).toContain("本次加载 1 条");
    expect(html).toContain("游标深度 4");
    expect(html).not.toContain("共 ");
    expect(html).toContain(">上一页<");
    expect(html).toContain(">下一页<");
    expect(html).toContain(">50 条<");
    expect(html).not.toContain("usage-pagination-page");
    expect(html).not.toContain("usage-pagination-ellipsis");
    expect(html).not.toContain("跳转页码");
    expect(html).not.toContain("aria-label=\"用量页码\"");
  });

  it("renders every advanced filter group and facet values outside the current page", () => {
    const draft = createEmptyUsageFilterDraft();
    draft.model = { value: "historical-model", mode: "exact" };
    draft.stream = "false";
    draft.inputTokens = { min: "100", max: "1000" };
    const html = renderUsagePage({
      managedKeys: {
        items: [{ id: "key-1", apiKeyId: 3641, name: "codex", status: "active", groupName: "CodeX Plus" }],
        page: 1,
        pageSize: 20,
        total: 1,
        pages: 1
      },
      usageFilterDraft: draft,
      usageFacetPages: {
        model: {
          field: "model",
          items: [{ value: "historical-model", label: "historical-model", count: 77 }],
          hasMore: true
        },
        apiKey: {
          field: "apiKey",
          items: [{ value: "9988", label: "deleted-history-key", count: 41 }],
          hasMore: false
        }
      },
      usageRecords: {
        items: [createUsageRow({ model: "current-page-model" })],
        pageSize: 20,
        nextCursor: null,
        previousCursor: null,
        hasNext: false,
        hasPrevious: false,
        total: null
      }
    });

    for (const title of ["时间与身份", "路由与归属", "请求与计费", "Token 范围", "成本与性能", "客户端与媒体"]) {
      expect(html).toContain(`>${title}<`);
    }
    for (const label of [
      "Usage ID",
      "Request ID",
      "API Key ID",
      "上游用户 ID",
      "上游账号 ID",
      "模型",
      "上游端点",
      "分组 ID",
      "订阅 ID",
      "订阅类型",
      "服务档位",
      "推理档位",
      "计费类型",
      "WebSocket 模式",
      "缓存 TTL 覆盖",
      "输入 Token",
      "图片输出 Token",
      "实际成本",
      "图片输出成本",
      "首 Token (ms)",
      "User-Agent",
      "图片尺寸来源",
      "图片尺寸明细"
    ]) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).toContain('value="historical-model"');
    expect(html).toContain("77 条");
    expect(html).toContain('value="9988"');
    expect(html).toContain("deleted-history-key (41)");
    expect(html).toContain('aria-label="模型匹配方式"');
    expect(html).toContain('<option value="exact" selected="">精确</option>');
    expect(html).toContain('<option value="prefix">前缀</option>');
    expect(html).toContain('<option value="false" selected="">否</option>');
  });

  it("keeps the empty state outside the table while retaining bounded cursor controls", () => {
    const html = renderUsagePage({
      usageRecords: {
        items: [],
        pageSize: 20,
        nextCursor: null,
        previousCursor: null,
        hasNext: false,
        hasPrevious: false,
        total: 0
      }
    });

    expect(html).toContain("当前没有用量明细");
    expect(html).toContain("本次加载 0 条");
    expect(html).toContain("共 0 条");
    expect(html).not.toContain("usage-table-wrap");
    expect(html).not.toContain('class="usage-table"');
    expect(html).toContain("usage-pagination");
    expect(html).toContain("每页条数");
    expect(html).toContain("disabled=\"\">上一页");
    expect(html).toContain("disabled=\"\">下一页");
  });
});
