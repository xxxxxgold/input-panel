// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildFloatingQuickSwitchCandidates,
  FloatingPanelWindow,
  resolveFloatingQuickSwitchPanelKey,
  resolveFloatingUsageIp,
  sortFloatingUsageRows
} from "../src/app/FloatingPanelWindow";
import { resolveFloatingPanelWindowHeight } from "../src/app/floating-panel-size";
import type { SubscriptionDetailRecord } from "../src/subscription-view";
import type {
  AccountRuntime,
  GroupRecord,
  ManagedKeyRecord,
  OverviewDashboardStatsPayload,
  UsageRow
} from "../src/types";

const floatingPanelSource = readFileSync(
  resolve(process.cwd(), "src/app/FloatingPanelWindow.tsx"),
  "utf8"
);
const floatingStyles = readFileSync(
  resolve(process.cwd(), "src/styles/06-floating.css"),
  "utf8"
);

const dashboardStats: OverviewDashboardStatsPayload = {
  todayStats: {
    totalRequests: 7_054,
    totalInputTokens: 47_538_402,
    totalOutputTokens: 3_999_040,
    totalCacheReadTokens: 888_452_864,
    totalTokens: 939_990_306,
    totalCost: 667.94163175,
    totalActualCost: 667.94163175,
    averageDurationMs: 22_873.705,
    rpm: 26,
    tpm: 136_307
  },
  totalStats: {
    totalRequests: 215_127,
    totalInputTokens: 3_347_325_632,
    totalOutputTokens: 179_662_883,
    totalCacheReadTokens: 36_678_762_390,
    totalTokens: 40_205_750_905,
    totalCost: 31_686.9147461,
    totalActualCost: 31_686.9147461,
    averageDurationMs: 22_873.705,
    rpm: 26,
    tpm: 136_307
  },
  totalApiKeys: 11,
  activeApiKeys: 11,
  platformSeries: []
};

const subscriptionDetails: SubscriptionDetailRecord[] = [
  {
    id: "subscription-pro",
    subscriptionKey: "group:101",
    identityAmbiguous: false,
    name: "Pro 订阅",
    status: "active",
    platform: "openai",
    groupName: "pro-group",
    sourceGroupId: 101,
    expiresAt: "2026-08-11T00:00:00.000Z",
    dailyUsedUsd: 12.5,
    dailyLimitUsd: 50,
    dailyWindowStart: "2026-07-11T00:00:00.000Z",
    weeklyUsedUsd: 48,
    weeklyLimitUsd: 200,
    weeklyWindowStart: "2026-07-07T00:00:00.000Z",
    monthlyUsedUsd: 120,
    monthlyLimitUsd: 500,
    monthlyWindowStart: "2026-07-01T00:00:00.000Z"
  },
  {
    id: "subscription-team",
    subscriptionKey: "group:202",
    identityAmbiguous: false,
    name: "Team 订阅",
    status: "active",
    platform: "openai",
    groupName: "team-group",
    sourceGroupId: 202,
    expiresAt: "2026-09-11T00:00:00.000Z",
    dailyUsedUsd: 1,
    dailyLimitUsd: 30,
    dailyWindowStart: "2026-07-11T00:00:00.000Z",
    weeklyUsedUsd: 5,
    weeklyLimitUsd: 100,
    weeklyWindowStart: "2026-07-07T00:00:00.000Z",
    monthlyUsedUsd: 11,
    monthlyLimitUsd: 300,
    monthlyWindowStart: "2026-07-01T00:00:00.000Z"
  }
];

const managedKeys: ManagedKeyRecord[] = [
  {
    id: "key-pro",
    name: "生产密钥",
    status: "active",
    groupId: 101,
    groupName: "pro-group"
  }
];

const groups: GroupRecord[] = [
  { id: 101, name: "pro-group", description: null, platform: "openai", rateMultiplier: 1 },
  { id: 202, name: "team-group", description: null, platform: "openai", rateMultiplier: 1 }
];

