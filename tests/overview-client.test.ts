import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn()
}));

import { invoke } from "@tauri-apps/api/core";

import { getOverview } from "../src/features/overview/client";

describe("overview client compatibility", () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = originalFetch;
    if (originalWindow) {
      globalThis.window = originalWindow;
    } else {
      // @ts-expect-error test cleanup
      delete globalThis.window;
    }
  });

  it("normalizes snapshot payloads to cacheView in HTTP mode", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        sites: [],
        accounts: [
          {
            id: "account-1",
            siteId: "site-1",
            label: "主账号",
            email: "demo@example.com",
            balanceWarning: -1,
            createdAt: "2026-06-28T00:00:00Z",
            updatedAt: "2026-06-28T00:00:00Z",
            sessionState: "ready",
            snapshot: {
              fetchedAt: "2026-06-28T12:00:00Z",
              online: true,
              siteName: "AI INPUT",
              balance: 42.5,
              stats: {
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
        generatedAt: "2026-06-28T12:00:00Z"
      })
    }) as typeof fetch;

    const result = await getOverview();

    expect(result.accounts[0].cacheView?.balance).toBe(42.5);
    expect(result.accounts[0].cacheView?.stats.totalApiKeys).toBe(9);
  });

  it("normalizes snapshot payloads to cacheView in Tauri mode", async () => {
    // @ts-expect-error test-only runtime flag
    globalThis.window = { __TAURI_INTERNALS__: {} };
    vi.mocked(invoke).mockResolvedValue({
      sites: [],
      accounts: [
        {
          id: "account-1",
          siteId: "site-1",
          label: "主账号",
          email: "demo@example.com",
          balanceWarning: -1,
          createdAt: "2026-06-28T00:00:00Z",
          updatedAt: "2026-06-28T00:00:00Z",
          sessionState: "ready",
          snapshot: {
            fetchedAt: "2026-06-28T12:00:00Z",
            online: true,
            siteName: "AI INPUT",
            balance: 42.5,
            stats: {
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
      generatedAt: "2026-06-28T12:00:00Z"
    });

    const result = await getOverview();

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("get_overview");
    expect(result.accounts[0].cacheView?.siteName).toBe("AI INPUT");
    expect(result.accounts[0].cacheView?.stats.todayRequests).toBe(3456);
  });
});
