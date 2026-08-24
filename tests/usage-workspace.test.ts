import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hookHarness = vi.hoisted(() => {
  type Cleanup = () => void;
  type EffectSlot = { cleanup?: Cleanup; deps?: readonly unknown[] };
  let stateSlots: unknown[] = [];
  let refSlots: Array<{ current: unknown }> = [];
  let effectSlots: EffectSlot[] = [];
  let stateCursor = 0;
  let refCursor = 0;
  let effectCursor = 0;

  function sameDependencies(left?: readonly unknown[], right?: readonly unknown[]) {
    return left?.length === right?.length && left?.every((value, index) => Object.is(value, right[index]));
  }

  return {
    beginRender() {
      stateCursor = 0;
      refCursor = 0;
      effectCursor = 0;
    },
    reset() {
      for (const slot of effectSlots) {
        slot.cleanup?.();
      }
      stateSlots = [];
      refSlots = [];
      effectSlots = [];
      stateCursor = 0;
      refCursor = 0;
      effectCursor = 0;
    },
    useState(initial: unknown) {
      const index = stateCursor++;
      if (!(index in stateSlots)) {
        stateSlots[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      }
      const setState = (next: unknown) => {
        stateSlots[index] = typeof next === "function"
          ? (next as (current: unknown) => unknown)(stateSlots[index])
          : next;
      };
      return [stateSlots[index], setState] as const;
    },
    useRef(initial: unknown) {
      const index = refCursor++;
      if (!(index in refSlots)) {
        refSlots[index] = { current: initial };
      }
      return refSlots[index];
    },
    useEffect(effect: () => void | Cleanup, deps?: readonly unknown[]) {
      const index = effectCursor++;
      const previous = effectSlots[index];
      if (previous && sameDependencies(previous.deps, deps)) {
        return;
      }
      previous?.cleanup?.();
      const cleanup = effect();
      effectSlots[index] = {
        cleanup: typeof cleanup === "function" ? cleanup : undefined,
        deps
      };
    }
  };
});

const usageClient = vi.hoisted(() => ({
  getApiKeyDailyUsage: vi.fn(),
  getDashboardModels: vi.fn(),
  getDashboardTrend: vi.fn(),
  getUsageAnalytics: vi.fn(),
  getUsageExtremes: vi.fn(),
  getUsageStats: vi.fn(),
  listUsageFacets: vi.fn(),
  listUsageRecords: vi.fn()
}));

vi.mock("react", () => ({
  useEffect: hookHarness.useEffect,
  useRef: hookHarness.useRef,
  useState: hookHarness.useState
}));

vi.mock("../src/features/usage/client", () => usageClient);

import { resolveUsageRefreshResult, useUsageWorkspace } from "../src/features/usage/useUsageWorkspace";
import { buildUsageScopeKey, usageScopeReferencesAccount } from "../src/features/usage/usage-scope";
import type { ManagedKeyRecord, NavKey, UsageAnalyticsPayload } from "../src/types";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function usageResult(
  label: string,
  pageSize = 20,
  options: {
    nextCursor?: string | null;
    previousCursor?: string | null;
    hasNext?: boolean;
    hasPrevious?: boolean;
    total?: number | null;
  } = {}
) {
  return {
    items: [{ id: label }],
    pageSize,
    nextCursor: options.nextCursor ?? null,
    previousCursor: options.previousCursor ?? null,
    hasNext: options.hasNext ?? false,
    hasPrevious: options.hasPrevious ?? false,
    total: options.total ?? null
  };
}

function usageAnalyticsResult(
  label = "analytics-sample",
  matchedRows = 1
): UsageAnalyticsPayload {
  return {
    version: 1,
    startDate: "2026-07-18",
    endDate: "2026-07-18",
    generatedAt: "2026-07-18 12:00:00",
    matchedRows,
    topN: 12,
    totals: {
      totalRequests: matchedRows,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      totalActualCost: 0,
      averageDurationMs: 0,
      rpm: null,
      tpm: null
    },
    trend: [],
    models: [],
    platforms: [],
    endpoints: [],
    apiKeys: [],
    groups: [],
    subscriptions: [],
    reasoningEfforts: [],
    requestTypes: [],
    reasoningRequestCombinations: [],
    userAgents: [],
    hourlyHeatmap: [],
    endpointFlows: [],
    costBreakdown: [],
    latencyPercentiles: { firstToken: null, duration: null },
    extremes: [],
    sampleRows: matchedRows > 0 ? [{ id: label } as UsageAnalyticsPayload["sampleRows"][number]] : []
  };
}

function UsageWorkspaceHookHarness(options: {
  nav?: NavKey;
  selectedAccountId?: string | null;
  managedKeys?: ManagedKeyRecord[];
} = {}) {
  hookHarness.beginRender();
  return useUsageWorkspace({
    nav: options.nav ?? "alerts",
    selectedAccountId: options.selectedAccountId === undefined ? "account-a" : options.selectedAccountId,
    managedKeys: options.managedKeys
      ? { items: options.managedKeys, total: options.managedKeys.length, page: 1, pageSize: 100, pages: 1 }
      : null,
    setBusyText: vi.fn(),
    setError: vi.fn()
  });
}

function pickDefaultKeyUsageKeyId(keys: ManagedKeyRecord[]) {
  const sorted = [...keys].sort((left, right) => {
    const leftTime = left.lastUsedAt ? Date.parse(left.lastUsedAt) : Number.NEGATIVE_INFINITY;
    const rightTime = right.lastUsedAt ? Date.parse(right.lastUsedAt) : Number.NEGATIVE_INFINITY;
    return rightTime - leftTime;
  });
  return sorted[0]?.id ?? "";
}

function normalizeUsagePageSize(value: number) {
  return [10, 20, 50, 100].includes(value) ? value : 20;
}

describe("usage workspace key selection helpers", () => {
  it("keeps cancelled silent refreshes distinct from successful local-cache reads", () => {
    expect(resolveUsageRefreshResult({ requestIsCurrent: true, blocked: false })).toBe("success");
    expect(resolveUsageRefreshResult({ requestIsCurrent: false, blocked: false })).toBe("cancelled");
    expect(resolveUsageRefreshResult({ requestIsCurrent: true, blocked: true })).toBe("cancelled");
  });
  it("prefers the most recently used key for default daily usage selection", () => {
    const keys: ManagedKeyRecord[] = [
      {
        id: "5524",
        apiKeyId: 5524,
        name: "codex++",
        status: "active",
        lastUsedAt: "2026-06-11T20:27:25.80647+08:00"
      },
      {
        id: "3641",
        apiKeyId: 3641,
        name: "codex",
        status: "active",
        lastUsedAt: "2026-06-13T00:38:44.766686+08:00"
      }
    ];

    expect(pickDefaultKeyUsageKeyId(keys)).toBe("3641");
  });

  it("normalizes unsupported usage page sizes back to the default", () => {
    expect(normalizeUsagePageSize(10)).toBe(10);
    expect(normalizeUsagePageSize(50)).toBe(50);
    expect(normalizeUsagePageSize(999)).toBe(20);
  });

  it("uses the complete applied filter and page size to isolate usage snapshots", () => {
    const base = {
      accountId: "account-a",
      surface: "usage" as const,
      pageSize: 20,
      filter: {
        startDate: "2026-06-24",
        endDate: "2026-06-28",
        apiKeyId: 3641,
        model: { value: "gpt-5.4", mode: "exact" as const },
        stream: true,
        inputTokens: { min: 100 },
        billingMode: { value: "token", mode: "exact" as const }
      }
    };
    const baseKey = buildUsageScopeKey(base);

    expect(buildUsageScopeKey({ ...base, accountId: "account-b" })).not.toBe(baseKey);
    expect(buildUsageScopeKey({ ...base, pageSize: 50 })).not.toBe(baseKey);
    expect(buildUsageScopeKey({
      ...base,
      filter: { ...base.filter, startDate: "2026-06-23" }
    })).not.toBe(baseKey);
    expect(buildUsageScopeKey({
      ...base,
      filter: { ...base.filter, model: { value: "gpt-5.5", mode: "exact" } }
    })).not.toBe(baseKey);
    expect(buildUsageScopeKey({
      ...base,
      filter: { ...base.filter, model: { value: "gpt-5.4", mode: "prefix" } }
    })).not.toBe(baseKey);
    expect(buildUsageScopeKey(base)).toBe(baseKey);
  });

  it("matches only usage cache keys owned by the deleted account", () => {
    const accountA = buildUsageScopeKey({ accountId: "account-a", surface: "usage" });
    const accountA2 = buildUsageScopeKey({ accountId: "account-a-2", surface: "usage" });

    expect(usageScopeReferencesAccount(accountA, "account-a")).toBe(true);
    expect(usageScopeReferencesAccount(accountA2, "account-a")).toBe(false);
    expect(usageScopeReferencesAccount("overview-realtime:{\"accountId\":\"account-a\"}", "account-a")).toBe(false);
    expect(usageScopeReferencesAccount("usage-workspace:not-json", "account-a")).toBe(false);
  });
});

describe("usage workspace scoped snapshots", () => {
  beforeEach(() => {
    hookHarness.reset();
    vi.clearAllMocks();
    usageClient.getUsageStats.mockResolvedValue({ totalRequests: 1 });
    usageClient.getUsageExtremes.mockResolvedValue({});
    usageClient.getDashboardTrend.mockResolvedValue(null);
    usageClient.getDashboardModels.mockResolvedValue(null);
    usageClient.getUsageAnalytics.mockResolvedValue(usageAnalyticsResult());
    usageClient.listUsageFacets.mockResolvedValue({ field: "model", items: [], hasMore: false });
    usageClient.listUsageRecords.mockResolvedValue(usageResult("default"));
    usageClient.getApiKeyDailyUsage.mockResolvedValue([]);
  });

  afterEach(() => {
    hookHarness.reset();
  });

  it("uses the complete aggregate filter identity while ignoring trends pagination", () => {
    const overview = buildUsageScopeKey({
      accountId: "account-a",
      surface: "overview",
      startDate: "2026-07-01",
      endDate: "2026-07-18",
      model: "ignored"
    });
    expect(buildUsageScopeKey({
      accountId: "account-a",
      surface: "overview",
      startDate: "2030-01-01",
      endDate: "2030-01-02",
      model: "also-ignored"
    })).toBe(overview);

    const modelStats = buildUsageScopeKey({
      accountId: "account-a",
      surface: "modelStats",
      filter: {
        startDate: "2026-07-01",
        endDate: "2026-07-18",
        apiKeyId: 42,
        model: { value: "gpt-5.4", mode: "exact" }
      }
    });
    expect(buildUsageScopeKey({
      accountId: "account-a",
      surface: "modelStats",
      filter: {
        startDate: "2026-07-01",
        endDate: "2026-07-18",
        apiKeyId: 42,
        model: { value: "gpt-5.5", mode: "exact" }
      }
    })).not.toBe(modelStats);
    expect(buildUsageScopeKey({
      accountId: "account-a",
      surface: "modelStats",
      filter: {
        startDate: "2026-07-01",
        endDate: "2026-07-18",
        apiKeyId: 43,
        model: { value: "gpt-5.4", mode: "exact" }
      }
    })).not.toBe(modelStats);

    const trends = buildUsageScopeKey({
      accountId: "account-a",
      surface: "trends",
      filter: {
        startDate: "2026-07-01",
        endDate: "2026-07-18",
        apiKeyId: 42
      },
      pageSize: 999
    });
    expect(buildUsageScopeKey({
      accountId: "account-a",
      surface: "trends",
      filter: {
        startDate: "2026-07-01",
        endDate: "2026-07-18",
        apiKeyId: 42
      },
      pageSize: 20
    })).toBe(trends);
    expect(buildUsageScopeKey({
      accountId: "account-a",
      surface: "trends",
      filter: {
        startDate: "2026-07-01",
        endDate: "2026-07-18",
        apiKeyId: 42,
        model: { value: "gpt-5.5", mode: "prefix" }
      }
    })).not.toBe(trends);
    expect(buildUsageScopeKey({
      accountId: "account-a",
      surface: "trends",
      filter: {
        startDate: "2026-07-01",
        endDate: "2026-07-18",
        apiKeyId: 42,
        billingMode: { value: "image", mode: "exact" }
      }
    })).not.toBe(trends);
  });

  it("forces a complete usage request from overview with the first cursor frame", async () => {
    const workspace = UsageWorkspaceHookHarness({ nav: "overview" });

    await workspace.refreshUsageSurfaceSilently("usage", {
      forceFullUsageSurface: true,
      mode: "background"
    });

    expect(usageClient.listUsageRecords).toHaveBeenCalledWith("account-a", expect.objectContaining({
      pageSize: 20,
      cursor: null,
      direction: "next",
      filter: expect.objectContaining({
        startDate: expect.any(String),
        endDate: expect.any(String)
      })
    }));
    expect(usageClient.getUsageStats).toHaveBeenCalledWith("account-a", expect.objectContaining({
      startDate: expect.any(String),
      endDate: expect.any(String)
    }));
  });

  it("preloads cold usage and model statistics surfaces once, then skips cached snapshots", async () => {
    const workspace = UsageWorkspaceHookHarness({ nav: "overview" });

    await expect(workspace.preloadUsageSurface("usage")).resolves.toBe("success");
    const usageRequestCounts = {
      stats: usageClient.getUsageStats.mock.calls.length,
      extremes: usageClient.getUsageExtremes.mock.calls.length,
      records: usageClient.listUsageRecords.mock.calls.length,
      trend: usageClient.getDashboardTrend.mock.calls.length,
      models: usageClient.getDashboardModels.mock.calls.length
    };

    await expect(workspace.preloadUsageSurface("usage")).resolves.toBe("success");
    expect(usageClient.getUsageStats).toHaveBeenCalledTimes(usageRequestCounts.stats);
    expect(usageClient.getUsageExtremes).toHaveBeenCalledTimes(usageRequestCounts.extremes);
    expect(usageClient.listUsageRecords).toHaveBeenCalledTimes(usageRequestCounts.records);
    expect(usageClient.getDashboardTrend).toHaveBeenCalledTimes(usageRequestCounts.trend);
    expect(usageClient.getDashboardModels).toHaveBeenCalledTimes(usageRequestCounts.models);

    await expect(workspace.preloadUsageSurface("modelStats")).resolves.toBe("success");
    const modelRequests = usageClient.getDashboardModels.mock.calls.length;
    expect(usageClient.getUsageStats).toHaveBeenCalledTimes(usageRequestCounts.stats);
    expect(usageClient.getUsageExtremes).toHaveBeenCalledTimes(usageRequestCounts.extremes);
    expect(usageClient.listUsageRecords).toHaveBeenCalledTimes(usageRequestCounts.records);
    expect(usageClient.getDashboardTrend).toHaveBeenCalledTimes(usageRequestCounts.trend);

    await expect(workspace.preloadUsageSurface("modelStats")).resolves.toBe("success");
    expect(usageClient.getDashboardModels).toHaveBeenCalledTimes(modelRequests);
  });

  it("loads the new model statistics scope when the API key filter changes", async () => {
    const managedKeys: ManagedKeyRecord[] = [{
      id: "key-3641",
      apiKeyId: 3641,
      name: "Key 3641",
      status: "active"
    }];
    usageClient.getDashboardModels.mockImplementation(async (_accountId: string, query: { apiKeyId?: number | null }) => ({
      startDate: "2026-07-18",
      endDate: "2026-07-18",
      models: [{ model: `api-${query.apiKeyId ?? "all"}`, requests: 1 }]
    }));

    UsageWorkspaceHookHarness({ nav: "modelStats", managedKeys });
    await flushPromises();
    let workspace = UsageWorkspaceHookHarness({ nav: "modelStats", managedKeys });
    expect(workspace.usageModels?.models[0]).toMatchObject({ model: "api-all" });

    usageClient.getDashboardModels.mockClear();
    workspace.setUsageApiKeyFilter("3641");
    workspace = UsageWorkspaceHookHarness({ nav: "modelStats", managedKeys });
    expect(workspace.presentation.hasSnapshot).toBe(false);

    await flushPromises();
    workspace = UsageWorkspaceHookHarness({ nav: "modelStats", managedKeys });
    expect(usageClient.getDashboardModels).toHaveBeenCalledWith("account-a", expect.objectContaining({
      apiKeyId: 3641
    }));
    expect(workspace.usageModels?.models[0]).toMatchObject({ model: "api-3641" });
  });

  it.each(["modelStats", "trends"] as const)(
    "cancels a late successful %s request from an older filter",
    async (surface) => {
      const deferredOldFilter = createDeferred<
        ReturnType<typeof usageAnalyticsResult> | {
          startDate: string;
          endDate: string;
          models: Array<{ model: string; requests: number }>;
        }
      >();
      if (surface === "modelStats") {
        usageClient.getDashboardModels.mockImplementation(async (_accountId: string, filter: { apiKeyId?: number }) => {
          if (filter.apiKeyId === 101) {
            return await deferredOldFilter.promise;
          }
          return {
            startDate: "2026-08-11",
            endDate: "2026-08-11",
            models: [{ model: `model-${filter.apiKeyId ?? "all"}`, requests: 1 }]
          };
        });
      } else {
        usageClient.getUsageAnalytics.mockImplementation(async (_accountId: string, filter: { apiKeyId?: number }) => {
          if (filter.apiKeyId === 101) {
            return await deferredOldFilter.promise;
          }
          return usageAnalyticsResult(`analytics-${filter.apiKeyId ?? "all"}`, filter.apiKeyId ?? 0);
        });
      }

      let workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
      workspace.setUsageApiKeyFilter("101");
      workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
      const pendingOldFilter = workspace.refreshUsageSurfaceSilently(surface, { mode: "background" });
      await flushPromises();

      workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
      workspace.setUsageApiKeyFilter("202");
      workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
      await expect(workspace.refreshUsageSurfaceSilently(surface, { mode: "background" })).resolves.toBe("success");

      if (surface === "modelStats") {
        deferredOldFilter.resolve({
          startDate: "2026-08-11",
          endDate: "2026-08-11",
          models: [{ model: "model-101", requests: 1 }]
        });
      } else {
        deferredOldFilter.resolve(usageAnalyticsResult("analytics-101", 101));
      }
      await expect(pendingOldFilter).resolves.toBe("cancelled");

      workspace = UsageWorkspaceHookHarness({ nav: surface });
      expect(workspace.presentation).toMatchObject({
        hasSnapshot: true,
        refreshing: false,
        lastError: null
      });
      if (surface === "modelStats") {
        expect(workspace.usageModels?.models[0]).toMatchObject({ model: "model-202" });
      } else {
        expect(workspace.usageAnalytics?.sampleRows[0]).toMatchObject({ id: "analytics-202" });
      }
    }
  );

  it.each(["modelStats", "trends"] as const)(
    "cancels a late failed %s request without polluting the current filter",
    async (surface) => {
      const deferredOldFilter = createDeferred<never>();
      if (surface === "modelStats") {
        usageClient.getDashboardModels.mockImplementation(async (_accountId: string, filter: { apiKeyId?: number }) => {
          if (filter.apiKeyId === 101) {
            return await deferredOldFilter.promise;
          }
          return {
            startDate: "2026-08-11",
            endDate: "2026-08-11",
            models: [{ model: `model-${filter.apiKeyId ?? "all"}`, requests: 1 }]
          };
        });
      } else {
        usageClient.getUsageAnalytics.mockImplementation(async (_accountId: string, filter: { apiKeyId?: number }) => {
          if (filter.apiKeyId === 101) {
            return await deferredOldFilter.promise;
          }
          return usageAnalyticsResult(`analytics-${filter.apiKeyId ?? "all"}`, filter.apiKeyId ?? 0);
        });
      }

      let workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
      workspace.setUsageApiKeyFilter("101");
      workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
      const pendingOldFilter = workspace.refreshUsageSurfaceSilently(surface, { mode: "foreground" });
      await flushPromises();

      workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
      workspace.setUsageApiKeyFilter("202");
      workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
      await expect(workspace.refreshUsageSurfaceSilently(surface, { mode: "foreground" })).resolves.toBe("success");

      deferredOldFilter.reject(new Error(`stale ${surface} failed`));
      await expect(pendingOldFilter).resolves.toBe("cancelled");

      workspace = UsageWorkspaceHookHarness({ nav: surface });
      expect(workspace.presentation).toMatchObject({
        hasSnapshot: true,
        refreshing: false,
        lastError: null
      });
      if (surface === "modelStats") {
        expect(workspace.usageModels?.models[0]).toMatchObject({ model: "model-202" });
      } else {
        expect(workspace.usageAnalytics?.sampleRows[0]).toMatchObject({ id: "analytics-202" });
      }
    }
  );

  it("keeps model statistics and trends requests independent", async () => {
    const deferredModels = createDeferred<{
      startDate: string;
      endDate: string;
      models: Array<{ model: string; requests: number }>;
    }>();
    const deferredTrends = createDeferred<UsageAnalyticsPayload>();
    usageClient.getDashboardModels.mockImplementation(async () => await deferredModels.promise);
    usageClient.getUsageAnalytics.mockImplementation(async () => await deferredTrends.promise);

    const workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    const pendingModels = workspace.refreshUsageSurfaceSilently("modelStats", { mode: "background" });
    const pendingTrends = workspace.refreshUsageSurfaceSilently("trends", { mode: "background" });
    await flushPromises();

    deferredTrends.resolve(usageAnalyticsResult("independent-trends"));
    deferredModels.resolve({
      startDate: "2026-08-11",
      endDate: "2026-08-11",
      models: [{ model: "independent-model", requests: 1 }]
    });

    await expect(pendingModels).resolves.toBe("success");
    await expect(pendingTrends).resolves.toBe("success");
  });

  it("navigates cursor history, reads only records, and clears history on page-size changes", async () => {
    usageClient.listUsageRecords.mockImplementation(async (_accountId: string, request: {
      cursor?: string | null;
      direction: "next" | "previous";
      pageSize: number;
    }) => {
      if (request.pageSize === 50) {
        return usageResult("size-50-first", 50, {
          nextCursor: "next-size-50",
          hasNext: true
        });
      }
      if (request.cursor === "next-1" && request.direction === "next") {
        return usageResult("cursor-page-2", 20, {
          previousCursor: "previous-2",
          hasPrevious: true
        });
      }
      return usageResult("cursor-page-1", 20, {
        nextCursor: "next-1",
        hasNext: true
      });
    });
    let workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    await workspace.refreshUsageSurfaceSilently("usage", { mode: "background" });
    workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    expect(workspace.usageRecords?.items[0]).toMatchObject({ id: "cursor-page-1" });
    expect(workspace.usageCursorDepth).toBe(0);
    const aggregateCallCounts = {
      stats: usageClient.getUsageStats.mock.calls.length,
      extremes: usageClient.getUsageExtremes.mock.calls.length,
      trend: usageClient.getDashboardTrend.mock.calls.length,
      models: usageClient.getDashboardModels.mock.calls.length
    };

    await workspace.handleUsageNextPage();
    workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    expect(workspace.usageRecords?.items[0]).toMatchObject({ id: "cursor-page-2" });
    expect(workspace.usageCursorDepth).toBe(1);
    expect(usageClient.getUsageStats).toHaveBeenCalledTimes(aggregateCallCounts.stats);
    expect(usageClient.getUsageExtremes).toHaveBeenCalledTimes(aggregateCallCounts.extremes);
    expect(usageClient.getDashboardTrend).toHaveBeenCalledTimes(aggregateCallCounts.trend);
    expect(usageClient.getDashboardModels).toHaveBeenCalledTimes(aggregateCallCounts.models);

    await workspace.handleUsagePreviousPage();
    workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    expect(workspace.usageRecords?.items[0]).toMatchObject({ id: "cursor-page-1" });
    expect(workspace.usageCursorDepth).toBe(0);

    await workspace.handleUsagePageSizeChange(50);
    workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    expect(workspace.usageRecords?.items[0]).toMatchObject({ id: "size-50-first" });
    expect(workspace.usageCursorDepth).toBe(0);
    expect(usageClient.listUsageRecords).toHaveBeenLastCalledWith("account-a", expect.objectContaining({
      pageSize: 50,
      cursor: null,
      direction: "next"
    }));
  });

  it("ignores a late result from an older filter on the same account", async () => {
    const deferredOldFilter = createDeferred<ReturnType<typeof usageResult>>();
    usageClient.listUsageRecords.mockImplementation(async (_accountId: string, request: {
      filter: { model?: { value: string } };
    }) => {
      const model = request.filter.model?.value;
      if (model === "model-old") {
        return await deferredOldFilter.promise;
      }
      if (model === "model-current") {
        return usageResult("current-filter", 20, {
          nextCursor: "current-next",
          hasNext: true
        });
      }
      return usageResult("default-filter");
    });

    let workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    workspace.setUsageFilterDraft({
      ...workspace.usageFilterDraft,
      model: { value: "model-old", mode: "exact" }
    });
    workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    const pendingOldFilter = workspace.handleUsageSearch();
    await flushPromises();

    workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    workspace.setUsageFilterDraft({
      ...workspace.usageFilterDraft,
      model: { value: "model-current", mode: "prefix" }
    });
    workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    await workspace.handleUsageSearch();

    deferredOldFilter.resolve(usageResult("late-old-filter"));
    await pendingOldFilter;

    workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    expect(workspace.usageAppliedFilter.model).toEqual({
      value: "model-current",
      mode: "prefix"
    });
    expect(workspace.usageRecords?.items[0]).toMatchObject({ id: "current-filter" });
    expect(workspace.usageCursorDepth).toBe(0);
    expect(workspace.presentation.lastError).toBeNull();
  });

  it("ignores a late cursor failure after the same filter is requeried", async () => {
    const deferredOldCursor = createDeferred<ReturnType<typeof usageResult>>();
    let firstPageRequestCount = 0;
    usageClient.listUsageRecords.mockImplementation(async (_accountId: string, request: {
      cursor?: string | null;
      direction: "next" | "previous";
    }) => {
      if (request.cursor === "next-stale" && request.direction === "next") {
        return await deferredOldCursor.promise;
      }
      firstPageRequestCount += 1;
      return usageResult(
        firstPageRequestCount === 1 ? "initial-first-page" : "refreshed-first-page",
        20,
        {
          nextCursor: "next-stale",
          hasNext: true
        }
      );
    });

    let workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    await workspace.refreshUsageSurfaceSilently("usage", { mode: "background" });
    workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    expect(workspace.usageRecords?.items[0]).toMatchObject({ id: "initial-first-page" });

    const pendingOldCursor = workspace.handleUsageNextPage();
    await flushPromises();
    workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    await workspace.handleUsageSearch();

    deferredOldCursor.reject(new Error("stale cursor failed"));
    await pendingOldCursor;

    workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    expect(workspace.usageRecords?.items[0]).toMatchObject({ id: "refreshed-first-page" });
    expect(workspace.usageCursorDepth).toBe(0);
    expect(workspace.presentation.lastError).toBeNull();
  });

  it("keeps draft filters separate, applies the complete filter atomically, and loads range-wide facets", async () => {
    usageClient.listUsageRecords.mockImplementation(async (_accountId: string, request: {
      filter: {
        model?: { value: string; mode: string };
        stream?: boolean;
        inputTokens?: { min?: number; max?: number };
        userAgentQuery?: string | null;
      };
      pageSize: number;
    }) => usageResult(
      `${request.filter.model?.value ?? "all"}-${String(request.filter.stream)}-${request.filter.inputTokens?.min ?? "none"}-${request.filter.userAgentQuery ?? "none"}`,
      request.pageSize
    ));
    usageClient.listUsageFacets.mockResolvedValue({
      field: "model",
      items: [{ value: "historical-model", label: "historical-model", count: 41 }],
      hasMore: false
    });
    let workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    await workspace.refreshUsageSurfaceSilently("usage", { mode: "background" });
    workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    expect(workspace.usageRecords?.items[0]).toMatchObject({ id: "all-undefined-none-none" });
    const originalScopeKey = workspace.presentation.scopeKey;
    const callsBeforeDraftEdit = usageClient.listUsageRecords.mock.calls.length;

    workspace.setUsageFilterDraft({
      ...workspace.usageFilterDraft,
      apiKeyId: "3641",
      model: { value: "model-a", mode: "prefix" },
      stream: "false",
      inputTokens: { min: "100", max: "1000" },
      userAgentQuery: "Codex"
    });
    workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    expect(workspace.presentation.scopeKey).toBe(originalScopeKey);
    expect(workspace.usageRecords?.items[0]).toMatchObject({ id: "all-undefined-none-none" });
    expect(usageClient.listUsageRecords).toHaveBeenCalledTimes(callsBeforeDraftEdit);

    await workspace.handleUsageSearch();
    workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    expect(workspace.usageRecords?.items[0]).toMatchObject({ id: "model-a-false-100-Codex" });
    expect(workspace.usageCursorDepth).toBe(0);
    expect(usageClient.listUsageRecords).toHaveBeenLastCalledWith("account-a", {
      filter: expect.objectContaining({
        apiKeyId: 3641,
        model: { value: "model-a", mode: "prefix" },
        stream: false,
        inputTokens: { min: 100, max: 1000 },
        userAgentQuery: "Codex"
      }),
      pageSize: 20,
      cursor: null,
      direction: "next"
    });

    await expect(workspace.loadUsageFacet("model")).resolves.toMatchObject({
      field: "model",
      items: [{ value: "historical-model", count: 41 }]
    });
    workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    expect(workspace.usageFacetPages.model?.items[0]).toMatchObject({ value: "historical-model" });
    expect(usageClient.listUsageFacets).toHaveBeenCalledWith("account-a", expect.objectContaining({
      field: "model",
      filter: expect.objectContaining({
        model: { value: "model-a", mode: "prefix" },
        stream: false
      }),
      limit: 50
    }));
  });

  it("never presents account A while account B is selected and ignores late A completion", async () => {
    const deferredA = createDeferred<ReturnType<typeof usageResult>>();
    usageClient.listUsageRecords.mockImplementation((accountId: string) => (
      accountId === "account-a" ? deferredA.promise : Promise.resolve(usageResult("account-b"))
    ));
    const accountA = UsageWorkspaceHookHarness({ nav: "alerts", selectedAccountId: "account-a" });
    const pendingA = accountA.refreshUsageSurfaceSilently("usage", { mode: "background" });
    await flushPromises();

    let accountB = UsageWorkspaceHookHarness({ nav: "alerts", selectedAccountId: "account-b" });
    expect(accountB.usageRecords).toBeNull();
    const pendingB = accountB.refreshUsageSurfaceSilently("usage", { mode: "background" });
    await pendingB;
    accountB = UsageWorkspaceHookHarness({ nav: "alerts", selectedAccountId: "account-b" });
    expect(accountB.usageRecords?.items[0]).toMatchObject({ id: "account-b" });

    deferredA.resolve(usageResult("late-account-a"));
    await expect(pendingA).resolves.toBe("cancelled");
    accountB = UsageWorkspaceHookHarness({ nav: "alerts", selectedAccountId: "account-b" });
    expect(accountB.usageRecords?.items[0]).toMatchObject({ id: "account-b" });
  });

  it("invalidates deleted-account usage scopes so a late response cannot restore them", async () => {
    const deferred = createDeferred<ReturnType<typeof usageResult>>();
    usageClient.listUsageRecords.mockReturnValue(deferred.promise);
    let workspace = UsageWorkspaceHookHarness({ nav: "alerts", selectedAccountId: "account-a" });
    const pending = workspace.refreshUsageSurfaceSilently("usage", { mode: "background" });
    await flushPromises();

    workspace.invalidateAccount("account-a");
    deferred.resolve(usageResult("late-account-a"));

    await expect(pending).resolves.toBe("cancelled");
    workspace = UsageWorkspaceHookHarness({ nav: "alerts", selectedAccountId: "account-a" });
    expect(workspace.usageRecords).toBeNull();
  });

  it("restores snapshots by surface without exposing the previous surface", async () => {
    usageClient.getDashboardModels.mockResolvedValue({
      startDate: "2026-07-18",
      endDate: "2026-07-18",
      models: [{ model: "model-scope", requests: 1 }]
    });
    let usage = UsageWorkspaceHookHarness({ nav: "alerts" });
    await usage.refreshUsageSurfaceSilently("usage", { mode: "background" });
    usage = UsageWorkspaceHookHarness({ nav: "alerts" });
    expect(usage.usageRecords).not.toBeNull();

    let models = UsageWorkspaceHookHarness({ nav: "modelStats" });
    expect(models.usageRecords).toBeNull();
    await models.refreshUsageSurfaceSilently("modelStats", { mode: "background" });
    models = UsageWorkspaceHookHarness({ nav: "modelStats" });
    expect(models.usageModels?.models[0]).toMatchObject({ model: "model-scope" });

    usage = UsageWorkspaceHookHarness({ nav: "alerts" });
    expect(usage.usageRecords?.items[0]).toMatchObject({ id: "default" });
  });

  it("loads one bounded analytics payload without usage pagination", async () => {
    const analytics = usageAnalyticsResult("bounded-sample", 525);
    analytics.sampleRows = Array.from(
      { length: 20 },
      (_, index) => ({ id: `sample-${index}` }) as UsageAnalyticsPayload["sampleRows"][number]
    );
    usageClient.getUsageAnalytics.mockResolvedValue(analytics);

    const workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    await workspace.refreshUsageSurfaceSilently("trends", { mode: "background" });
    const trends = UsageWorkspaceHookHarness({ nav: "trends" });

    expect(trends.presentation.scopeKey).toContain('"surface":"trends"');
    expect(trends.usageAnalytics?.matchedRows).toBe(525);
    expect(trends.usageAnalytics?.sampleRows).toHaveLength(20);
    expect(trends.usageRecords).toBeNull();
    expect(usageClient.getUsageAnalytics).toHaveBeenCalledTimes(1);
    expect(usageClient.getUsageAnalytics).toHaveBeenCalledWith("account-a", expect.objectContaining({
      startDate: expect.any(String),
      endDate: expect.any(String)
    }));
    expect(usageClient.listUsageRecords).not.toHaveBeenCalled();
    expect(usageClient.getUsageStats).not.toHaveBeenCalled();
    expect(usageClient.getDashboardTrend).not.toHaveBeenCalled();
    expect(usageClient.getDashboardModels).not.toHaveBeenCalled();
  });

  it("retains the last bounded analytics snapshot when a background refresh fails", async () => {
    usageClient.getUsageAnalytics.mockResolvedValue(usageAnalyticsResult("scope-success"));
    const workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    await workspace.refreshUsageSurfaceSilently("trends", { mode: "background" });
    UsageWorkspaceHookHarness({ nav: "trends" });
    await flushPromises();
    let trends = UsageWorkspaceHookHarness({ nav: "trends" });

    usageClient.getUsageAnalytics.mockRejectedValueOnce(new Error("analytics scope offline"));
    const failedRefresh = trends.refreshUsageWorkspaceSilently({ mode: "background" });
    trends = UsageWorkspaceHookHarness({ nav: "trends" });
    expect(trends.usageAnalytics?.sampleRows).toEqual([{ id: "scope-success" }]);

    await expect(failedRefresh).rejects.toThrow("analytics scope offline");
    trends = UsageWorkspaceHookHarness({ nav: "trends" });
    expect(trends.usageAnalytics?.sampleRows).toEqual([{ id: "scope-success" }]);
    expect(trends.presentation).toMatchObject({
      hasSnapshot: true,
      refreshing: false,
      lastError: "analytics scope offline"
    });
  });

  it("stores an explicit empty bounded analytics payload", async () => {
    usageClient.getUsageAnalytics.mockResolvedValue(usageAnalyticsResult("empty", 0));
    const workspace = UsageWorkspaceHookHarness({ nav: "alerts" });
    await workspace.refreshUsageSurfaceSilently("trends", { mode: "background" });
    const trends = UsageWorkspaceHookHarness({ nav: "trends" });

    expect(trends.usageAnalytics).toMatchObject({ matchedRows: 0, sampleRows: [] });
    expect(trends.usageRecords).toBeNull();
    expect(usageClient.listUsageRecords).not.toHaveBeenCalled();
  });

  it("invalidates current presentation when account selection becomes null", async () => {
    let workspace = UsageWorkspaceHookHarness({ nav: "alerts", selectedAccountId: "account-a" });
    await workspace.refreshUsageSurfaceSilently("usage", { mode: "background" });

    workspace = UsageWorkspaceHookHarness({ nav: "alerts", selectedAccountId: null });
    expect(workspace.usageRecords).toBeNull();
    expect(workspace.presentation).toMatchObject({
      scopeKey: null,
      hasSnapshot: false,
      initialLoading: false,
      refreshing: false,
      lastError: null,
      updatedAt: null
    });
  });

  it("retains the current usage snapshot through a failed refresh and replaces it after manual retry", async () => {
    usageClient.getUsageStats.mockResolvedValue({ totalRequests: 1 });
    usageClient.listUsageRecords.mockResolvedValue(usageResult("last-success"));
    let workspace = UsageWorkspaceHookHarness({ nav: "alerts", selectedAccountId: "account-a" });

    await expect(
      workspace.refreshUsageSurfaceSilently("usage", { mode: "background" })
    ).resolves.toBe("success");
    workspace = UsageWorkspaceHookHarness({ nav: "alerts", selectedAccountId: "account-a" });
    expect(workspace.usageRecords?.items[0]).toMatchObject({ id: "last-success" });
    expect(workspace.usageStats).toMatchObject({ totalRequests: 1 });
    expect(workspace.presentation).toMatchObject({
      hasSnapshot: true,
      refreshing: false,
      lastError: null
    });

    usageClient.listUsageRecords.mockRejectedValueOnce(new Error("usage refresh offline"));
    const failedRefresh = workspace.refreshUsageSurfaceSilently("usage", { mode: "background" });
    workspace = UsageWorkspaceHookHarness({ nav: "alerts", selectedAccountId: "account-a" });
    expect(workspace.usageRecords?.items[0]).toMatchObject({ id: "last-success" });
    expect(workspace.usageStats).toMatchObject({ totalRequests: 1 });
    expect(workspace.presentation).toMatchObject({
      hasSnapshot: true,
      refreshing: true,
      lastError: null
    });
    expect(workspace.usageModelSummariesInitialLoading).toBe(false);

    await expect(failedRefresh).rejects.toThrow("usage refresh offline");
    workspace = UsageWorkspaceHookHarness({ nav: "alerts", selectedAccountId: "account-a" });
    expect(workspace.usageRecords?.items[0]).toMatchObject({ id: "last-success" });
    expect(workspace.usageStats).toMatchObject({ totalRequests: 1 });
    expect(workspace.presentation).toMatchObject({
      hasSnapshot: true,
      initialLoading: false,
      refreshing: false,
      lastError: "usage refresh offline"
    });

    usageClient.getUsageStats.mockResolvedValue({ totalRequests: 2 });
    usageClient.listUsageRecords.mockResolvedValue(usageResult("manual-retry"));
    await expect(
      workspace.refreshUsageSurfaceSilently("usage", { mode: "foreground" })
    ).resolves.toBe("success");
    workspace = UsageWorkspaceHookHarness({ nav: "alerts", selectedAccountId: "account-a" });
    expect(workspace.usageRecords?.items[0]).toMatchObject({ id: "manual-retry" });
    expect(workspace.usageStats).toMatchObject({ totalRequests: 2 });
    expect(workspace.presentation).toMatchObject({
      hasSnapshot: true,
      refreshing: false,
      lastError: null,
      updatedAt: expect.any(Number)
    });
  });

  it("loads selected key daily usage for data analysis", async () => {
    const key: ManagedKeyRecord = { id: "key-1", apiKeyId: 1, name: "Key 1", status: "active" };
    usageClient.getApiKeyDailyUsage.mockResolvedValue([{ date: "2026-07-18", requests: 1 }]);
    UsageWorkspaceHookHarness({ nav: "trends", managedKeys: [key] });
    await flushPromises();
    UsageWorkspaceHookHarness({ nav: "trends", managedKeys: [key] });
    await flushPromises();
    const workspace = UsageWorkspaceHookHarness({ nav: "trends", managedKeys: [key] });
    expect(workspace.keyUsageRows).toEqual([{ date: "2026-07-18", requests: 1 }]);
    expect(usageClient.getApiKeyDailyUsage).toHaveBeenCalledWith("account-a", "key-1", 30);
  });
});
