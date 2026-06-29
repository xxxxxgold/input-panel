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
    expect(html).toContain("status-pill ready");
    expect(html).toContain(">正常</span>");
    expect(html).toContain("剩余 363 天");
    expect(html).toContain("到期时间: 2027/06/10 13:54:40");
    expect(html).not.toContain(">CodeX Plus 月度</p>");
    expect(html.indexOf("subscription-platform-pill openai")).toBeLessThan(html.indexOf("<strong>CodeX Plus 月度</strong>"));
  });

  it("keeps a secondary label when group name differs from the title", () => {
    const subscriptions: SubscriptionRecord[] = [
      {
        id: "sub-custom",
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

  it("still renders expiration details when daily quota has no window start", () => {
    const subscriptions: SubscriptionRecord[] = [
      {
        id: "sub-yearly",
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

  it("renders clickable subscription cards when a detail handler is provided", () => {
    const subscriptions: SubscriptionRecord[] = [
      {
        id: "sub-clickable",
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
