import { describe, expect, it } from "vitest";

import { buildWorkspaceSummaryTexts } from "../src/app/workspace-summary";
import type { AccountRuntime, AccountSyncStatusRecord, OverviewPayload, UsageStatsRecord } from "../src/types";
import type { AccountSyncStatusPresentation } from "../src/app/account-sync-status-presentation";

function buildAccount(overrides: Partial<AccountRuntime> = {}): AccountRuntime {
  return {
    id: overrides.id ?? "account-1",
    siteId: overrides.siteId ?? "site-1",
    label: overrides.label ?? "账号",
    email: overrides.email ?? "demo@example.com",
    balanceWarning: overrides.balanceWarning ?? -1,
    lastLoginAt: overrides.lastLoginAt ?? null,
    createdAt: overrides.createdAt ?? "2026-06-11T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-06-11T00:00:00Z",
    site: overrides.site ?? null,
    cacheView: overrides.cacheView ?? null,
    sessionState: overrides.sessionState ?? "ready",
    lastError: overrides.lastError ?? null
  };
}

describe("buildWorkspaceSummaryTexts", () => {
  it("includes request and token summaries in the workspace header", () => {
    const overview = {
      sites: [],
      accounts: [],
      totals: {
        balance: 0,
        totalSites: 2,
        totalAccounts: 2,
        totalApiKeys: 0,
        activeApiKeys: 0,
        todayRequests: 4101,
        totalRequests: 94774,
        todayActualCost: 12.3456,
        totalActualCost: 0,
        todayTokens: 864229530,
        totalTokens: 18962484350
      },
      alerts: [],
      platformSeries: [],
      trend: [],
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-06-13T00:00:00Z"
    } satisfies OverviewPayload;

    const accounts = [
      buildAccount({
        cacheView: {
          stats: {
            todayInputTokens: 700,
            todayOutputTokens: 500,
            todayTokens: 1200,
            todayRequests: 10,
            totalRequests: 10,
            todayActualCost: 0,
            totalActualCost: 0,
            todayCost: 0,
            totalCost: 0,
            totalApiKeys: 0,
            activeApiKeys: 0,
            averageDurationMs: 0,
            byPlatform: []
          },
          trend: [
            {
              bucket: "2026-06-13",
              actualCost: 0,
              totalCost: 0,
              requests: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 300,
              totalTokens: 0
            }
          ]
        } as AccountRuntime["cacheView"]
      })
    ];

    expect(buildWorkspaceSummaryTexts({ overview, accounts, now: new Date("2026-06-13T00:00:00Z") })).toEqual([
      { key: "sites", label: "2 个站点" },
      { key: "accounts", label: "2 个账号" },
      { key: "requests", label: "今日 4.1K 请求" },
      {
        key: "tokens",
        tone: "token-group",
        segments: [
          { key: "input", label: "输入", value: "700" },
          { key: "cache", label: "缓存", value: "300" },
          { key: "output", label: "输出", value: "500" }
        ]
      },
      { key: "totalTokens", label: "总 Token 864.2M" },
      { key: "todayActualCost", label: "今日消费 $12.3456" },
      { key: "sync", label: "快照生成 08:00:00" }
    ]);
  });

  it("prefers dashboard usage stats over stale overview cache summaries", () => {
    const overview = {
      sites: [],
      accounts: [],
      totals: {
        balance: 0,
        totalSites: 1,
        totalAccounts: 2,
        totalApiKeys: 0,
        activeApiKeys: 0,
        todayRequests: 10,
        totalRequests: 10,
        todayActualCost: 0,
        totalActualCost: 0,
        todayTokens: 1906247,
        totalTokens: 1906247
      },
      alerts: [],
      platformSeries: [],
      trend: [],
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-07-06T02:52:25Z"
    } satisfies OverviewPayload;
    const usageStats = {
      totalRequests: 1010,
      totalInputTokens: 12030000,
      totalOutputTokens: 830430,
      totalCacheTokens: 103390000,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 103390000,
      totalTokens: 116240000,
      totalCost: 119.8799,
      totalActualCost: 119.8799,
      averageDurationMs: 0,
      rpm: 0,
      tpm: 0
    } satisfies UsageStatsRecord;

    expect(buildWorkspaceSummaryTexts({
      overview,
      accounts: [],
      usageStats,
      now: new Date("2026-07-06T02:52:25Z")
    })).toEqual([
      { key: "sites", label: "1 个站点" },
      { key: "accounts", label: "2 个账号" },
      { key: "requests", label: "今日 1.0K 请求" },
      {
        key: "tokens",
        tone: "token-group",
        segments: [
          { key: "input", label: "输入", value: "12.0M" },
          { key: "cache", label: "缓存", value: "103.4M" },
          { key: "output", label: "输出", value: "830.4K" }
        ]
      },
      { key: "totalTokens", label: "总 Token 116.2M" },
      { key: "todayActualCost", label: "今日消费 $119.8799" },
      { key: "sync", label: "快照生成 10:52:25" }
    ]);
  });

  it("keeps the consumption placeholder after total tokens while overview loads", () => {
    const summary = buildWorkspaceSummaryTexts({ overview: null, accounts: [] });
    const totalTokenIndex = summary.findIndex((item) => item.key === "totalTokens");

    expect(summary[totalTokenIndex + 1]).toEqual({
      key: "todayActualCost",
      label: "暂无今日消费"
    });
  });

  it("prefers failed sync summary over stale running placeholders once sync status settles", () => {
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
      generatedAt: "2026-06-28T00:00:00Z"
    } satisfies OverviewPayload;

    const syncStatuses: AccountSyncStatusRecord[] = [
      {
        accountId: "account-1",
        scope: "core",
        state: "failed",
        lastAttemptAt: "2026-06-28T03:56:35Z",
        lastSuccessAt: null,
        lastError: "error decoding response body",
        itemCount: 0
      },
      {
        accountId: "account-1",
        scope: "keys",
        state: "succeeded",
        lastAttemptAt: "2026-06-28T03:40:00Z",
        lastSuccessAt: "2026-06-28T03:40:00Z",
        lastError: null,
        itemCount: 1
      }
    ];

    const summary = buildWorkspaceSummaryTexts({ overview, accounts: [], syncStatuses });
    const last = summary.at(-1);
    expect(last && !("segments" in last) ? last.label : null).toBe("同步失败: core");
  });

  it("falls back to overview generatedAt when sync status is still running", () => {
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
      generatedAt: "2026-06-28T04:17:46Z"
    } satisfies OverviewPayload;

    const syncStatuses: AccountSyncStatusRecord[] = [
      {
        accountId: "account-1",
        scope: "core",
        state: "running",
        lastAttemptAt: "2026-06-28T04:17:46Z",
        lastSuccessAt: "2026-06-28T04:17:30Z",
        lastError: null,
        itemCount: 5
      }
    ];

    const summary = buildWorkspaceSummaryTexts({ overview, accounts: [], syncStatuses });
    const last = summary.at(-1);
    expect(last && !("segments" in last) ? last.label : null).toBe("1 项同步中");
  });

  it("shows the actual sync date instead of treating a fresh snapshot as a fresh sync", () => {
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
      generatedAt: "2026-07-31T10:30:00Z"
    } satisfies OverviewPayload;
    const syncStatuses: AccountSyncStatusRecord[] = [{
      accountId: "account-1",
      scope: "usage",
      state: "succeeded",
      lastAttemptAt: "2026-07-30T09:18:36Z",
      lastSuccessAt: "2026-07-30T09:18:36Z",
      lastError: null,
      itemCount: 435843
    }];

    const summary = buildWorkspaceSummaryTexts({
      overview,
      accounts: [],
      syncStatuses,
      now: new Date("2026-07-31T10:30:00Z")
    });
    const last = summary.at(-1);

    expect(last && !("segments" in last) ? last.label : null).toBe("最近同步 7月30日 17:18:36");
  });

  it("distinguishes a sync-status cold failure and preserves a retained snapshot in the header", () => {
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
      generatedAt: "2026-08-05T08:00:00Z"
    } satisfies OverviewPayload;
    const coldFailure: AccountSyncStatusPresentation = {
      accountId: "account-1",
      hasSnapshot: false,
      initialLoading: false,
      statuses: [],
      lastError: "服务暂不可用"
    };
    const retainedSnapshot: AccountSyncStatusPresentation = {
      accountId: "account-1",
      hasSnapshot: true,
      initialLoading: false,
      statuses: [{
        accountId: "account-1",
        scope: "core",
        state: "succeeded",
        lastAttemptAt: "2026-08-05T07:55:00Z",
        lastSuccessAt: "2026-08-05T07:55:00Z",
        lastError: null,
        itemCount: 3
      }],
      lastError: "服务暂不可用"
    };

    const coldSummary = buildWorkspaceSummaryTexts({
      overview,
      accounts: [],
      syncStatusPresentation: coldFailure
    }).at(-1);
    const loadingSummary = buildWorkspaceSummaryTexts({
      overview: null,
      accounts: [],
      syncStatusPresentation: coldFailure
    }).at(-1);
    const retainedSummary = buildWorkspaceSummaryTexts({
      overview,
      accounts: [],
      syncStatusPresentation: retainedSnapshot,
      now: new Date("2026-08-05T08:00:00Z")
    }).at(-1);

    expect(coldSummary && !("segments" in coldSummary) ? coldSummary.label : null).toBe("同步状态暂不可读取");
    expect(loadingSummary && !("segments" in loadingSummary) ? loadingSummary.label : null)
      .toBe("同步状态暂不可读取");
    expect(retainedSummary && !("segments" in retainedSummary) ? retainedSummary.label : null)
      .toBe("最近同步 15:55:00（状态刷新失败）");
  });
});
