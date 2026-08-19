import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AnalyticsLab } from "../src/features/analytics/AnalyticsLab";
import type { UsageAnalyticsPayload } from "../src/types";

type AnalyticsLabProps = ComponentProps<typeof AnalyticsLab>;

const aggregatePoint = {
  key: "gpt-5.4",
  label: "gpt-5.4",
  isOther: false,
  requests: 379,
  inputTokens: 11_900_000,
  outputTokens: 490_100,
  cacheCreationTokens: 707_100_000,
  cacheReadTokens: 6_800_000,
  totalTokens: 111_200_000,
  totalCost: 105.1355,
  actualCost: 105.1355,
  averageFirstTokenMs: 1_200,
  averageDurationMs: 38_100,
  averageRateMultiplier: 1.5
} satisfies UsageAnalyticsPayload["models"][number];

const sampleRow = {
  id: "usage-1",
  model: "gpt-5.4",
  apiKeyName: "codex",
  endpoint: "/responses",
  createdAt: "2026-06-14T02:12:57.000Z",
  billingMode: "standard",
  billingType: 1,
  totalTokens: 688_100,
  inputTokens: 100_000,
  outputTokens: 588_100,
  actualCost: 0.47199,
  totalCost: 0.5,
  durationMs: 38_100,
  firstTokenMs: 1_200
} satisfies UsageAnalyticsPayload["sampleRows"][number];

const usageAnalytics: UsageAnalyticsPayload = {
  version: 1,
  startDate: "2026-06-14",
  endDate: "2026-06-14",
  generatedAt: "2026-06-14T03:12:57.000Z",
  matchedRows: 2,
  topN: 10,
  totals: {
    totalRequests: 379,
    totalInputTokens: 11_900_000,
    totalOutputTokens: 490_100,
    totalCacheCreationTokens: 707_100_000,
    totalCacheReadTokens: 6_800_000,
    totalTokens: 111_200_000,
    totalCost: 105.1355,
    totalActualCost: 105.1355,
    averageDurationMs: 38_100,
    rpm: 0,
    tpm: 0
  },
  trend: [
    {
      date: "2026-06-14",
      requests: 379,
      inputTokens: 11_900_000,
      outputTokens: 490_100,
      cacheWriteTokens: 707_100_000,
      cacheReadTokens: 6_800_000,
      totalTokens: 111_200_000,
      actualCost: 105.1355,
      totalCost: 105.1355
    }
  ],
  models: [aggregatePoint],
  platforms: [{ ...aggregatePoint, key: "openai", label: "OpenAI" }],
  endpoints: [{ ...aggregatePoint, key: "/responses", label: "/responses" }],
  apiKeys: [{ ...aggregatePoint, key: "key-1", label: "codex" }],
  groups: [],
  subscriptions: [],
  reasoningEfforts: [],
  requestTypes: [],
  reasoningRequestCombinations: [],
  userAgents: [],
  hourlyHeatmap: [],
  endpointFlows: [],
  costBreakdown: [],
  latencyPercentiles: {
    firstToken: { p50: 1_000, p90: 1_200, p99: 1_800 },
    duration: { p50: 20_000, p90: 38_100, p99: 50_000 }
  },
  extremes: [sampleRow],
  sampleRows: [sampleRow]
};

const baseProps: AnalyticsLabProps = {
  overview: {
    sites: [],
    accounts: [],
    totals: {
      balance: 0,
      totalSites: 0,
      totalAccounts: 0,
      totalApiKeys: 0,
      activeApiKeys: 0,
      todayRequests: 0,
      totalRequests: 0,
      todayActualCost: 0,
      totalActualCost: 0,
      todayTokens: 0,
      totalTokens: 0
    },
    alerts: [],
    platformSeries: [],
    trend: [],
    recentUsage: [],
    subscriptions: [],
    keys: [],
    generatedAt: "2026-06-14T03:12:57.000Z"
  },
  selectedAccount: null,
  loading: false,
  managedKeys: null,
  usageAnalytics,
  subscriptionSummary: null,
  profileRecord: null,
  platformQuotas: null,
  keyUsageRows: [],
  keyUsageKeyId: "",
  usageApiKeyFilter: "",
  usageStartDate: "2026-06-14",
  usageEndDate: "2026-06-14",
  onUsageApiKeyFilterChange: () => {},
  onUsageStartDateChange: () => {},
  onUsageEndDateChange: () => {},
  onUsageSearch: () => {},
  onKeyUsageSelect: () => {}
};

function renderAnalyticsLab(overrides: Partial<AnalyticsLabProps> = {}) {
  const props: AnalyticsLabProps = { ...baseProps, ...overrides };
  return renderToStaticMarkup(createElement(AnalyticsLab, props));
}

describe("AnalyticsLab", () => {
  it("renders overview charts from the current usage analytics payload", () => {
    const html = renderAnalyticsLab();

    expect(html).toContain("分析视图");
    expect(html).toContain("当前筛选范围共 2 条本地明细。");
    expect(html).toContain("$105.1355");
    expect(html.match(/class="analytics-stat-card"/g)).toHaveLength(8);
    expect(html.match(/class="chart-wrap tall analytics-chart-shell"/g)).toHaveLength(4);
  });

  it("renders the aggregate empty state when usage analytics has not loaded", () => {
    const html = renderAnalyticsLab({ usageAnalytics: null });

    expect(html).toContain("当前还没有筛选范围聚合数据。");
    expect(html).toContain("<span>当前总请求</span><strong>-</strong>");
    expect(html).toContain("当前图表暂无数据");
    expect(html).not.toContain("当前筛选范围共 2 条本地明细。");
    expect(html).not.toContain("chart-wrap tall analytics-chart-shell");
  });
});
