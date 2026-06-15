import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Topbar } from "../src/app/Topbar";
import type { TopbarSubscriptionPreviewRecord } from "../src/subscription-view";
import type { AccountRuntime, ServiceStatusPayload } from "../src/types";

afterEach(() => {
  vi.useRealTimers();
});

describe("Topbar subscription peek", () => {
  const serviceStatus: ServiceStatusPayload = {
    allOk: false,
    generatedAt: 1781449307,
    services: [
      {
        model: "gpt-5.5",
        uptimePct: 100,
        last: {
          ts: 1781449307,
          ok: true,
          latencyMs: 1379,
          error: null
        },
        history: []
      },
      {
        model: "gpt-5.4",
        uptimePct: 97.1,
        last: {
          ts: 1781449307,
          ok: false,
          latencyMs: null,
          error: "probe timeout"
        },
        history: []
      }
    ]
  };

  it("renders multi-dot indicators and subscription rows", () => {
    const selectedAccount = {
      id: "account-1",
      siteId: "site-1",
      label: "主账号",
      email: "demo@example.com",
      sessionState: "ready",
      site: {
        id: "site-1",
        name: "AI INPUT",
        baseUrl: "https://example.com",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z"
      }
    } satisfies Partial<AccountRuntime> as AccountRuntime;

    const subscriptions: TopbarSubscriptionPreviewRecord[] = [
      {
        id: "sub-1",
        name: "CodeX Plus 年度",
        status: "active",
        statusLabel: "正常",
        expiresAt: "2027-05-18T22:42:23+08:00",
        remainingDaysLabel: "剩余 340 天",
        accountLabel: "主账号",
        siteName: "AI INPUT",
        quota: {
          label: "每日",
          used: 437.11,
          limit: 500
        },
        quotaProgress: {
          percent: 87.422,
          rawPercent: 87.422,
          tone: "quota-tier-90"
        },
        indicatorTone: "quota-tier-90"
      },
      {
        id: "sub-2",
        name: "CodeX Plus 月度",
        status: "active",
        statusLabel: "正常",
        expiresAt: "2027-06-10T13:54:40+08:00",
        remainingDaysLabel: "剩余 363 天",
        accountLabel: "主账号",
        siteName: "AI INPUT",
        quota: {
          label: "每日",
          used: 206.75,
          limit: 500
        },
        quotaProgress: {
          percent: 41.35,
          rawPercent: 41.35,
          tone: "quota-tier-60"
        },
        indicatorTone: "quota-tier-60"
      }
    ];

    const html = renderToStaticMarkup(
      createElement(Topbar, {
        onReload: () => {},
        serviceStatus,
        serviceStatusRefreshing: false,
        topbarServiceStatusExpanded: false,
        setTopbarServiceStatusExpanded: () => {},
        topbarServiceStatusRef: createRef<HTMLDivElement>(),
        alertCount: 0,
        topbarAlertsExpanded: false,
        setTopbarAlertsExpanded: () => {},
        topbarAlertsRef: createRef<HTMLDivElement>(),
        topbarAlertPreview: [],
        closeTopbarAccountMenu: () => {},
        setTopbarSubscriptionsExpanded: () => {},
        topbarSubscriptionsExpanded: true,
        topbarSubscriptionsRef: createRef<HTMLDivElement>(),
        usageStatusLabel: "2 个有效订阅",
        usageStatusHint: "已用 $643.86",
        subscriptionSpend: 643.86,
        subscriptionCount: 2,
        subscriptionPreviewRecords: subscriptions,
        closeTopbarPeekPanels: () => {},
        onRefreshServiceStatus: () => {},
        onTriggerTestNotification: () => {},
        onOpenAlerts: () => {},
        onOpenSubscriptions: () => {},
        selectedAccount,
        topbarAccountMenuOpen: false,
        setTopbarAccountMenuOpen: () => {},
        topbarAccountMenuRef: createRef<HTMLDivElement>(),
        selectedAccountStatusLabel: "已连接",
        selectedAccountAvatarUrl: null,
        selectedSite: selectedAccount.site,
        topbarFilteredAccounts: [selectedAccount],
        accounts: [selectedAccount],
        topbarAccountSearch: "",
        setTopbarAccountSearch: () => {},
        onAccountSelect: () => {},
        onOpenProfileModal: () => {},
        onOpenSystemSettings: () => {},
        onOpenSettings: () => {},
        onRefreshSelectedAccount: () => {},
        onOpenSelectedAccountLogin: () => {}
      })
    );

    expect(html).toContain("topbar-subscription-dots");
    expect(html).toContain("topbar-subscription-dot quota-tier-90");
    expect(html).toContain("CodeX Plus 年度");
    expect(html).toContain("$437.11 / $500.00");
    expect(html).toContain("剩余 363 天");
  });

  it("renders empty state when there are no subscriptions", () => {
    const selectedAccount = {
      id: "account-1",
      siteId: "site-1",
      label: "主账号",
      email: "demo@example.com",
      sessionState: "ready",
      site: {
        id: "site-1",
        name: "AI INPUT",
        baseUrl: "https://example.com",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z"
      }
    } satisfies Partial<AccountRuntime> as AccountRuntime;

    const html = renderToStaticMarkup(
      createElement(Topbar, {
        onReload: () => {},
        serviceStatus,
        serviceStatusRefreshing: false,
        topbarServiceStatusExpanded: false,
        setTopbarServiceStatusExpanded: () => {},
        topbarServiceStatusRef: createRef<HTMLDivElement>(),
        alertCount: 0,
        topbarAlertsExpanded: false,
        setTopbarAlertsExpanded: () => {},
        topbarAlertsRef: createRef<HTMLDivElement>(),
        topbarAlertPreview: [],
        closeTopbarAccountMenu: () => {},
        setTopbarSubscriptionsExpanded: () => {},
        topbarSubscriptionsExpanded: true,
        topbarSubscriptionsRef: createRef<HTMLDivElement>(),
        usageStatusLabel: "等待同步",
        usageStatusHint: "暂无订阅数据",
        subscriptionSpend: 0,
        subscriptionCount: 0,
        subscriptionPreviewRecords: [],
        closeTopbarPeekPanels: () => {},
        onRefreshServiceStatus: () => {},
        onTriggerTestNotification: () => {},
        onOpenAlerts: () => {},
        onOpenSubscriptions: () => {},
        selectedAccount,
        topbarAccountMenuOpen: false,
        setTopbarAccountMenuOpen: () => {},
        topbarAccountMenuRef: createRef<HTMLDivElement>(),
        selectedAccountStatusLabel: "已连接",
        selectedAccountAvatarUrl: null,
        selectedSite: selectedAccount.site,
        topbarFilteredAccounts: [selectedAccount],
        accounts: [selectedAccount],
        topbarAccountSearch: "",
        setTopbarAccountSearch: () => {},
        onAccountSelect: () => {},
        onOpenProfileModal: () => {},
        onOpenSystemSettings: () => {},
        onOpenSettings: () => {},
        onRefreshSelectedAccount: () => {},
        onOpenSelectedAccountLogin: () => {}
      })
    );

    expect(html).toContain("当前没有订阅数据");
    expect(html).not.toContain("topbar-subscription-dot quota-tier-");
  });

  it("renders a live human-readable clock on the left side", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T14:05:09+08:00"));

    const selectedAccount = {
      id: "account-1",
      siteId: "site-1",
      label: "主账号",
      email: "demo@example.com",
      sessionState: "ready",
      site: {
        id: "site-1",
        name: "AI INPUT",
        baseUrl: "https://example.com",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z"
      }
    } satisfies Partial<AccountRuntime> as AccountRuntime;

    const html = renderToStaticMarkup(
      createElement(Topbar, {
        onReload: () => {},
        serviceStatus,
        serviceStatusRefreshing: false,
        topbarServiceStatusExpanded: false,
        setTopbarServiceStatusExpanded: () => {},
        topbarServiceStatusRef: createRef<HTMLDivElement>(),
        alertCount: 0,
        topbarAlertsExpanded: false,
        setTopbarAlertsExpanded: () => {},
        topbarAlertsRef: createRef<HTMLDivElement>(),
        topbarAlertPreview: [],
        closeTopbarAccountMenu: () => {},
        setTopbarSubscriptionsExpanded: () => {},
        topbarSubscriptionsExpanded: false,
        topbarSubscriptionsRef: createRef<HTMLDivElement>(),
        usageStatusLabel: "等待同步",
        usageStatusHint: "暂无订阅数据",
        subscriptionSpend: 0,
        subscriptionCount: 0,
        subscriptionPreviewRecords: [],
        closeTopbarPeekPanels: () => {},
        onRefreshServiceStatus: () => {},
        onTriggerTestNotification: () => {},
        onOpenAlerts: () => {},
        onOpenSubscriptions: () => {},
        selectedAccount,
        topbarAccountMenuOpen: false,
        setTopbarAccountMenuOpen: () => {},
        topbarAccountMenuRef: createRef<HTMLDivElement>(),
        selectedAccountStatusLabel: "已连接",
        selectedAccountAvatarUrl: null,
        selectedSite: selectedAccount.site,
        topbarFilteredAccounts: [selectedAccount],
        accounts: [selectedAccount],
        topbarAccountSearch: "",
        setTopbarAccountSearch: () => {},
        onAccountSelect: () => {},
        onOpenProfileModal: () => {},
        onOpenSystemSettings: () => {},
        onOpenSettings: () => {},
        onRefreshSelectedAccount: () => {},
        onOpenSelectedAccountLogin: () => {}
      })
    );

    expect(html).toContain("topbar-clock-card");
    expect(html).toContain("6月13日星期五");
    expect(html).toContain("14:05:09");
    expect(html).not.toContain("北京时间");
    expect(html.indexOf("6月13日星期五")).toBeLessThan(html.indexOf("14:05:09"));
  });

  it("renders a login trigger when there is no selected account", () => {
    const html = renderToStaticMarkup(
      createElement(Topbar, {
        onReload: () => {},
        serviceStatus,
        serviceStatusRefreshing: false,
        topbarServiceStatusExpanded: false,
        setTopbarServiceStatusExpanded: () => {},
        topbarServiceStatusRef: createRef<HTMLDivElement>(),
        alertCount: 0,
        topbarAlertsExpanded: false,
        setTopbarAlertsExpanded: () => {},
        topbarAlertsRef: createRef<HTMLDivElement>(),
        topbarAlertPreview: [],
        closeTopbarAccountMenu: () => {},
        setTopbarSubscriptionsExpanded: () => {},
        topbarSubscriptionsExpanded: false,
        topbarSubscriptionsRef: createRef<HTMLDivElement>(),
        usageStatusLabel: "等待同步",
        usageStatusHint: "暂无订阅数据",
        subscriptionSpend: 0,
        subscriptionCount: 0,
        subscriptionPreviewRecords: [],
        closeTopbarPeekPanels: () => {},
        onRefreshServiceStatus: () => {},
        onTriggerTestNotification: () => {},
        onOpenAlerts: () => {},
        onOpenSubscriptions: () => {},
        selectedAccount: null,
        topbarAccountMenuOpen: false,
        setTopbarAccountMenuOpen: () => {},
        topbarAccountMenuRef: createRef<HTMLDivElement>(),
        selectedAccountStatusLabel: "未选择账号",
        selectedAccountAvatarUrl: null,
        selectedSite: null,
        topbarFilteredAccounts: [],
        accounts: [],
        topbarAccountSearch: "",
        setTopbarAccountSearch: () => {},
        onAccountSelect: () => {},
        onOpenProfileModal: () => {},
        onOpenSystemSettings: () => {},
        onOpenSettings: () => {},
        onRefreshSelectedAccount: () => {},
        onOpenSelectedAccountLogin: () => {}
      })
    );

    expect(html).toContain("topbar-account-login-trigger");
    expect(html).toContain(">登录<");
    expect(html).toContain("前往站点账号配置");
    expect(html).not.toContain("当前账号菜单");
  });

  it("renders service status dots and service rows in the peek panel", () => {
    const selectedAccount = {
      id: "account-1",
      siteId: "site-1",
      label: "主账号",
      email: "demo@example.com",
      sessionState: "ready",
      site: {
        id: "site-1",
        name: "AI INPUT",
        baseUrl: "https://example.com",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z"
      }
    } satisfies Partial<AccountRuntime> as AccountRuntime;

    const html = renderToStaticMarkup(
      createElement(Topbar, {
        onReload: () => {},
        serviceStatus,
        serviceStatusRefreshing: false,
        topbarServiceStatusExpanded: true,
        setTopbarServiceStatusExpanded: () => {},
        topbarServiceStatusRef: createRef<HTMLDivElement>(),
        alertCount: 0,
        topbarAlertsExpanded: false,
        setTopbarAlertsExpanded: () => {},
        topbarAlertsRef: createRef<HTMLDivElement>(),
        topbarAlertPreview: [],
        closeTopbarAccountMenu: () => {},
        setTopbarSubscriptionsExpanded: () => {},
        topbarSubscriptionsExpanded: false,
        topbarSubscriptionsRef: createRef<HTMLDivElement>(),
        usageStatusLabel: "2 个有效订阅",
        usageStatusHint: "已用 $643.86",
        subscriptionSpend: 643.86,
        subscriptionCount: 2,
        subscriptionPreviewRecords: [],
        closeTopbarPeekPanels: () => {},
        onRefreshServiceStatus: () => {},
        onTriggerTestNotification: () => {},
        onOpenAlerts: () => {},
        onOpenSubscriptions: () => {},
        selectedAccount,
        topbarAccountMenuOpen: false,
        setTopbarAccountMenuOpen: () => {},
        topbarAccountMenuRef: createRef<HTMLDivElement>(),
        selectedAccountStatusLabel: "已连接",
        selectedAccountAvatarUrl: null,
        selectedSite: selectedAccount.site,
        topbarFilteredAccounts: [selectedAccount],
        accounts: [selectedAccount],
        topbarAccountSearch: "",
        setTopbarAccountSearch: () => {},
        onAccountSelect: () => {},
        onOpenProfileModal: () => {},
        onOpenSystemSettings: () => {},
        onOpenSettings: () => {},
        onRefreshSelectedAccount: () => {},
        onOpenSelectedAccountLogin: () => {}
      })
    );

    expect(html).toContain("服务状态");
    expect(html).toContain("topbar-service-status-dots");
    expect(html).toContain("topbar-subscription-dot subscription-dot-ready");
    expect(html).toContain("topbar-subscription-dot subscription-dot-critical");
    expect(html).toContain("gpt-5.5");
    expect(html).toContain("gpt-5.4");
    expect(html).toContain("立即刷新服务状态");
    expect(html).toContain("每 9 秒刷新一次最新探测结果");
    expect(html).toContain('aria-label="测试红色通知"');
    expect(html).toContain('aria-label="测试绿色通知"');
  });
});
