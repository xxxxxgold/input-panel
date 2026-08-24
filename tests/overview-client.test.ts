import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn()
}));

import { invoke } from "@tauri-apps/api/core";

import {
  getCodexRadarFast,
  getCodexRadarInsights,
  getCodexRadarIntelligence,
  getCodexRadarModelIq,
  getOverview,
  getOverviewShell,
  getOverviewShellLite
} from "../src/features/overview/client";
import { getUsageAnalytics } from "../src/features/usage/client";
import type { UsageFilter } from "../src/types";
import { restoreWindow, stubWindow } from "./helpers/window";

describe("overview client compatibility", () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;

  function stubTauriWindow() {
    stubWindow({
      __TAURI_INTERNALS__: {}
    } as Window & typeof globalThis);
  }

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
    restoreWindow(originalWindow);
  });

  const analyticsFilter: UsageFilter = {
    apiKeyId: 3641,
    startDate: "2026-05-01",
    endDate: "2026-06-14",
    model: { value: "gpt-5.4", mode: "prefix" },
    groupName: { value: "生产组", mode: "exact" },
    subscriptionName: { value: "高级订阅", mode: "exact" },
    platform: { value: "openai", mode: "exact" },
    reasoningEffort: { value: "high", mode: "exact" },
    requestType: { value: "stream", mode: "exact" },
    billingType: 2,
    billingMode: { value: "balance", mode: "exact" },
    stream: false,
    inputTokens: { min: 100, max: 1_000 },
    userAgentQuery: "Codex"
  };

  it("posts every analytics filter as one HTTP JSON body", async () => {
    const payload = { version: 1 };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload
    }) as typeof fetch;

    await expect(
      getUsageAnalytics("account-1", analyticsFilter)
    ).resolves.toEqual(payload);

    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0];
    const url = new URL(String(requestUrl), "http://localhost");
    expect(url.pathname).toBe("/api/accounts/account-1/usage/analytics");
    expect(Object.fromEntries(url.searchParams.entries())).toEqual({});
    expect(requestInit).toEqual(expect.objectContaining({
      method: "POST",
      body: JSON.stringify(analyticsFilter),
      cache: "no-store"
    }));
  });

  it("passes every analytics filter as one nested Tauri argument", async () => {
    stubTauriWindow();
    const payload = { version: 1 };
    vi.mocked(invoke).mockResolvedValue(payload);

    await expect(
      getUsageAnalytics("account-1", analyticsFilter)
    ).resolves.toEqual(payload);

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("get_usage_analytics", {
      accountId: "account-1",
      filter: analyticsFilter
    });
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
        modelSeries: [],
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

  it("uses the Codex Radar HTTP route in browser mode", async () => {
    const payload = {
      items: [],
      sourceUpdatedAt: "2026-07-21T18:07:02+08:00",
      fetchedAt: "2026-07-21T18:10:00+08:00",
      lastError: null,
      isStale: false
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload
    }) as typeof fetch;

    await expect(getCodexRadarModelIq()).resolves.toEqual(payload);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      "/api/codex-radar/model-iq",
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("uses the Codex Radar Tauri command in desktop mode", async () => {
    stubTauriWindow();
    const payload = {
      items: [],
      sourceUpdatedAt: "2026-07-21T18:07:02+08:00",
      fetchedAt: "2026-07-21T18:10:00+08:00",
      lastError: null,
      isStale: false
    };
    vi.mocked(invoke).mockResolvedValue(payload);

    await expect(getCodexRadarModelIq()).resolves.toEqual(payload);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("get_codex_radar_model_iq", undefined);
  });

  it("uses the local intelligence route and Tauri command", async () => {
    const payload = {
      efficiencyPoints: [],
      detailItems: [],
      sourceUpdatedAt: "2026-07-22T08:16:45+08:00",
      fetchedAt: "2026-07-22T08:18:00+08:00",
      lastError: null,
      isStale: false
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload
    }) as typeof fetch;

    await expect(getCodexRadarIntelligence()).resolves.toEqual(payload);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      "/api/codex-radar/intelligence",
      expect.objectContaining({ cache: "no-store" })
    );

    stubTauriWindow();
    vi.mocked(invoke).mockResolvedValue(payload);

    await expect(getCodexRadarIntelligence()).resolves.toEqual(payload);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("get_codex_radar_intelligence", undefined);
  });

  it("uses the local Fast Radar route and Tauri command", async () => {
    const payload = {
      summary: { costMultiplier: 2.5, e2eMultiplier: 1.208, ttftDeltaSeconds: -2.28, tpsMultiplier: 1.44 },
      items: [],
      sourceUpdatedAt: "7月22日10:09更新",
      fetchedAt: "2026-07-22T10:12:00+08:00",
      lastError: null,
      isStale: false
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload
    }) as typeof fetch;

    await expect(getCodexRadarFast()).resolves.toEqual(payload);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      "/api/codex-radar/fast",
      expect.objectContaining({ cache: "no-store" })
    );

    stubTauriWindow();
    vi.mocked(invoke).mockResolvedValue(payload);

    await expect(getCodexRadarFast()).resolves.toEqual(payload);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("get_codex_radar_fast", undefined);
  });

  it("uses equivalent normal and forced Insights arguments for HTTP and Tauri", async () => {
    const payload = {
      recommendations: [],
      degradationRule: "12 小时 IQ 下降达到上游门槛",
      degradationAlerts: [],
      sourceUpdatedAt: "2026-07-29T20:38:00+08:00",
      fetchedAt: "2026-07-29T20:39:00+08:00",
      lastError: null,
      isStale: false
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload
    }) as typeof fetch;

    await expect(getCodexRadarInsights()).resolves.toEqual(payload);
    await expect(getCodexRadarInsights(true)).resolves.toEqual(payload);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenNthCalledWith(
      1,
      "/api/codex-radar/insights",
      expect.objectContaining({ cache: "no-store" })
    );
    expect(vi.mocked(globalThis.fetch)).toHaveBeenNthCalledWith(
      2,
      "/api/codex-radar/insights?force=true",
      expect.objectContaining({ cache: "no-store" })
    );

    stubTauriWindow();
    vi.mocked(invoke).mockResolvedValue(payload);

    await expect(getCodexRadarInsights()).resolves.toEqual(payload);
    await expect(getCodexRadarInsights(true)).resolves.toEqual(payload);
    expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(1, "get_codex_radar_insights", { force: false });
    expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(2, "get_codex_radar_insights", { force: true });
  });

  it("normalizes snapshot payloads to cacheView in Tauri mode", async () => {
    stubTauriWindow();
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
      modelSeries: [],
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

  it("uses the shell overview HTTP route when requested", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
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
        modelSeries: [],
        trend: [],
        recentUsage: [],
        subscriptions: [],
        keys: [],
        generatedAt: "2026-07-02T00:00:00Z"
      })
    }) as typeof fetch;

    await getOverviewShell();

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      "/api/dashboard/overview-shell",
      expect.objectContaining({
        cache: "no-store"
      })
    );
  });

  it("uses the shell overview Tauri command when requested", async () => {
    stubTauriWindow();
    vi.mocked(invoke).mockResolvedValue({
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
      modelSeries: [],
      trend: [],
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-07-02T00:00:00Z"
    });

    await getOverviewShell();

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("get_overview_shell");
  });

  it("uses the shell-lite overview HTTP route when requested", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
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
        modelSeries: [],
        trend: [],
        recentUsage: [],
        subscriptions: [],
        keys: [],
        generatedAt: "2026-07-03T00:00:00Z"
      })
    }) as typeof fetch;

    await getOverviewShellLite();

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      "/api/dashboard/overview-shell-lite",
      expect.objectContaining({
        cache: "no-store"
      })
    );
  });

  it("uses the shell-lite overview Tauri command when requested", async () => {
    stubTauriWindow();
    vi.mocked(invoke).mockResolvedValue({
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
      modelSeries: [],
      trend: [],
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-07-03T00:00:00Z"
    });

    await getOverviewShellLite();

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("get_overview_shell_lite");
  });
});
