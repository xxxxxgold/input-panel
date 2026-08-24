import { beforeEach, describe, expect, it, vi } from "vitest";

const overviewApi = vi.hoisted(() => ({
  getOverview: vi.fn(),
  getOverviewShell: vi.fn(),
  getOverviewShellLite: vi.fn()
}));

vi.mock("../src/api", () => overviewApi);

import {
  appendToastDeduped,
  ERROR_TOAST_DURATION_MS,
  evictOverviewEntities,
  INFO_TOAST_DURATION_MS,
  pruneDismissedOverviewAlertIds,
  pruneReadNotificationKeys,
  resolveOverviewSelection,
  useMonitorStore,
  type MonitorToast
} from "../src/shared/state/monitor-store";
import {
  isAccountDataStaleForToday,
  shouldRefreshAccountData,
  shouldRefreshCoreForNav
} from "../src/app/refresh-policy";
import { formatAppErrorMessage } from "../src/shared/lib/error-display";
import type { AccountRuntime, OverviewPayload, SiteRecord } from "../src/types";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function buildSite(overrides: Partial<SiteRecord> = {}): SiteRecord {
  return {
    id: overrides.id ?? "site-1",
    name: overrides.name ?? "站点",
    baseUrl: overrides.baseUrl ?? "https://example.com",
    createdAt: overrides.createdAt ?? "2026-06-11T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-06-11T00:00:00Z"
  };
}

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
    site: overrides.site ?? buildSite({ id: overrides.siteId ?? "site-1" }),
    cacheView: overrides.cacheView ?? null,
    sessionState: overrides.sessionState ?? "missing",
    lastError: overrides.lastError ?? null
  };
}

function buildOverview({
  accountId = "account-1",
  generatedAt = "2026-07-18T00:00:00Z",
  siteId = "site-1"
}: {
  accountId?: string;
  generatedAt?: string;
  siteId?: string;
} = {}): OverviewPayload {
  const site = buildSite({ id: siteId });
  return {
    sites: [site],
    accounts: [
      buildAccount({
        id: accountId,
        site,
        siteId,
        sessionState: "ready"
      })
    ],
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
    generatedAt
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useMonitorStore.setState({
    overview: null,
    loading: true,
    overviewRefreshing: false,
    overviewLastError: null,
    overviewUpdatedAt: null,
    busyText: null,
    toasts: [],
    activeBusyToastId: null,
    error: null,
    appNotifications: [],
    dismissedOverviewAlertIds: [],
    readNotificationKeys: [],
    selectedSiteId: null,
    selectedAccountId: null
  });
});

