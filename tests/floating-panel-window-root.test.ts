import { describe, expect, it } from "vitest";

import { resolveFloatingPanelCurrentAccount } from "../src/app/FloatingPanelWindowRoot";
import type { OverviewPayload } from "../src/types";

describe("resolveFloatingPanelCurrentAccount", () => {
  it("prefers the currently selected account when it is still valid", () => {
    const overview = {
      sites: [
        {
          id: "site-1",
          name: "AI INPUT",
          baseUrl: "https://example.com",
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z"
        }
      ],
      accounts: [
        {
          id: "account-1",
          siteId: "site-1",
          label: "主账号",
          email: "main@example.com",
          balanceWarning: -1,
          lastLoginAt: null,
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
          site: {
            id: "site-1",
            name: "AI INPUT",
            baseUrl: "https://example.com",
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z"
          },
          sessionState: "ready",
          lastError: null,
          cacheView: {
            fetchedAt: "2026-06-28T00:00:00Z",
            online: true,
            siteName: "AI INPUT",
            balance: 42.5,
            stats: {
              totalApiKeys: 1,
              activeApiKeys: 1,
              todayRequests: 5,
              totalRequests: 5,
              todayActualCost: 1,
              totalActualCost: 1,
              todayCost: 1,
              totalCost: 1,
              todayTokens: 1000,
              totalTokens: 1000,
              todayInputTokens: 600,
              todayOutputTokens: 400,
              averageDurationMs: 1000,
              byPlatform: []
            },
            recentUsage: [],
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
          label: "副账号",
          email: "secondary@example.com",
          balanceWarning: -1,
          lastLoginAt: null,
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
          site: {
            id: "site-1",
            name: "AI INPUT",
            baseUrl: "https://example.com",
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z"
          },
          sessionState: "ready",
          lastError: null,
          cacheView: {
            fetchedAt: "2026-06-28T00:00:00Z",
            online: true,
            siteName: "AI INPUT",
            balance: 18.2,
            stats: {
              totalApiKeys: 1,
              activeApiKeys: 1,
              todayRequests: 3,
              totalRequests: 3,
              todayActualCost: 0.5,
              totalActualCost: 0.5,
              todayCost: 0.5,
              totalCost: 0.5,
              todayTokens: 500,
              totalTokens: 500,
              todayInputTokens: 300,
              todayOutputTokens: 200,
              averageDurationMs: 800,
              byPlatform: []
            },
            recentUsage: [],
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
        totalApiKeys: 2,
        activeApiKeys: 2,
        todayRequests: 8,
        totalRequests: 8,
        todayActualCost: 1.5,
        totalActualCost: 1.5,
        todayTokens: 1500,
        totalTokens: 1500
      },
      alerts: [],
      platformSeries: [],
      trend: [],
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-06-28T00:00:00Z"
    } satisfies OverviewPayload;

    const current = resolveFloatingPanelCurrentAccount({
      overview,
      selectedAccountId: "account-2",
      selectedSiteId: "site-1"
    });

    expect(current?.id).toBe("account-2");
    expect(current?.label).toBe("副账号");
  });
});
