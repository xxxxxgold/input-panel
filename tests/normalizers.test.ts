import { describe, expect, it } from "vitest";

import { normalizeSubscriptionSummary } from "../src/shared/transport/normalizers";

describe("normalizeSubscriptionSummary", () => {
  it("accepts native summary payloads", () => {
    const result = normalizeSubscriptionSummary({
      active_count: 2,
      total_used_usd: 12.5,
      subscriptions: [
        {
          id: 1,
          group_id: 10,
          group_name: "Pro",
          status: "active",
          daily_used_usd: 2.5,
          daily_limit_usd: 50
        }
      ]
    });

    expect(result.activeCount).toBe(2);
    expect(result.totalUsedUsd).toBe(12.5);
    expect(result.subscriptions[0]).toMatchObject({
      groupName: "Pro",
      dailyUsedUsd: 2.5,
      dailyLimitUsd: 50
    });
  });

  it("falls back to subscription-list shaped payloads", () => {
    const result = normalizeSubscriptionSummary({
      items: [
        {
          id: "mock-sub-1",
          status: "active",
          expires_at: "2027-06-06T00:00:00+08:00",
          group: {
            name: "Mock Annual",
            platform: "openai",
            daily_limit_usd: 50
          },
          daily_usage_usd: 1.5
        }
      ]
    });

    expect(result.activeCount).toBe(1);
    expect(result.totalUsedUsd).toBe(1.5);
    expect(result.subscriptions[0]).toMatchObject({
      groupName: "Mock Annual",
      dailyUsedUsd: 1.5,
      dailyLimitUsd: 50
    });
  });
});
