import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApiKeyList } from "../src/features/keys/components/ApiKeyList";
import { OverviewPage } from "../src/pages/OverviewPage";
import type { KeyRecord, OverviewPayload } from "../src/types";

const sampleKey: KeyRecord = {
  id: "key-1",
  name: "codex++",
  groupId: 3,
  groupName: "CodeX Plus 年度",
  platform: "openai",
  status: "active",
  lastUsedAt: "2026-06-11T20:27:00+08:00"
};

describe("ApiKeyList summary style", () => {
  it("removes duplicated raw status fields and keeps status plus group info on the secondary row", () => {
    const html = renderToStaticMarkup(
      createElement(ApiKeyList, {
        keys: [sampleKey]
      })
    );

    expect(html).toContain("api-key-summary-row");
    expect(html).toContain("status-pill ready");
    expect(html).toContain("codex++");
    expect(html).toContain("CodeX Plus 年度");
    expect(html).toContain("key-platform-pill openai");
    expect(html).toContain("最后使用时间：06/11 20:27");
    expect(html).not.toContain(">active</small>");
    expect(html).not.toContain(">active</span>");
    expect(html.indexOf("codex++")).toBeLessThan(html.indexOf("status-pill ready"));
    expect(html.indexOf("status-pill ready")).toBeLessThan(html.indexOf("CodeX Plus 年度"));
  });

  it("renders the overview all-account keys panel with the same summary row style", () => {
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
          cacheView: null
        }
      ],
      totals: {
        balance: 0,
        totalSites: 1,
        totalAccounts: 1,
        totalApiKeys: 1,
        activeApiKeys: 1,
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

    const visibleSnapshot = {
      fetchedAt: "2026-06-15T10:00:00Z",
      online: true,
      siteName: "AI INPUT",
      balance: 42.5,
      stats: {
        totalApiKeys: 1,
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
      subscriptions: [],
      keys: [sampleKey],
      activeSubscription: null,
      alerts: []
    };

    const html = renderToStaticMarkup(
      createElement(OverviewPage, {
        overview,
        currentAccountStats: visibleSnapshot.stats,
        currentAccountSubscriptions: visibleSnapshot.subscriptions,
        subscriptionSummary: null,
        allAccountKeys: visibleSnapshot.keys,
        currentAccountRecentUsage: visibleSnapshot.recentUsage,
        usageStats: null,
        usageStatsMode: "all-accounts"
      })
    );

    expect(html).toContain("全部密钥");
    expect(html).toContain("api-key-summary-row");
    expect(html).toContain("codex++");
    expect(html).toContain("CodeX Plus 年度");
    expect(html).not.toContain(">active</span>");
    expect(html).toContain("06/11 20:27");
  });
});
