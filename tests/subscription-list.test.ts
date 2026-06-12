import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SubscriptionList } from "../src/features/subscriptions/components/SubscriptionList";
import type { SubscriptionRecord } from "../src/types";

describe("SubscriptionList quota bar tiers", () => {
  it("renders the quota fill with the matching 10 percent tone class", () => {
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
    expect(html).toContain("width:70.114%");
  });
});
