import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const mainWindowApp = readFileSync(new URL("../src/app/MainWindowApp.tsx", import.meta.url), "utf8");
const mainWindowChrome = readFileSync(new URL("../src/app/MainWindowChrome.tsx", import.meta.url), "utf8");

describe("MainWindowApp overview refresh boundary", () => {
  it("uses one shared bounded executor for realtime snapshots, balances, and all-account key hydration", () => {
    expect(mainWindowApp).toContain("OVERVIEW_UPSTREAM_REQUEST_CONCURRENCY = 3");
    expect(mainWindowApp).toContain("createBoundedExecutor(OVERVIEW_UPSTREAM_REQUEST_CONCURRENCY)");
    expect(mainWindowApp.match(/overviewUpstreamRequestExecutor\.map\(/g)).toHaveLength(3);
    expect(mainWindowApp.match(/overviewUpstreamRequestExecutor\.run\(/g)).toHaveLength(4);
  });

  it("keeps each all-account realtime snapshot atomic under the bounded account mapper", () => {
    const realtimeLoaderStart = mainWindowApp.indexOf("const rows = await overviewUpstreamRequestExecutor.map(");
    const realtimeLoaderEnd = mainWindowApp.indexOf("usageStatsRows: rows", realtimeLoaderStart);
    const realtimeLoader = mainWindowApp.slice(realtimeLoaderStart, realtimeLoaderEnd);
    const dashboardIndex = realtimeLoader.indexOf(
      "await getOverviewDashboardStats(readyAccount.id, forceUpstream)"
    );
    const trendIndex = realtimeLoader.indexOf("await getDashboardTrend(readyAccount.id, range)");
    const modelIndex = realtimeLoader.indexOf("await getDashboardModels(readyAccount.id, range)");
    const insightsIndex = realtimeLoader.indexOf("await getUsageInsights(readyAccount.id, range)");

    expect(dashboardIndex).toBeGreaterThan(-1);
    expect(trendIndex).toBeGreaterThan(dashboardIndex);
    expect(modelIndex).toBeGreaterThan(trendIndex);
    expect(insightsIndex).toBeGreaterThan(modelIndex);
  });

  it("propagates explicit realtime refreshes to the dashboard stats endpoint", () => {
    expect(mainWindowApp).toContain("const forceUpstream = options?.force ?? false;");
    expect(mainWindowApp).toContain("getOverviewDashboardStats(account.id, forceUpstream)");
    expect(mainWindowApp).toContain("getOverviewDashboardStats(readyAccount.id, forceUpstream)");
    expect(mainWindowApp).toContain("{ force: options?.force }");
  });

  it("hydrates only eligible overview scopes and preserves a one-time desktop initial hydration", () => {
    expect(mainWindowApp).toContain("shouldHydrateOverviewRealtime({");
    expect(mainWindowApp).toContain("overviewInitialHydrationPendingRef.current && hasReadyOverviewScope");
    expect(mainWindowApp).toContain("readyOverviewAccountIds.length > 0");
    expect(mainWindowApp).toContain("readyOverviewAccountIds,");
  });

  it("does not add visibility gating to the explicit manual refresh path", () => {
    const manualRefreshStart = mainWindowApp.indexOf("async function refreshOverviewSilently");
    const manualRefreshEnd = mainWindowApp.indexOf("const refreshOverviewSnapshotSilently", manualRefreshStart);
    const manualRefreshSource = mainWindowApp.slice(manualRefreshStart, manualRefreshEnd);

    expect(manualRefreshStart).toBeGreaterThan(-1);
    expect(manualRefreshEnd).toBeGreaterThan(manualRefreshStart);
    expect(manualRefreshSource).not.toContain("pageVisible");
    expect(manualRefreshSource).not.toContain("windowFocused");
  });

  it("keeps usage stale refresh local instead of routing it through account synchronization", () => {
    const staleRefreshStart = mainWindowApp.indexOf("if (!shouldAutoRefreshSelectedAccountData({");
    const staleRefreshEnd = mainWindowApp.indexOf("  useEffect(() => {", staleRefreshStart + 1);
    const staleRefreshSource = mainWindowApp.slice(staleRefreshStart, staleRefreshEnd);

    expect(staleRefreshStart).toBeGreaterThan(-1);
    expect(staleRefreshEnd).toBeGreaterThan(staleRefreshStart);
    expect(staleRefreshSource).toContain("const scope = resolveAutoRefreshScope(nav);");
    expect(staleRefreshSource).toContain('if (scope === "none" || scope === "usage") {');
    expect(staleRefreshSource).toContain("scope,\n      triggerSource: \"stale_auto\"");
    expect(staleRefreshSource).not.toContain('scope: "core"');
  });

  it("refreshes the visible usage workspace from the completed full-sync snapshot", () => {
    const fullSyncStart = mainWindowApp.indexOf("const refreshedFullSyncRunRef");
    const fullSyncEnd = mainWindowApp.indexOf("const resolvedOverviewSelection", fullSyncStart);
    const fullSyncSource = mainWindowApp.slice(fullSyncStart, fullSyncEnd);

    expect(fullSyncStart).toBeGreaterThan(-1);
    expect(fullSyncEnd).toBeGreaterThan(fullSyncStart);
    expect(fullSyncSource).toContain('if (fullStatus?.state !== "succeeded") {');
    expect(fullSyncSource).toContain("refreshedFullSyncRunRef.current === runKey");
    expect(fullSyncSource).not.toContain("invalidateUsageAccount(selectedAccountId)");
    expect(fullSyncSource).toContain('loadOverview({ source: "shell" })');
    expect(fullSyncSource).toContain("accountDataWorkspace.refreshAccountData({");
    expect(fullSyncSource).toContain("force: false,");
    expect(fullSyncSource).toContain('mode: "background"');
    expect(fullSyncSource).toContain('refreshUsageWorkspaceSilently({ mode: "background" })');
  });

  it("restricts full-source overview loads to explicit live refresh so background warmup cannot storm upstream", () => {
    // 后台预热与自动刷新只能读 shell 本地缓存；full（全账号 live 上游请求）
    // 必须由用户显式刷新（live: true）触发。
    expect(mainWindowApp).toContain('source: live && nav !== "overview" ? "full" : "shell"');
    expect(mainWindowApp).not.toContain('source: nav === "overview" ? "shell" : "full"');

    const warmupStart = mainWindowApp.indexOf("const refreshOverviewSnapshotSilently");
    const warmupEnd = mainWindowApp.indexOf("const runWarmupTask", warmupStart);
    const warmupSource = mainWindowApp.slice(warmupStart, warmupEnd);
    expect(warmupSource).toContain('source: "shell"');
    expect(warmupSource).not.toContain('"full"');

    const retryStart = mainWindowApp.indexOf("const retryOverviewForCurrentScope");
    const retrySource = mainWindowApp.slice(retryStart, mainWindowApp.indexOf("});", retryStart));
    expect(retrySource).toContain("loadOverviewForCurrentSurface({ live: true })");
  });

  it("keeps the shared overview account resolver", () => {
    expect(mainWindowApp).toContain("resolveOverviewSelection({ accounts, sites, selectedAccountId, selectedSiteId })");
    expect(mainWindowApp).toContain("resolvedOverviewSelection.selectedAccountId");
  });

  it("reads only the active overview scope cache and retries its exact realtime scope", () => {
    expect(mainWindowApp).toContain("const overviewRealtimeEntry = overviewRealtimeScopeKey");
    expect(mainWindowApp).toContain("overviewRealtimeCache.peek(overviewRealtimeScopeKey)");
    expect(mainWindowApp).toContain("const overviewAllAccountKeysEntry = overviewAllAccountKeysScopeKey");
    expect(mainWindowApp).toContain("overviewAllAccountKeysCache.peek(overviewAllAccountKeysScopeKey)");
    expect(mainWindowApp).toContain("const retryOverviewForCurrentScope = useStableCallback(async () => {");
    expect(mainWindowApp).toContain("loadOverviewDirectUsageStats({ force: true, bypassHydration: true })");
    expect(mainWindowApp).toContain("loadOverviewAllAccountKeys({ force: true, bypassHydration: true })");
    expect(mainWindowApp).not.toContain("setOverviewAllAccountKeys(null)");
  });

  it("moves toast and notification subscriptions into memoized local shell boundaries", () => {
    const mainStart = mainWindowApp.indexOf("export function MainWindowApp");
    const mainSource = mainWindowApp.slice(mainStart);

    expect(mainWindowChrome).toContain("export const MainWindowToastLayer = memo");
    expect(mainWindowChrome).toContain("export const MainWindowNotificationChrome = memo");
    expect(mainWindowChrome).toContain("useMonitorStore(useShallow(selectMainWindowNotificationState))");
    expect(mainSource).toContain("<MainWindowToastLayer />");
    expect(mainSource).toContain("<MainWindowAlertInbox");
    expect(mainSource).not.toContain("state.toasts");
    expect(mainSource).not.toContain("state.appNotifications");
  });

  it("passes stable events into the notification chrome so overview refreshes do not invalidate it through callbacks", () => {
    expect(mainWindowApp).toContain("const openProfileModal = useStableCallback(() => {");
    expect(mainWindowApp).toContain("const closeTopbarPeekPanels = useStableCallback(() => {");
    expect(mainWindowApp).toContain("onCloseTopbarPeekPanels={closeTopbarPeekPanels}");
  });
});