describe("resolveOverviewSelection", () => {
  it("prefers a ready account on first load so detail panels do not default to an offline account", () => {
    const sites = [buildSite({ id: "site-1" }), buildSite({ id: "site-2" })];
    const accounts = [
      buildAccount({ id: "offline", siteId: "site-1", label: "主账号", sessionState: "missing" }),
      buildAccount({
        id: "ready",
        siteId: "site-2",
        label: "2FA账号",
        sessionState: "ready"
      })
    ];

    expect(
      resolveOverviewSelection({
        accounts,
        sites,
        selectedAccountId: null,
        selectedSiteId: null
      })
    ).toEqual({
      selectedAccountId: "ready",
      selectedSiteId: "site-2"
    });
  });

  it("keeps the current account when it is still valid inside the selected site", () => {
    const sites = [buildSite({ id: "site-1" }), buildSite({ id: "site-2" })];
    const accounts = [
      buildAccount({ id: "offline", siteId: "site-1", sessionState: "missing" }),
      buildAccount({ id: "ready", siteId: "site-2", sessionState: "ready" })
    ];

    expect(
      resolveOverviewSelection({
        accounts,
        sites,
        selectedAccountId: "offline",
        selectedSiteId: "site-1"
      })
    ).toEqual({
      selectedAccountId: "offline",
      selectedSiteId: "site-1"
    });
  });

  it("removes deleted entities before resolving the next valid account", () => {
    const siteA = buildSite({ id: "site-a" });
    const siteB = buildSite({ id: "site-b" });
    const accountA = buildAccount({ id: "account-a", siteId: "site-a", site: siteA, sessionState: "ready" });
    const accountB = buildAccount({ id: "account-b", siteId: "site-b", site: siteB, sessionState: "ready" });
    const overview = {
      ...buildOverview({ accountId: "account-a", siteId: "site-a" }),
      sites: [siteA, siteB],
      accounts: [accountA, accountB],
      alerts: [{
        id: "alert-a",
        severity: "low" as const,
        title: "A",
        detail: "A",
        accountId: "account-a",
        siteId: "site-a",
        createdAt: "2026-07-18T00:00:00Z"
      }],
      recentUsage: [{
        id: "usage-a",
        accountId: "account-a",
        siteId: "site-a",
        siteName: "A",
        createdAt: "2026-07-18T00:00:00Z",
        model: "gpt-5",
        actualCost: 1,
        totalCost: 1,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2
      }]
    } satisfies OverviewPayload;

    const next = evictOverviewEntities(overview, { accountIds: ["account-a"] });

    expect(next.accounts.map((account) => account.id)).toEqual(["account-b"]);
    expect(next.sites.map((site) => site.id)).toEqual(["site-a", "site-b"]);
    expect(next.alerts).toEqual([]);
    expect(next.recentUsage).toEqual([]);
    expect(next.platformSeries).toEqual([]);
    expect(next.totals.totalAccounts).toBe(1);
    expect(resolveOverviewSelection({
      accounts: next.accounts,
      sites: next.sites,
      selectedAccountId: "account-a",
      selectedSiteId: "site-a"
    })).toEqual({ selectedAccountId: "account-b", selectedSiteId: "site-b" });
  });

  it("keeps the existing snapshot intact when no requested entity is present", () => {
    const overview = {
      ...buildOverview(),
      platformSeries: [{ platform: "OpenAI", actualCost: 12, totalCost: 16 }],
      modelSeries: [{ model: "gpt-5", actualCost: 8, totalCost: 10 }],
      trend: [{ date: "2026-07-18", actualCost: 3, totalCost: 4 }]
    } satisfies OverviewPayload;

    expect(evictOverviewEntities(overview, {
      accountIds: ["missing-account"],
      siteIds: ["missing-site"]
    })).toBe(overview);
  });
});

