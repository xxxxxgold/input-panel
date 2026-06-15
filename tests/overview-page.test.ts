import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OverviewPage } from "../src/pages/OverviewPage";
import type { OverviewPayload } from "../src/types";

describe("OverviewPage metric hints", () => {
  it("shows the richest account and latest alert in card hints", () => {
    const overview = {
      sites: [],
      accounts: [
        {
          id: "account-1",
          siteId: "site-1",
          label: "主账号",
          email: "main@example.com",
          balanceWarning: -1,
          lastLoginAt: null,
          createdAt: "2026-06-11T00:00:00Z",
          updatedAt: "2026-06-11T00:00:00Z",
          site: null,
          sessionState: "ready",
          lastError: null,
          snapshot: {
            fetchedAt: "2026-06-15T10:00:00Z",
            online: true,
            siteName: "AI INPUT",
            siteUrl: "https://example.com",
            accountLabel: "主账号",
            emailMasked: "m***@example.com",
            balance: 42.5,
            currency: "USD",
            stats: {
              totalApiKeys: 2,
              activeApiKeys: 1,
              todayRequests: 123,
              totalRequests: 103576,
              todayActualCost: 32.2293,
              totalActualCost: 15701.5399,
              todayCost: 32.2293,
              totalCost: 15701.5399,
              todayTokens: 54100000,
              totalTokens: 21600700000,
              todayInputTokens: 1000,
              todayOutputTokens: 2000,
              averageDurationMs: 400,
              byPlatform: []
            },
            usageSummary: {
              windowStart: "2026-06-15T00:00:00Z",
              windowEnd: "2026-06-15T23:59:59Z",
              todayRequests: 123,
              todayActualCost: 32.2293,
              todayCost: 32.2293,
              todayTokens: 54100000,
              todayInputTokens: 1000,
              todayOutputTokens: 2000,
              totalRequests: 103576,
              totalActualCost: 15701.5399,
              totalCost: 15701.5399,
              totalTokens: 21600700000,
              totalInputTokens: 3000,
              totalOutputTokens: 4000,
              averageDurationMs: 400,
              byPlatform: []
            },
            recentUsage: [],
            requestHistory: [],
            trend: [],
            keys: [],
            subscriptions: [],
            activeSubscription: null,
            alerts: []
          }
        },
        {
          id: "account-2",
          siteId: "site-1",
          label: "次账号",
          email: "secondary@example.com",
          balanceWarning: -1,
          lastLoginAt: null,
          createdAt: "2026-06-11T00:00:00Z",
          updatedAt: "2026-06-11T00:00:00Z",
          site: null,
          sessionState: "ready",
          lastError: null,
          snapshot: {
            fetchedAt: "2026-06-15T10:05:00Z",
            online: true,
            siteName: "AI INPUT",
            siteUrl: "https://example.com",
            accountLabel: "次账号",
            emailMasked: "s***@example.com",
            balance: 18.2,
            currency: "USD",
            stats: {
              totalApiKeys: 1,
              activeApiKeys: 1,
              todayRequests: 8,
              totalRequests: 50,
              todayActualCost: 1.2,
              totalActualCost: 10.5,
              todayCost: 1.2,
              totalCost: 10.5,
              todayTokens: 1000,
              totalTokens: 2000,
              todayInputTokens: 100,
              todayOutputTokens: 200,
              averageDurationMs: 320,
              byPlatform: []
            },
            usageSummary: {
              windowStart: "2026-06-15T00:00:00Z",
              windowEnd: "2026-06-15T23:59:59Z",
              todayRequests: 8,
              todayActualCost: 1.2,
              todayCost: 1.2,
              todayTokens: 1000,
              todayInputTokens: 100,
              todayOutputTokens: 200,
              totalRequests: 50,
              totalActualCost: 10.5,
              totalCost: 10.5,
              totalTokens: 2000,
              totalInputTokens: 300,
              totalOutputTokens: 500,
              averageDurationMs: 320,
              byPlatform: []
            },
            recentUsage: [],
            requestHistory: [],
            trend: [],
            keys: [],
            subscriptions: [],
            activeSubscription: null,
            alerts: []
          }
        }
      ],
      totals: {
        balance: 60.7,
        totalSites: 1,
        totalAccounts: 2,
        totalApiKeys: 3,
        activeApiKeys: 2,
        todayRequests: 131,
        totalRequests: 103626,
        todayActualCost: 33.4293,
        totalActualCost: 15712.0399,
        todayTokens: 54101000,
        totalTokens: 21600702000
      },
      alerts: [
        {
          id: "account-1:balance-low",
          severity: "high",
          title: "主账号 余额偏低, 需要尽快补充避免影响后续调用",
          detail: "AI INPUT 当前余额 42.50, 低于预警阈值 50.00。",
          siteId: "site-1",
          accountId: "account-1",
          createdAt: "2026-06-15T10:47:34Z"
        }
      ],
      platformSeries: [],
      trend: [],
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-06-15T10:47:34Z"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        visibleSnapshot: overview.accounts[0].snapshot,
        alertCount: overview.alerts.length
      })
    );

    expect(html).toContain("主账号 余额最高, $42.50");
    expect(html).toContain("最新: 主账号 余额偏低, 需要尽快补充避免影响后续调用");
  });
});
