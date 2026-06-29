import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FloatingPanelWindow } from "../src/app/FloatingPanelWindow";
import type { NotificationInboxItem } from "../src/features/overview/components/AlertInboxModal";
import type { OverviewPayload } from "../src/types";

const overview: OverviewPayload = {
  sites: [],
  accounts: [],
  totals: {
    balance: 42.5,
    totalSites: 1,
    totalAccounts: 1,
    totalApiKeys: 14,
    activeApiKeys: 10,
    todayRequests: 379,
    totalRequests: 0,
    todayActualCost: 0,
    totalActualCost: 0,
    todayTokens: 111_200_000,
    totalTokens: 0
  },
  alerts: [],
  platformSeries: [],
  trend: [],
  recentUsage: [],
  subscriptions: [],
  keys: [],
  generatedAt: "2026-06-14T10:00:00.000Z"
};

describe("FloatingPanelWindow", () => {
  const notificationItems: NotificationInboxItem[] = [
    {
      notificationKey: "service-status:status-1",
      source: "service-status",
      id: "status-1",
      severity: "critical",
      title: "检测到服务状态不可用",
      detail: "服务状态自动刷新发现异常: gpt-5.5 探测失败, probe timeout",
      createdAt: "2026-06-15T12:00:00.000Z",
      models: ["gpt-5.5"]
    }
  ];

  it("renders right-side icon rail with tooltip copy and bubble preview shell", () => {
    const html = renderToStaticMarkup(
      createElement(FloatingPanelWindow, {
        overview,
        currentAccountLabel: "主账号",
        currentSiteName: "AI INPUT",
        currentAccountBalance: 42.5,
        currentAccountSubscriptions: [],
        currentAccountRecentUsage: [],
        notificationItems,
        loading: false,
        keepVisible: false,
        floatingPanelOpacity: 0.82,
        onRefresh: () => {}
      })
    );

    expect(html).toContain("floating-panel-window-preview");
    expect(html).toContain("floating-panel-window-menu");
    expect(html).toContain("floating-menu-card visible dock-right");
    expect(html).toContain("floating-menu-tooltip dock-right");
    expect(html).toContain("floating-panel-window dock-right visible");
    expect(html).not.toContain("floating-preview-bubble-tail");
    expect(html).toContain('aria-label="实时总览"');
    expect(html).toContain('title="实时总览 · 余额、请求、Token"');
    expect(html).toContain("今日请求");
    expect(html).toContain("379");
  });

  it("keeps the icon rail and default overview metrics when not switched", () => {
    const html = renderToStaticMarkup(
      createElement(FloatingPanelWindow, {
        overview: {
          ...overview,
          alerts: []
        },
        currentAccountLabel: "主账号",
        currentSiteName: "AI INPUT",
        currentAccountBalance: 42.5,
        currentAccountSubscriptions: [],
        currentAccountRecentUsage: [],
        notificationItems,
        loading: false,
        keepVisible: false,
        floatingPanelOpacity: 0.82,
        onRefresh: () => {}
      })
    );

    expect(html).toContain("实时总览");
    expect(html).toContain("今日 Tokens");
    expect(html).toContain("floating-menu-item-icon");
  });

  it("stays visible when keepVisible is enabled", () => {
    const html = renderToStaticMarkup(
      createElement(FloatingPanelWindow, {
        overview,
        currentAccountLabel: "主账号",
        currentSiteName: "AI INPUT",
        currentAccountBalance: 42.5,
        currentAccountSubscriptions: [],
        currentAccountRecentUsage: [],
        notificationItems,
        loading: false,
        keepVisible: true,
        floatingPanelOpacity: 0.82,
        onRefresh: () => {},
        initialPanel: "alerts"
      })
    );

    expect(html).toContain("floating-panel-window dock-right visible");
    expect(html).toContain("pinned-glass");
  });

  it("renders service status notifications inside the alerts panel", () => {
    const html = renderToStaticMarkup(
      createElement(FloatingPanelWindow, {
        overview,
        currentAccountLabel: "主账号",
        currentSiteName: "AI INPUT",
        currentAccountBalance: 42.5,
        currentAccountSubscriptions: [],
        currentAccountRecentUsage: [],
        notificationItems,
        loading: false,
        keepVisible: true,
        floatingPanelOpacity: 0.82,
        onRefresh: () => {},
        initialPanel: "alerts"
      })
    );

    expect(html).toContain("优先告警");
    expect(html).toContain("检测到服务状态不可用");
  });
});
