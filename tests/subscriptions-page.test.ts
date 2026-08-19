import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SubscriptionsPage } from "../src/pages/SubscriptionsPage";
import type { SubscriptionRecord, SubscriptionSummaryPayload } from "../src/types";

describe("SubscriptionsPage layout", () => {
  it("renders summary as a dedicated top row before the subscription list area", () => {
    const subscriptions: SubscriptionRecord[] = [
        {
          id: "sub-monthly",
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
          managedKeys: []
      })
    );

    expect(html).toContain("subscriptions-page-layout");
    expect(html).toContain("subscription-summary-lead");
    expect(html).toContain("subscriptions-content-grid");
    expect(html.indexOf(">订阅摘要</h3>")).toBeLessThan(html.indexOf(">订阅列表</h3>"));
    expect(html).not.toContain(">订阅明细</h3>");
  });

  it("renders clickable subscription cards and no longer keeps a pinned detail panel", () => {
    const subscriptions: SubscriptionRecord[] = [
        {
          id: "sub-monthly",
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
          managedKeys: []
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
          managedKeys: []
      })
    );

    expect(html).toContain("$313.24 / $500.00");
    expect(html).not.toContain("$13.47 / $500.00");
  });
});

