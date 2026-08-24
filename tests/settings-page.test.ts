import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const siteFailoverStatusHook = vi.hoisted(() => ({
  useSiteFailoverStatus: vi.fn()
}));

vi.mock("../src/features/accounts/useSiteFailoverStatus", () => siteFailoverStatusHook);

import {
  runSiteAccountRowAction,
  runSiteCardAction,
  SettingsPage
} from "../src/pages/SettingsPage";
import type {
  AccountRuntime,
  SiteFailoverStatusPayload,
  SiteRecord
} from "../src/types";
import type { AccountSyncStatusPresentation } from "../src/app/account-sync-status-presentation";
import { readBundledStyles } from "./helpers/styles";

const bundledStyles = readBundledStyles();

const site: SiteRecord = {
  id: "site-1",
  name: "AI INPUT",
  baseUrl: "https://ai.input.im",
  fallbackBaseUrls: ["https://input.codes"],
  failoverCooldownSeconds: 60,
  retryCountPerAddress: 0,
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
  cacheView: {
    fetchedAt: "2026-06-15T15:30:00.000Z",
    online: true,
    siteName: "AI INPUT",
    balance: 42.5,
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
    recentUsage: [],
    trend: [],
    keys: [],
    subscriptions: [],
    activeSubscription: null,
    alerts: []
  }
};

const confirmedEmptySyncStatusPresentation: AccountSyncStatusPresentation = {
  accountId: account.id,
  hasSnapshot: true,
  initialLoading: false,
  statuses: [],
  lastError: null
};

