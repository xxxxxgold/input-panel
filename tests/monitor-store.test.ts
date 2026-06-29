import { describe, expect, it } from "vitest";
import {
  appendToastDeduped,
  ERROR_TOAST_DURATION_MS,
  INFO_TOAST_DURATION_MS,
  pruneDismissedOverviewAlertIds,
  pruneReadNotificationKeys,
  resolveOverviewSelection,
  type MonitorToast
} from "../src/shared/state/monitor-store";
import {
  isAccountDataStaleForToday,
  shouldRefreshAccountData,
  shouldRefreshCoreForNav
} from "../src/app/refresh-policy";
import { formatAppErrorMessage } from "../src/shared/lib/error-display";
import type { AccountRuntime, OverviewPayload, SiteRecord } from "../src/types";

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
      detail: "服务状态自动刷新发现异常: gpt-5.5 探测失败, probe timeout",
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