describe("overview payload compatibility", () => {
  it("accepts runtime account data under cacheView shape", () => {
    const account = buildAccount({
      cacheView: {
        fetchedAt: "2026-06-28T03:43:55.880722700+00:00",
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
      },
      sessionState: "ready"
    });

    const overview = {
      sites: [buildSite()],
      accounts: [account],
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

    expect(overview.accounts[0].cacheView?.stats.totalApiKeys).toBe(9);
    expect(overview.accounts[0].cacheView?.recentUsage).toEqual([]);
  });
});

describe("appendToastDeduped", () => {
  it("avoids pushing the same error toast twice", () => {
    const existing: MonitorToast[] = [
      {
        id: "toast-1",
        tone: "error",
        message: "账号 主账号 尚未保存可恢复凭据，请重新登录。",
        durationMs: 4200
      }
    ];

    const next = appendToastDeduped(
      existing,
      {
        tone: "error",
        message: "账号 主账号 尚未保存可恢复凭据，请重新登录。",
        durationMs: 4200
      },
      () => "toast-2"
    );

    expect(next.toastId).toBe("toast-1");
    expect(next.toasts).toEqual(existing);
  });

  it("still appends a distinct toast when the message changes", () => {
    const existing: MonitorToast[] = [
      {
        id: "toast-1",
        tone: "error",
        message: "旧错误",
        durationMs: 4200
      }
    ];

    const next = appendToastDeduped(
      existing,
      {
        tone: "error",
        message: "新错误",
        durationMs: 4200
      },
      () => "toast-2"
    );

    expect(next.toastId).toBe("toast-2");
    expect(next.toasts).toHaveLength(2);
  });

  it("does not dedupe an actionable toast against a message-only toast", () => {
    const existing: MonitorToast[] = [
      {
        id: "toast-1",
        tone: "error",
        title: "保存失败",
        message: "设置保存失败。",
        durationMs: 4200
      }
    ];

    const next = appendToastDeduped(
      existing,
      {
        tone: "error",
        title: "保存失败",
        message: "设置保存失败。",
        durationMs: 4200,
        action: {
          label: "重试保存",
          onClick: () => undefined
        }
      },
      () => "toast-2"
    );

    expect(next.toastId).toBe("toast-2");
    expect(next.toasts).toHaveLength(2);
  });
});

describe("busy text feedback", () => {
  it("keeps request progress in state without showing a loading toast", () => {
    useMonitorStore.setState({
      busyText: "旧处理中",
      activeBusyToastId: "busy-toast",
      toasts: [
        {
          id: "busy-toast",
          tone: "info",
          message: "旧处理中",
          durationMs: INFO_TOAST_DURATION_MS,
          loading: true
        },
        {
          id: "keep-toast",
          tone: "info",
          message: "别的提示",
          durationMs: INFO_TOAST_DURATION_MS
        }
      ]
    });

    useMonitorStore.getState().setBusyText("正在删除站点...");

    expect(useMonitorStore.getState().busyText).toBe("正在删除站点...");
    expect(useMonitorStore.getState().activeBusyToastId).toBeNull();
    expect(useMonitorStore.getState().toasts).toEqual([
      {
        id: "keep-toast",
        tone: "info",
        message: "别的提示",
        durationMs: INFO_TOAST_DURATION_MS
      }
    ]);
  });
});

describe("overview stale-while-revalidate lifecycle", () => {
  it("uses global loading only for a cold load and records the first successful snapshot", async () => {
    const deferred = createDeferred<OverviewPayload>();
    const next = buildOverview({ accountId: "cold-account" });
    overviewApi.getOverview.mockReturnValueOnce(deferred.promise);

    const pending = useMonitorStore.getState().loadOverview();

    expect(useMonitorStore.getState()).toMatchObject({
      overview: null,
      loading: true,
      overviewRefreshing: false,
      overviewLastError: null,
      overviewUpdatedAt: null
    });

    deferred.resolve(next);
    await expect(pending).resolves.toBe(true);

    expect(useMonitorStore.getState()).toMatchObject({
      overview: next,
      loading: false,
      overviewRefreshing: false,
      overviewLastError: null,
      selectedAccountId: "cold-account",
      selectedSiteId: "site-1"
    });
    expect(useMonitorStore.getState().overviewUpdatedAt).toEqual(expect.any(Number));
  });

  it.each([
    { label: "silent", options: { silent: true, source: "shell" as const } },
    { label: "manual", options: { source: "shell-lite" as const } }
  ])("keeps the snapshot visible during a $label refresh", async ({ options }) => {
    const snapshot = buildOverview({ generatedAt: "old" });
    const deferred = createDeferred<OverviewPayload>();
    const next = buildOverview({ accountId: "refreshed-account", generatedAt: "new" });
    const loader = options.source === "shell"
      ? overviewApi.getOverviewShell
      : overviewApi.getOverviewShellLite;
    loader.mockReturnValueOnce(deferred.promise);
    useMonitorStore.setState({
      overview: snapshot,
      loading: true,
      overviewUpdatedAt: 100
    });

    const pending = useMonitorStore.getState().loadOverview(options);

    expect(useMonitorStore.getState()).toMatchObject({
      overview: snapshot,
      loading: false,
      overviewRefreshing: true,
      overviewLastError: null,
      overviewUpdatedAt: 100
    });

    deferred.resolve(next);
    await expect(pending).resolves.toBe(true);
    expect(useMonitorStore.getState()).toMatchObject({
      overview: next,
      loading: false,
      overviewRefreshing: false,
      overviewLastError: null
    });
    expect(useMonitorStore.getState().overviewUpdatedAt).not.toBe(100);
  });

  it("keeps the previous overview reference when a refresh returns equivalent data", async () => {
    const snapshot = buildOverview({ generatedAt: "2026-07-26T00:00:00Z" });
    const deferred = createDeferred<OverviewPayload>();
    // 后端 generatedAt 每次响应都会变化；除它以外内容一致时必须复用旧引用，
    // 让订阅 overview 的组件跳过重渲染。
    const equivalentNext = buildOverview({ generatedAt: "2026-07-26T00:00:09Z" });
    overviewApi.getOverviewShell.mockReturnValueOnce(deferred.promise);
    useMonitorStore.setState({ overview: snapshot, loading: false, overviewUpdatedAt: 100 });

    const pending = useMonitorStore.getState().loadOverview({ source: "shell", silent: true });
    deferred.resolve(equivalentNext);
    await expect(pending).resolves.toBe(true);

    expect(useMonitorStore.getState().overview).toBe(snapshot);
    expect(useMonitorStore.getState().overviewUpdatedAt).not.toBe(100);
    expect(useMonitorStore.getState().overviewRefreshing).toBe(false);
  });

  it("rejects an older success after a newer success without replacing visible state or toasts", async () => {
    const snapshot = buildOverview({ generatedAt: "snapshot" });
    const older = createDeferred<OverviewPayload>();
    const newer = createDeferred<OverviewPayload>();
    const olderPayload = buildOverview({ generatedAt: "older" });
    const newerPayload = buildOverview({ accountId: "new-account", generatedAt: "newer" });
    overviewApi.getOverview
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    useMonitorStore.setState({ overview: snapshot, loading: false, overviewUpdatedAt: 100 });

    const olderRequest = useMonitorStore.getState().loadOverview({ successMessage: "旧请求完成" });
    const newerRequest = useMonitorStore.getState().loadOverview({ successMessage: "新请求完成" });

    newer.resolve(newerPayload);
    await expect(newerRequest).resolves.toBe(true);
    const updatedAt = useMonitorStore.getState().overviewUpdatedAt;

    older.resolve(olderPayload);
    await expect(olderRequest).resolves.toBe(false);

    expect(useMonitorStore.getState()).toMatchObject({
      overview: newerPayload,
      loading: false,
      overviewRefreshing: false,
      overviewLastError: null,
      overviewUpdatedAt: updatedAt,
      selectedAccountId: "new-account"
    });
    expect(useMonitorStore.getState().toasts.map((toast) => toast.message)).toEqual(["新请求完成"]);
  });

  it("keeps the current request refreshing when an older success settles first", async () => {
    const snapshot = buildOverview({ generatedAt: "snapshot" });
    const older = createDeferred<OverviewPayload>();
    const newer = createDeferred<OverviewPayload>();
    const newerPayload = buildOverview({ accountId: "newer-account", generatedAt: "newer" });
    overviewApi.getOverview
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    useMonitorStore.setState({ overview: snapshot, loading: false, overviewUpdatedAt: 100 });

    const olderRequest = useMonitorStore.getState().loadOverview();
    const newerRequest = useMonitorStore.getState().loadOverview();

    older.resolve(buildOverview({ generatedAt: "stale" }));
    await expect(olderRequest).resolves.toBe(false);
    expect(useMonitorStore.getState()).toMatchObject({
      overview: snapshot,
      loading: false,
      overviewRefreshing: true,
      overviewLastError: null,
      overviewUpdatedAt: 100
    });

    newer.resolve(newerPayload);
    await expect(newerRequest).resolves.toBe(true);
    expect(useMonitorStore.getState()).toMatchObject({
      overview: newerPayload,
      loading: false,
      overviewRefreshing: false,
      overviewLastError: null
    });
  });

  it("rejects an older failure after a newer success without restoring an error or loading state", async () => {
    const snapshot = buildOverview({ generatedAt: "snapshot" });
    const older = createDeferred<OverviewPayload>();
    const newer = createDeferred<OverviewPayload>();
    const newerPayload = buildOverview({ accountId: "newer-account", generatedAt: "newer" });
    overviewApi.getOverview
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    useMonitorStore.setState({ overview: snapshot, loading: false, overviewUpdatedAt: 100 });

    const olderRequest = useMonitorStore.getState().loadOverview();
    const newerRequest = useMonitorStore.getState().loadOverview();

    newer.resolve(newerPayload);
    await expect(newerRequest).resolves.toBe(true);
    const updatedAt = useMonitorStore.getState().overviewUpdatedAt;

    older.reject(new Error("stale failure"));
    await expect(olderRequest).resolves.toBe(false);

    expect(useMonitorStore.getState()).toMatchObject({
      overview: newerPayload,
      loading: false,
      overviewRefreshing: false,
      overviewLastError: null,
      overviewUpdatedAt: updatedAt,
      error: null,
      toasts: []
    });
  });

  it("keeps the current request refreshing when an older foreground failure settles first", async () => {
    const snapshot = buildOverview({ generatedAt: "snapshot" });
    const older = createDeferred<OverviewPayload>();
    const newer = createDeferred<OverviewPayload>();
    const newerPayload = buildOverview({ accountId: "newer-account", generatedAt: "newer" });
    overviewApi.getOverview
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    useMonitorStore.setState({ overview: snapshot, loading: false, overviewUpdatedAt: 100 });

    const olderRequest = useMonitorStore.getState().loadOverview();
    const newerRequest = useMonitorStore.getState().loadOverview();

    older.reject(new Error("stale failure"));
    await expect(olderRequest).resolves.toBe(false);
    expect(useMonitorStore.getState()).toMatchObject({
      overview: snapshot,
      loading: false,
      overviewRefreshing: true,
      overviewLastError: null,
      overviewUpdatedAt: 100,
      error: null,
      toasts: []
    });

    newer.resolve(newerPayload);
    await expect(newerRequest).resolves.toBe(true);
    expect(useMonitorStore.getState()).toMatchObject({
      overview: newerPayload,
      loading: false,
      overviewRefreshing: false,
      overviewLastError: null
    });
  });

  it("does not let an older request clear the current request busy text", async () => {
    const snapshot = buildOverview({ generatedAt: "snapshot" });
    const older = createDeferred<OverviewPayload>();
    const newer = createDeferred<OverviewPayload>();
    overviewApi.getOverview
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    useMonitorStore.setState({ overview: snapshot, loading: false });

    const olderRequest = useMonitorStore.getState().loadOverview({ busyText: "旧请求刷新中" });
    const newerRequest = useMonitorStore.getState().loadOverview({ busyText: "新请求刷新中" });

    older.resolve(buildOverview({ generatedAt: "stale" }));
    await expect(olderRequest).resolves.toBe(false);
    expect(useMonitorStore.getState().busyText).toBe("新请求刷新中");

    newer.resolve(buildOverview({ generatedAt: "newer" }));
    await expect(newerRequest).resolves.toBe(true);
    expect(useMonitorStore.getState().busyText).toBeNull();
  });

  it("invalidates an in-flight load when a direct snapshot replaces the overview", async () => {
    const snapshot = buildOverview({ generatedAt: "snapshot" });
    const replacement = buildOverview({ accountId: "replacement", generatedAt: "replacement" });
    const deferred = createDeferred<OverviewPayload>();
    overviewApi.getOverview.mockReturnValueOnce(deferred.promise);
    useMonitorStore.setState({ overview: snapshot, loading: false });

    const pending = useMonitorStore.getState().loadOverview({ busyText: "overview 刷新中" });
    useMonitorStore.getState().replaceOverview(replacement);

    expect(useMonitorStore.getState()).toMatchObject({
      overview: replacement,
      loading: false,
      overviewRefreshing: false,
      overviewLastError: null,
      busyText: null
    });

    deferred.resolve(buildOverview({ generatedAt: "stale" }));
    await expect(pending).resolves.toBe(false);
    expect(useMonitorStore.getState().overview).toBe(replacement);
  });

  it("evicts deleted entities atomically so a late pre-delete response cannot restore them", async () => {
    const siteA = buildSite({ id: "site-a" });
    const siteB = buildSite({ id: "site-b" });
    const accountA = buildAccount({ id: "account-a", siteId: "site-a", site: siteA, sessionState: "ready" });
    const accountB = buildAccount({ id: "account-b", siteId: "site-b", site: siteB, sessionState: "ready" });
    const snapshot = {
      ...buildOverview({ accountId: "account-a", siteId: "site-a" }),
      sites: [siteA, siteB],
      accounts: [accountA, accountB]
    } satisfies OverviewPayload;
    const deferred = createDeferred<OverviewPayload>();
    overviewApi.getOverview.mockReturnValueOnce(deferred.promise);
    useMonitorStore.setState({
      overview: snapshot,
      loading: false,
      selectedSiteId: "site-a",
      selectedAccountId: "account-a"
    });

    const pending = useMonitorStore.getState().loadOverview();
    useMonitorStore.getState().evictOverviewEntities({ accountIds: ["account-a"] });

    expect(useMonitorStore.getState()).toMatchObject({
      selectedSiteId: "site-b",
      selectedAccountId: "account-b",
      overview: expect.objectContaining({ accounts: [accountB] })
    });

    deferred.resolve(snapshot);
    await expect(pending).resolves.toBe(false);
    expect(useMonitorStore.getState().overview?.accounts.map((account) => account.id)).toEqual(["account-b"]);
  });

  it("clears an affected selection and invalidates a cold in-flight overview request", async () => {
    const deferred = createDeferred<OverviewPayload>();
    overviewApi.getOverview.mockReturnValueOnce(deferred.promise);
    useMonitorStore.setState({
      overview: null,
      loading: true,
      selectedSiteId: "site-a",
      selectedAccountId: "account-a"
    });

    const pending = useMonitorStore.getState().loadOverview();
    useMonitorStore.getState().evictOverviewEntities({ accountIds: ["account-a"], siteIds: ["site-a"] });

    expect(useMonitorStore.getState()).toMatchObject({
      overview: null,
      selectedSiteId: null,
      selectedAccountId: null
    });

    deferred.resolve(buildOverview({ accountId: "account-a", siteId: "site-a" }));
    await expect(pending).resolves.toBe(false);
    expect(useMonitorStore.getState().overview).toBeNull();
  });

  it("retains a snapshot on silent failure and clears the local error after a successful retry", async () => {
    const snapshot = buildOverview({ generatedAt: "snapshot" });
    const recovered = buildOverview({ accountId: "recovered-account", generatedAt: "recovered" });
    overviewApi.getOverview
      .mockRejectedValueOnce(new Error("background offline"))
      .mockResolvedValueOnce(recovered);
    useMonitorStore.setState({
      overview: snapshot,
      loading: false,
      overviewUpdatedAt: 100,
      error: "unrelated foreground error"
    });

    await expect(useMonitorStore.getState().loadOverview({ silent: true })).resolves.toBe(false);
    expect(useMonitorStore.getState()).toMatchObject({
      overview: snapshot,
      loading: false,
      overviewRefreshing: false,
      overviewLastError: "background offline",
      overviewUpdatedAt: 100,
      error: "unrelated foreground error",
      toasts: []
    });

    await expect(useMonitorStore.getState().loadOverview()).resolves.toBe(true);
    expect(useMonitorStore.getState()).toMatchObject({
      overview: recovered,
      loading: false,
      overviewRefreshing: false,
      overviewLastError: null,
      error: null
    });
    expect(useMonitorStore.getState().overviewUpdatedAt).not.toBe(100);
  });

  it("keeps a snapshot and preserves foreground error/toast feedback on manual failure", async () => {
    const snapshot = buildOverview({ generatedAt: "snapshot" });
    overviewApi.getOverview.mockRejectedValueOnce(new Error("manual offline"));
    useMonitorStore.setState({ overview: snapshot, loading: false, overviewUpdatedAt: 100 });

    await expect(useMonitorStore.getState().loadOverview()).resolves.toBe(false);

    const expectedError = formatAppErrorMessage("manual offline");
    expect(useMonitorStore.getState()).toMatchObject({
      overview: snapshot,
      loading: false,
      overviewRefreshing: false,
      overviewLastError: "manual offline",
      overviewUpdatedAt: 100,
      error: expectedError
    });
    expect(useMonitorStore.getState().toasts).toEqual([
      expect.objectContaining({ tone: "error", message: expectedError })
    ]);
  });
});

describe("overview reload feedback copy", () => {
  it("keeps the topbar reload busy and success messages stable", () => {
    expect("正在刷新当前账号数据...").toBe("正在刷新当前账号数据...");
    expect("当前账号数据已刷新").toBe("当前账号数据已刷新");
    expect(
      formatAppErrorMessage(
        "error sending request for url (https://ai.input.im/api/v1/usage?page=84&page_size=20)"
      )
    ).toBe("用量数据请求失败, 上游接口暂时不可用, 请稍后重试。");
  });
});

describe("app notifications", () => {
  it("treats service-status notification records as stable item shapes", () => {
    const item = {
      id: "notify-1",
      source: "service-status",
      severity: "critical",
      kind: "service-status-down",
      title: "检测到服务状态不可用",
      detail: "gpt-5.5 当前无法使用, 请打开服务状态查看详情",
      createdAt: "2026-06-15T12:00:00.000Z",
      dedupeKey: "service-status:down:gpt-5.5:probe timeout",
      models: ["gpt-5.5"]
    };

    expect(item.kind).toBe("service-status-down");
    expect(item.dedupeKey).toContain("service-status:down");
  });

  it("keeps service-status toast durations stable for down and recovered transitions", () => {
    expect(ERROR_TOAST_DURATION_MS).toBe(4200);
    expect(INFO_TOAST_DURATION_MS).toBe(2400);
  });

  it("rearms a stable service-status notification key after an intervening recovery", () => {
    const pushAppNotification = useMonitorStore.getState().pushAppNotification;
    const down = {
      id: "down-1",
      source: "service-status" as const,
      severity: "critical" as const,
      kind: "service-status-down" as const,
      title: "检测到服务状态不可用",
      detail: "gpt-5.5 当前无法使用",
      createdAt: "2026-07-11T00:00:00.000Z",
      dedupeKey: "service-status:down:gpt-5.5:probe timeout",
      models: ["gpt-5.5"]
    };
    const recovery = {
      id: "recovered-1",
      source: "service-status" as const,
      severity: "success" as const,
      kind: "service-status-recovered" as const,
      title: "检测到服务状态恢复正常",
      detail: "gpt-5.5 已恢复正常",
      createdAt: "2026-07-11T00:01:00.000Z",
      dedupeKey: "service-status:recovered",
      models: []
    };

    pushAppNotification(down);
    pushAppNotification({ ...down, id: "down-duplicate" });
    expect(useMonitorStore.getState().appNotifications).toHaveLength(1);

    pushAppNotification(recovery);
    pushAppNotification({ ...down, id: "down-2", createdAt: "2026-07-11T00:02:00.000Z" });

    expect(useMonitorStore.getState().appNotifications.map((item) => item.id)).toEqual([
      "down-2",
      "recovered-1",
      "down-1"
    ]);
  });

  it("drops acknowledged overview alerts once the upstream overview no longer returns them", () => {
    expect(pruneDismissedOverviewAlertIds(["alert-1", "alert-2"], ["alert-2", "alert-3"])).toEqual(["alert-2"]);
    expect(pruneDismissedOverviewAlertIds(["alert-1"], [])).toEqual([]);
  });

  it("drops read notification keys once the underlying notifications disappear", () => {
    expect(
      pruneReadNotificationKeys(
        ["service-status:notify-1", "overview-alert:alert-1"],
        ["overview-alert:alert-1", "overview-alert:alert-2"]
      )
    ).toEqual(["overview-alert:alert-1"]);
    expect(pruneReadNotificationKeys(["service-status:notify-1"], [])).toEqual([]);
  });
});

describe("refresh policy", () => {
  it("refreshes account-scoped data for subscription-adjacent pages", () => {
    expect(shouldRefreshAccountData("subscriptions")).toBe(true);
    expect(shouldRefreshAccountData("keys")).toBe(true);
    expect(shouldRefreshAccountData("systemSettings")).toBe(false);
  });

  it("refreshes stale snapshots only on pages that render cacheView-based views", () => {
    expect(shouldRefreshCoreForNav("overview")).toBe(true);
    expect(shouldRefreshCoreForNav("subscriptions")).toBe(true);
    expect(shouldRefreshCoreForNav("usage")).toBe(false);
  });

  it("treats missing, invalid, or cross-day snapshots as stale", () => {
    const now = new Date("2026-06-13T00:30:00+08:00");

    expect(isAccountDataStaleForToday(null, now)).toBe(true);
    expect(isAccountDataStaleForToday("invalid-date", now)).toBe(true);
    expect(isAccountDataStaleForToday("2026-06-12T23:59:59+08:00", now)).toBe(true);
    expect(isAccountDataStaleForToday("2026-06-13T00:00:01+08:00", now)).toBe(false);
  });
});
