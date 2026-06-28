import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OverviewPage } from "../src/pages/OverviewPage";
import type { OverviewPayload, SubscriptionSummaryPayload } from "../src/types";

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
          cacheView: {
            fetchedAt: "2026-06-15T10:00:00Z",
            online: true,
            siteName: "AI INPUT",
            balance: 42.5,
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
          label: "次账号",
          email: "secondary@example.com",
          balanceWarning: -1,
          lastLoginAt: null,
          createdAt: "2026-06-11T00:00:00Z",
          updatedAt: "2026-06-11T00:00:00Z",
          site: null,
          sessionState: "ready",
          lastError: null,
          cacheView: {
            fetchedAt: "2026-06-15T10:05:00Z",
            online: true,
            siteName: "AI INPUT",
            balance: 18.2,
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
        currentAccountStats: overview.accounts[0].cacheView?.stats ?? null,
        currentAccountSubscriptions: overview.accounts[0].cacheView?.subscriptions ?? [],
        subscriptionSummary: null,
        currentAccountKeys: overview.accounts[0].cacheView?.keys ?? [],
        currentAccountRecentUsage: overview.accounts[0].cacheView?.recentUsage ?? [],
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
        currentAccountStats: null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountKeys: [],
        currentAccountRecentUsage: [],
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
        currentAccountStats: null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountKeys: [],
        currentAccountRecentUsage: [],
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
        currentAccountStats: null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountKeys: [],
        currentAccountRecentUsage: [],
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
        currentAccountStats: null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountKeys: [],
        currentAccountRecentUsage: [],
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

  it("falls back to the selected cacheView when overview performance stats are not separately loaded", () => {
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
        currentAccountStats: {
          totalApiKeys: 0,
          activeApiKeys: 0,
          todayRequests: 120,
          totalRequests: 120,
          todayActualCost: 2.4,
          totalActualCost: 2.4,
          todayCost: 2.4,
          totalCost: 2.4,
          todayTokens: 36000,
          totalTokens: 36000,
          todayInputTokens: 12000,
          todayOutputTokens: 24000,
          averageDurationMs: 1500,
          byPlatform: []
        },
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountKeys: [],
        currentAccountRecentUsage: [],
        usageStats: null
      })
    );

    expect(html).toContain("性能指标");
    expect(html).not.toContain("- RPM");
    expect(html).not.toContain("TPM -");
    expect(html).toContain("1.50 s");
    expect(html).toContain("36.0K");
  });

  it("merges subscription summary windows into the overview subscription cards", () => {
    const overview = {
      sites: [],
      accounts: [],
      totals: {
        balance: 0,
        totalSites: 1,
        totalAccounts: 1,
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
      generatedAt: "2026-06-28T01:53:00+08:00"
    } satisfies OverviewPayload;

    const currentAccountSubscriptions = [
      {
        id: "sub-monthly",
        groupId: 3,
        name: "CodeX Plus 月度",
        groupName: "CodeX Plus 月度",
        status: "active",
        expiresAt: "2027-06-13T13:54:40+08:00",
        platform: "openai",
        daily: null,
        weekly: null,
        monthly: null
      }
    ];

    const subscriptionSummary = {
      activeCount: 1,
      totalUsedUsd: 169.66578825,
      subscriptions: [
        {
          id: 3365,
          groupId: 3,
          groupName: "CodeX Plus 月度",
          status: "active",
          dailyUsedUsd: 169.66578825,
          dailyLimitUsd: 500,
          weeklyUsedUsd: 682.98767475,
          monthlyUsedUsd: 4337.1385451,
          expiresAt: "2027-06-13T13:54:40+08:00"
        }
      ]
    } satisfies SubscriptionSummaryPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccountStats: {
          totalApiKeys: 0,
          activeApiKeys: 0,
          todayRequests: 0,
          totalRequests: 0,
          todayActualCost: 0,
          totalActualCost: 0,
          todayCost: 0,
          totalCost: 0,
          todayTokens: 0,
          totalTokens: 0,
          todayInputTokens: 0,
          todayOutputTokens: 0,
          averageDurationMs: 0,
          byPlatform: []
        },
        currentAccountSubscriptions,
        subscriptionSummary,
        currentAccountKeys: [],
        currentAccountRecentUsage: [],
        usageStats: null
      })
    );

    expect(html).toContain("CodeX Plus 月度");
    expect(html).toContain("每日额度");
    expect(html).toContain("$169.67 / $500.00");
    expect(html).toContain("33.9%");
  });

  it("renders keys and recent usage when overview account data comes through snapshot compatibility", () => {
    const overview = {
      sites: [],
      accounts: [],
      totals: {
        balance: 42.5,
        totalSites: 1,
        totalAccounts: 1,
        totalApiKeys: 9,
        activeApiKeys: 9,
        todayRequests: 3456,
        totalRequests: 13052,
        todayActualCost: 535.2615,
        totalActualCost: 1966.8461,
        todayTokens: 815397136,
        totalTokens: 2565410987
      },
      alerts: [],
      platformSeries: [],
      trend: [],
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-06-28T03:43:55.880722700+00:00"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccountStats: {
          totalApiKeys: 9,
          activeApiKeys: 9,
          todayRequests: 3456,
          totalRequests: 13052,
          todayActualCost: 535.2615,
          totalActualCost: 1966.8461,
          todayCost: 535.2615,
          totalCost: 1966.8461,
          todayTokens: 815397136,
          totalTokens: 2565410987,
          todayInputTokens: 35164183,
          todayOutputTokens: 3599620,
          averageDurationMs: 27789.4,
          byPlatform: []
        },
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountKeys: [
          {
            id: "3641",
            groupId: 3,
            name: "codex",
            status: "active",
            platform: "openai",
            groupName: "CodeX Plus 月度",
            expiresAt: null,
            lastUsedAt: "2026-06-28T11:43:00.813405+08:00",
            quota: 0,
            quotaUsed: 0,
            rateLimit5h: 0,
            rateLimit1d: 0,
            rateLimit7d: 0,
            usage5h: 0,
            usage1d: 0,
            usage7d: 0
          }
        ],
        currentAccountRecentUsage: [
          {
            id: "36196842",
            apiKeyId: 3641,
            apiKeyName: "codex",
            createdAt: "2026-06-28T11:43:28.205102+08:00",
            model: "gpt-5.4",
            reasoningEffort: "xhigh",
            endpoint: "/responses",
            upstreamEndpoint: "/v1/responses",
            actualCost: 0.034639,
            totalCost: 0.034639,
            inputTokens: 644,
            outputTokens: 651,
            inputCost: 0.00161,
            outputCost: 0.009765,
            cacheCreationTokens: 0,
            cacheReadTokens: 93056,
            cacheCreationCost: 0,
            cacheReadCost: 0.023264,
            totalTokens: 94351,
            firstTokenMs: 11292,
            durationMs: 23291,
            billingMode: "token",
            requestType: "stream",
            stream: true,
            billingType: 1,
            rateMultiplier: 1,
            userAgent: "Codex Desktop",
            platform: "openai",
            subscriptionName: "CodeX Plus 月度",
            groupName: "CodeX Plus 月度",
            subscriptionType: "subscription"
          }
        ],
        usageStats: null
      })
    );

    expect(html).toContain("codex");
    expect(html).toContain("CodeX Plus 月度");
    expect(html).not.toContain("还没有 Key 数据");
    expect(html).toContain("gpt-5.4");
    expect(html).toContain("/responses");
    expect(html).not.toContain("还没有账号数据");
  });

  it("renders recent usage as a standalone full-width section", () => {
    const overview = {
      sites: [],
      accounts: [],
      totals: {
        balance: 0,
        totalSites: 1,
        totalAccounts: 1,
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
      generatedAt: "2026-06-28T03:43:55.880722700+00:00"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccountStats: null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountKeys: [],
        currentAccountRecentUsage: [],
        usageStats: null
      })
    );

    expect(html).toContain('<section class="stack-list"><section class="section-card"><header class="section-card-header"><div><h3>最近使用</h3>');
  });
});