beforeEach(() => {
  siteFailoverStatusHook.useSiteFailoverStatus.mockReset();
  siteFailoverStatusHook.useSiteFailoverStatus.mockReturnValue({
    status: null,
    loading: false,
    error: null,
    nowMs: Date.parse("2026-06-15T15:30:00.000Z"),
    addressActions: {},
    refresh: async () => {},
    clearCooldown: async () => {}
  });
});
describe("SettingsPage site detail panel", () => {
  it("renders selected site details and current site accounts below the site list", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsPage, {
        siteSearch: "",
        onSiteSearchChange: () => {},
        filteredSites: [site],
        accounts: [account],
        selectedSite: site,
        selectedAccountId: account.id,
        currentAccountBalance: 51.75,
        currentAccountTotalKeys: 12,
        currentAccountActiveKeys: 10,
        currentAccountSubscriptions: account.cacheView?.subscriptions ?? [],
        currentAccountSyncStatusPresentation: confirmedEmptySyncStatusPresentation,
        onOpenNewSite: () => {},
        onSelectSite: () => {},
        onOpenSiteAccountManager: () => {},
        onOpenEditSite: () => {},
        onRemoveSite: () => {},
        onOpenNewAccount: () => {},
        onSelectAccount: () => {},
        onEditAccount: () => {},
        onRemoveAccount: () => {},
        handleActionKey: () => {}
      })
    );

    expect(html).toContain("当前站点账号");
    expect(html).toContain("站点余额汇总");
    expect(html.match(/\$51\.75/g)).toHaveLength(4);
    expect(html).not.toContain("$42.50");
    expect(html).toContain("管理账号");
    expect(html).toContain("Keys 12 / 活跃 10");
    expect(html.match(/>删除<\/button>/g)).toHaveLength(2);
    expect(html).toContain("打开");
    expect(html).toContain("同步状态");
    expect(html).toContain("从未同步");
    expect(html).toContain("account-detail-summary-grid");
    expect(html).toContain("settings-account-sync");
    expect(html).toContain("settings-account-identity");
    expect(html).toContain("main@example.com");
    expect(html).toContain('class="settings-account-site">AI INPUT</span>');
    expect(html).toContain("编辑账号");
    expect(html).toContain("settings-account-stat");
    expect(html).toContain("settings-account-section-head");
    expect(html).toContain("当前账号详情");
    expect(html).toContain("全部订阅");
    expect(html).not.toContain("全部密钥");
    expect(html).not.toContain("配置订阅链");
    expect(html).not.toContain("功能配置");
    expect(html).not.toContain("全部 API Keys");
    expect(html).not.toContain("请求记录详情");
    expect(html).not.toContain("本地累计请求记录");
    expect(html).not.toContain("本次最新拉取");
    expect(bundledStyles).toMatch(/\.settings-account-detail\s*\{[^}]*margin-inline:\s*auto;/s);
    expect(bundledStyles).toMatch(/@media \(max-width: 1080px\) \{[\s\S]*?\.settings-site-management \.table-list\.wide \.site-account-row \{\s*grid-template-columns: minmax\(0, 1fr\);/);
    expect(bundledStyles).toMatch(/@media \(max-width: 1080px\) \{[\s\S]*?\.settings-site-management \.site-account-row \.row-actions \{[\s\S]*?width: 100%;[\s\S]*?min-width: 0;[\s\S]*?justify-content: flex-start;[\s\S]*?flex-wrap: wrap;/);
    expect(bundledStyles).toMatch(/@media \(max-width: 640px\) \{[\s\S]*?\.settings-site-management \.site-detail-grid \{\s*grid-template-columns: minmax\(0, 1fr\);/);
    expect(siteFailoverStatusHook.useSiteFailoverStatus).toHaveBeenCalledWith(site);
  });

  it("distinguishes an empty search result from an empty site collection", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsPage, {
        siteSearch: "missing-site",
        onSiteSearchChange: () => {},
        filteredSites: [],
        accounts: [account],
        selectedSite: site,
        selectedAccountId: account.id,
        currentAccountBalance: 51.75,
        currentAccountTotalKeys: 12,
        currentAccountActiveKeys: 10,
        currentAccountSubscriptions: [],
        currentAccountSyncStatusPresentation: {
          accountId: account.id,
          hasSnapshot: false,
          initialLoading: false,
          statuses: [],
          lastError: "服务暂不可用"
        },
        onOpenNewSite: () => {},
        onSelectSite: () => {},
        onOpenSiteAccountManager: () => {},
        onOpenEditSite: () => {},
        onRemoveSite: () => {},
        onOpenNewAccount: () => {},
        onSelectAccount: () => {},
        onEditAccount: () => {},
        onRemoveAccount: () => {},
        handleActionKey: () => {}
      })
    );

    expect(html).toContain("没有匹配的站点");
    expect(html).toContain("换个站点名称或 URL 试试。");
    expect(html).not.toContain("先添加第一个站点");
    expect(html).toContain("AI INPUT");
    expect(html).toContain("同步状态暂不可读取");
    expect(html).toContain("服务暂不可用");
    expect(html).not.toContain("从未同步");
  });

  it("keeps the live failover status separate from a retained sync failure", () => {
    const liveStatus: SiteFailoverStatusPayload = {
      siteId: site.id,
      activeBaseUrl: site.baseUrl,
      evaluationRevision: 7,
      transitionRevision: 11,
      serverNow: "2026-06-15T15:30:00.000Z",
      addresses: [
        {
          baseUrl: site.baseUrl,
          kind: "primary",
          status: "active",
          cooldownUntil: null,
          cooldownRemainingSeconds: null
        },
        {
          baseUrl: "https://input.codes",
          kind: "fallback",
          status: "cooling",
          cooldownUntil: "2026-06-15T15:31:00.000Z",
          cooldownRemainingSeconds: 60
        }
      ]
    };
    siteFailoverStatusHook.useSiteFailoverStatus.mockReturnValue({
      status: liveStatus,
      loading: false,
      error: null,
      nowMs: Date.parse(liveStatus.serverNow),
      addressActions: {},
      refresh: async () => {},
      clearCooldown: async () => {}
    });
    const html = renderToStaticMarkup(
      createElement(SettingsPage, {
        siteSearch: "",
        onSiteSearchChange: () => {},
        filteredSites: [site],
        accounts: [account],
        selectedSite: site,
        selectedAccountId: account.id,
        currentAccountBalance: 51.75,
        currentAccountTotalKeys: 12,
        currentAccountActiveKeys: 10,
        currentAccountSubscriptions: [],
        currentAccountSyncStatusPresentation: {
          accountId: account.id,
          hasSnapshot: true,
          initialLoading: false,
          statuses: [],
          lastError: "所有站点地址都在冷却中"
        },
        onOpenNewSite: () => {},
        onSelectSite: () => {},
        onOpenSiteAccountManager: () => {},
        onOpenEditSite: () => {},
        onRemoveSite: () => {},
        onOpenNewAccount: () => {},
        onSelectAccount: () => {},
        onEditAccount: () => {},
        onRemoveAccount: () => {},
        handleActionKey: () => {}
      })
    );

    expect(html).toContain("故障转移状态");
    expect(html).toContain("当前使用");
    expect(html).toContain("冷却中 60s");
    expect(html).toContain('aria-label="解除备用地址 1冷却"');
    expect(html).not.toContain('aria-label="解除主地址冷却"');
    expect(html).toContain("已保留上次读取结果: 所有站点地址都在冷却中");
    expect(bundledStyles).toContain(".site-failover-status-panel");
    expect(bundledStyles).toContain(".site-failover-address-row");
  });

  it("summarizes an all-cooling topology and prevents another clear while one is pending", () => {
    const allCoolingStatus: SiteFailoverStatusPayload = {
      siteId: site.id,
      activeBaseUrl: null,
      evaluationRevision: 8,
      transitionRevision: 12,
      serverNow: "2026-06-15T15:30:00.000Z",
      addresses: [
        {
          baseUrl: site.baseUrl,
          kind: "primary",
          status: "cooling",
          cooldownUntil: "2026-06-15T15:31:00.000Z",
          cooldownRemainingSeconds: 60
        },
        {
          baseUrl: site.fallbackBaseUrls[0],
          kind: "fallback",
          status: "cooling",
          cooldownUntil: "2026-06-15T15:30:30.000Z",
          cooldownRemainingSeconds: 30
        }
      ]
    };
    siteFailoverStatusHook.useSiteFailoverStatus.mockReturnValue({
      status: allCoolingStatus,
      loading: false,
      error: null,
      nowMs: Date.parse(allCoolingStatus.serverNow),
      addressActions: {
        [site.baseUrl]: { clearing: true, error: null }
      },
      refresh: async () => {},
      clearCooldown: async () => {}
    });
    const html = renderToStaticMarkup(
      createElement(SettingsPage, {
        siteSearch: "",
        onSiteSearchChange: () => {},
        filteredSites: [site],
        accounts: [account],
        selectedSite: site,
        selectedAccountId: account.id,
        currentAccountBalance: 51.75,
        currentAccountTotalKeys: 12,
        currentAccountActiveKeys: 10,
        currentAccountSubscriptions: [],
        currentAccountSyncStatusPresentation: confirmedEmptySyncStatusPresentation,
        onOpenNewSite: () => {},
        onSelectSite: () => {},
        onOpenSiteAccountManager: () => {},
        onOpenEditSite: () => {},
        onRemoveSite: () => {},
        onOpenNewAccount: () => {},
        onSelectAccount: () => {},
        onEditAccount: () => {},
        onRemoveAccount: () => {},
        handleActionKey: () => {}
      })
    );

    expect(html).toContain("所有地址冷却中，最早 30 秒后可重试");
    expect(html).toContain('aria-label="解除主地址冷却"');
    expect(html).toContain('aria-label="解除备用地址 1冷却"');
    expect(html).toMatch(
      /<button(?=[^>]*aria-label="解除备用地址 1冷却")(?=[^>]*disabled="")[^>]*>/
    );
    expect(html).not.toContain('site-failover-address-list" role="list" aria-live');
    expect(bundledStyles).toContain(".site-failover-all-cooling");
    expect(bundledStyles).toMatch(/@media \(max-width: 640px\) \{[\s\S]*?\.site-failover-address-row\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(bundledStyles).toMatch(/@media \(max-width: 640px\) \{[\s\S]*?\.site-failover-address-url\s*\{[\s\S]*?white-space:\s*normal;[\s\S]*?overflow-wrap:\s*anywhere;/);
  });

  it("does not render an old address snapshot after the selected topology changes", () => {
    const staleStatus: SiteFailoverStatusPayload = {
      siteId: site.id,
      activeBaseUrl: site.baseUrl,
      evaluationRevision: 7,
      transitionRevision: 11,
      serverNow: "2026-06-15T15:30:00.000Z",
      addresses: [
        {
          baseUrl: site.baseUrl,
          kind: "primary",
          status: "active",
          cooldownUntil: null,
          cooldownRemainingSeconds: null
        },
        {
          baseUrl: site.fallbackBaseUrls[0],
          kind: "fallback",
          status: "cooling",
          cooldownUntil: "2026-06-15T15:31:00.000Z",
          cooldownRemainingSeconds: 60
        }
      ]
    };
    const updatedSite: SiteRecord = {
      ...site,
      fallbackBaseUrls: ["https://new-fallback.example.com"],
      updatedAt: "2026-06-15T15:31:00.000Z"
    };
    siteFailoverStatusHook.useSiteFailoverStatus.mockReturnValue({
      status: staleStatus,
      loading: false,
      error: null,
      nowMs: Date.parse(staleStatus.serverNow),
      addressActions: {},
      refresh: async () => {},
      clearCooldown: async () => {}
    });
    const html = renderToStaticMarkup(
      createElement(SettingsPage, {
        siteSearch: "",
        onSiteSearchChange: () => {},
        filteredSites: [updatedSite],
        accounts: [account],
        selectedSite: updatedSite,
        selectedAccountId: account.id,
        currentAccountBalance: 51.75,
        currentAccountTotalKeys: 12,
        currentAccountActiveKeys: 10,
        currentAccountSubscriptions: [],
        currentAccountSyncStatusPresentation: confirmedEmptySyncStatusPresentation,
        onOpenNewSite: () => {},
        onSelectSite: () => {},
        onOpenSiteAccountManager: () => {},
        onOpenEditSite: () => {},
        onRemoveSite: () => {},
        onOpenNewAccount: () => {},
        onSelectAccount: () => {},
        onEditAccount: () => {},
        onRemoveAccount: () => {},
        handleActionKey: () => {}
      })
    );

    expect(html).toContain("暂未读取实时状态");
    expect(html).not.toContain("https://input.codes");
    expect(html).not.toContain('aria-label="解除备用地址 1冷却"');
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
