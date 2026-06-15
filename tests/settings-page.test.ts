import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { runSiteAccountRowAction, runSiteCardAction, SettingsPage } from "../src/pages/SettingsPage";
import type { AccountRuntime, SiteRecord } from "../src/types";

const site: SiteRecord = {
  id: "site-1",
  name: "AI INPUT",
  baseUrl: "https://ai.input.im",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-15T00:00:00.000Z"
};

const account: AccountRuntime = {
  id: "account-1",
  siteId: "site-1",
  label: "主账号",
  email: "main@example.com",
  balanceWarning: -1,
  lastLoginAt: null,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-15T00:00:00.000Z",
  site,
  sessionState: "ready",
  lastError: null,
  snapshot: {
    fetchedAt: "2026-06-15T15:30:00.000Z",
    online: true,
    siteName: "AI INPUT",
    siteUrl: "https://ai.input.im",
    accountLabel: "主账号",
    emailMasked: "m***@example.com",
    balance: 42.5,
    currency: "USD",
    stats: {
      totalApiKeys: 9,
      activeApiKeys: 9,
      todayRequests: 12,
      totalRequests: 120,
      todayActualCost: 3.2,
      totalActualCost: 22.8,
      todayCost: 3.2,
      totalCost: 22.8,
      todayTokens: 120000,
      totalTokens: 960000,
      todayInputTokens: 70000,
      todayOutputTokens: 50000,
      averageDurationMs: 540,
      byPlatform: []
    },
    usageSummary: {
      totalRequests: 120,
      totalTokens: 960000,
      totalInputTokens: 600000,
      totalOutputTokens: 360000,
      totalActualCost: 22.8,
      totalCost: 22.8,
      averageDurationMs: 540
    },
    recentUsage: [],
    requestHistory: [],
    trend: [],
    keys: [],
    subscriptions: [],
    activeSubscription: null,
    alerts: []
  }
};

describe("SettingsPage site detail panel", () => {
  it("renders selected site details and current site accounts below the site list", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsPage, {
        siteSearch: "",
        onSiteSearchChange: () => {},
        filteredSites: [site],
        accounts: [account],
        selectedSite: site,
        visibleSnapshot: account.snapshot,
        onOpenNewSite: () => {},
        onSelectSite: () => {},
        onOpenSiteAccountManager: () => {},
        onOpenEditSite: () => {},
        onRemoveSite: () => {},
        onOpenNewAccount: () => {},
        onOpenAccountManager: () => {},
        handleActionKey: () => {}
      })
    );

    expect(html).toContain("当前站点账号");
    expect(html).toContain("站点余额汇总");
    expect(html).toContain("$42.50");
    expect(html).toContain("管理账号");
    expect(html).toContain("Keys 9 / 活跃 9");
    expect(html).toContain("打开");
    expect(html).not.toContain("请求记录详情");
    expect(html).not.toContain("本地累计请求记录");
    expect(html).not.toContain("本次最新拉取");
  });

  it("treats site account rows as select-on-click and edit-on-double-click", () => {
    const calls: string[] = [];
    const actions = runSiteAccountRowAction({
      account,
      onSelectAccount: (nextAccount) => calls.push(`select:${nextAccount.id}`),
      onEditAccount: (nextAccount) => calls.push(`edit:${nextAccount.id}`)
    });

    actions.handleClick();
    actions.handleDoubleClick();

    expect(calls).toEqual([`select:${account.id}`, `edit:${account.id}`]);
  });

  it("opens account manager on single click when the site card is already selected", () => {
    const calls: string[] = [];
    runSiteCardAction({
      site,
      selectedSiteId: site.id,
      onSelectSite: (siteId) => calls.push(`select:${siteId}`),
      onOpenSiteAccountManager: (currentSite) => calls.push(`open:${currentSite.id}`)
    });

    expect(calls).toEqual([`open:${site.id}`]);
  });

  it("selects the site first when clicking a non-selected site card", () => {
    const calls: string[] = [];
    runSiteCardAction({
      site,
      selectedSiteId: "site-2",
      onSelectSite: (siteId) => calls.push(`select:${siteId}`),
      onOpenSiteAccountManager: (currentSite) => calls.push(`open:${currentSite.id}`)
    });

    expect(calls).toEqual([`select:${site.id}`]);
  });
});