const recentUsage: UsageRow[] = [
  {
    id: "usage-earlier",
    createdAt: "2026-07-11T08:00:00.000Z",
    model: "gpt-4.1",
    actualCost: 0.12,
    totalCost: 0.12,
    inputTokens: 100,
    outputTokens: 30,
    totalTokens: 130,
    durationMs: 1_200,
    apiKeyName: "早期密钥",
    ipAddress: ""
  },
  {
    id: "usage-latest",
    createdAt: "2026-07-11T09:00:00.000Z",
    model: "gpt-5",
    actualCost: 0.34,
    totalCost: 0.34,
    inputTokens: 200,
    outputTokens: 80,
    totalTokens: 280,
    durationMs: 2_500,
    apiKeyName: "最新密钥",
    ipAddress: "2001:db8:85a3::8a2e:370:7334"
  }
];

const snapshot = {
  managedKeys,
  groups,
  subscriptionDetails
};

const accounts: AccountRuntime[] = [
  {
    id: "account-primary",
    siteId: "site-primary",
    label: "主账号",
    email: "primary@example.com",
    balanceWarning: -1,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    sessionState: "ready",
    site: {
      id: "site-primary",
      name: "AI INPUT",
      baseUrl: "https://example.com",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    }
  },
  {
    id: "account-secondary",
    siteId: "site-primary",
    label: "副账号",
    email: "secondary@example.com",
    balanceWarning: -1,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    sessionState: "ready",
    site: {
      id: "site-primary",
      name: "AI INPUT",
      baseUrl: "https://example.com",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    }
  }
];

const defaultProps: ComponentProps<typeof FloatingPanelWindow> = {
  currentAccountId: "account-primary",
  currentSiteId: "site-primary",
  currentAccountLabel: "主账号",
  accounts,
  selectionState: "resolved",
  selectionError: null,
  dashboardStats: dashboardStats.todayStats,
  dashboardStatsLoading: false,
  dashboardStatsError: null,
  dashboardStatsUpdatedAt: "2026-07-11T09:30:00.000Z",
  currentAccountSubscriptionDetails: subscriptionDetails,
  currentAccountRecentUsage: recentUsage,
  managedKeys,
  groups,
  loading: false,
  keepVisible: false,
  floatingPanelOpacity: 0.82,
  onRefresh: () => {},
  onAccountSelect: async () => {},
  onValidateQuickSwitch: async () => snapshot,
  onSubmitQuickSwitch: async () => ({ kind: "succeeded", snapshot }),
  onReloadQuickSwitchData: async () => snapshot
};

function renderFloatingPanel(overrides: Partial<ComponentProps<typeof FloatingPanelWindow>> = {}) {
  return renderToStaticMarkup(createElement(FloatingPanelWindow, { ...defaultProps, ...overrides }));
}

afterEach(() => {
  cleanup();
});

