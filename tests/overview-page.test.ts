import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OverviewPage } from "../src/pages/OverviewPage";
import type { OverviewPayload } from "../src/types";

describe("OverviewPage metric hints", () => {
  it("shows the richest account in card hints and does not render an alert metric card", () => {
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
        usageStats: null
      })
    );

    expect(html).toContain("主账号 $42.50");
    expect(html).not.toContain("异常数");
    expect(html).not.toContain("最新: 主账号 余额已耗尽");
    expect(html).not.toContain("主账号 余额偏低, 需要尽快补充避免影响后续调用");
  });

  it("renders the shared trend section with all-account subtitle", () => {
    const overview = {
      sites: [],
      accounts: [],
      totals: {
        balance: 0,
        totalSites: 1,
        totalAccounts: 0,
        totalApiKeys: 0,
        activeApiKeys: 0,
        todayRequests: 12,
        totalRequests: 34,
        todayActualCost: 1.2,
        totalActualCost: 5.6,
        todayTokens: 7890,
        totalTokens: 12345
      },
      alerts: [],
      platformSeries: [],
      trend: [
        {
          bucket: "2026-06-14",
          actualCost: 1.2,
          totalCost: 1.2,
          requests: 12,
          inputTokens: 3000,
          outputTokens: 800,
          cacheCreationTokens: 1200,
          cacheReadTokens: 500,
          totalTokens: 5500
        }
      ],
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-06-15T10:47:34Z"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        visibleSnapshot: null,
        usageStats: null
      })
    );

    expect(html).toContain("对齐 dashboard/trend 接口, 聚合全部账号的成本、请求与缓存表现");
    expect(html).toContain("echart-card-shell");
  });

  it("renders platform distribution as summary cards instead of a donut chart", () => {
    const overview = {
      sites: [],
      accounts: [],
      totals: {
        balance: 0,
        totalSites: 1,
        totalAccounts: 0,
        totalApiKeys: 0,
        activeApiKeys: 0,
        todayRequests: 12,
        totalRequests: 34,
        todayActualCost: 1.2,
        totalActualCost: 5.6,
        todayTokens: 7890,
        totalTokens: 12345
      },
      alerts: [],
      platformSeries: [
        {
          platform: "openai",
          totalActualCost: 5.6,
          todayActualCost: 1.2,
          totalRequests: 34,
          totalTokens: 12345
        }
      ],
      trend: [],
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-06-15T10:47:34Z"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        visibleSnapshot: null,
        usageStats: null
      })
    );

    expect(html).toContain("platform-distribution-card");
    expect(html).toContain("累计实际成本");
    expect(html).toContain("$5.6000");
    expect(html).toContain("12.3K");
    expect(html).not.toContain("当前没有平台汇总数据");
  });

  it("renders performance metric card from usage stats", () => {
    const overview = {
      sites: [],
      accounts: [],
      totals: {
        balance: 0,
        totalSites: 1,
        totalAccounts: 0,
        totalApiKeys: 0,
        activeApiKeys: 0,
        todayRequests: 12,
        totalRequests: 34,
        todayActualCost: 1.2,
        totalActualCost: 5.6,
        todayTokens: 7890,
        totalTokens: 12345
      },
      alerts: [],
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
        visibleSnapshot: null,
        usageStats: {
          totalRequests: 2241,
          totalInputTokens: 42600000,
          totalOutputTokens: 2600000,
          totalCacheTokens: 0,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          totalTokens: 116700,
          totalCost: 0,
          totalActualCost: 0,
          averageDurationMs: 23220,
          rpm: 5,
          tpm: 116700
        }
      })
    );

    expect(html).toContain("性能指标");
    expect(html).toContain("5 RPM");
    expect(html).toContain("116.7K TPM");
    expect(html).toContain("当前账号性能指标");
  });

  it("keeps zero performance values visible instead of falling back to placeholders", () => {
    const overview = {
      sites: [],
      accounts: [],
      totals: {
        balance: 0,
        totalSites: 1,
        totalAccounts: 0,
        totalApiKeys: 0,
        activeApiKeys: 0,
        todayRequests: 12,
        totalRequests: 34,
        todayActualCost: 1.2,
        totalActualCost: 5.6,
        todayTokens: 7890,
        totalTokens: 12345
      },
      alerts: [],
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
        visibleSnapshot: null,
        usageStats: {
          totalRequests: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheTokens: 0,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          totalTokens: 0,
          totalCost: 0,
          totalActualCost: 0,
          averageDurationMs: 0,
          rpm: 0,
          tpm: 0
        }
      })
    );

    expect(html).toContain("0 RPM");
    expect(html).toContain("0 TPM");
    expect(html).not.toContain("- RPM");
    expect(html).not.toContain("TPM -");
  });

  it("falls back to the selected snapshot when overview performance stats are not separately loaded", () => {
    const overview = {
      sites: [],
      accounts: [],
      totals: {
        balance: 0,
        totalSites: 1,
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
      generatedAt: "2026-06-15T10:47:34Z"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        visibleSnapshot: {
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
            todayRequests: 120,
            totalRequests: 300,
            todayActualCost: 2.4,
            totalActualCost: 6.8,
            todayCost: 2.4,
            totalCost: 6.8,
            todayTokens: 36000,
            totalTokens: 80000,
            todayInputTokens: 12000,
            todayOutputTokens: 24000,
            averageDurationMs: 1500,
            byPlatform: []
          },
          usageSummary: {
            totalRequests: 300,
            totalTokens: 80000,
            totalInputTokens: 30000,
            totalOutputTokens: 50000,
            totalActualCost: 6.8,
            totalCost: 6.8,
            averageDurationMs: 1500
          },
          recentUsage: [],
          requestHistory: [],
          trend: [],
          keys: [],
          subscriptions: [],
          activeSubscription: null,
          alerts: []
        },
        usageStats: null
      })
    );

    expect(html).toContain("性能指标");
    expect(html).not.toContain("- RPM");
    expect(html).not.toContain("TPM -");
    expect(html).toContain("1.50 s");
    expect(html).toContain("36.0K");
  });
});
