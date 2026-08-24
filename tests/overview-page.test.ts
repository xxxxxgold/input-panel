import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  buildOverviewConcurrencyKeyItems,
  OverviewPage
} from "../src/pages/OverviewPage";
import { sortOverviewSubscriptionsByUsage } from "../src/features/overview/overview-subscription-sort";
import type {
  OverviewPayload,
  SubscriptionRecord,
  SubscriptionSummaryPayload,
  UsageRow
} from "../src/types";

describe("OverviewPage metric hints", () => {
  it("builds a stable current-concurrency key view model", () => {
    const items = buildOverviewConcurrencyKeyItems(
      [
        { id: "beta", name: "Beta", status: "active", currentConcurrency: 3, accountLabel: "账号 B" },
        { id: "ignored-zero", name: "Idle", status: "active", currentConcurrency: 0, accountLabel: "账号 B" },
        { id: "alpha-first", name: "Alpha", status: "active", currentConcurrency: 3, accountLabel: "账号 A" },
        { id: "alpha-second", name: "Alpha", status: "active", currentConcurrency: 3, accountLabel: "账号 C" },
        { id: "highest", name: "Highest", status: "active", currentConcurrency: 7, accountLabel: "账号 D" },
        { id: "unknown", name: "Unknown", status: "active", currentConcurrency: null, accountLabel: "账号 E" }
      ],
      true
    );

    expect(items).toEqual([
      { id: "highest", name: "Highest", currentConcurrency: 7, accountLabel: "账号 D" },
      { id: "alpha-first", name: "Alpha", currentConcurrency: 3, accountLabel: "账号 A" },
      { id: "alpha-second", name: "Alpha", currentConcurrency: 3, accountLabel: "账号 C" },
      { id: "beta", name: "Beta", currentConcurrency: 3, accountLabel: "账号 B" }
    ]);
  });

  it("sorts subscriptions by quota usage while preserving equal-usage order", () => {
    const subscriptions = [
      {
        id: "half-first",
        subscriptionKey: "upstream:half-first",
        identityKind: "upstream" as const,
        identityAmbiguous: false,
        name: "半额 A",
        status: "active",
        daily: { current: 50, limit: 100 }
      },
      {
        id: "empty",
        subscriptionKey: "upstream:empty",
        identityKind: "upstream" as const,
        identityAmbiguous: false,
        name: "未使用",
        status: "active",
        daily: { current: 0, limit: 100 }
      },
      {
        id: "full",
        subscriptionKey: "upstream:full",
        identityKind: "upstream" as const,
        identityAmbiguous: false,
        name: "已用满",
        status: "active",
        daily: { current: 500, limit: 500 }
      },
      {
        id: "weekly",
        subscriptionKey: "upstream:weekly",
        identityKind: "upstream" as const,
        identityAmbiguous: false,
        name: "周额度",
        status: "active",
        weekly: { current: 80, limit: 100 }
      },
      {
        id: "half-second",
        subscriptionKey: "upstream:half-second",
        identityKind: "upstream" as const,
        identityAmbiguous: false,
        name: "半额 B",
        status: "active",
        daily: { current: 200, limit: 400 }
      }
    ];

    const sorted = sortOverviewSubscriptionsByUsage(subscriptions);

    expect(sorted.map((item) => item.id)).toEqual([
      "full",
      "weekly",
      "half-first",
      "half-second",
      "empty"
    ]);
    expect(subscriptions.map((item) => item.id)).toEqual([
      "half-first",
      "empty",
      "full",
      "weekly",
      "half-second"
    ]);
  });

  it("renders the full-width concurrent-key band with account labels and an empty state", () => {
    const overview = {
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
      generatedAt: "2026-07-11T09:00:00Z"
    } satisfies OverviewPayload;

    const populatedHtml = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccountStats: null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountRecentUsage: [],
        usageStats: null,
        usageStatsMode: "all-accounts",
        onUsageStatsModeChange: () => {},
        usageStatsRows: [],
        allAccountKeys: [
          { id: "key-1", name: "低并发", status: "active", currentConcurrency: 2, accountLabel: "账号 A" },
          { id: "key-2", name: "高并发", status: "active", currentConcurrency: 5, accountLabel: "账号 B" },
          { id: "key-3", name: "空闲", status: "active", currentConcurrency: 0, accountLabel: "账号 C" }
        ]
      })
    );

    const concurrencyBandStart = populatedHtml.indexOf("overview-concurrency-band");
    const concurrencyBandEnd = populatedHtml.indexOf("overview-usage-insights-section", concurrencyBandStart);
    const concurrencyBandHtml = populatedHtml.slice(concurrencyBandStart, concurrencyBandEnd);

    expect(concurrencyBandHtml).toContain("当前并发密钥");
    expect(concurrencyBandHtml.indexOf("高并发")).toBeLessThan(concurrencyBandHtml.indexOf("低并发"));
    expect(concurrencyBandHtml).toContain("账号 A");
    expect(concurrencyBandHtml).toContain("账号 B");
    expect(concurrencyBandHtml).not.toContain("空闲");

    const emptyHtml = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccountStats: null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountKeys: [{ id: "idle-key", name: "空闲密钥", status: "active", currentConcurrency: 0 }],
        currentAccountRecentUsage: [],
        usageStats: null,
        usageStatsMode: "selected-account",
        onUsageStatsModeChange: () => {},
        usageStatsRows: [],
        allAccountKeys: []
      })
    );

    expect(emptyHtml).toContain("当前没有正在并发的密钥。");
  });

  it("uses the linked account email when its label is empty", () => {
    const overview = {
      sites: [],
      accounts: [
        {
          id: "account-empty-label",
          siteId: "site-1",
          label: "",
          email: "empty@example.com",
          balanceWarning: -1,
          lastLoginAt: null,
          createdAt: "2026-07-11T09:00:00Z",
          updatedAt: "2026-07-11T09:00:00Z",
          sessionState: "ready",
          lastError: null
        }
      ],
      totals: {
        balance: 0,
        totalSites: 1,
        totalAccounts: 1,
        totalApiKeys: 1,
        activeApiKeys: 1,
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
      generatedAt: "2026-07-11T09:00:00Z"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccountStats: null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountRecentUsage: [],
        usageStats: null,
        usageStatsMode: "all-accounts",
        onUsageStatsModeChange: () => {},
        usageStatsRows: [],
        allAccountKeys: [
          {
            id: "key-empty-label",
            accountId: "account-empty-label",
            name: "codex",
            status: "active",
            currentConcurrency: 14
          }
        ]
      })
    );

    const concurrencyBandStart = html.indexOf("overview-concurrency-band");
    const concurrencyBandEnd = html.indexOf("overview-usage-insights-section", concurrencyBandStart);
    const concurrencyBandHtml = html.slice(concurrencyBandStart, concurrencyBandEnd);

    expect(concurrencyBandHtml).toContain("emp***@example.com");
    expect(concurrencyBandHtml).not.toContain("未关联账号");
  });

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
            balance: 0,
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
        currentAccount: overview.accounts[0],
        currentAccountBalance: 42.5,
        currentAccountStats: overview.accounts[0].cacheView?.stats ?? null,
        currentAccountSubscriptions: overview.accounts[0].cacheView?.subscriptions ?? [],
        subscriptionSummary: null,
        currentAccountRecentUsage: overview.accounts[0].cacheView?.recentUsage ?? [],
        usageStats: null,
        usageStatsMode: "selected-account",
        onUsageStatsModeChange: () => {},
        usageStatsRows: []
      })
    );

    expect(html).toContain("主账号 $42.50");
    expect(html).toContain("当前账号余额");
    expect(html).toContain("账户资料余额");
    expect(html).toContain("全部密钥");
    expect(html).not.toContain("异常数");
    expect(html).not.toContain("最新: 主账号 余额已耗尽");
    expect(html).not.toContain("主账号 余额偏低, 需要尽快补充避免影响后续调用");
  });

  it("keeps the total-balance label in all-account mode", () => {
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
        }
      ],
      totals: {
        balance: 42.5,
        totalSites: 1,
        totalAccounts: 1,
        totalApiKeys: 2,
        activeApiKeys: 1,
        todayRequests: 123,
        totalRequests: 103576,
        todayActualCost: 32.2293,
        totalActualCost: 15701.5399,
        todayTokens: 54100000,
        totalTokens: 21600700000
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
        currentAccount: overview.accounts[0],
        currentAccountStats: overview.accounts[0].cacheView?.stats ?? null,
        currentAccountSubscriptions: overview.accounts[0].cacheView?.subscriptions ?? [],
        subscriptionSummary: null,
        currentAccountRecentUsage: overview.accounts[0].cacheView?.recentUsage ?? [],
        usageStats: null,
        allAccountKeys: [
          {
            id: "account-1-key-1",
            accountId: "account-1",
            name: "主账号密钥",
            status: "active"
          },
          {
            id: "account-1-key-2",
            accountId: "account-1",
            name: "主账号停用密钥",
            status: "inactive"
          }
        ],
        allAccountBalances: [
          {
            accountId: "account-1",
            balance: 42.5,
            fetchedAt: "2026-07-31T09:00:00Z"
          }
        ],
        usageStatsMode: "all-accounts",
        onUsageStatsModeChange: () => {},
        usageStatsRows: []
      })
    );

    expect(html).toContain("总余额");
    expect(html).toContain("$42.50");
    expect(html).toContain("API 密钥");
    expect(html).toContain("正常 1 / 总 2");
    expect(html).not.toContain("当前账号余额");
  });

  it("keeps all-account usage cards empty when upstream stats are absent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T10:22:56+08:00"));

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
            fetchedAt: "2026-07-01T02:22:56Z",
            online: true,
            siteName: "AI INPUT",
            balance: 0,
            stats: {
              totalApiKeys: 9,
              activeApiKeys: 9,
              todayRequests: 1180,
              totalRequests: 27547,
              todayActualCost: 120.99102945,
              totalActualCost: 3474.5220039999635,
              todayCost: 120.99102945,
              totalCost: 3474.5220039999635,
              todayTokens: 108136542,
              totalTokens: 4449861438,
              todayInputTokens: 17559180,
              todayOutputTokens: 378322,
              averageDurationMs: 25779.187534032742,
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
          siteId: "site-2",
          label: "2FA账号",
          email: "secondary@example.com",
          balanceWarning: -1,
          lastLoginAt: null,
          createdAt: "2026-06-11T00:00:00Z",
          updatedAt: "2026-06-11T00:00:00Z",
          site: null,
          sessionState: "ready",
          lastError: "error decoding response body",
          cacheView: {
            fetchedAt: "2026-06-27T12:58:39Z",
            online: true,
            siteName: "Mock 2FA Site",
            balance: 0,
            stats: {
              totalApiKeys: 1,
              activeApiKeys: 1,
              todayRequests: 0,
              totalRequests: 1,
              todayActualCost: 0,
              totalActualCost: 0.5,
              todayCost: 0,
              totalCost: 0.5,
              todayTokens: 0,
              totalTokens: 500,
              todayInputTokens: 0,
              todayOutputTokens: 0,
              averageDurationMs: 2222,
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
        balance: 0,
        totalSites: 2,
        totalAccounts: 2,
        totalApiKeys: 10,
        activeApiKeys: 10,
        todayRequests: 1180,
        totalRequests: 27548,
        todayActualCost: 120.99102945,
        totalActualCost: 3475.0220039999635,
        todayTokens: 108136542,
        totalTokens: 4449861938
      },
      alerts: [],
      platformSeries: [
        {
          platform: "openai",
          totalActualCost: 3475.0220039999635,
          todayActualCost: 120.99102945,
          totalRequests: 27548,
          totalTokens: 4449861938
        }
      ],
      trend: [],
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-07-01T02:22:56Z"
    } satisfies OverviewPayload;

    try {
      const html = renderToStaticMarkup(
        createElement(OverviewPage, {
          overview,
          currentAccount: overview.accounts[0],
          currentAccountStats: overview.accounts[0].cacheView?.stats ?? null,
          currentAccountSubscriptions: [],
          subscriptionSummary: null,
          currentAccountRecentUsage: [],
          usageStats: null,
          usageStatsMode: "all-accounts",
          onUsageStatsModeChange: () => {},
          usageStatsRows: []
        })
      );

      expect(html).toContain("当前还没有可展示的数据");
      expect(html).toContain("当前还没有统计数据");
      expect(html).toContain('class="metric-value">-</h3>');
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps selected-account usage details empty when upstream stats are absent", () => {
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
          site: {
            id: "site-1",
            name: "AI INPUT",
            baseUrl: "https://ai.input.im",
            createdAt: "2026-06-11T00:00:00Z",
            updatedAt: "2026-06-11T00:00:00Z"
          },
          sessionState: "ready",
          lastError: null,
          cacheView: {
            fetchedAt: "2026-07-02T23:04:11+08:00",
            online: true,
            siteName: "AI INPUT",
            balance: 0,
            stats: {
              totalApiKeys: 9,
              activeApiKeys: 9,
              todayRequests: 5760,
              totalRequests: 38140,
              todayActualCost: 645.2667,
              totalActualCost: 4823.2107,
              todayCost: 645.2667,
              totalCost: 4823.2107,
              todayTokens: 860000000,
              totalTokens: 6042300000,
              todayInputTokens: 56000000,
              todayOutputTokens: 2900000,
              averageDurationMs: 24600,
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
        balance: 0,
        totalSites: 1,
        totalAccounts: 1,
        totalApiKeys: 9,
        activeApiKeys: 9,
        todayRequests: 5760,
        totalRequests: 38140,
        todayActualCost: 645.2667,
        totalActualCost: 4823.2107,
        todayTokens: 860000000,
        totalTokens: 6042300000
      },
      alerts: [],
      platformSeries: [],
      trend: [],
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-07-02T23:04:11+08:00"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccount: overview.accounts[0],
        currentAccountBalance: 0,
        currentAccountStats: overview.accounts[0].cacheView?.stats ?? null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountRecentUsage: [],
        usageStats: null,
        usageStatsMode: "selected-account",
        onUsageStatsModeChange: () => {},
        usageStatsRows: []
      })
    );

    expect(html).toContain("当前账号还没有可展示的数据");
    expect(html).toContain("当前账号还没有统计数据");
    expect(html).not.toContain("AI INPUT / 主账号 · 累计 5,760 请求");
    expect(html).not.toContain("AI INPUT / 主账号 · 请求 5,760 / Tokens 860.0M");
    expect(html).not.toContain("AI INPUT / 主账号 · 输入 56.0M / 输出 2.9M");
  });

  it("keeps selected-account semantics and hides other scopes when no ready account is selected", () => {
    const staleAccount = {
      id: "stale-account",
      siteId: "site-1",
      label: "待登录账号",
      email: "stale@example.com",
      balanceWarning: -1,
      lastLoginAt: null,
      createdAt: "2026-07-18T00:00:00Z",
      updatedAt: "2026-07-18T00:00:00Z",
      site: null,
      sessionState: "expired" as const,
      lastError: null,
      cacheView: {
        fetchedAt: "2026-07-17T10:00:00Z",
        online: false,
        siteName: "旧站点",
        balance: 88.88,
        stats: {
          totalApiKeys: 7,
          activeApiKeys: 7,
          todayRequests: 987,
          totalRequests: 9870,
          todayActualCost: 76.54,
          totalActualCost: 765.4,
          todayCost: 76.54,
          totalCost: 765.4,
          todayTokens: 123456,
          totalTokens: 1234567,
          todayInputTokens: 100000,
          todayOutputTokens: 23456,
          averageDurationMs: 4321,
          byPlatform: [{
            platform: "stale-platform",
            totalActualCost: 765.4,
            todayActualCost: 76.54,
            totalRequests: 9870,
            totalTokens: 1234567
          }],
          byModel: [{
            model: "stale-model",
            requests: 987,
            totalTokens: 123456,
            actualCost: 76.54,
            totalCost: 76.54
          }]
        },
        recentUsage: [],
        trend: [{
          bucket: "2026-07-17",
          actualCost: 76.54,
          totalCost: 76.54,
          requests: 987,
          inputTokens: 100000,
          outputTokens: 23456,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 123456
        }],
        keys: [],
        subscriptions: [],
        activeSubscription: null,
        alerts: []
      }
    };
    const overview = {
      sites: [],
      accounts: [staleAccount],
      totals: {
        balance: 88.88,
        totalSites: 1,
        totalAccounts: 1,
        totalApiKeys: 7,
        activeApiKeys: 7,
        todayRequests: 987,
        totalRequests: 9870,
        todayActualCost: 76.54,
        totalActualCost: 765.4,
        todayTokens: 123456,
        totalTokens: 1234567
      },
      alerts: [],
      platformSeries: staleAccount.cacheView.stats.byPlatform,
      modelSeries: staleAccount.cacheView.stats.byModel,
      trend: staleAccount.cacheView.trend,
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-07-18T10:00:00Z"
    } satisfies OverviewPayload;
    const staleStats = {
      totalRequests: 987,
      totalInputTokens: 100000,
      totalOutputTokens: 23456,
      totalCacheTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      totalTokens: 123456,
      totalCost: 76.54,
      totalActualCost: 76.54,
      averageDurationMs: 4321,
      rpm: 987,
      tpm: 123456
    };
    const renderSelectedScope = (currentAccount: typeof staleAccount | null) => renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccount,
        currentAccountBalance: 88.88,
        currentAccountStats: staleAccount.cacheView.stats,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountKeys: [{ id: "stale-selected-key", name: "旧账号密钥", status: "active" }],
        allAccountKeys: [{ id: "all-account-key", name: "全部账号密钥", status: "active" }],
        currentAccountRecentUsage: [],
        usageStats: staleStats,
        totalUsageStats: staleStats,
        platformSeries: staleAccount.cacheView.stats.byPlatform,
        trendPoints: staleAccount.cacheView.trend,
        modelSeries: staleAccount.cacheView.stats.byModel,
        usageStatsMode: "selected-account",
        onUsageStatsModeChange: () => {},
        usageStatsRows: [{ accountId: staleAccount.id, label: staleAccount.label, siteName: "旧站点", stats: staleStats }]
      })
    );

    const noSelectionHtml = renderSelectedScope(null);
    expect(noSelectionHtml).toContain("尚未选择可用账号");
    expect(noSelectionHtml).toContain("当前账号余额");
    expect(noSelectionHtml).not.toContain("总余额");
    expect(noSelectionHtml).not.toContain("全部账号");
    expect(noSelectionHtml).not.toContain("全部账号密钥");
    expect(noSelectionHtml).not.toContain("旧账号密钥");
    expect(noSelectionHtml).not.toContain("stale-platform");
    expect(noSelectionHtml).not.toContain("stale-model");
    expect(noSelectionHtml).not.toContain("987 RPM");
    expect(noSelectionHtml).not.toContain("$88.88");

    const notReadyHtml = renderSelectedScope(staleAccount);
    expect(notReadyHtml).toContain("当前账号尚未就绪");
    expect(notReadyHtml).toContain("“待登录账号”尚未登录或会话未就绪");
    expect(notReadyHtml).not.toContain("全部账号密钥");
    expect(notReadyHtml).not.toContain("旧账号密钥");
    expect(notReadyHtml).not.toContain("stale-platform");
    expect(notReadyHtml).not.toContain("stale-model");
    expect(notReadyHtml).not.toContain("987 RPM");
    expect(notReadyHtml).not.toContain("$88.88");
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
        currentAccountRecentUsage: [],
        usageStats: null,
        usageStatsMode: "all-accounts",
        onUsageStatsModeChange: () => {},
        usageStatsRows: []
      })
    );

    expect(html).not.toContain("看看所选时间范围的使用变化和花费变化");
    expect(html).toContain("echart-card-shell");
  });

  it("uses selected-account trend data when selected-account mode is active", () => {
    const currentAccount = {
      id: "account-1",
      siteId: "site-1",
      label: "主账号",
      email: "demo@example.com",
      balanceWarning: -1,
      lastLoginAt: null,
      createdAt: "2026-06-11T00:00:00Z",
      updatedAt: "2026-06-11T00:00:00Z",
      site: null,
      sessionState: "ready" as const,
      lastError: null,
      cacheView: {
        fetchedAt: "2026-06-15T10:47:34Z",
        online: true,
        siteName: "AI INPUT",
        balance: 0,
        stats: {
          totalApiKeys: 0,
          activeApiKeys: 0,
          todayRequests: 12,
          totalRequests: 34,
          todayActualCost: 1.2,
          totalActualCost: 5.6,
          todayCost: 1.2,
          totalCost: 5.6,
          todayTokens: 7890,
          totalTokens: 12345,
          todayInputTokens: 3000,
          todayOutputTokens: 800,
          averageDurationMs: 400,
          byPlatform: [],
          byModel: []
        },
        recentUsage: [],
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
        keys: [],
        subscriptions: [],
        activeSubscription: null,
        alerts: []
      }
    };
    const overview = {
      sites: [],
      accounts: [currentAccount],
      totals: {
        balance: 0,
        totalSites: 1,
        totalAccounts: 1,
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
      modelSeries: [],
      trend: [],
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-06-15T10:47:34Z"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccount,
        currentAccountStats: currentAccount.cacheView?.stats ?? null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountRecentUsage: [],
        usageStats: null,
        usageStatsMode: "selected-account",
        onUsageStatsModeChange: () => {},
        usageStatsRows: []
      })
    );

    expect(html).not.toContain("看看所选时间范围的使用变化和花费变化");
    expect((html.match(/echart-card-shell/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(html).not.toContain("当前账号最近 7 天还没有趋势数据");
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
        currentAccountRecentUsage: [],
        usageStats: null
      })
    );

    expect(html).toContain("platform-distribution-card");
    expect(html).toContain("platform-distribution-name openai");
    expect(html).toContain(">Openai<");
    expect(html).not.toContain("34 请求");
    expect(html).toContain("累计实际成本");
    expect(html).toContain("$5.6000");
    expect(html).toContain("12.3K");
    expect(html).not.toContain("当前没有平台汇总数据");
  });

  it("renders a model ranking chart in overview", () => {
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
      modelSeries: [
        {
          model: "gpt-5.4",
          requests: 847,
          totalTokens: 80800000,
          actualCost: 86.8297,
          totalCost: 86.8297
        },
        {
          model: "gpt-5.5",
          requests: 793,
          totalTokens: 76600000,
          actualCost: 85.5491,
          totalCost: 85.5491
        }
      ],
      trend: [],
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-06-30T10:47:34Z"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccountStats: null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountRecentUsage: [],
        usageStats: null,
        usageStatsMode: "all-accounts",
        onUsageStatsModeChange: () => {},
        usageStatsRows: []
      })
    );

    expect(html).toContain("模型排行");
    expect(html).toContain("overview-usage-insight-rank-shell");
    expect(html).toContain("gpt-5.4");
    expect(html).toContain("80.8M");
    expect(html).toContain("$86.8297");
    expect(html).not.toContain("overview-usage-insight-table");
    expect(html).not.toContain("暂时没有模型数据");
  });

  it("uses selected-account model data when selected-account mode is active", () => {
    const currentAccount = {
      id: "account-1",
      siteId: "site-1",
      label: "主账号",
      email: "demo@example.com",
      balanceWarning: -1,
      lastLoginAt: null,
      createdAt: "2026-06-11T00:00:00Z",
      updatedAt: "2026-06-11T00:00:00Z",
      site: null,
      sessionState: "ready" as const,
      lastError: null,
      cacheView: {
        fetchedAt: "2026-06-30T10:47:34Z",
        online: true,
        siteName: "AI INPUT",
        balance: 0,
        stats: {
          totalApiKeys: 0,
          activeApiKeys: 0,
          todayRequests: 12,
          totalRequests: 34,
          todayActualCost: 1.2,
          totalActualCost: 5.6,
          todayCost: 1.2,
          totalCost: 5.6,
          todayTokens: 7890,
          totalTokens: 12345,
          todayInputTokens: 3000,
          todayOutputTokens: 800,
          averageDurationMs: 400,
          byPlatform: [],
          byModel: [
            {
              model: "gpt-5.4",
              requests: 12,
              totalTokens: 5500,
              actualCost: 1.2,
              totalCost: 1.2
            }
          ]
        },
        recentUsage: [],
        trend: [],
        keys: [],
        subscriptions: [],
        activeSubscription: null,
        alerts: []
      }
    };
    const overview = {
      sites: [],
      accounts: [currentAccount],
      totals: {
        balance: 0,
        totalSites: 1,
        totalAccounts: 1,
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
      modelSeries: [],
      trend: [],
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-06-30T10:47:34Z"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccount,
        currentAccountStats: currentAccount.cacheView?.stats ?? null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountRecentUsage: [],
        usageStats: null,
        usageStatsMode: "selected-account",
        onUsageStatsModeChange: () => {},
        usageStatsRows: []
      })
    );

    expect(html).toContain("gpt-5.4");
    expect(html).toContain("5.5K");
    expect(html).not.toContain("当前账号还没有模型数据");
  });

  it("keeps selected-account model distribution empty when only overview-wide model data exists", () => {
    const currentAccount = {
      id: "account-1",
      siteId: "site-1",
      label: "主账号",
      email: "demo@example.com",
      balanceWarning: -1,
      lastLoginAt: null,
      createdAt: "2026-06-11T00:00:00Z",
      updatedAt: "2026-06-11T00:00:00Z",
      site: null,
      sessionState: "ready" as const,
      lastError: null,
      cacheView: {
        fetchedAt: "2026-06-30T10:47:34Z",
        online: true,
        siteName: "AI INPUT",
        balance: 0,
        stats: {
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
          byPlatform: [],
          byModel: []
        },
        recentUsage: [],
        trend: [],
        keys: [],
        subscriptions: [],
        activeSubscription: null,
        alerts: []
      }
    };
    const overview = {
      sites: [],
      accounts: [currentAccount],
      totals: {
        balance: 0,
        totalSites: 1,
        totalAccounts: 1,
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
      modelSeries: [
        {
          model: "gpt-5.4",
          requests: 847,
          totalTokens: 80800000,
          actualCost: 86.8297,
          totalCost: 86.8297
        }
      ],
      trend: [],
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-06-30T10:47:34Z"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccount,
        currentAccountStats: currentAccount.cacheView?.stats ?? null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountRecentUsage: [],
        usageStats: null,
        usageStatsMode: "selected-account",
        onUsageStatsModeChange: () => {},
        usageStatsRows: []
      })
    );

    expect(html).toContain("当前账号还没有模型数据");
    expect((html.match(/echart-card-shell/g) ?? []).length).toBe(0);
  });

  it("treats explicit null selected-account chart props as a cold scope without fallback", () => {
    const currentAccount = {
      id: "account-1",
      siteId: "site-1",
      label: "主账号",
      email: "demo@example.com",
      balanceWarning: -1,
      lastLoginAt: null,
      createdAt: "2026-06-11T00:00:00Z",
      updatedAt: "2026-06-11T00:00:00Z",
      site: null,
      sessionState: "ready" as const,
      lastError: null,
      cacheView: {
        fetchedAt: "2026-06-30T10:47:34Z",
        online: true,
        siteName: "AI INPUT",
        balance: 0,
        stats: {
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
          byPlatform: [],
          byModel: []
        },
        recentUsage: [],
        trend: [],
        keys: [],
        subscriptions: [],
        activeSubscription: null,
        alerts: []
      }
    };
    const overview = {
      sites: [],
      accounts: [currentAccount],
      totals: {
        balance: 0,
        totalSites: 1,
        totalAccounts: 1,
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
      modelSeries: [
        {
          model: "gpt-5.4",
          requests: 847,
          totalTokens: 80800000,
          actualCost: 86.8297,
          totalCost: 86.8297
        }
      ],
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
      generatedAt: "2026-06-30T10:47:34Z"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccount,
        currentAccountStats: currentAccount.cacheView?.stats ?? null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountRecentUsage: [],
        usageStats: null,
        platformSeries: null,
        trendPoints: null,
        modelSeries: null,
        overviewRealtimeChartsLoading: true,
        usageStatsMode: "selected-account",
        onUsageStatsModeChange: () => {},
        usageStatsRows: []
      })
    );

    expect(html).toContain("正在刷新当前账号趋势");
    expect(html).toContain("正在刷新当前账号模型分布");
    expect(html).toContain("正在刷新当前账号平台分布");
    expect(html).not.toContain("platform-distribution-card");
    expect(html).not.toContain("gpt-5.4");
    expect(html).not.toContain("echart-card-shell");
  });

  it("uses realtime aggregated trend, model, and platform props in all-accounts mode", () => {
    const overview = {
      sites: [],
      accounts: [],
      totals: {
        balance: 0,
        totalSites: 2,
        totalAccounts: 2,
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
      modelSeries: [],
      trend: [],
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-07-03T11:00:00Z"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccountStats: null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountRecentUsage: [],
        usageStats: null,
        platformSeries: [
          {
            platform: "openai",
            totalActualCost: 26551.098,
            todayActualCost: 570.5521,
            totalRequests: 171299,
            totalTokens: 33332802678
          }
        ],
        trendPoints: [
          {
            bucket: "2026-07-03",
            actualCost: 570.5521,
            totalCost: 570.5521,
            requests: 5441,
            inputTokens: 57700000,
            outputTokens: 3200000,
            cacheCreationTokens: 0,
            cacheReadTokens: 745000000,
            totalTokens: 810000000
          }
        ],
        modelSeries: [
          {
            model: "gpt-5.4",
            requests: 5000,
            totalTokens: 800000000,
            actualCost: 550,
            totalCost: 550
          },
          {
            model: "gpt-5.5",
            requests: 441,
            totalTokens: 10000000,
            actualCost: 20,
            totalCost: 20
          }
        ],
        usageStatsMode: "all-accounts",
        onUsageStatsModeChange: () => {},
        usageStatsRows: []
      })
    );

    expect(html).toContain("platform-distribution-card");
    expect(html).toContain("$26551.0980");
    expect(html).toContain("171,299");
    expect((html.match(/echart-card-shell/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(html).toContain("gpt-5.4");
    expect(html).not.toContain("当前没有总览趋势数据");
    expect(html).not.toContain("暂时没有模型数据");
  });

  it("keeps previous all-account realtime sections visible while a silent refresh is pending", () => {
    const overview = {
      sites: [],
      accounts: [],
      totals: {
        balance: 0,
        totalSites: 2,
        totalAccounts: 2,
        totalApiKeys: 2,
        activeApiKeys: 1,
        todayRequests: 0,
        totalRequests: 0,
        todayActualCost: 0,
        totalActualCost: 0,
        todayTokens: 0,
        totalTokens: 0
      },
      alerts: [],
      platformSeries: [],
      modelSeries: [],
      trend: [],
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-07-03T11:00:00Z"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccountStats: null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountRecentUsage: [],
        usageStats: null,
        platformSeries: [
          {
            platform: "openai",
            totalActualCost: 26673.1342,
            todayActualCost: 692.5883,
            totalRequests: 172405,
            totalTokens: 33525100000
          }
        ],
        trendPoints: [
          {
            bucket: "2026-07-03",
            actualCost: 692.5883,
            totalCost: 692.5883,
            requests: 6400,
            inputTokens: 79300,
            outputTokens: 4500,
            cacheCreationTokens: 0,
            cacheReadTokens: 1300000,
            totalTokens: 1016800000
          }
        ],
        modelSeries: [
          {
            model: "gpt-5.4",
            requests: 5000,
            totalTokens: 800000000,
            actualCost: 550,
            totalCost: 550
          }
        ],
        allAccountKeys: [
          {
            id: "all-key-1",
            accountId: "account-1",
            siteId: "site-1",
            siteName: "AI INPUT",
            groupId: 3,
            name: "全部账号密钥 A",
            status: "active",
            platform: "openai",
            groupName: "CodeX Plus 月度",
            expiresAt: null,
            lastUsedAt: null,
            quota: 0,
            quotaUsed: 0,
            rateLimit5h: 0,
            rateLimit1d: 0,
            rateLimit7d: 0,
            usage5h: 0,
            usage1d: 0,
            usage7d: 0,
            rawKey: "sk-all-a-123456"
          }
        ],
        allAccountKeysLoading: true,
        overviewRealtimeChartsLoading: true,
        usageStatsMode: "all-accounts",
        onUsageStatsModeChange: () => {},
        usageStatsRows: []
      })
    );

    expect(html).toContain("$26673.1342");
    expect(html).toContain("全部账号密钥 A");
    expect((html.match(/echart-card-shell/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(html).toContain("gpt-5.4");
    expect(html).not.toContain("正在刷新全部账号最近 7 天趋势");
    expect(html).not.toContain("正在刷新全部账号模型分布");
    expect(html).not.toContain("正在刷新全部账号密钥");
  });

  it("renders performance metric card from the latest one-minute usage window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T17:08:00+08:00"));
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

    try {
      const html = renderToStaticMarkup(
        createElement(OverviewPage, {
          overview,
          currentAccount: {
            id: "account-1",
            siteId: "site-1",
            label: "主账号",
            email: "demo@example.com",
            balanceWarning: -1,
            lastLoginAt: null,
            createdAt: "2026-06-11T00:00:00Z",
            updatedAt: "2026-06-11T00:00:00Z",
            site: null,
            sessionState: "ready",
            lastError: null,
            cacheView: {
              fetchedAt: "2026-06-30T17:08:18+08:00",
              online: true,
              siteName: "AI INPUT",
              balance: 0,
              stats: {
                totalApiKeys: 0,
                activeApiKeys: 0,
                todayRequests: 2241,
                totalRequests: 2241,
                todayActualCost: 0,
                totalActualCost: 0,
                todayCost: 0,
                totalCost: 0,
                todayTokens: 116700,
                totalTokens: 116700,
                todayInputTokens: 42600000,
                todayOutputTokens: 2600000,
                averageDurationMs: 23220,
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
          currentAccountStats: null,
          currentAccountSubscriptions: [],
          subscriptionSummary: null,
          currentAccountKeys: [],
          currentAccountRecentUsage: [
            {
              id: "usage-1",
              apiKeyId: 1,
              createdAt: "2026-06-30T17:08:00+08:00",
              model: "gpt-5.4",
              actualCost: 0,
              totalCost: 0,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 20000,
              apiKeyName: "codex"
            },
            {
              id: "usage-2",
              apiKeyId: 2,
              createdAt: "2026-06-30T17:07:45+08:00",
              model: "gpt-5.4",
              actualCost: 0,
              totalCost: 0,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 21000,
              apiKeyName: "cxl"
            },
            {
              id: "usage-3",
              apiKeyId: 3,
              createdAt: "2026-06-30T17:07:30+08:00",
              model: "gpt-5.4",
              actualCost: 0,
              totalCost: 0,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 22000,
              apiKeyName: "codex"
            },
            {
              id: "usage-4",
              apiKeyId: 4,
              createdAt: "2026-06-30T17:07:15+08:00",
              model: "gpt-5.4",
              actualCost: 0,
              totalCost: 0,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 23000,
              apiKeyName: "cxl"
            },
            {
              id: "usage-5",
              apiKeyId: 5,
              createdAt: "2026-06-30T17:07:00+08:00",
              model: "gpt-5.4",
              actualCost: 0,
              totalCost: 0,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 30700,
              apiKeyName: "codex"
            }
          ] as UsageRow[],
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
          },
          usageStatsMode: "selected-account",
          onUsageStatsModeChange: () => {},
          usageStatsRows: [
            {
              accountId: "account-1",
              label: "主账号",
              siteName: "AI INPUT",
              stats: {
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
            }
          ]
        })
      );

      expect(html).toContain("性能指标");
      expect(html).toContain("5 RPM");
      expect(html).toContain("116.7K TPM");
      expect(html).toContain("当前账号性能指标");
      expect(html).toContain("平均响应");
      expect(html).toContain("23.22 s");
      expect(html).toContain("基于 2,241 次请求");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps selected-account performance empty when upstream stats are absent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T17:08:18+08:00"));
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

    try {
      const html = renderToStaticMarkup(
        createElement(OverviewPage, {
          overview,
          currentAccount: {
            id: "account-1",
            siteId: "site-1",
            label: "主账号",
            email: "demo@example.com",
            balanceWarning: -1,
            lastLoginAt: null,
            createdAt: "2026-06-11T00:00:00Z",
            updatedAt: "2026-06-11T00:00:00Z",
            site: null,
            sessionState: "ready",
            lastError: null,
            cacheView: {
              fetchedAt: "2026-06-30T17:08:18+08:00",
              online: true,
              siteName: "AI INPUT",
              balance: 0,
              stats: {
                totalApiKeys: 0,
                activeApiKeys: 0,
                todayRequests: 12,
                totalRequests: 34,
                todayActualCost: 1.2,
                totalActualCost: 5.6,
                todayCost: 1.2,
                totalCost: 5.6,
                todayTokens: 7890,
                totalTokens: 12345,
                todayInputTokens: 0,
                todayOutputTokens: 0,
                averageDurationMs: 0,
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
          currentAccountStats: null,
          currentAccountSubscriptions: [],
          subscriptionSummary: null,
          currentAccountKeys: [],
            currentAccountRecentUsage: [
            {
              id: "usage-1",
              apiKeyId: 1,
              createdAt: "2026-06-30T17:08:18+08:00",
              model: "gpt-5.4",
              actualCost: 0,
              totalCost: 0,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 71113,
              apiKeyName: "codex"
            },
            {
              id: "usage-2",
              apiKeyId: 2,
              createdAt: "2026-06-30T17:08:11+08:00",
              model: "gpt-5.4",
              actualCost: 0,
              totalCost: 0,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 210770,
              apiKeyName: "cxl"
            },
            {
              id: "usage-3",
              apiKeyId: 3,
              createdAt: "2026-06-30T17:08:05+08:00",
              model: "gpt-5.4",
              actualCost: 0,
              totalCost: 0,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 163789,
              apiKeyName: "codex"
            }
          ] as UsageRow[],
          usageStats: null,
          usageStatsMode: "selected-account",
          onUsageStatsModeChange: () => {},
          usageStatsRows: []
        })
      );

      expect(html).toContain("性能指标");
      expect(html).toContain("- RPM");
      expect(html).toContain("当前账号还没有速度数据");
      expect(html).not.toContain("14 RPM");
      expect(html).not.toContain("2.1M TPM");
      expect(html).not.toContain("实时 RPM");
      expect(html).not.toContain("实时 TPM");
    } finally {
      vi.useRealTimers();
    }
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
        },
        usageStatsMode: "selected-account",
        onUsageStatsModeChange: () => {},
        usageStatsRows: []
      })
    );

    expect(html).toContain("0 RPM");
    expect(html).toContain("0 TPM");
    expect(html).not.toContain("- RPM");
    expect(html).not.toContain("TPM -");
  });

  it("keeps selected-account average and performance cards empty without upstream stats", () => {
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
        currentAccountRecentUsage: [],
        usageStats: null,
        usageStatsMode: "selected-account",
        onUsageStatsModeChange: () => {},
        usageStatsRows: []
      })
    );

    expect(html).toContain("性能指标");
    expect(html).toContain("- RPM");
    expect(html).toContain("当前账号还没有速度数据");
    expect(html).toContain("平均响应");
    expect(html).toContain("当前账号没有响应样本");
    expect(html).not.toContain("36.0K");
  });

  it("renders the expanded eight-card overview metric layout with token and key summaries", () => {
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
              totalApiKeys: 9,
              activeApiKeys: 9,
              todayRequests: 3969,
              totalRequests: 153515,
              todayActualCost: 417.1515,
              totalActualCost: 24062.0021,
              todayCost: 417.1515,
              totalCost: 24062.0021,
              todayTokens: 442900000,
              totalTokens: 30519000000,
              todayInputTokens: 48300000,
              todayOutputTokens: 2900000,
              averageDurationMs: 24040,
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
        balance: 42.5,
        totalSites: 1,
        totalAccounts: 1,
        totalApiKeys: 9,
        activeApiKeys: 9,
        todayRequests: 3969,
        totalRequests: 153515,
        todayActualCost: 417.1515,
        totalActualCost: 24062.0021,
        todayTokens: 442900000,
        totalTokens: 30519000000
      },
      alerts: [],
      platformSeries: [],
      trend: [],
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-06-30T10:47:34Z"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccountStats: overview.accounts[0].cacheView?.stats ?? null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountKeys: Array.from({ length: 9 }, (_, index) => ({
          id: `expanded-managed-key-${index + 1}`,
          name: `真实密钥 ${index + 1}`,
          status: "active"
        })),
        currentAccountRecentUsage: [],
        usageStats: null,
        usageStatsMode: "selected-account",
        onUsageStatsModeChange: () => {},
        usageStatsRows: []
      })
    );

    expect(html).toContain("overview-metric-grid");
    expect(html).toContain("API 密钥");
    expect(html).toContain("正常 9 / 总 9");
    expect(html).toContain("今日消费");
    expect(html).toContain("累计 Tokens");
    expect(html).toContain("当前账号还没有可展示的数据");
    expect(html).toContain("平均响应");
    expect(html).toContain("当前账号没有响应样本");
    expect(html).not.toContain("24.04 s");
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
        subscriptionKey: "group:3",
        identityKind: "group" as const,
        identityAmbiguous: false,
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
        currentAccountRecentUsage: [],
        usageStats: null,
        usageStatsMode: "selected-account",
        onUsageStatsModeChange: () => {},
        usageStatsRows: []
      })
    );

    expect(html).toContain("CodeX Plus 月度");
    expect(html).toContain("每日额度");
    expect(html).toContain("$169.67 / $500.00");
    expect(html).toContain("33.9%");
  });

  it("fills missing overview subscription platforms from current account keys", () => {
    const overview = {
      sites: [],
      accounts: [],
      totals: {
        balance: 0,
        totalSites: 1,
        totalAccounts: 1,
        totalApiKeys: 2,
        activeApiKeys: 2,
        todayRequests: 10,
        totalRequests: 10,
        todayActualCost: 1.23,
        totalActualCost: 1.23,
        todayTokens: 12345,
        totalTokens: 12345
      },
      alerts: [],
      platformSeries: [],
      modelSeries: [],
      trend: [],
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-07-03T10:00:00+08:00"
    } satisfies OverviewPayload;

    const currentAccountSubscriptions = [
      {
        id: "sub-monthly",
        subscriptionKey: "group:3",
        identityKind: "group" as const,
        identityAmbiguous: false,
        groupId: 3,
        name: "CodeX Plus 月度",
        groupName: "CodeX Plus 月度",
        status: "active",
        expiresAt: "2027-06-13T13:54:40+08:00",
        platform: null,
        daily: {
          current: 394.96,
          limit: 500,
          windowStart: null
        },
        weekly: null,
        monthly: null
      },
      {
        id: "sub-yearly",
        subscriptionKey: "group:18",
        identityKind: "group",
        identityAmbiguous: false,
        groupId: 18,
        name: "CodeX Plus 年度",
        groupName: "CodeX Plus 年度",
        status: "active",
        expiresAt: "2027-05-21T22:42:23+08:00",
        platform: null,
        daily: {
          current: 131.37,
          limit: 500,
          windowStart: null
        },
        weekly: null,
        monthly: null
      }
    ] satisfies SubscriptionRecord[];

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccountStats: {
          totalApiKeys: 2,
          activeApiKeys: 2,
          todayRequests: 10,
          totalRequests: 10,
          todayActualCost: 1.23,
          totalActualCost: 1.23,
          todayCost: 1.23,
          totalCost: 1.23,
          todayTokens: 12345,
          totalTokens: 12345,
          todayInputTokens: 6789,
          todayOutputTokens: 5556,
          averageDurationMs: 0,
          byPlatform: []
        },
        currentAccountSubscriptions,
        subscriptionSummary: null,
        currentAccountKeys: [
          {
            id: "key-monthly",
            groupId: 3,
            name: "codex",
            status: "active",
            platform: "openai",
            groupName: "CodeX Plus 月度",
            expiresAt: null,
            lastUsedAt: null,
            quota: 0,
            quotaUsed: 0,
            rateLimit5h: 0,
            rateLimit1d: 0,
            rateLimit7d: 0,
            usage5h: 0,
            usage1d: 0,
            usage7d: 0
          },
          {
            id: "key-yearly",
            groupId: 18,
            name: "image",
            status: "active",
            platform: "openai",
            groupName: "CodeX Plus 年度",
            expiresAt: null,
            lastUsedAt: null,
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
        currentAccountRecentUsage: [],
        usageStats: null,
        usageStatsMode: "selected-account",
        onUsageStatsModeChange: () => {},
        usageStatsRows: []
      })
    );

    expect(html).toContain("CodeX Plus 月度");
    expect(html).toContain("CodeX Plus 年度");
    expect(html).toContain(">Openai</span>");
    expect(html).not.toContain(">未知平台</span>");
  });

  it("does not render recent usage on the overview page even when cache data exists", () => {
    const recentUsage = [
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
    ];
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
      recentUsage: recentUsage.map((row) => ({
        id: row.id,
        apiKeyId: row.apiKeyId,
        createdAt: row.createdAt,
        model: row.model,
        actualCost: row.actualCost,
        totalCost: row.totalCost,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        totalTokens: row.totalTokens,
        apiKeyName: row.apiKeyName,
        accountId: "account-1",
        siteId: "site-1",
        siteName: "AI INPUT"
      })),
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
        currentAccountRecentUsage: recentUsage,
        usageStats: null,
        usageStatsMode: "selected-account",
        onUsageStatsModeChange: () => {},
        usageStatsRows: []
      })
    );

    expect(html).toContain("codex");
    expect(html).toContain("CodeX Plus 月度");
    expect(html).not.toContain("还没有 Key 数据");
    expect(html).not.toContain("<h3>最近使用</h3>");
    expect(html).not.toContain("gpt-5.4");
    expect(html).not.toContain("overview-layout-card--recent");
  });

  it("uses all-account keys for the overview key list when all-account mode is active", () => {
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
          createdAt: "2026-07-03T10:00:00+08:00",
          updatedAt: "2026-07-03T10:00:00+08:00",
          site: null,
          sessionState: "ready",
          lastError: null,
          cacheView: null
        },
        {
          id: "account-2",
          siteId: "site-1",
          label: "fxlshang",
          email: "fxlshang@example.com",
          balanceWarning: -1,
          lastLoginAt: null,
          createdAt: "2026-07-03T10:00:00+08:00",
          updatedAt: "2026-07-03T10:00:00+08:00",
          site: null,
          sessionState: "ready",
          lastError: null,
          cacheView: null
        }
      ],
      totals: {
        balance: 0,
        totalSites: 2,
        totalAccounts: 2,
        totalApiKeys: 3,
        activeApiKeys: 2,
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
      keys: [
        {
          id: "cache-key",
          accountId: "account-1",
          siteId: "site-1",
          siteName: "AI INPUT",
          groupId: 3,
          name: "缓存密钥",
          status: "active",
          platform: "openai",
          groupName: "Cache Group",
          expiresAt: null,
          lastUsedAt: null,
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
      generatedAt: "2026-07-03T10:00:00+08:00"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccountStats: null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountKeys: [
          {
            id: "current-key",
            groupId: 1,
            name: "当前账号密钥",
            status: "active",
            platform: "openai",
            groupName: "Current Group",
            expiresAt: null,
            lastUsedAt: null,
            quota: 0,
            quotaUsed: 0,
            rateLimit5h: 0,
            rateLimit1d: 0,
            rateLimit7d: 0,
            usage5h: 0,
            usage1d: 0,
            usage7d: 0,
            rawKey: "sk-current-123456"
          }
        ],
        allAccountKeys: [
          {
            id: "all-key-1",
            accountId: "account-1",
            siteId: "site-1",
            siteName: "AI INPUT",
            groupId: 3,
            name: "全部账号密钥 A",
            status: "active",
            platform: "openai",
            groupName: "CodeX Plus 月度",
            expiresAt: null,
            lastUsedAt: null,
            quota: 0,
            quotaUsed: 0,
            rateLimit5h: 0,
            rateLimit1d: 0,
            rateLimit7d: 0,
            usage5h: 0,
            usage1d: 0,
            usage7d: 0,
            rawKey: "sk-all-a-123456"
          },
          {
            id: "all-key-2",
            accountId: "account-2",
            siteId: "site-1",
            siteName: "AI INPUT",
            groupId: 9,
            name: "全部账号密钥 B",
            status: "disabled",
            platform: "anthropic",
            groupName: "CodeX Plus 年度",
            expiresAt: null,
            lastUsedAt: null,
            quota: 0,
            quotaUsed: 0,
            rateLimit5h: 0,
            rateLimit1d: 0,
            rateLimit7d: 0,
            usage5h: 0,
            usage1d: 0,
            usage7d: 0,
            rawKey: "sk-all-b-123456"
          }
        ],
        currentAccountRecentUsage: [],
        usageStats: null,
        usageStatsMode: "all-accounts",
        onUsageStatsModeChange: () => {},
        usageStatsRows: []
      })
    );

    expect(html).toContain("全部账号密钥 A");
    expect(html).toContain("全部账号密钥 B");
    expect(html).toContain("主账号");
    expect(html).toContain("fxlshang");
    expect(html).not.toContain("当前账号密钥");
    expect(html).not.toContain("缓存密钥");
  });

  it("derives all-account API key KPI totals from the complete managed-key read instead of usage-cache zeros", () => {
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
          createdAt: "2026-07-16T00:00:00Z",
          updatedAt: "2026-07-16T00:00:00Z",
          site: null,
          sessionState: "ready",
          lastError: null,
          cacheView: null
        },
        {
          id: "account-2",
          siteId: "site-1",
          label: "次账号",
          email: "secondary@example.com",
          balanceWarning: -1,
          lastLoginAt: null,
          createdAt: "2026-07-16T00:00:00Z",
          updatedAt: "2026-07-16T00:00:00Z",
          site: null,
          sessionState: "ready",
          lastError: null,
          cacheView: null
        }
      ],
      totals: {
        balance: 0,
        totalSites: 1,
        totalAccounts: 2,
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
      generatedAt: "2026-07-16T10:00:00Z"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccountStats: null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountRecentUsage: [],
        usageStats: null,
        usageStatsMode: "all-accounts",
        onUsageStatsModeChange: () => {},
        usageStatsRows: [],
        allAccountKeys: [
          { id: "key-1", accountId: "account-1", name: "主账号密钥", status: "active" },
          { id: "key-2", accountId: "account-1", name: "主账号停用密钥", status: "inactive" },
          { id: "key-3", accountId: "account-2", name: "次账号密钥", status: "active" }
        ]
      })
    );

    expect(html).toContain("正常 2 / 总 3");
    expect(html).toContain(">3</h3>");
    expect(html).toContain("主账号");
    expect(html).toContain("1 启用 / 2 密钥");
    expect(html).toContain("次账号");
    expect(html).toContain("1 启用 / 1 密钥");
    expect(html).not.toContain("全部账号密钥暂不可用");
  });

  it("shows all-account API key KPI as unknown when the complete managed-key read is unavailable", () => {
    const overview = {
      sites: [],
      accounts: [],
      totals: {
        balance: 0,
        totalSites: 1,
        totalAccounts: 2,
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
      keys: [
        { id: "cache-key", name: "不应回退的缓存密钥", status: "active" }
      ],
      generatedAt: "2026-07-16T10:00:00Z"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccountStats: null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountKeys: [{ id: "selected-key", name: "不应回退的当前密钥", status: "active" }],
        currentAccountRecentUsage: [],
        usageStats: null,
        usageStatsMode: "all-accounts",
        onUsageStatsModeChange: () => {},
        usageStatsRows: [],
        allAccountKeys: null,
        allAccountKeysLoading: false
      })
    );

    expect(html).toContain("全部账号密钥暂不可用");
    expect(html).toContain("<h3 class=\"metric-value\">-</h3>");
    expect(html).not.toContain("不应回退的缓存密钥");
    expect(html).not.toContain("不应回退的当前密钥");
    expect(html).not.toContain("正常 9 / 总 9");
  });

  it("shows selected-account API key KPI as unknown when the managed-key read is unavailable", () => {
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
          createdAt: "2026-07-16T00:00:00Z",
          updatedAt: "2026-07-16T00:00:00Z",
          site: null,
          sessionState: "ready",
          lastError: null,
          cacheView: {
            fetchedAt: "2026-07-16T10:00:00Z",
            online: true,
            siteName: "AI INPUT",
            balance: 0,
            stats: {
              totalApiKeys: 7,
              activeApiKeys: 7,
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
            recentUsage: [],
            trend: [],
            keys: [{ id: "cache-key", name: "不应回退的缓存密钥", status: "active" }],
            subscriptions: [],
            activeSubscription: null,
            alerts: []
          }
        }
      ],
      totals: {
        balance: 0,
        totalSites: 1,
        totalAccounts: 1,
        totalApiKeys: 7,
        activeApiKeys: 7,
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
      keys: [{ id: "overview-key", name: "不应回退的总览密钥", status: "active" }],
      generatedAt: "2026-07-16T10:00:00Z"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccount: overview.accounts[0],
        currentAccountStats: overview.accounts[0].cacheView?.stats ?? null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountKeys: null,
        currentAccountRecentUsage: [],
        usageStats: null,
        usageStatsMode: "selected-account",
        onUsageStatsModeChange: () => {},
        usageStatsRows: []
      })
    );

    expect(html).toContain("当前账号密钥暂不可用");
    expect(html).toContain("<h3 class=\"metric-value\">-</h3>");
    expect(html).not.toContain("不应回退的缓存密钥");
    expect(html).not.toContain("不应回退的总览密钥");
    expect(html).not.toContain("正常 7 / 总 7");
  });

  it("keeps selected-account API key zero only after a complete empty managed-key read", () => {
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
          createdAt: "2026-07-16T00:00:00Z",
          updatedAt: "2026-07-16T00:00:00Z",
          site: null,
          sessionState: "ready",
          lastError: null,
          cacheView: null
        }
      ],
      totals: {
        balance: 0,
        totalSites: 1,
        totalAccounts: 1,
        totalApiKeys: 9,
        activeApiKeys: 9,
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
      keys: [{ id: "overview-key", name: "不应回退的总览密钥", status: "active" }],
      generatedAt: "2026-07-16T10:00:00Z"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccount: overview.accounts[0],
        currentAccountStats: null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountKeys: [],
        currentAccountRecentUsage: [],
        usageStats: null,
        usageStatsMode: "selected-account",
        onUsageStatsModeChange: () => {},
        usageStatsRows: []
      })
    );

    expect(html).toContain("正常 0 / 总 0");
    expect(html).toContain("当前没有密钥");
    expect(html).not.toContain("当前账号密钥暂不可用");
    expect(html).not.toContain("不应回退的总览密钥");
  });

  it("renders aggregated direct usage stats in all-accounts mode", () => {
    const overview = {
      sites: [],
      accounts: [],
      totals: {
        balance: 0,
        totalSites: 2,
        totalAccounts: 2,
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
      generatedAt: "2026-06-30T10:47:34Z"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccountStats: null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountRecentUsage: [],
        usageStats: {
          totalRequests: 230,
          totalInputTokens: 2500,
          totalOutputTokens: 1200,
          totalCacheTokens: 0,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          totalTokens: 3700,
          totalCost: 1.7,
          totalActualCost: 1.5,
          averageDurationMs: 1356.5217,
          rpm: 5,
          tpm: 12700
        },
        allAccountKeys: [
          { id: "all-account-key-1", accountId: "account-1", name: "主账号密钥", status: "active" },
          { id: "all-account-key-2", accountId: "account-2", name: "2FA账号密钥", status: "active" }
        ],
        usageStatsMode: "all-accounts",
        onUsageStatsModeChange: () => {},
        usageStatsRows: [
          {
            accountId: "account-1",
            label: "主账号",
            siteName: "AI INPUT",
            stats: {
              totalRequests: 200,
              totalInputTokens: 2000,
              totalOutputTokens: 1000,
              totalCacheTokens: 0,
              totalCacheCreationTokens: 0,
              totalCacheReadTokens: 0,
              totalTokens: 3000,
              totalCost: 1.2,
              totalActualCost: 1.1,
              averageDurationMs: 1200,
              rpm: 4,
              tpm: 12000
            }
          },
          {
            accountId: "account-2",
            label: "2FA账号",
            siteName: "Mock 2FA Site",
            stats: {
              totalRequests: 30,
              totalInputTokens: 500,
              totalOutputTokens: 200,
              totalCacheTokens: 0,
              totalCacheCreationTokens: 0,
              totalCacheReadTokens: 0,
              totalTokens: 700,
              totalCost: 0.5,
              totalActualCost: 0.4,
              averageDurationMs: 2400,
              rpm: 1,
              tpm: 700
            }
          }
        ]
      })
    );

      expect(html).toContain("5 RPM");
      expect(html).toContain("正常 2 / 总 2");
      expect(html).toContain("2 个账号");
      expect(html).toContain("AI INPUT / 主账号");
      expect(html).toContain("Mock 2FA Site / 2FA账号");
  });

  it("keeps total token hover details on cumulative request semantics", () => {
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
          createdAt: "2026-07-01T10:00:00Z",
          updatedAt: "2026-07-01T10:00:00Z",
          site: null,
          sessionState: "ready",
          lastError: null,
          cacheView: {
            fetchedAt: "2026-07-01T10:08:42+08:00",
            online: true,
            siteName: "AI INPUT",
            balance: 12.5,
            stats: {
              totalApiKeys: 2,
              activeApiKeys: 2,
              todayRequests: 30,
              totalRequests: 230,
              todayActualCost: 1.5,
              totalActualCost: 9.5,
              todayCost: 1.5,
              totalCost: 9.5,
              todayTokens: 700,
              totalTokens: 3700,
              todayInputTokens: 500,
              todayOutputTokens: 200,
              averageDurationMs: 1200,
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
        balance: 12.5,
        totalSites: 1,
        totalAccounts: 1,
        totalApiKeys: 2,
        activeApiKeys: 2,
        todayRequests: 30,
        totalRequests: 230,
        todayActualCost: 1.5,
        totalActualCost: 9.5,
        todayTokens: 700,
        totalTokens: 3700
      },
      alerts: [],
      platformSeries: [],
      trend: [],
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-07-01T02:08:42Z"
    } satisfies OverviewPayload;

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccount: overview.accounts[0],
        currentAccountBalance: overview.accounts[0].cacheView?.balance ?? null,
        currentAccountStats: overview.accounts[0].cacheView?.stats ?? null,
        currentAccountSubscriptions: [],
        subscriptionSummary: null,
        currentAccountRecentUsage: [],
        usageStats: null,
        totalUsageStats: {
          totalRequests: 230,
          totalInputTokens: 500,
          totalOutputTokens: 200,
          totalCacheTokens: 0,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          totalTokens: 3700,
          totalCost: 9.5,
          totalActualCost: 9.5,
          averageDurationMs: 1200,
          rpm: 1,
          tpm: 3700
        },
        usageStatsMode: "selected-account",
        onUsageStatsModeChange: () => {},
        usageStatsRows: [
          {
            accountId: "account-1",
            label: "主账号",
            siteName: "AI INPUT",
            stats: {
              totalRequests: 30,
              totalInputTokens: 500,
              totalOutputTokens: 200,
              totalCacheTokens: 0,
              totalCacheCreationTokens: 0,
              totalCacheReadTokens: 0,
              totalTokens: 700,
              totalCost: 1.5,
              totalActualCost: 1.5,
              averageDurationMs: 1200,
              rpm: 1,
              tpm: 700
            },
            totalStats: {
              totalRequests: 230,
              totalInputTokens: 500,
              totalOutputTokens: 200,
              totalCacheTokens: 0,
              totalCacheCreationTokens: 0,
              totalCacheReadTokens: 0,
              totalTokens: 3700,
              totalCost: 9.5,
              totalActualCost: 9.5,
              averageDurationMs: 1200,
              rpm: 1,
              tpm: 3700
            }
          }
        ]
      })
    );

    expect(html).toContain("AI INPUT / 主账号 · 累计 230 请求");
    expect(html).not.toContain("AI INPUT / 主账号 · 今日 700 tokens");
  });

  it("keeps all-account performance empty when upstream stats are absent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T10:08:42+08:00"));

    const overview = {
      sites: [],
      accounts: [],
      totals: {
        balance: 42.5,
        totalSites: 2,
        totalAccounts: 2,
        totalApiKeys: 10,
        activeApiKeys: 10,
        todayRequests: 1310,
        totalRequests: 27548,
        todayActualCost: 134.8457,
        totalActualCost: 3475.022,
        todayTokens: 123700000,
        totalTokens: 4449900000
      },
      alerts: [],
      platformSeries: [],
      trend: [],
      recentUsage: [
        {
          id: "usage-1",
          apiKeyId: 1,
          createdAt: "2026-07-01T10:08:40+08:00",
          model: "gpt-5.4",
          actualCost: 0,
          totalCost: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 300000,
          apiKeyName: "codex",
          accountId: "account-1",
          siteId: "site-1",
          siteName: "AI INPUT"
        },
        {
          id: "usage-2",
          apiKeyId: 2,
          createdAt: "2026-07-01T10:08:32+08:00",
          model: "gpt-5.4",
          actualCost: 0,
          totalCost: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 480000,
          apiKeyName: "codex",
          accountId: "account-1",
          siteId: "site-1",
          siteName: "AI INPUT"
        }
      ],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-07-01T02:08:42Z"
    } satisfies OverviewPayload;

    try {
      const html = renderToStaticMarkup(
        createElement(OverviewPage, {
          overview,
          currentAccountStats: null,
          currentAccountSubscriptions: [],
          subscriptionSummary: null,
          currentAccountKeys: [],
          currentAccountRecentUsage: overview.recentUsage,
          usageStats: null,
          usageStatsMode: "all-accounts",
          onUsageStatsModeChange: () => {},
          usageStatsRows: []
        })
      );

      expect(html).toContain("性能指标");
      expect(html).toContain("- RPM");
      expect(html).toContain("当前还没有速度数据");
      expect(html).not.toContain("15 RPM");
      expect(html).not.toContain("5.8M TPM");
      expect(html).not.toContain("实时 RPM");
      expect(html).not.toContain("实时 TPM");
    } finally {
      vi.useRealTimers();
    }
  });

  describe("usage insights", () => {
    function createUsageInsightOverview(): OverviewPayload {
      return {
        sites: [],
        accounts: [
          {
            id: "account-1",
            siteId: "site-1",
            label: "主账号",
            email: "main@example.com",
            balanceWarning: -1,
            lastLoginAt: null,
            createdAt: "2026-07-07T00:00:00Z",
            updatedAt: "2026-07-07T00:00:00Z",
            site: null,
            sessionState: "ready",
            lastError: null,
            cacheView: {
              fetchedAt: "2026-07-07T10:00:00Z",
              online: true,
              siteName: "AI INPUT",
              balance: 42.5,
              stats: {
                totalApiKeys: 2,
                activeApiKeys: 2,
                todayRequests: 12,
                totalRequests: 120,
                todayActualCost: 2.42,
                totalActualCost: 24.2,
                todayCost: 2.42,
                totalCost: 24.2,
                todayTokens: 3600,
                totalTokens: 36000,
                todayInputTokens: 1200,
                todayOutputTokens: 2400,
                averageDurationMs: 420,
                byPlatform: [],
                byModel: [
                  {
                    model: "gpt-5.4",
                    requests: 8,
                    totalTokens: 2400,
                    actualCost: 1.9,
                    totalCost: 1.9
                  },
                  {
                    model: "gpt-image-2",
                    requests: 2,
                    totalTokens: 600,
                    actualCost: 0.3,
                    totalCost: 0.3
                  }
                ]
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
          balance: 42.5,
          totalSites: 1,
          totalAccounts: 1,
          totalApiKeys: 2,
          activeApiKeys: 2,
          todayRequests: 12,
          totalRequests: 120,
          todayActualCost: 2.42,
          totalActualCost: 24.2,
          todayTokens: 3600,
          totalTokens: 36000
        },
        alerts: [],
        platformSeries: [],
        modelSeries: [],
        trend: [],
        recentUsage: [],
        subscriptions: [],
        keys: [],
        generatedAt: "2026-07-07T10:00:00Z"
      };
    }

    it("renders group and endpoint distributions from selected-account recent usage samples", () => {
      const overview = createUsageInsightOverview();
      const currentAccountRecentUsage: UsageRow[] = [
        {
          id: "usage-1",
          createdAt: "2026-07-07T09:00:00Z",
          model: "gpt-5.4",
          endpoint: "/responses",
          groupName: "Codex Plus 月度",
          actualCost: 0.32,
          totalCost: 0.32,
          inputTokens: 100,
          outputTokens: 60,
          totalTokens: 160
        },
        {
          id: "usage-2",
          createdAt: "2026-07-07T09:10:00Z",
          model: "gpt-5.4",
          endpoint: "/responses",
          groupName: "Codex Plus 月度",
          actualCost: 0.48,
          totalCost: 0.48,
          inputTokens: 140,
          outputTokens: 80,
          totalTokens: 220
        },
        {
          id: "usage-3",
          createdAt: "2026-07-07T09:20:00Z",
          model: "gpt-image-2",
          endpoint: "/v1/images/edits",
          groupName: "Codex Plus 年度",
          actualCost: 0.18,
          totalCost: 0.18,
          inputTokens: 60,
          outputTokens: 20,
          totalTokens: 80
        }
      ];

      const html = renderToStaticMarkup(
        createElement(OverviewPage, {
          overview,
          currentAccount: overview.accounts[0],
          currentAccountBalance: overview.accounts[0].cacheView?.balance ?? null,
          currentAccountStats: overview.accounts[0].cacheView?.stats ?? null,
          currentAccountSubscriptions: [],
          subscriptionSummary: null,
          currentAccountRecentUsage,
          usageStats: null,
          usageStatsMode: "selected-account",
          onUsageStatsModeChange: () => {},
          usageStatsRows: []
        })
      );

      expect(html).toContain("用量洞察");
      expect(html).toContain("分组排行");
      expect(html).toContain("端点排行");
      expect(html).toContain("Codex Plus 月度");
      expect(html).toContain("/responses");
    });

    it("uses the selected range and its complete aggregated request count for usage insights", () => {
      const overview = createUsageInsightOverview();
      const html = renderToStaticMarkup(
        createElement(OverviewPage, {
          overview,
          currentAccount: overview.accounts[0],
          currentAccountBalance: overview.accounts[0].cacheView?.balance ?? null,
          currentAccountStats: overview.accounts[0].cacheView?.stats ?? null,
          currentAccountSubscriptions: [],
          subscriptionSummary: null,
          currentAccountRecentUsage: [
            {
              id: "usage-rank-1",
              createdAt: "2026-07-07T09:00:00Z",
              model: "gpt-5.4",
              endpoint: "/responses",
              groupName: "Codex Plus 月度",
              actualCost: 0.42,
              totalCost: 0.48,
              inputTokens: 120,
              outputTokens: 80,
              totalTokens: 200
            }
          ],
          usageStats: null,
          trendPoints: [
            {
              bucket: "2026-07-07",
              actualCost: 0.42,
              totalCost: 0.48,
              requests: 1,
              inputTokens: 120,
              outputTokens: 80,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              totalTokens: 200
            }
          ],
          modelSeries: [
            {
              model: "gpt-5.4",
              requests: 1,
              totalTokens: 200,
              actualCost: 0.42,
              totalCost: 0.48
            }
          ],
          usageStatsMode: "selected-account",
          onUsageStatsModeChange: () => {},
          usageStatsRows: [],
          usageInsightRange: { startDate: "2026-07-01", endDate: "2026-07-07" },
          onUsageInsightRangeChange: () => {},
          usageInsights: {
            startDate: "2026-07-01",
            endDate: "2026-07-07",
            totalRequests: 37,
            groups: [{ name: "全部范围分组", requests: 37, totalTokens: 7400, actualCost: 1.48, totalCost: 1.6 }],
            endpoints: [{ name: "/responses", requests: 37, totalTokens: 7400, actualCost: 1.48, totalCost: 1.6 }]
          }
        })
      );

      expect((html.match(/aria-label="用量洞察排序口径"/g) ?? []).length).toBe(1);
      expect((html.match(/role="tab"/g) ?? []).length).toBe(2);
      expect(html).toContain('aria-label="开始日期" value="2026-07-01"');
      expect(html).toContain('aria-label="结束日期" value="2026-07-07"');
      expect(html).toContain("37 条请求");
      expect(html).toContain("全部范围分组");
      expect(html).toContain('aria-label="用量洞察时间范围"');
      expect(html).not.toContain("趋势:");
      expect(html).not.toContain("模型:");
      expect(html).not.toContain("分组 / 端点:");
      expect(html).not.toContain("把全部账号的趋势、模型、分组和端点直接放到总览里。");
      expect(html).not.toContain("看看2026-07-01 至 2026-07-07的使用变化和花费变化");
      expect(html).toContain("模型排行");
      expect(html).toContain("分组排行");
      expect(html).toContain("端点排行");
      expect(html).toContain("overview-usage-insights-trend-card");
      expect(html).toContain("overview-usage-insight-rank-shell");
      expect(html).not.toContain("overview-usage-insight-card-shell");
      expect(html).not.toContain("overview-usage-insight-table");
    });

    it("uses range insights rather than overview recent usage samples in all-account mode", () => {
      const overview = createUsageInsightOverview();
      overview.recentUsage = [
        {
          id: "overview-usage-1",
          accountId: "account-1",
          siteId: "site-1",
          siteName: "AI INPUT",
          createdAt: "2026-07-07T09:30:00Z",
          model: "gpt-5.4",
          endpoint: "/responses",
          groupName: "全部账号分组",
          actualCost: 0.66,
          totalCost: 0.66,
          inputTokens: 180,
          outputTokens: 120,
          totalTokens: 300
        }
      ];

      const html = renderToStaticMarkup(
        createElement(OverviewPage, {
          overview,
          currentAccount: overview.accounts[0],
          currentAccountBalance: overview.accounts[0].cacheView?.balance ?? null,
          currentAccountStats: overview.accounts[0].cacheView?.stats ?? null,
          currentAccountSubscriptions: [],
          subscriptionSummary: null,
          currentAccountRecentUsage: [],
          usageStats: null,
          usageStatsMode: "all-accounts",
          onUsageStatsModeChange: () => {},
          usageStatsRows: [],
          usageInsightRange: { startDate: "2026-07-01", endDate: "2026-07-07" },
          onUsageInsightRangeChange: () => {},
          usageInsights: {
            startDate: "2026-07-01",
            endDate: "2026-07-07",
            totalRequests: 86,
            groups: [{ name: "范围内全部账号分组", requests: 86, totalTokens: 25800, actualCost: 6.6, totalCost: 6.6 }],
            endpoints: [{ name: "/responses", requests: 86, totalTokens: 25800, actualCost: 6.6, totalCost: 6.6 }]
          }
        })
      );

      expect(html).toContain("范围内全部账号分组");
      expect(html).toContain("86 条请求");
    });
  });

});
