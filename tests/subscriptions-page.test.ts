import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SubscriptionsPage } from "../src/pages/SubscriptionsPage";
import type { AccountSnapshot, SubscriptionSummaryPayload } from "../src/types";

describe("SubscriptionsPage layout", () => {
  it("renders summary as a dedicated top row before the two-column detail area", () => {
    const visibleSnapshot: AccountSnapshot = {
      fetchedAt: "2026-06-15T10:00:00+08:00",
      online: true,
      siteName: "AI INPUT",
      siteUrl: "https://example.com",
      accountLabel: "主账号",
      emailMasked: "m***@example.com",
      balance: 12.3,
      currency: "USD",
      stats: {
        totalApiKeys: 1,
        activeApiKeys: 1,
        todayRequests: 10,
        totalRequests: 100,
        todayActualCost: 1.2,
        totalActualCost: 12.3,
        todayCost: 1.2,
        totalCost: 12.3,
        todayTokens: 1000,
        totalTokens: 10000,
        todayInputTokens: 600,
        todayOutputTokens: 400,
        averageDurationMs: 123,
        byPlatform: []
      },
      usageSummary: {
        windowStart: "2026-06-15T00:00:00+08:00",
        windowEnd: "2026-06-15T23:59:59+08:00",
        todayRequests: 10,
        todayActualCost: 1.2,
        todayCost: 1.2,
        todayTokens: 1000,
        todayInputTokens: 600,
        todayOutputTokens: 400,
        totalRequests: 100,
        totalActualCost: 12.3,
        totalCost: 12.3,
        totalTokens: 10000,
        totalInputTokens: 6000,
        totalOutputTokens: 4000,
        averageDurationMs: 123,
        byPlatform: []
      },
      recentUsage: [],
      requestHistory: [],
      trend: [],
      keys: [],
      subscriptions: [
        {
          id: "sub-monthly",
          groupId: 3,
          name: "CodeX Plus 月度",
          groupName: "CodeX Plus 月度",
          status: "active",
          expiresAt: "2027-06-10T13:54:40+08:00",
          platform: "openai",
          daily: {
            current: 13.47,
            limit: 500,
            windowStart: "2026-06-15T00:00:00+08:00"
          },
          weekly: null,
          monthly: null
        }
      ],
      activeSubscription: null,
      alerts: []
    };

    const subscriptionSummary: SubscriptionSummaryPayload = {
      activeCount: 2,
      totalUsedUsd: 3977.0634,
      subscriptions: [
        {
          id: 3365,
          groupId: 3,
          groupName: "CodeX Plus 月度",
          status: "active",
          dailyUsedUsd: 13.47,
          dailyLimitUsd: 500,
          weeklyUsedUsd: 1677.64,
          monthlyUsedUsd: 1677.64,
          expiresAt: "2027-06-13T13:54:40+08:00"
        }
      ]
    };

    const html = renderToStaticMarkup(
      createElement(SubscriptionsPage, {
        visibleSnapshot,
        subscriptionSummary
      })
    );

    expect(html).toContain("subscriptions-page-layout");
    expect(html).toContain("subscription-summary-lead");
    expect(html).toContain("订阅明细");
    expect(html.indexOf(">订阅摘要</h3>")).toBeLessThan(html.indexOf(">订阅视图</h3>"));
    expect(html.indexOf(">订阅视图</h3>")).toBeLessThan(html.indexOf(">订阅明细</h3>"));
  });
});
