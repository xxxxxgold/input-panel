import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const mainWindowApp = readFileSync(new URL("../src/app/MainWindowApp.tsx", import.meta.url), "utf8");

function sourceBetween(start: string, end: string) {
  const startIndex = mainWindowApp.indexOf(start);
  const endIndex = mainWindowApp.indexOf(end, startIndex + start.length);

  expect(startIndex, `Expected MainWindowApp to contain: ${start}`).toBeGreaterThan(-1);
  expect(endIndex, `Expected MainWindowApp to contain: ${end}`).toBeGreaterThan(startIndex);
  return mainWindowApp.slice(startIndex, endIndex);
}

describe("MainWindowApp page continuity wiring", () => {
  it("keeps every continuity page behind its stable loader and retryable local chunk boundary", () => {
    const pages = [
      ["keys", "loadKeysPage", "../pages/KeysPage", "KeysPage"],
      ["modelStats", "loadModelStatsPage", "../pages/ModelStatsPage", "ModelStatsPage"],
      ["serviceStatus", "loadServiceStatusPage", "../pages/ServiceStatusPage", "ServiceStatusPage"],
      ["subscriptions", "loadSubscriptionsPage", "../pages/SubscriptionsPage", "SubscriptionsPage"],
      ["systemSettings", "loadSystemSettingsPage", "../pages/SystemSettingsPage", "SystemSettingsPage"],
      ["usage", "loadUsagePage", "../pages/UsagePage", "UsagePage"]
    ] as const;

    for (const [page, loader, modulePath, component] of pages) {
      expect(mainWindowApp).toMatch(
        new RegExp(
          `async function ${loader}\\(\\)\\s*\\{\\s*return \\{ default: \\(await import\\("${modulePath}"\\)\\)\\.${component} \\};\\s*\\}`
        )
      );
      expect(mainWindowApp).toMatch(
        new RegExp(`<RetryableLazyPage\\s+page="${page}"\\s+loader=\\{${loader}\\}`)
      );
    }
  });

  it("keeps cold account and usage pages local, with an error-aware retry for their own resources", () => {
    expect(mainWindowApp).toContain('primaryResources: readonly AccountDataResourceKey[]');
    expect(mainWindowApp).toContain('diagnosticResources: readonly AccountDataResourceKey[] = primaryResources');
    expect(mainWindowApp).toContain('const primaryEntries = primaryResources.map((resource) => resourcePresentation[resource]);');
    expect(mainWindowApp).toContain('const diagnosticEntries = diagnosticResources.map((resource) => resourcePresentation[resource]);');
    expect(mainWindowApp).toContain('["managedKeys"],\n    KEYS_PAGE_RESOURCES');
    expect(mainWindowApp).toContain('["subscriptions"],\n    SUBSCRIPTIONS_PAGE_RESOURCES');

    const keys = sourceBetween('{nav === "keys" && (', '{nav === "usage" && (');
    expect(keys).toContain("shouldRenderColdPageState(keysPageDataState, Boolean(selectedAccountId))");
    expect(keys).toContain('<WorkspaceLoadingState\n                  page="keys"');
    expect(keys).toContain("error={keysPageDataState.lastError}");
    expect(keys).toContain("accountDataWorkspace.refreshResources(");
    expect(keys).toContain('{ force: true, mode: "background" }');

    const usage = sourceBetween('{nav === "usage" && (', '{nav === "modelStats" && (');
    expect(usage).toContain("shouldRenderColdPageState(presentation, Boolean(selectedAccountId))");
    expect(usage).toContain('<WorkspaceLoadingState\n                  page="usage"');
    expect(usage).toContain("error={presentation.lastError}");
    expect(usage).toContain('refreshUsageWorkspaceSilently({ mode: "background" })');
    expect(usage).toContain("usageModelSummariesLoading={usageModelSummariesInitialLoading}");

    const modelStats = sourceBetween('{nav === "modelStats" && (', '{nav === "subscriptions" && (');
    expect(modelStats).toContain("shouldRenderColdPageState(presentation, Boolean(selectedAccountId))");
    expect(modelStats).toContain('<WorkspaceLoadingState\n                  page="modelStats"');
    expect(modelStats).toContain("error={presentation.lastError}");
    expect(modelStats).toContain('refreshUsageSurfaceSilently("modelStats", { mode: "background" })');
    expect(modelStats).toContain("loading={usageModelSummariesInitialLoading}");

    const subscriptions = sourceBetween('{nav === "subscriptions" && (', '{nav === "trends" && (');
    expect(subscriptions).toContain("shouldRenderColdPageState(subscriptionsPageDataState, Boolean(selectedAccountId))");
    expect(subscriptions).toContain('<WorkspaceLoadingState\n                  page="subscriptions"');
    expect(subscriptions).toContain("error={subscriptionsPageDataState.lastError}");
    expect(subscriptions).toContain("accountDataWorkspace.refreshResources(");
    expect(subscriptions).toContain('{ force: true, mode: "background" }');
    expect(subscriptions).toContain("subscriptionQuotaAlerts: true");
    expect(subscriptions).toContain("subscriptionQuotaAlerts={accountDataWorkspace.subscriptionQuotaAlerts}");
    expect(subscriptions).toContain("onRefreshSubscriptionQuotaAlerts={async (saved, accountId) => {");
    expect(subscriptions).toContain("applySubscriptionQuotaAlertConfig(accountId, saved)");
    expect(subscriptions).toContain("{ subscriptionQuotaAlerts: true }");
  });

  it("does not add an artificial cold data gate to system settings or the service-status terminal", () => {
    const serviceStatus = sourceBetween('{nav === "serviceStatus" && (', '{nav === "settings" && (');
    expect(serviceStatus).toContain("workspace={topbarServiceStatusWorkspace}");
    expect(serviceStatus).not.toContain("shouldRenderColdPageState");
    expect(serviceStatus).not.toContain("WorkspaceLoadingState");

    const systemSettings = sourceBetween('{nav === "systemSettings" && (', "const hasReadyOverviewScope");
    expect(systemSettings).toContain("desktopUiPrefs={desktopUi.prefs}");
    expect(systemSettings).not.toContain("shouldRenderColdPageState");
    expect(systemSettings).not.toContain("WorkspaceLoadingState");
  });

  it("does not retain a standalone key usage page or route", () => {
    expect(mainWindowApp).not.toContain("KeyUsagePage");
    expect(mainWindowApp).not.toContain('{nav === "keyUsage" && (');
  });

  it("keeps retained-snapshot failures actionable without a normal refresh banner", () => {
    const workspaceFrame = sourceBetween("          <WorkspaceFrame", "            onRetry={() => void retryCurrentWorkspaceSurface({");

    expect(workspaceFrame).not.toContain("refreshing={");
    expect(workspaceFrame).toContain("refreshError={workspaceHasRetainedSnapshot ? resolveWorkspaceRefreshError({");
    expect(workspaceFrame).toContain("}) : null}");
  });

  it("renders a retryable page-local error when the overview fails before its first snapshot", () => {
    const overview = sourceBetween('{nav === "overview" && overview && (', '{nav === "serviceStatus" && (');

    expect(overview).toContain('nav === "overview" && !overview && !loading && overviewLastError');
    expect(overview).toContain('<WorkspaceLoadingState\n          page="overview"');
    expect(overview).toContain("error={overviewLastError}");
    expect(overview).toContain("retryOverviewForCurrentScope().catch(() => undefined)");
  });

  it("lets the public service-status snapshot clear the frame loading overlay independently", () => {
    expect(mainWindowApp).toContain('nav === "serviceStatus"\n    ? serviceStatusPageDataState.initialLoading');
    expect(mainWindowApp).toContain('nav === "serviceStatus"\n    ? serviceStatusPageDataState.hasSnapshot');
    expect(mainWindowApp).toContain("const workspaceFrameLoading = ");
    expect(mainWindowApp).toContain("const workspaceFrameReady = ");
    expect(mainWindowApp).toContain("loading={workspaceFrameLoading}");
    expect(mainWindowApp).toContain("ready={workspaceFrameReady}");
  });

  it("connects hover intent, click navigation, and idle work through the bounded preloader without analytics", () => {
    expect(mainWindowApp).toContain("new PagePreloadCoordinator({ maxCompletedPages: 3 })");
    expect(mainWindowApp).toContain('import("./page-preload-coordinator")');
    expect(mainWindowApp).toContain("onNavIntent={schedulePagePreloadIntent}");

    const intent = sourceBetween("  function schedulePagePreloadIntent", "  useEffect(() => {");
    expect(intent).toContain('requestPagePreload(nextNav, "intent", nav)');

    const navigation = sourceBetween(
      "  function handleNavChange",
      "\n  const openProfileModal = useStableCallback"
    );
    expect(navigation).toContain('requestPagePreload(nextNav, "navigate", nav)');
    expect(navigation).toContain("setNav(nextNav)");

    const idle = sourceBetween("  useEffect(() => {\n    const candidate = getIdlePagePreloadCandidate(nav);", "  function handleActionKey");
    expect(idle).toContain("getIdlePagePreloadCandidate(nav)");
    expect(idle).toContain('requestPagePreload(candidate, "idle", nav)');

    const chunkPreload = sourceBetween("async function preloadPageChunk", "function scheduleIdlePagePreload");
    for (const loader of [
      "loadSystemSettingsPage",
      "loadUsagePage",
      "loadKeysPage",
      "loadSubscriptionsPage",
      "loadServiceStatusPage",
      "loadModelStatsPage"
    ]) {
      expect(chunkPreload).toContain(`await ${loader}()`);
    }
    expect(chunkPreload).not.toContain("AnalyticsLab");
  });
});
