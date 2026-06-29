import { describe, expect, it } from "vitest";

import { buildWorkspaceSummaryTexts } from "../src/app/workspace-summary";
import type { AccountRuntime, AccountSyncStatusRecord, OverviewPayload } from "../src/types";

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
        todayActualCost: 0,
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
      { key: "sync", label: "最近同步 08:00:00" }
    ]);
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
});
