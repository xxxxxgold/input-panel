import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  isFloatingPanelResourceDataCurrent,
  resolveFloatingPanelCurrentAccount,
  shouldActivateFloatingPanelData
} from "../src/app/FloatingPanelWindowRoot";
import {
  createFloatingPanelSelectionCoordinator,
  type WindowSelectionState
} from "../src/app/window-selection-sync";
import type { OverviewPayload } from "../src/types";

const rootSource = readFileSync(
  new URL("../src/app/FloatingPanelWindowRoot.tsx", import.meta.url),
  "utf8"
);
const mainWindowSource = readFileSync(
  new URL("../src/app/MainWindowApp.tsx", import.meta.url),
  "utf8"
);
const tauriRuntimeSource = readFileSync(
  new URL("../src-tauri/src/lib.rs", import.meta.url),
  "utf8"
);

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("resolveFloatingPanelCurrentAccount", () => {
  it("prefers the currently selected account when it is still valid", () => {
    const overview = {
      sites: [
        {
          id: "site-1",
          name: "AI INPUT",
          baseUrl: "https://example.com",
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z"
        }
      ],
      accounts: [
        {
          id: "account-1",
          siteId: "site-1",
          label: "主账号",
          email: "main@example.com",
          balanceWarning: -1,
          lastLoginAt: null,
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
          site: {
            id: "site-1",
            name: "AI INPUT",
            baseUrl: "https://example.com",
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z"
          },
          sessionState: "ready",
          lastError: null,
          cacheView: {
            fetchedAt: "2026-06-28T00:00:00Z",
            online: true,
            siteName: "AI INPUT",
            balance: 42.5,
            stats: {
              totalApiKeys: 1,
              activeApiKeys: 1,
              todayRequests: 5,
              totalRequests: 5,
              todayActualCost: 1,
              totalActualCost: 1,
              todayCost: 1,
              totalCost: 1,
              todayTokens: 1000,
              totalTokens: 1000,
              todayInputTokens: 600,
              todayOutputTokens: 400,
              averageDurationMs: 1000,
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
          label: "副账号",
          email: "secondary@example.com",
          balanceWarning: -1,
          lastLoginAt: null,
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
          site: {
            id: "site-1",
            name: "AI INPUT",
            baseUrl: "https://example.com",
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z"
          },
          sessionState: "ready",
          lastError: null,
          cacheView: {
            fetchedAt: "2026-06-28T00:00:00Z",
            online: true,
            siteName: "AI INPUT",
            balance: 18.2,
            stats: {
              totalApiKeys: 1,
              activeApiKeys: 1,
              todayRequests: 3,
              totalRequests: 3,
              todayActualCost: 0.5,
              totalActualCost: 0.5,
              todayCost: 0.5,
              totalCost: 0.5,
              todayTokens: 500,
              totalTokens: 500,
              todayInputTokens: 300,
              todayOutputTokens: 200,
              averageDurationMs: 800,
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
        totalApiKeys: 2,
        activeApiKeys: 2,
        todayRequests: 8,
        totalRequests: 8,
        todayActualCost: 1.5,
        totalActualCost: 1.5,
        todayTokens: 1500,
        totalTokens: 1500
      },
      alerts: [],
      platformSeries: [],
      trend: [],
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-06-28T00:00:00Z"
    } satisfies OverviewPayload;

    const current = resolveFloatingPanelCurrentAccount({
      overview,
      selectedAccountId: "account-2",
      selectedSiteId: "site-1"
    });

    expect(current?.id).toBe("account-2");
    expect(current?.label).toBe("副账号");
  });

  it("resolves a duplicated account identifier inside the selected site only", () => {
    const account = {
      id: "account-shared",
      label: "目标账号",
      email: "target@example.com",
      balanceWarning: -1,
      lastLoginAt: null,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      sessionState: "ready" as const,
      lastError: null,
      cacheView: null
    };
    const overview = {
      sites: [
        { id: "site-a", name: "站点 A", baseUrl: "https://a.example.com", createdAt: account.createdAt, updatedAt: account.updatedAt },
        { id: "site-b", name: "站点 B", baseUrl: "https://b.example.com", createdAt: account.createdAt, updatedAt: account.updatedAt }
      ],
      accounts: [
        { ...account, siteId: "site-a", site: { id: "site-a", name: "站点 A", baseUrl: "https://a.example.com", createdAt: account.createdAt, updatedAt: account.updatedAt } },
        { ...account, siteId: "site-b", site: { id: "site-b", name: "站点 B", baseUrl: "https://b.example.com", createdAt: account.createdAt, updatedAt: account.updatedAt } }
      ],
      totals: { balance: 0, totalSites: 2, totalAccounts: 2, totalApiKeys: 0, activeApiKeys: 0, todayRequests: 0, totalRequests: 0, todayActualCost: 0, totalActualCost: 0, todayTokens: 0, totalTokens: 0 },
      alerts: [],
      platformSeries: [],
      trend: [],
      recentUsage: [],
      subscriptions: [],
      keys: [],
      generatedAt: "2026-06-28T00:00:00Z"
    } satisfies OverviewPayload;

    const current = resolveFloatingPanelCurrentAccount({
      overview,
      selectedAccountId: "account-shared",
      selectedSiteId: "site-b"
    });

    expect(current?.siteId).toBe("site-b");
  });
});

describe("shouldActivateFloatingPanelData", () => {
  it("refreshes live resources every 30 seconds and clears the timer when inactive", () => {
    expect(rootSource).toContain("const FLOATING_LIVE_REFRESH_INTERVAL_MS = 30_000;");
    expect(rootSource).toContain("accountDataWorkspace.refreshAccountData({ force: false })");
    expect(rootSource).toContain("window.clearTimeout(timerId)");
  });

  it("skips hidden floating-panel data loads in tauri mode", () => {
    expect(
      shouldActivateFloatingPanelData({
        tauriRuntime: true,
        keepVisible: false,
        panelVisible: false
      })
    ).toBe(false);
  });

  it("keeps loading active when the panel is pinned or visible", () => {
    expect(
      shouldActivateFloatingPanelData({
        tauriRuntime: true,
        keepVisible: true,
        panelVisible: false
      })
    ).toBe(true);
    expect(
      shouldActivateFloatingPanelData({
        tauriRuntime: true,
        keepVisible: false,
        panelVisible: true
      })
    ).toBe(true);
  });

  it("hydrates panel visibility from native state after subscribing to hover events", () => {
    expect(rootSource).toContain('"floating-native-panel-visibility"');
    expect(rootSource).toContain("setPanelWindowVisible(event.payload.visible);");
    expect(rootSource).toContain("getFloatingPanelVisible");
    expect(rootSource).toContain("const hydrationEventVersion = panelVisibilityEventVersionRef.current;");
    expect(rootSource).toContain(
      "panelVisibilityEventVersionRef.current === hydrationEventVersion"
    );
    expect(rootSource).toContain("nativeVisibilityCleanup();");
    expect(tauriRuntimeSource).toContain("fn emit_floating_native_panel_visibility");
    expect(tauriRuntimeSource).toContain(
      'FLOATING_PANEL_WINDOW_LABEL,\n        "floating-native-panel-visibility"'
    );
  });
});

describe("floating-panel account resource ownership", () => {
  it("uses the existing masked-email presentation when a selected account has no label", () => {
    expect(rootSource).toContain("const currentAccountLabel = currentAccount");
    expect(rootSource).toContain("maskEmail(currentAccount.email.trim())");
  });

  it("retains the same-identity resource owner while hidden and invalidates only after selection clears", () => {
    expect(rootSource).toContain("if (!currentResourceIdentity) {\n      invalidateFloatingResourceData();");
    expect(rootSource).toContain("if (!panelDataActive) {\n      return;");
    expect(rootSource).not.toContain("if (!panelDataActive || !currentResourceIdentity)");
  });

  it("withholds cross-site resources until the target identity has refreshed successfully", () => {
    expect(isFloatingPanelResourceDataCurrent({
      resourceOwner: { siteId: "site-a", accountId: "account-a" },
      currentIdentity: { siteId: "site-b", accountId: "account-a" }
    })).toBe(false);
    expect(isFloatingPanelResourceDataCurrent({
      resourceOwner: null,
      currentIdentity: { siteId: "site-b", accountId: "account-a" }
    })).toBe(false);
    expect(isFloatingPanelResourceDataCurrent({
      resourceOwner: { siteId: "site-b", accountId: "account-a" },
      currentIdentity: { siteId: "site-b", accountId: "account-a" }
    })).toBe(true);
    expect(isFloatingPanelResourceDataCurrent({
      resourceOwner: { siteId: "site-a", accountId: "account-a" },
      currentIdentity: null
    })).toBe(false);
    expect(rootSource).toContain('resourceRefresh.status === "success"');
  });
});

describe("floating-panel selection coordination", () => {
  it("persists account switches initiated in the panel and synchronizes them to the main window", () => {
    expect(rootSource).toContain("accounts={overview?.accounts ?? []}");
    expect(rootSource).toContain("onAccountSelect={selectFloatingAccount}");
    expect(rootSource).toContain('emitTo("main", "floating-panel-selection-sync", payload)');
    expect(mainWindowSource).toContain(
      'getCurrentWindow().listen<WindowSelectionSyncPayload>(\n      "floating-panel-selection-sync"'
    );
    expect(mainWindowSource).toContain("setSelectedSiteId(event.payload.selectedSiteId);");
    expect(mainWindowSource).toContain("setSelectedAccountId(event.payload.selectedAccountId);");
  });

  it("refreshes overview-shell immediately when an empty visible panel receives its first account selection", async () => {
    let listener: ((payload: { selectedSiteId: string | null; selectedAccountId: string | null; revision: number }) => void) | null = null;
    let appliedSelection: WindowSelectionState | null = null;
    const refreshOverview = vi.fn().mockResolvedValue(undefined);
    const coordinator = createFloatingPanelSelectionCoordinator({
      subscribe: async (nextListener) => {
        listener = nextListener;
        return () => {};
      },
      readPersisted: async () => ({ selectedSiteId: null, selectedAccountId: null }),
      applySelection: (selection) => {
        appliedSelection = selection;
      },
      isPanelDataActive: () => true,
      refreshOverview,
      reportError: vi.fn()
    });

    const start = coordinator.start();
    await Promise.resolve();
    listener?.({ selectedSiteId: "site-1", selectedAccountId: "account-1", revision: 1 });
    await start;
    await Promise.resolve();

    expect(appliedSelection).toEqual({ selectedSiteId: "site-1", selectedAccountId: "account-1" });
    expect(refreshOverview).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer selection event when an older persisted read resolves later", async () => {
    const persisted = createDeferred<WindowSelectionState>();
    let listener: ((payload: { selectedSiteId: string | null; selectedAccountId: string | null; revision: number }) => void) | null = null;
    const appliedSelections: WindowSelectionState[] = [];
    const coordinator = createFloatingPanelSelectionCoordinator({
      subscribe: async (nextListener) => {
        listener = nextListener;
        return () => {};
      },
      readPersisted: () => persisted.promise,
      applySelection: (selection) => {
        appliedSelections.push(selection);
      },
      isPanelDataActive: () => true,
      refreshOverview: async () => {},
      reportError: vi.fn()
    });

    const start = coordinator.start();
    await Promise.resolve();
    listener?.({ selectedSiteId: "site-new", selectedAccountId: "account-new", revision: 2 });
    persisted.resolve({ selectedSiteId: "site-old", selectedAccountId: "account-old" });
    await start;

    expect(appliedSelections).toEqual([
      { selectedSiteId: "site-new", selectedAccountId: "account-new" }
    ]);
  });

  it("revalidates a newer same-account replay without destructively reapplying the selection", async () => {
    let listener: ((payload: { selectedSiteId: string | null; selectedAccountId: string | null; revision: number }) => void) | null = null;
    const appliedSelections: WindowSelectionState[] = [];
    const resolutions: string[] = [];
    const initialRefresh = createDeferred<boolean>();
    const refreshOverview = vi.fn<() => Promise<boolean>>()
      .mockImplementationOnce(() => initialRefresh.promise)
      .mockResolvedValueOnce(true);
    const coordinator = createFloatingPanelSelectionCoordinator({
      subscribe: async (nextListener) => {
        listener = nextListener;
        return () => {};
      },
      readPersisted: () => new Promise<WindowSelectionState>(() => {}),
      applySelection: (selection) => {
        appliedSelections.push(selection);
      },
      isPanelDataActive: () => true,
      refreshOverview,
      updateResolution: (resolution) => {
        resolutions.push(resolution.state);
      },
      reportError: vi.fn()
    });

    void coordinator.start();
    await Promise.resolve();
    listener?.({ selectedSiteId: "site-1", selectedAccountId: "account-1", revision: 8 });
    await Promise.resolve();
    initialRefresh.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    listener?.({ selectedSiteId: "site-1", selectedAccountId: "account-1", revision: 1 });
    listener?.({ selectedSiteId: "site-1", selectedAccountId: "account-1", revision: 9 });
    await Promise.resolve();

    expect(appliedSelections).toEqual([
      { selectedSiteId: "site-1", selectedAccountId: "account-1" }
    ]);
    expect(refreshOverview).toHaveBeenCalledTimes(2);
    expect(resolutions).toEqual(["resolving", "resolving", "resolved", "resolved"]);
  });

  it("keeps a resolved account visible when its same-identity revalidation fails", async () => {
    let listener: ((payload: { selectedSiteId: string | null; selectedAccountId: string | null; revision: number }) => void) | null = null;
    const appliedSelections: WindowSelectionState[] = [];
    const resolutions: string[] = [];
    const coordinator = createFloatingPanelSelectionCoordinator({
      subscribe: async (nextListener) => {
        listener = nextListener;
        return () => {};
      },
      readPersisted: () => new Promise<WindowSelectionState>(() => {}),
      applySelection: (selection) => {
        appliedSelections.push(selection);
      },
      isPanelDataActive: () => true,
      refreshOverview: vi.fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      retryDelaysMs: [],
      updateResolution: (resolution) => {
        resolutions.push(resolution.state);
      },
      reportError: vi.fn()
    });

    void coordinator.start();
    await Promise.resolve();
    listener?.({ selectedSiteId: "site-1", selectedAccountId: "account-1", revision: 1 });
    await Promise.resolve();
    listener?.({ selectedSiteId: "site-1", selectedAccountId: "account-1", revision: 2 });
    await Promise.resolve();

    expect(appliedSelections).toEqual([{ selectedSiteId: "site-1", selectedAccountId: "account-1" }]);
    expect(resolutions.at(-1)).toBe("resolved");
  });

  it("retries an old empty overview until the selected account is confirmed", async () => {
    let active = false;
    let listener: ((payload: { selectedSiteId: string | null; selectedAccountId: string | null; revision: number }) => void) | null = null;
    const resolutions: string[] = [];
    const refreshOverview = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const coordinator = createFloatingPanelSelectionCoordinator({
      subscribe: async (nextListener) => {
        listener = nextListener;
        return () => {};
      },
      readPersisted: () => new Promise<WindowSelectionState>(() => {}),
      applySelection: () => {},
      isPanelDataActive: () => active,
      refreshOverview,
      retryDelaysMs: [0, 0],
      wait: async () => {},
      updateResolution: (resolution) => {
        resolutions.push(resolution.state);
      },
      reportError: vi.fn()
    });

    void coordinator.start();
    await Promise.resolve();
    listener?.({ selectedSiteId: "site-1", selectedAccountId: "account-new", revision: 10 });
    active = true;

    await expect(coordinator.refreshIfActive()).resolves.toBe(true);
    expect(refreshOverview).toHaveBeenCalledTimes(3);
    expect(resolutions).toEqual(["resolving", "resolving", "resolved"]);
  });

  it("keeps a missing selected account retryable instead of degrading to empty", async () => {
    let active = false;
    let listener: ((payload: { selectedSiteId: string | null; selectedAccountId: string | null; revision: number }) => void) | null = null;
    const resolutions: Array<{ state: string; message: string | null }> = [];
    const refreshOverview = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const coordinator = createFloatingPanelSelectionCoordinator({
      subscribe: async (nextListener) => {
        listener = nextListener;
        return () => {};
      },
      readPersisted: () => new Promise<WindowSelectionState>(() => {}),
      applySelection: () => {},
      isPanelDataActive: () => active,
      refreshOverview,
      retryDelaysMs: [],
      updateResolution: (resolution) => {
        resolutions.push(resolution);
      },
      reportError: vi.fn()
    });

    void coordinator.start();
    await Promise.resolve();
    listener?.({ selectedSiteId: "site-1", selectedAccountId: "account-new", revision: 11 });
    active = true;

    await expect(coordinator.refreshIfActive()).resolves.toBe(false);
    expect(resolutions.at(-1)).toEqual({
      state: "retryable-error",
      message: "当前账号暂时无法确认，请点击刷新重试。"
    });

    await expect(coordinator.refreshIfActive()).resolves.toBe(true);
    expect(resolutions.at(-1)).toEqual({ state: "resolved", message: null });
  });

  it("does not let an older selection retry overwrite a newer resolved account", async () => {
    let active = false;
    let listener: ((payload: { selectedSiteId: string | null; selectedAccountId: string | null; revision: number }) => void) | null = null;
    const retryGate = createDeferred<void>();
    const newerSelectionSeen = createDeferred<void>();
    const resolutions: string[] = [];
    const coordinator = createFloatingPanelSelectionCoordinator({
      subscribe: async (nextListener) => {
        listener = nextListener;
        return () => {};
      },
      readPersisted: () => new Promise<WindowSelectionState>(() => {}),
      applySelection: () => {},
      isPanelDataActive: () => active,
      refreshOverview: async (selection) => {
        if (selection.selectedAccountId === "account-new") {
          newerSelectionSeen.resolve();
          return true;
        }
        return false;
      },
      retryDelaysMs: [1],
      wait: () => retryGate.promise,
      updateResolution: (resolution) => {
        resolutions.push(resolution.state);
      },
      reportError: vi.fn()
    });

    void coordinator.start();
    await Promise.resolve();
    listener?.({ selectedSiteId: "site-1", selectedAccountId: "account-old", revision: 20 });
    active = true;
    const oldRefresh = coordinator.refreshIfActive();
    await Promise.resolve();

    listener?.({ selectedSiteId: "site-1", selectedAccountId: "account-new", revision: 21 });
    await newerSelectionSeen.promise;
    await Promise.resolve();
    retryGate.resolve();

    await expect(oldRefresh).resolves.toBe(false);
    expect(resolutions.at(-1)).toBe("resolved");
  });

  it("allows an empty persisted selection to finish after overview-shell applies its default account", async () => {
    let listener: ((payload: { selectedSiteId: string | null; selectedAccountId: string | null; revision: number }) => void) | null = null;
    const appliedSelections: WindowSelectionState[] = [];
    const coordinator = createFloatingPanelSelectionCoordinator({
      subscribe: async (nextListener) => {
        listener = nextListener;
        return () => {};
      },
      readPersisted: async () => ({ selectedSiteId: null, selectedAccountId: null }),
      applySelection: (selection) => {
        appliedSelections.push(selection);
      },
      isPanelDataActive: () => true,
      refreshOverview: async () => true,
      reportError: vi.fn()
    });

    await coordinator.start();
    await Promise.resolve();

    expect(listener).toBeTypeOf("function");
    expect(appliedSelections).toEqual([{ selectedSiteId: null, selectedAccountId: null }]);
  });

  it("defers hidden unpinned panel loading until the panel becomes visible", async () => {
    let active = false;
    let listener: ((payload: { selectedSiteId: string | null; selectedAccountId: string | null; revision: number }) => void) | null = null;
    const refreshOverview = vi.fn().mockResolvedValue(undefined);
    const coordinator = createFloatingPanelSelectionCoordinator({
      subscribe: async (nextListener) => {
        listener = nextListener;
        return () => {};
      },
      readPersisted: async () => ({ selectedSiteId: null, selectedAccountId: null }),
      applySelection: () => {},
      isPanelDataActive: () => active,
      refreshOverview,
      reportError: vi.fn()
    });

    const start = coordinator.start();
    await Promise.resolve();
    listener?.({ selectedSiteId: "site-1", selectedAccountId: "account-1", revision: 1 });
    await start;
    await Promise.resolve();
    expect(refreshOverview).not.toHaveBeenCalled();

    active = true;
    await coordinator.refreshIfActive();
    expect(refreshOverview).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed same-selection refresh eligible for the next visible-panel refresh", async () => {
    let listener: ((payload: { selectedSiteId: string | null; selectedAccountId: string | null; revision: number }) => void) | null = null;
    const refreshOverview = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const reportError = vi.fn();
    const coordinator = createFloatingPanelSelectionCoordinator({
      subscribe: async (nextListener) => {
        listener = nextListener;
        return () => {};
      },
      readPersisted: () => new Promise<WindowSelectionState>(() => {}),
      applySelection: () => {},
      isPanelDataActive: () => true,
      refreshOverview,
      retryDelaysMs: [],
      reportError
    });

    void coordinator.start();
    await Promise.resolve();
    listener?.({ selectedSiteId: "site-1", selectedAccountId: "account-1", revision: 1 });
    await Promise.resolve();
    await coordinator.refreshIfActive();

    expect(refreshOverview).toHaveBeenCalledTimes(2);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("resolves a newly created, not-yet-logged-in account after its overview shell arrives", () => {
    const overview = {
      sites: [{
        id: "site-1",
        name: "新站点",
        baseUrl: "https://example.com",
        createdAt: "2026-07-16T00:00:00Z",
        updatedAt: "2026-07-16T00:00:00Z"
      }],
      accounts: [{
        id: "account-new",
        siteId: "site-1",
        label: "新账号",
        email: "new@example.com",
        balanceWarning: -1,
        lastLoginAt: null,
        createdAt: "2026-07-16T00:00:00Z",
        updatedAt: "2026-07-16T00:00:00Z",
        site: {
          id: "site-1",
          name: "新站点",
          baseUrl: "https://example.com",
          createdAt: "2026-07-16T00:00:00Z",
          updatedAt: "2026-07-16T00:00:00Z"
        },
        sessionState: "missing" as const,
        lastError: null,
        cacheView: null
      }],
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
      generatedAt: "2026-07-16T00:00:00Z"
    } satisfies OverviewPayload;

    expect(resolveFloatingPanelCurrentAccount({
      overview,
      selectedSiteId: "site-1",
      selectedAccountId: "account-new"
    })?.label).toBe("新账号");
  });
});
