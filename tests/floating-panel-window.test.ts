import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  FloatingPanelWindow,
  type FloatingQuickSwitchSnapshot
} from "../src/app/FloatingPanelWindow";
import type { AccountRuntime, UsageStatsRecord } from "../src/types";

const account: AccountRuntime = {
  id: "account-1",
  siteId: "site-1",
  label: "主账号",
  email: "main@example.com",
  balanceWarning: -1,
  lastLoginAt: null,
  createdAt: "2026-06-14T10:00:00.000Z",
  updatedAt: "2026-06-14T10:00:00.000Z",
  site: null,
  sessionState: "ready",
  lastError: null,
  cacheView: null
};

const dashboardStats: UsageStatsRecord = {
  totalRequests: 379,
  totalInputTokens: 111_200_000,
  totalOutputTokens: 2_500_000,
  totalCacheTokens: 6_800_000,
  totalCacheCreationTokens: 3_100_000,
  totalCacheReadTokens: 3_700_000,
  totalTokens: 120_500_000,
  totalCost: 42.5,
  totalActualCost: 42.5,
  averageDurationMs: 367,
  rpm: 84.1,
  tpm: 1_540_000
};

const quickSwitchSnapshot: FloatingQuickSwitchSnapshot = {
  managedKeys: [],
  groups: [],
  subscriptionDetails: []
};

function renderFloatingPanel(overrides: Partial<ComponentProps<typeof FloatingPanelWindow>> = {}) {
  return renderToStaticMarkup(
    createElement(FloatingPanelWindow, {
      currentAccountId: account.id,
      currentSiteId: account.siteId,
      currentAccountLabel: account.label,
      accounts: [account],
      selectionState: "resolved",
      selectionError: null,
      dashboardStats,
      dashboardStatsLoading: false,
      dashboardStatsError: null,
      dashboardStatsUpdatedAt: "2026-06-15T12:00:00.000Z",
      currentAccountSubscriptionDetails: [],
      currentAccountRecentUsage: [],
      managedKeys: [],
      groups: [],
      loading: false,
      keepVisible: false,
      floatingPanelOpacity: 0.82,
      onRefresh: () => {},
      onAccountSelect: async () => {},
      onValidateQuickSwitch: async () => quickSwitchSnapshot,
      onSubmitQuickSwitch: async () => ({ kind: "succeeded", snapshot: quickSwitchSnapshot }),
      onReloadQuickSwitchData: async () => quickSwitchSnapshot,
      ...overrides
    })
  );
}

describe("FloatingPanelWindow", () => {
  it("renders the right-side command panel and current overview metrics", () => {
    const html = renderFloatingPanel();

    expect(html).toContain("floating-panel-window dock-right visible");
    expect(html).toContain("floating-command-panel dock-right");
    expect(html).toContain("floating-command-tab selected");
    expect(html).toContain('aria-label="刷新悬浮面板"');
    expect(html).toContain("实时总览");
    expect(html).toContain("今日请求");
    expect(html).toContain("379");
  });

  it("keeps the overview metric shell when dashboard data has not loaded", () => {
    const html = renderFloatingPanel({ dashboardStats: null });

    expect(html).toContain("实时总览");
    expect(html).toContain("今日 Token");
    expect(html).toContain("等待统计");
    expect(html).toContain("floating-command-tab");
  });

  it("stays visible when keepVisible is enabled", () => {
    const html = renderFloatingPanel({ keepVisible: true });

    expect(html).toContain("floating-panel-window dock-right visible");
    expect(html).toContain("pinned-glass");
  });

  it("renders the quick-switch empty state for the subscriptions panel", () => {
    const html = renderFloatingPanel({ initialPanel: "subscriptions" });

    expect(html).toContain("快速切换");
    expect(html).toContain("暂无可切换密钥");
  });
});
