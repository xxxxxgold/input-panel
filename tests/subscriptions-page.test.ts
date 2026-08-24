import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubscriptionDetailModal, SubscriptionsPage } from "../src/pages/SubscriptionsPage";
import { buildSubscriptionKeyUsageScopeKey } from "../src/features/subscriptions/subscription-key-usage-scope";
import type { SubscriptionDetailRecord } from "../src/subscription-view";
import * as usageClient from "../src/features/usage/client";
import type { ManagedKeyRecord, SubscriptionRecord, SubscriptionSummaryPayload } from "../src/types";

describe("SubscriptionsPage layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  vi.spyOn(usageClient, "getSubscriptionKeyUsage").mockResolvedValue({
    items: [
      {
        keyId: "key-1",
        apiKeyId: 101,
        rawKeyAvailable: true,
        keyName: "主生产 Key",
        status: "active",
        platform: "openai",
        groupName: "CodeX Plus 月度",
        planName: "CodeX Plus 月度",
        quotaMode: "quota_limited",
        quotaRemaining: 287.53,
        quotaLimit: 500,
        requests: 905,
        inputTokens: 112000000,
        outputTokens: 800000,
        totalTokens: 112800000,
        actualCost: 21.07
      }
    ],
    totalRequests: 905,
    totalInputTokens: 112000000,
    totalOutputTokens: 800000,
    totalTokens: 112800000,
    totalActualCost: 21.07,
    activeKeyCount: 1,
    inactiveKeyCount: 0
  });

  const managedKeys: ManagedKeyRecord[] = [
    {
      id: "key-1",
      apiKeyId: 101,
      name: "主生产 Key",
      status: "active",
      groupId: 3,
      groupName: "CodeX Plus 月度",
      platform: "openai"
    }
  ];

  it("renders summary as a dedicated top row before the subscription list area", () => {
    const subscriptions: SubscriptionRecord[] = [
        {
          id: "sub-monthly",
          subscriptionKey: "group:3",
          identityKind: "group",
          identityAmbiguous: false,
          groupId: 3,
          name: "CodeX Plus 月度",
          groupName: "CodeX Plus 月度",
          status: "active",
          expiresAt: "2027-06-10T13:54:40+08:00",
          platform: "openai",
          daily: {
            current: 13.47,
            limit: 500,
            windowStart: "2026-06-15T00:00:00+08:00"
          },
          weekly: null,
          monthly: null
        }

    ];

    const subscriptionSummary: SubscriptionSummaryPayload = {
      activeCount: 2,
      totalUsedUsd: 3977.0634,
      subscriptions: [
        {
          id: 3365,
          groupId: 3,
          groupName: "CodeX Plus 月度",
          status: "active",
          dailyUsedUsd: 13.47,
          dailyLimitUsd: 500,
          weeklyUsedUsd: 1677.64,
          monthlyUsedUsd: 1677.64,
          expiresAt: "2027-06-13T13:54:40+08:00"
        }
      ]
    };

    const html = renderToStaticMarkup(
      createElement(SubscriptionsPage, {
        subscriptions,
        subscriptionSummary,
        selectedAccountId: "account-1",
        managedKeys
      })
    );

    expect(html).toContain("subscriptions-page-layout");
    expect(html).toContain("subscription-summary-lead");
    expect(html).toContain("subscriptions-content-grid");
    expect(html.indexOf(">订阅摘要</h3>")).toBeLessThan(html.indexOf(">订阅列表</h3>"));
    expect(html).toContain('aria-label="查看订阅摘要说明"');
    expect(html).toContain('aria-label="查看订阅列表说明"');
    expect(html).not.toContain(">订阅明细</h3>");
  });

  it("renders clickable subscription cards and no longer keeps a pinned detail panel", () => {
    const subscriptions: SubscriptionRecord[] = [
        {
          id: "sub-monthly",
          subscriptionKey: "group:3",
          identityKind: "group",
          identityAmbiguous: false,
          groupId: 3,
          name: "CodeX Plus 月度",
          groupName: "CodeX Plus 月度",
          status: "active",
          expiresAt: "2027-06-13T13:54:40+08:00",
          platform: "openai",
          daily: {
            current: 13.47,
            limit: 500,
            windowStart: "2026-06-15T00:00:00+08:00"
          },
          weekly: {
            current: 1677.64,
            limit: 3000,
            windowStart: "2026-06-09T00:00:00+08:00"
          },
          monthly: {
            current: 1677.64,
            limit: 10000,
            windowStart: "2026-06-01T00:00:00+08:00"
          }
        }

    ];

    const subscriptionSummary: SubscriptionSummaryPayload = {
      activeCount: 2,
      totalUsedUsd: 3977.0634,
      subscriptions: [
        {
          id: 3365,
          groupId: 3,
          groupName: "CodeX Plus 月度",
          status: "active",
          dailyUsedUsd: 13.47,
          dailyLimitUsd: 500,
          weeklyUsedUsd: 1677.64,
          monthlyUsedUsd: 1677.64,
          expiresAt: "2027-06-13T13:54:40+08:00"
        }
      ]
    };

    const html = renderToStaticMarkup(
      createElement(SubscriptionsPage, {
        subscriptions,
        subscriptionSummary,
        selectedAccountId: "account-1",
        managedKeys
      })
    );

    expect(html).toContain("点击任意订阅卡片, 查看这个订阅更详细的额度和到期信息。");
    expect(html).toContain("查看 CodeX Plus 月度 的订阅详情");
    expect(html).toContain("subscription-card-button");
    expect(html).not.toContain("改为按订阅弹窗查看");
    expect(html).not.toContain(">订阅明细</h3>");
  });

  it("renders the subscription cards from merged summary data so the outer card matches the detail modal", () => {
    const subscriptions: SubscriptionRecord[] = [
        {
          id: "sub-monthly",
          subscriptionKey: "group:3",
          identityKind: "group",
          identityAmbiguous: false,
          groupId: 3,
          name: "CodeX Plus 月度",
          groupName: "CodeX Plus 月度",
          status: "active",
          expiresAt: "2027-06-13T13:54:40+08:00",
          platform: "openai",
          daily: {
            current: 13.47,
            limit: 500,
            windowStart: "2026-06-23T00:00:00+08:00"
          },
          weekly: null,
          monthly: null
        }

    ];

    const subscriptionSummary: SubscriptionSummaryPayload = {
      activeCount: 1,
      totalUsedUsd: 313.24,
      subscriptions: [
        {
          id: 3365,
          groupId: 3,
          groupName: "CodeX Plus 月度",
          status: "active",
          dailyUsedUsd: 313.24,
          dailyLimitUsd: 500,
          weeklyUsedUsd: 313.24,
          monthlyUsedUsd: 313.24,
          expiresAt: "2027-06-13T13:54:40+08:00"
        }
      ]
    };

    const html = renderToStaticMarkup(
      createElement(SubscriptionsPage, {
        subscriptions,
        subscriptionSummary,
        selectedAccountId: "account-1",
        managedKeys
      })
    );

    expect(html).toContain("$313.24 / $500.00");
    expect(html).not.toContain("$13.47 / $500.00");
  });

  it("renders subscription cards when only the live summary has rows", () => {
    const subscriptionSummary: SubscriptionSummaryPayload = {
      activeCount: 1,
      totalUsedUsd: 42.25,
      subscriptions: [
        {
          id: 3365,
          groupId: 3,
          groupName: "CodeX Plus 月度",
          status: "active",
          dailyUsedUsd: 42.25,
          dailyLimitUsd: 500,
          weeklyUsedUsd: 42.25,
          monthlyUsedUsd: 42.25,
          expiresAt: "2027-06-13T13:54:40+08:00"
        }
      ]
    };

    const html = renderToStaticMarkup(
      createElement(SubscriptionsPage, {
        subscriptions: [],
        subscriptionSummary,
        selectedAccountId: "account-1",
        managedKeys
      })
    );

    expect(html).toContain("CodeX Plus 月度");
    expect(html).toContain("$42.25 / $500.00");
    expect(html).not.toContain("当前没有订阅数据");
  });

  it("renders the subscription key usage section in the detail modal shell when a subscription is selected", () => {
    const subscriptions: SubscriptionRecord[] = [
      {
        id: "sub-clickable",
        subscriptionKey: "group:3",
        identityKind: "group",
        identityAmbiguous: false,
        groupId: 3,
        name: "CodeX Plus 月度",
        groupName: "CodeX Plus 月度",
        status: "active",
        expiresAt: "2027-06-13T13:54:40+08:00",
        platform: "openai",
        daily: {
          current: 42.25,
          limit: 500,
          windowStart: "2026-06-23T00:00:00+08:00"
        },
        weekly: null,
        monthly: null
      }
    ];

    const subscriptionSummary: SubscriptionSummaryPayload = {
      activeCount: 1,
      totalUsedUsd: 42.25,
      subscriptions: [
        {
          id: 3365,
          groupId: 3,
          groupName: "CodeX Plus 月度",
          status: "active",
          dailyUsedUsd: 42.25,
          dailyLimitUsd: 500,
          weeklyUsedUsd: 42.25,
          monthlyUsedUsd: 42.25,
          expiresAt: "2027-06-13T13:54:40+08:00"
        }
      ]
    };

    const html = renderToStaticMarkup(
      createElement(SubscriptionsPage, {
        subscriptions,
        subscriptionSummary,
        selectedAccountId: "account-1",
        managedKeys
      })
    );

    expect(html).toContain("订阅列表");
    expect(html).toContain("CodeX Plus 月度");
  });

  it("renders key usage section copy when the detail modal is opened", async () => {
    const record: SubscriptionDetailRecord = {
      id: "sub-detail",
      subscriptionKey: "group:3",
      identityAmbiguous: false,
      name: "CodeX Plus 月度",
      status: "active",
      platform: "openai",
      groupName: "CodeX Plus 月度",
      sourceGroupId: 3,
      expiresAt: "2027-06-13T13:54:40+08:00",
      dailyUsedUsd: 42.25,
      dailyLimitUsd: 500,
      dailyWindowStart: "2026-06-23T00:00:00+08:00",
      weeklyUsedUsd: 42.25,
      weeklyLimitUsd: 1000,
      weeklyWindowStart: "2026-06-20T00:00:00+08:00",
      monthlyUsedUsd: 42.25,
      monthlyLimitUsd: 3000,
      monthlyWindowStart: "2026-06-01T00:00:00+08:00"
    };

    const html = renderToStaticMarkup(
      createElement(SubscriptionDetailModal, {
        record,
        selectedAccountId: "account-1",
        managedKeys,
        onClose: () => {}
      })
    );

    expect(html).toContain("关联 Key 用量");
    expect(html).toContain("搜索 Key 名称或 ID");
    expect(html).toContain("按消耗排序");
    expect(html).toContain(">额度提醒</h3>");
    expect(html).toContain('value="98"');
    expect(html.indexOf("subscription-detail-window-grid"))
      .toBeLessThan(html.indexOf("subscription-quota-alert-editor"));
    expect(html.indexOf("subscription-quota-alert-editor"))
      .toBeLessThan(html.indexOf("subscription-detail-key-usage"));
  });
});
describe("subscription detail key usage scope", () => {
  const base = {
    accountId: "account-1",
    subscriptionId: "subscription-1",
    subscriptionKey: "group:3",
    relatedKeyIdsSignature: "key-1|key-2",
    startDate: "2026-08-05",
    endDate: "2026-08-05"
  };

  it("isolates a changed range or related key set from the current payload", () => {
    const scope = buildSubscriptionKeyUsageScopeKey(base);

    expect(buildSubscriptionKeyUsageScopeKey({ ...base, startDate: "2026-08-04" })).not.toBe(scope);
    expect(buildSubscriptionKeyUsageScopeKey({ ...base, endDate: "2026-08-06" })).not.toBe(scope);
    expect(buildSubscriptionKeyUsageScopeKey({ ...base, relatedKeyIdsSignature: "key-1" })).not.toBe(scope);
    expect(buildSubscriptionKeyUsageScopeKey({ ...base, subscriptionId: "subscription-2" })).not.toBe(scope);
  });
});
