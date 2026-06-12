import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Topbar } from "../src/app/Topbar";
import type { TopbarSubscriptionPreviewRecord } from "../src/subscription-view";
import type { AccountRuntime } from "../src/types";

describe("Topbar subscription peek", () => {
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
    expect(html).not.toContain("topbar-subscription-dots");
  });
});
