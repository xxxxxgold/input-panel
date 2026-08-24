import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionList } from "../src/features/subscriptions/components/SubscriptionList";
import type { SubscriptionRecord } from "../src/types";

describe("SubscriptionList quota bar tiers", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-13T12:00:00+08:00"));

  it("hides duplicated group labels while keeping the matching quota tone class", () => {
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
          current: 350.57,
          limit: 500,
          windowStart: "2026-06-11T00:00:00+08:00"
        },
        weekly: null,
        monthly: null
      }
    ];

    const html = renderToStaticMarkup(
      createElement(SubscriptionList, {
        subscriptions
      })
    );

    expect(html).toContain("bar-fill quota-tier-80");
    expect(html).toContain("bar-track quota-tier-80");
    expect(html).toContain("width:70.114%");
    expect(html).toContain("quota-progress-percent quota-tier-80");
    expect(html).toContain(">70.1%</small>");
    expect(html).toContain("subscription-platform-pill openai");
    expect(html).toContain(">Openai</span>");
    expect(html).toContain("status-pill ready");
    expect(html).toContain(">正常</span>");
    expect(html).toContain("剩余 363 天");
    expect(html).toContain("到期时间: 2027/06/10 13:54:40");
    expect(html).not.toContain(">CodeX Plus 月度</p>");
    expect(html).not.toContain("额度提醒 98%");
    expect(html.indexOf("subscription-platform-pill openai")).toBeLessThan(html.indexOf("<strong>CodeX Plus 月度</strong>"));
  });

  it("keeps a secondary label when group name differs from the title", () => {
    const subscriptions: SubscriptionRecord[] = [
      {
        id: "sub-custom",
        subscriptionKey: "group:8",
        identityKind: "group",
        identityAmbiguous: false,
        groupId: 8,
        name: "自定义套餐",
        groupName: "团队专线",
        status: "active",
        expiresAt: "2027-06-10T13:54:40+08:00",
        platform: "anthropic",
        daily: {
          current: 50,
          limit: 100,
          windowStart: "2026-06-11T00:00:00+08:00"
        },
        weekly: null,
        monthly: null
      }
    ];

    const html = renderToStaticMarkup(
      createElement(SubscriptionList, {
        subscriptions
      })
    );

    expect(html).toContain(">团队专线</p>");
    expect(html).toContain("subscription-platform-pill anthropic");
  });

  it("reuses the only known platform across the list before summary data arrives", () => {
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
          current: 350.57,
          limit: 500,
          windowStart: "2026-06-11T00:00:00+08:00"
        },
        weekly: null,
        monthly: null
      },
      {
        id: "sub-yearly",
        subscriptionKey: "group:18",
        identityKind: "group",
        identityAmbiguous: false,
        groupId: 18,
        name: "CodeX Plus 年度",
        groupName: "CodeX Plus 年度",
        status: "active",
        expiresAt: "2027-05-18T22:42:23+08:00",
        platform: null,
        daily: {
          current: 125.3,
          limit: 500,
          windowStart: null
        },
        weekly: null,
        monthly: null
      }
    ];

    const html = renderToStaticMarkup(
      createElement(SubscriptionList, {
        subscriptions
      })
    );

    expect(html).toContain("CodeX Plus 年度");
    expect(html).toContain("subscription-platform-pill openai");
    expect(html).toContain(">Openai</span>");
    expect(html).not.toContain(">未知平台</span>");
    expect(html).not.toContain(">unknown</span>");
  });

  it("falls back to a localized label when no platform is available anywhere in the list", () => {
    const subscriptions: SubscriptionRecord[] = [
      {
        id: "sub-platform-missing",
        subscriptionKey: "group:28",
        identityKind: "group",
        identityAmbiguous: false,
        groupId: 28,
        name: "备用套餐",
        groupName: "备用套餐",
        status: "active",
        expiresAt: null,
        platform: null,
        daily: {
          current: 12,
          limit: 100,
          windowStart: null
        },
        weekly: null,
        monthly: null
      }
    ];

    const html = renderToStaticMarkup(
      createElement(SubscriptionList, {
        subscriptions
      })
    );

    expect(html).toContain("subscription-platform-pill unknown");
    expect(html).toContain(">未知平台</span>");
    expect(html).not.toContain(">unknown</span>");
  });

  it("still renders expiration details when daily quota has no window start", () => {
    const subscriptions: SubscriptionRecord[] = [
      {
        id: "sub-yearly",
        subscriptionKey: "group:18",
        identityKind: "group",
        identityAmbiguous: false,
        groupId: 18,
        name: "CodeX Plus 年度",
        groupName: "CodeX Plus 年度",
        status: "active",
        expiresAt: "2027-05-18T22:42:23+08:00",
        platform: "openai",
        daily: {
          current: 0,
          limit: 500,
          windowStart: null
        },
        weekly: null,
        monthly: null
      }
    ];

    const html = renderToStaticMarkup(
      createElement(SubscriptionList, {
        subscriptions
      })
    );

    expect(html).toContain(">0.0%</small>");
    expect(html).toContain("到期情况: 剩余 340 天");
    expect(html).toContain("到期时间: 2027/05/18 22:42:23");
  });

  it("shows the effective default, percentage, dollar, and disabled quota alert summaries", () => {
    const buildSubscription = (id: string, subscriptionKey: string): SubscriptionRecord => ({
      id,
      subscriptionKey,
      identityKind: "group",
      identityAmbiguous: false,
      groupId: Number(id.replace(/\D/g, "")) || 1,
      name: id,
      groupName: id,
      status: "active",
      expiresAt: null,
      platform: "openai",
      daily: null,
      weekly: null,
      monthly: null
    });
    const subscriptions = [
      buildSubscription("订阅 1", "group:1"),
      buildSubscription("订阅 2", "group:2"),
      buildSubscription("订阅 3", "group:3"),
      buildSubscription("订阅 4", "group:4")
    ];

    const html = renderToStaticMarkup(
      createElement(SubscriptionList, {
        subscriptions,
        quotaAlertSettings: {
          defaultRule: {
            enabled: true,
            thresholdMode: "usage_percent",
            thresholdValue: 98,
            revision: 0
          },
          overrides: [
            {
              subscriptionKey: "group:2",
              rule: { enabled: true, thresholdMode: "usage_percent", thresholdValue: 85.5, revision: 1 }
            },
            {
              subscriptionKey: "group:3",
              rule: { enabled: true, thresholdMode: "amount_usd", thresholdValue: 120, revision: 1 }
            },
            {
              subscriptionKey: "group:4",
              rule: { enabled: false, thresholdMode: "usage_percent", thresholdValue: 98, revision: 1 }
            }
          ]
        }
      })
    );

    expect(html).toContain("额度提醒 98%");
    expect(html).toContain("额度提醒 85.5%");
    expect(html).toContain("额度提醒 $120");
    expect(html).toContain("额度提醒 已关闭");
    expect(html).toContain("lucide-bell-off");
    expect(html.indexOf("<strong>订阅 1</strong>")).toBeLessThan(
      html.indexOf("subscription-quota-alert-summary enabled")
    );
    expect(html.indexOf("subscription-quota-alert-summary enabled")).toBeLessThan(
      html.indexOf("subscription-card-meta")
    );
    expect(html.match(/<button/g)).toHaveLength(4);
    expect(html).not.toContain("<input");
  });

  it("renders clickable subscription cards when a detail handler is provided", () => {
    const subscriptions: SubscriptionRecord[] = [
      {
        id: "sub-clickable",
        subscriptionKey: "group:18",
        identityKind: "group",
        identityAmbiguous: false,
        groupId: 18,
        name: "CodeX Plus 年度",
        groupName: "CodeX Plus 年度",
        status: "active",
        expiresAt: "2027-05-18T22:42:23+08:00",
        platform: "openai",
        daily: {
          current: 243.8,
          limit: 500,
          windowStart: "2026-06-15T00:00:00+08:00"
        },
        weekly: null,
        monthly: null
      }
    ];

    const html = renderToStaticMarkup(
      createElement(SubscriptionList, {
        subscriptions,
        selectedSubscriptionId: "sub-clickable",
        onSelectSubscription: () => {}
      })
    );

    expect(html).toContain("subscription-card-button");
    expect(html).toContain("aria-pressed=\"true\"");
    expect(html).toContain("查看 CodeX Plus 年度 的订阅详情");
    expect(html).toContain("subscription-card subscription-card-button selected");
  });
});