describe("FloatingPanelWindow", () => {
  it("renders every current-account subscription with status, usage, and progress", () => {
    const html = renderFloatingPanel();

    expect(html).toContain("floating-command-panel dock-right");
    expect(html).toContain("selection-resolved");
    expect(html).not.toContain("selection-placeholder");
    expect(html).toContain("floating-command-status tone-success");
    expect(html).toContain('aria-label="悬浮面板工具栏"');
    expect(html).toContain('aria-label="实时总览"');
    expect(html).toContain('aria-label="最新用量"');
    expect(html).toContain('aria-label="快速切换"');
    expect(html).toContain("floating-command-tabs");
    expect(html).toContain("floating-command-tab selected");
    expect(html).toContain(">总览<");
    expect(html).toContain(">用量<");
    expect(html).toContain(">切换<");
    expect(html).not.toContain('aria-label="优先告警"');
    expect(html).not.toContain('aria-label="订阅与账号"');
    expect(html.match(/class="usage-detail-trigger"/g)).toHaveLength(4);
    expect(html).toContain('aria-label="今日金额明细"');
    expect(html).toContain('aria-label="实时 RPM/TPM 明细"');
    expect(html).toContain("$667.9416");
    expect(html).toContain("26/136.3K");
    expect(html).toContain("订阅概览");
    expect(html).toContain('aria-label="查看订阅概览说明"');
    expect(html).not.toContain("当前账号的全部订阅与额度");
    expect(html).not.toContain(">2 项<");
    expect(html).not.toContain(">实时<");
    expect(html).not.toContain(">今日<");
    expect(html).not.toContain("floating-metric-tag");
    expect(html).toContain('aria-label="RPM/TPM: 26/136.3K，已更新"');
    expect(html).toContain("Pro 订阅");
    expect(html).toContain("Team 订阅");
    expect(html).toContain("正常");
    expect(html).toContain("剩余");
    expect(html).toContain('class="floating-subscription-name" title="Pro 订阅"');
    expect(html).toContain('class="floating-subscription-meta"><span title="openai">openai</span><span title="剩余');
    expect(html.indexOf("floating-subscription-name")).toBeLessThan(html.indexOf("floating-subscription-status"));
    expect(html.indexOf("floating-subscription-status")).toBeLessThan(html.indexOf("floating-subscription-meta"));
    expect(html).toContain("$12.50 / $50.00");
    expect(html).toContain("$5.00 / $100.00");
    expect(html).toContain('style="width:25%"');
    expect(html).toContain('style="width:5%"');
    expect(html).toContain('aria-label="当前账号订阅列表"');
    expect(html).not.toContain(">+1<");
  });

  it("opens the account switcher from the account label and switches accounts", async () => {
    const onAccountSelect = vi.fn().mockResolvedValue(undefined);
    const view = render(createElement(FloatingPanelWindow, {
      ...defaultProps,
      onAccountSelect
    }));
    const trigger = view.getByRole("button", { name: "切换账号，当前主账号" });

    fireEvent.click(trigger);

    expect(view.getByRole("dialog", { name: "切换账号" })).toBeTruthy();
    expect(view.getByRole("button", { name: "主账号，当前账号" })).toBeTruthy();
    expect(view.getByRole("button", { name: "切换到 副账号" })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "切换到 副账号" }));
    await waitFor(() => expect(onAccountSelect).toHaveBeenCalledWith(accounts[1]));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "切换账号" })).toBeNull());
  });

  it("does not let an earlier switch result close a newly reopened account dialog", async () => {
    let resolveFirst: (() => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    const firstSwitch = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const secondSwitch = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const onAccountSelect = vi.fn()
      .mockImplementationOnce(() => firstSwitch)
      .mockImplementationOnce(() => secondSwitch);
    const view = render(createElement(FloatingPanelWindow, {
      ...defaultProps,
      onAccountSelect
    }));
    const trigger = view.getByRole("button", { name: "切换账号，当前主账号" });

    fireEvent.click(trigger);
    fireEvent.click(view.getByRole("button", { name: "切换到 副账号" }));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(view.queryByRole("dialog", { name: "切换账号" })).toBeNull());

    fireEvent.click(trigger);
    fireEvent.click(view.getByRole("button", { name: "切换到 副账号" }));
    resolveFirst?.();

    await waitFor(() => expect(onAccountSelect).toHaveBeenCalledTimes(2));
    expect(view.getByRole("dialog", { name: "切换账号" })).toBeTruthy();

    resolveSecond?.();
    await waitFor(() => expect(view.queryByRole("dialog", { name: "切换账号" })).toBeNull());
  });

  it("closes the account switcher with Escape and restores trigger focus", async () => {
    const view = render(createElement(FloatingPanelWindow, defaultProps));
    const trigger = view.getByRole("button", { name: "切换账号，当前主账号" });
    trigger.focus();
    fireEvent.click(trigger);

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(view.queryByRole("dialog", { name: "切换账号" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("moves realtime metric loading feedback to the top-right refresh icon", () => {
    const view = render(createElement(FloatingPanelWindow, {
      ...defaultProps,
      dashboardStatsLoading: true,
      loading: false
    }));
    const refreshButton = view.getByRole("button", { name: "刷新悬浮面板" });

    expect(view.queryByText("正在读取上游实时指标...")).toBeNull();
    expect(refreshButton.getAttribute("aria-busy")).toBe("true");
    expect(refreshButton.querySelector(".lucide-refresh-cw")?.classList.contains("spin")).toBe(true);

    view.rerender(createElement(FloatingPanelWindow, {
      ...defaultProps,
      dashboardStatsLoading: false,
      dashboardStatsError: "上游超时",
      loading: false
    }));

    expect(refreshButton.getAttribute("aria-busy")).toBe("false");
    expect(refreshButton.querySelector(".lucide-refresh-cw")?.classList.contains("spin")).toBe(false);
    expect(view.getByText("实时指标暂不可用: 上游超时")).toBeTruthy();
  });

  it("formats the requested RPM/TPM sample and uses actual rather than standard cost", () => {
    const html = renderFloatingPanel({
      dashboardStats: {
        ...dashboardStats.todayStats,
        totalCost: 888.1234,
        totalActualCost: 12.3456,
        rpm: 5,
        tpm: 169_400
      }
    });

    expect(html).toContain('aria-label="RPM/TPM: 5/169.4K，已更新"');
    expect(html).toContain("$12.3456");
    expect(html).toContain("$888.1234");
  });

  it("uses the same aligned detail layout for all four overview metrics", () => {
    const html = renderFloatingPanel();

    expect(html.match(/class="floating-live-metric-detail"/g)).toHaveLength(4);
    for (const title of [
      "今日金额明细",
      "实时 RPM/TPM 明细",
      "今日 Token 明细",
      "今日请求明细"
    ]) {
      expect(html).toContain(`aria-label="${title}"`);
    }
    expect(floatingStyles).toMatch(
      /\.floating-live-metric-detail\s*\{[^}]*display:\s*grid;[^}]*gap:\s*0;/s
    );
    expect(floatingStyles).toMatch(
      /\.floating-live-metric-detail > span\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;[^}]*align-items:\s*baseline;/s
    );
    expect(floatingStyles).toMatch(
      /\.floating-live-metric-detail > span \+ span\s*\{[^}]*border-top:\s*1px solid color-mix\(in srgb, var\(--chart-tooltip-border\) 52%, transparent\);/s
    );
    expect(floatingStyles).toMatch(
      /\.floating-live-metric-detail > span > b\s*\{[^}]*font-variant-numeric:\s*tabular-nums;[^}]*text-align:\s*right;[^}]*white-space:\s*nowrap;/s
    );
  });

  it("only renders quota windows with finite positive limits", () => {
    const partialQuotaHtml = renderFloatingPanel({
      currentAccountSubscriptionDetails: [
        { ...subscriptionDetails[0], weeklyLimitUsd: null, monthlyLimitUsd: null }
      ]
    });

    expect(partialQuotaHtml).toContain("$12.50 / $50.00");
    expect(partialQuotaHtml).not.toContain("未提供额度上限");
    expect(partialQuotaHtml).not.toContain('aria-label="每周额度进度');
    expect(partialQuotaHtml).not.toContain('aria-label="每月额度进度');

    const subscriptionWithMissingQuotaLimits = {
      ...subscriptionDetails[1],
      dailyLimitUsd: Number.POSITIVE_INFINITY,
      weeklyLimitUsd: null,
      monthlyLimitUsd: Number.NEGATIVE_INFINITY
    };
    Reflect.deleteProperty(subscriptionWithMissingQuotaLimits, "weeklyLimitUsd");
    Reflect.deleteProperty(subscriptionWithMissingQuotaLimits, "monthlyLimitUsd");

    const noQuotaHtml = renderFloatingPanel({
      currentAccountSubscriptionDetails: [
        {
          ...subscriptionDetails[0],
          dailyLimitUsd: 0,
          weeklyLimitUsd: -1,
          monthlyLimitUsd: Number.NaN
        },
        subscriptionWithMissingQuotaLimits
      ]
    });

    expect(noQuotaHtml).not.toContain('aria-label="Pro 订阅额度详情"');
    expect(noQuotaHtml).not.toContain('aria-label="Team 订阅额度详情"');
    expect(noQuotaHtml).not.toContain("floating-subscription-quotas");
    expect(noQuotaHtml).not.toContain("floating-subscription-quota");
    expect(noQuotaHtml).not.toContain("未提供额度上限");
    expect(noQuotaHtml.match(/floating-subscription-name/g)).toHaveLength(2);
    expect(noQuotaHtml.match(/floating-subscription-status/g)).toHaveLength(2);
    expect(noQuotaHtml.match(/floating-subscription-meta/g)).toHaveLength(2);
    expect(noQuotaHtml).toContain('class="floating-subscription-name" title="Pro 订阅"');
    expect(noQuotaHtml).toContain('class="floating-subscription-name" title="Team 订阅"');
    expect(noQuotaHtml).toContain('class="floating-subscription-status tone-ready">正常</span>');
    expect(noQuotaHtml).toContain('<span title="openai">openai</span>');
    expect(noQuotaHtml).toContain('title="剩余');
  });

  it("shows a newly created account with normal no-data placeholders before it logs in", () => {
    const html = renderFloatingPanel({
      currentAccountLabel: "新账号",
      dashboardStats: null,
      dashboardStatsLoading: false,
      dashboardStatsError: null,
      dashboardStatsUpdatedAt: null,
      currentAccountSubscriptionDetails: [],
      currentAccountRecentUsage: []
    });

    expect(html).toContain("新账号");
    expect(html).toContain("<strong>--</strong>");
    expect(html).toContain("尚未读取到订阅数据。");
    expect(html).not.toContain("请选择账号");
  });

  it("keeps a selected account with a blank label in the resolved state", () => {
    const commonOverrides = {
      currentAccountId: "account-with-blank-label",
      currentAccountLabel: "",
      selectionState: "resolved" as const,
      dashboardStats: null,
      currentAccountSubscriptionDetails: [],
      currentAccountRecentUsage: [],
      managedKeys: [],
      groups: []
    };
    const panels = [
      renderFloatingPanel(commonOverrides),
      renderFloatingPanel({ ...commonOverrides, initialPanel: "usage" }),
      renderFloatingPanel({ ...commonOverrides, initialPanel: "subscriptions" })
    ];

    for (const html of panels) {
      expect(html).toContain("selection-resolved");
      expect(html).not.toContain("selection-placeholder");
      expect(html).toContain("floating-command-status tone-success");
      expect(html).toContain("未命名账号");
      expect(html).not.toContain("暂无可用账号");
      expect(html).not.toContain("floating-account-alert");
    }
  });

  it("returns to the empty selection state after the final account is removed", () => {
    const html = renderFloatingPanel({
      currentAccountId: null,
      currentAccountLabel: null,
      selectionState: "empty",
      dashboardStats: null,
      currentAccountSubscriptionDetails: [],
      currentAccountRecentUsage: [],
      managedKeys: [],
      groups: []
    });

    expect(html).toContain("selection-empty selection-placeholder");
    expect(html).toContain("floating-command-status tone-warning");
    expect(html).toContain("floating-account-alert tone-warning");
    expect(html).toContain("账号不可用");
    expect(html).toContain("暂无可用账号");
    expect(html).toContain("请先在主窗口添加账号，或切换到已有账号。");
    expect(html).toContain("账号与站点");
    expect(html).not.toContain("请选择账号");
  });

  it("shows selection loading rather than stale account data during a cross-window switch", () => {
    const html = renderFloatingPanel({
      currentAccountId: null,
      currentAccountLabel: null,
      selectionState: "resolving",
      dashboardStats: null,
      currentAccountSubscriptionDetails: [],
      currentAccountRecentUsage: [],
      managedKeys: [],
      groups: []
    });

    expect(html).toContain("正在读取账号");
    expect(html).toContain("selection-resolving selection-placeholder");
    expect(html).toContain("floating-command-status tone-info");
    expect(html).toContain("floating-account-alert tone-info");
    expect(html).toContain("正在同步");
    expect(html).not.toContain("账号与站点");
    expect(html).not.toContain("请选择账号");
  });

  it("keeps every floating panel view in the selection-loading state until the new overview resolves", () => {
    const usageHtml = renderFloatingPanel({
      initialPanel: "usage",
      currentAccountId: null,
      currentAccountLabel: null,
      selectionState: "resolving",
      currentAccountRecentUsage: []
    });
    const quickSwitchHtml = renderFloatingPanel({
      initialPanel: "subscriptions",
      currentAccountId: null,
      currentAccountLabel: null,
      selectionState: "resolving",
      managedKeys: [],
      groups: []
    });

    expect(usageHtml).toContain("正在读取账号");
    expect(usageHtml).not.toContain("请选择账号");
    expect(quickSwitchHtml).toContain("正在读取账号");
    expect(quickSwitchHtml).not.toContain("请选择账号");
  });

  it("keeps every floating panel view in a retryable error state after selection resolution fails", () => {
    const commonOverrides = {
      currentAccountId: null,
      currentAccountLabel: null,
      selectionState: "retryable-error" as const,
      selectionError: "当前账号暂时无法确认，请点击刷新重试。"
    };
    const overviewHtml = renderFloatingPanel(commonOverrides);
    const usageHtml = renderFloatingPanel({
      ...commonOverrides,
      initialPanel: "usage"
    });
    const quickSwitchHtml = renderFloatingPanel({
      ...commonOverrides,
      initialPanel: "subscriptions"
    });

    for (const html of [overviewHtml, usageHtml, quickSwitchHtml]) {
      expect(html).toContain("账号同步失败");
      expect(html).toContain("当前账号暂时无法确认，请点击刷新重试。");
      expect(html).toContain("selection-retryable-error selection-placeholder");
      expect(html).toContain("floating-command-status tone-danger");
      expect(html).toContain("floating-account-alert tone-danger");
      expect(html).toContain("同步异常");
      expect(html).toContain('role="alert"');
      expect(html).not.toContain("请选择账号");
    }
  });

  it("maps unresolved account states to the compact native window height", () => {
    expect(resolveFloatingPanelWindowHeight(null)).toBe(196);
    expect(resolveFloatingPanelWindowHeight("account-primary")).toBe(456);
    expect(floatingPanelSource).toContain(
      "appWindow.setSize(new LogicalSize(FLOATING_PANEL_WIDTH, panelWindowHeight))"
    );
    expect(floatingPanelSource).toContain(
      "resolveFloatingPanelWindowHeight(currentAccountId)"
    );
    expect(floatingPanelSource).toContain("previousGeometry.position.y + heightDelta");
  });

  it("hydrates the Tauri panel from the native visibility state after event listeners are ready", () => {
    const setupStart = floatingPanelSource.indexOf("async function setup()");
    const syncListener = floatingPanelSource.indexOf('"floating-panel-sync"', setupStart);
    const hideListener = floatingPanelSource.indexOf('"floating-panel-hide"', setupStart);
    const nativeStateRead = floatingPanelSource.indexOf("getFloatingPanelVisible()", setupStart);

    expect(syncListener).toBeGreaterThan(setupStart);
    expect(hideListener).toBeGreaterThan(syncListener);
    expect(nativeStateRead).toBeGreaterThan(hideListener);
    expect(floatingPanelSource).toContain("const hydrationEventVersion = visibilityEventVersionRef.current;");
    expect(floatingPanelSource).toContain(
      "visibilityEventVersionRef.current === hydrationEventVersion"
    );
    expect(floatingPanelSource).toContain("unlistenSync();");
    expect(floatingPanelSource).toContain("unlistenHide();");
  });

  it("keeps CSS panel height aligned with the native compact/full size contract", () => {
    expect(floatingStyles).toMatch(
      /\.floating-command-panel\s*\{[^}]*width:\s*392px;[^}]*height:\s*456px;/s
    );
    expect(floatingStyles).toMatch(
      /\.floating-panel-window\.selection-placeholder \.floating-command-panel\s*\{[^}]*height:\s*196px;/s
    );
    expect(floatingStyles).toContain(".floating-account-alert.tone-info");
    expect(floatingStyles).toContain(".floating-account-alert.tone-danger");
    expect(floatingStyles).toContain(".floating-account-switcher-backdrop");
    expect(floatingStyles).toMatch(
      /\.floating-account-switcher-dialog\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto;[^}]*overflow:\s*hidden;/s
    );
    expect(floatingStyles).toMatch(
      /\.floating-account-switcher-list\s*\{[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;/s
    );
    expect(floatingStyles).toContain("border-left: 3px solid var(--floating-account-tone)");
    expect(floatingStyles).toContain(".floating-command-tabs");
    expect(floatingStyles).toMatch(
      /\.floating-command-content\.panel-overview\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*minmax\(0, 1fr\);/s
    );
    expect(floatingStyles).toMatch(
      /\.floating-overview-content\s*\{[^}]*height:\s*100%;[^}]*display:\s*grid;[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);/s
    );
    expect(floatingStyles).toContain(".floating-subscription-list");
    expect(floatingStyles).toContain("overflow-y: auto");
    expect(floatingStyles).toContain("overscroll-behavior: contain");
    expect(floatingStyles).toContain("overflow-x: hidden");
    expect(floatingStyles).toMatch(
      /\.floating-command-content \.floating-live-metric\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;[^}]*align-items:\s*center;/s
    );
    expect(floatingStyles).toMatch(
      /\.floating-command-content \.floating-live-metric strong\s*\{[^}]*font-variant-numeric:\s*tabular-nums;[^}]*text-align:\s*right;/s
    );
    expect(floatingStyles).toContain(".floating-live-metric-copy");
    expect(floatingStyles).toMatch(
      /\.floating-subscription-item-heading\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;[^}]*align-items:\s*center;/s
    );
    expect(floatingStyles).toContain(".floating-subscription-name");
    expect(floatingStyles).not.toContain(".floating-subscription-count");
    expect(floatingStyles).not.toContain("quota-unavailable");
    expect(floatingStyles).toMatch(
      /\.floating-command-tabs\s*\{[^}]*var\(--bg-soft\)/s
    );
    expect(floatingStyles).toMatch(
      /\.floating-command-content \.floating-live-metric\s*\{[^}]*var\(--bg-card\)/s
    );
    expect(floatingStyles).toMatch(
      /\.floating-subscription-item\s*\{[^}]*var\(--bg-card\)/s
    );
    expect(floatingStyles).toContain(".floating-usage-record");
    expect(floatingStyles).toContain("overflow-x: hidden");
    expect(floatingStyles).toMatch(
      /\.floating-command-panel\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*1;/s
    );
  });

  it("uses site and account identity to remount the quick-switch state and discard an earlier snapshot", () => {
    const accountAKey = resolveFloatingQuickSwitchPanelKey("account-a", "site-a");
    const sameAccountDifferentSiteKey = resolveFloatingQuickSwitchPanelKey("account-a", "site-b");
    const accountBKey = resolveFloatingQuickSwitchPanelKey("account-b", "site-a");

    expect(accountAKey).not.toBe(accountBKey);
    expect(accountAKey).not.toBe(sameAccountDifferentSiteKey);
    expect(resolveFloatingQuickSwitchPanelKey(null)).toBe("unselected-account");
  });

  it("renders latest usage in descending time order and preserves IPv6 with an empty-value fallback", () => {
    const html = renderFloatingPanel({ initialPanel: "usage" });

    expect(html.indexOf("最新密钥")).toBeLessThan(html.indexOf("早期密钥"));
    expect(html).toContain("2001:db8:85a3::8a2e:370:7334");
    expect(html).toContain("floating-usage-record");
    expect(html).toContain('aria-label="查看 gpt-5 调用详情"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="table"');
    expect(resolveFloatingUsageIp(recentUsage[0])).toBe("-");
    expect(sortFloatingUsageRows(recentUsage).map((row) => row.id)).toEqual(["usage-latest", "usage-earlier"]);
  });

  it("expands a usage record on click and supports keyboard collapse", () => {
    const view = render(createElement(FloatingPanelWindow, {
      ...defaultProps,
      initialPanel: "usage"
    }));
    const trigger = view.getByRole("button", { name: "查看 gpt-5 调用详情" });

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const detail = view.getByRole("region", { name: "gpt-5 调用详情" });
    expect(detail.textContent).toContain("完整时间");
    expect(detail.textContent).toContain("缓存读取");
    expect(detail.textContent).toContain("来源 IP");

    fireEvent.keyDown(trigger, { key: "Enter" });

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByRole("region", { name: "gpt-5 调用详情" })).toBeNull();
  });

  it("renders a direct quick-switch action without exposing removed alert navigation", () => {
    const html = renderFloatingPanel({ initialPanel: "subscriptions" });

    expect(html).toContain("选择要切换的密钥");
    expect(html).toContain("当前绑定");
    expect(html).toContain("候选订阅");
    expect(html).toContain("Team 订阅");
    expect(html).toContain('aria-label="切换到 Team 订阅"');
    expect(html).not.toContain("floating-switch-candidate selected");
    expect(html).not.toContain("立即切换");
    expect(html).not.toContain("确认提交");
    expect(html).not.toContain("优先告警");
  });

  it("validates and submits the clicked subscription immediately", async () => {
    const switchedSnapshot = {
      ...snapshot,
      managedKeys: [{ ...managedKeys[0], groupId: 202, groupName: "team-group" }]
    };
    const onValidateQuickSwitch = vi.fn().mockResolvedValue(snapshot);
    const onSubmitQuickSwitch = vi.fn().mockResolvedValue({ kind: "succeeded", snapshot: switchedSnapshot });
    const view = render(createElement(FloatingPanelWindow, {
      ...defaultProps,
      initialPanel: "subscriptions",
      onValidateQuickSwitch,
      onSubmitQuickSwitch
    }));

    fireEvent.click(view.getByRole("button", { name: "切换到 Team 订阅" }));

    await waitFor(() => {
      expect(onValidateQuickSwitch).toHaveBeenCalledTimes(1);
      expect(onSubmitQuickSwitch).toHaveBeenCalledWith({ keyId: "key-pro", groupId: 202 });
    });
    expect(view.getByText("已将 生产密钥 切换到 Team 订阅。")).toBeTruthy();
    expect(view.queryByRole("button", { name: "立即切换" })).toBeNull();
    expect(view.queryByText("确认切换")).toBeNull();
  });

  it("changes the selected key without starting a subscription switch", () => {
    const onValidateQuickSwitch = vi.fn().mockResolvedValue(snapshot);
    const onSubmitQuickSwitch = vi.fn().mockResolvedValue({ kind: "succeeded", snapshot });
    const view = render(createElement(FloatingPanelWindow, {
      ...defaultProps,
      initialPanel: "subscriptions",
      managedKeys: [
        ...managedKeys,
        { ...managedKeys[0], id: "key-team", name: "备用密钥", groupId: 202, groupName: "team-group" }
      ],
      onValidateQuickSwitch,
      onSubmitQuickSwitch
    }));

    const selector = view.getByRole("combobox", { name: "选择要切换的密钥" });
    fireEvent.change(selector, { target: { value: "key-team" } });

    expect((selector as HTMLSelectElement).value).toBe("key-team");
    expect(onValidateQuickSwitch).not.toHaveBeenCalled();
    expect(onSubmitQuickSwitch).not.toHaveBeenCalled();
  });

  it("prevents duplicate submissions while validating a clicked subscription", async () => {
    let resolveValidation: ((value: typeof snapshot) => void) | null = null;
    const onValidateQuickSwitch = vi.fn(() => new Promise<typeof snapshot>((resolve) => {
      resolveValidation = resolve;
    }));
    const onSubmitQuickSwitch = vi.fn().mockResolvedValue({ kind: "succeeded", snapshot });
    const view = render(createElement(FloatingPanelWindow, {
      ...defaultProps,
      initialPanel: "subscriptions",
      onValidateQuickSwitch,
      onSubmitQuickSwitch
    }));
    const candidate = view.getByRole("button", { name: "切换到 Team 订阅" });

    fireEvent.click(candidate);
    fireEvent.click(candidate);

    expect(onValidateQuickSwitch).toHaveBeenCalledTimes(1);
    expect(candidate.getAttribute("aria-busy")).toBe("true");
    resolveValidation?.(snapshot);
    await waitFor(() => expect(onSubmitQuickSwitch).toHaveBeenCalledTimes(1));
  });

  it("styles the native key selector and its dark-theme option popup", () => {
    expect(floatingStyles).toContain(".floating-switch-field select {");
    expect(floatingStyles).toContain("background-color: var(--bg-modal);");
    expect(floatingStyles).toContain(".floating-switch-field option {");
    expect(floatingStyles).toContain("html.titan-noir .floating-switch-field select,");
    expect(floatingStyles).toContain("html.ember-circuit .floating-switch-field select,");
    expect(floatingStyles).toContain("html.verdant-core .floating-switch-field select {");
    expect(floatingStyles).toContain("color-scheme: dark;");
    expect(floatingStyles).toMatch(
      /\.floating-switch-field option:checked\s*\{[^}]*background-color:\s*color-mix\(in srgb, var\(--accent\) 18%, var\(--bg-modal\)\);/s
    );
  });

  it("keeps only ready subscriptions with a different group as quick-switch candidates", () => {
    const candidates = buildFloatingQuickSwitchCandidates({
      key: managedKeys[0],
      groups,
      subscriptionDetails: [
        ...subscriptionDetails,
        { ...subscriptionDetails[1], id: "disabled", name: "停用订阅", status: "disabled", sourceGroupId: 303 },
        { ...subscriptionDetails[1], id: "same-group", name: "同组订阅", sourceGroupId: 101 }
      ]
    });

    expect(candidates).toEqual([
      expect.objectContaining({ groupId: 202, name: "Team 订阅" })
    ]);
  });

  it("renders mirrored left-dock classes for the compact command panel", () => {
    const html = renderFloatingPanel({ initialDock: "left", keepVisible: true });

    expect(html).toContain("floating-panel-window dock-left visible");
    expect(html).toContain("floating-command-panel dock-left");
    expect(html).toContain("floating-command-header");
    expect(html).toContain("pinned-glass");
  });
});
