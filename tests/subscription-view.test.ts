import { describe, expect, it } from "vitest";
import {
  buildSubscriptionUsageInsights,
  buildTopbarSubscriptionPreviewRecords,
  getTopbarSubscriptionIndicatorTone,
  getSubscriptionQuotaProgressMeta,
  getSubscriptionStatusPresentation,
  mergeSubscriptionRecords
} from "../src/subscription-view";
import type {
  OverviewSubscriptionRecord,
  SubscriptionRecord,
  SubscriptionSummaryPayload
} from "../src/types";

describe("mergeSubscriptionRecords", () => {
  it("returns snapshot records when summary is unavailable", () => {
    const snapshotSubscriptions: SubscriptionRecord[] = [
      {
        id: "sub-yearly",
        groupId: 4,
        name: "CodeX Plus 年度",
        status: "active",
        groupName: "CodeX Plus 年度",
        platform: "openai",
        expiresAt: "2027-05-18T22:42:23+08:00",
        daily: {
          current: 339.55,
          limit: 500,
          windowStart: "2026-06-10T00:00:00+08:00"
        }
      }
    ];

    expect(mergeSubscriptionRecords(snapshotSubscriptions, null)).toEqual(snapshotSubscriptions);
  });

  it("prefers summary rows when they expose more subscriptions than the snapshot", () => {
    const snapshotSubscriptions: SubscriptionRecord[] = [
      {
        id: "sub-yearly",
        groupId: 4,
        name: "CodeX Plus 年度",
        status: "active",
        groupName: "CodeX Plus 年度",
        platform: "openai",
        expiresAt: "2027-05-18T22:42:23+08:00",
        daily: {
          current: 339.55,
          limit: 500,
          windowStart: "2026-06-10T00:00:00+08:00"
        }
      }
    ];
    const summary: SubscriptionSummaryPayload = {
      activeCount: 2,
      totalUsedUsd: 1077.28529185,
      subscriptions: [
        {
          id: 3365,
          groupId: 3,
          groupName: "CodeX Plus 月度",
          status: "active",
          dailyUsedUsd: 76.63,
          dailyLimitUsd: 500,
          weeklyUsedUsd: 76.63,
          monthlyUsedUsd: 76.63,
          expiresAt: "2027-06-10T13:54:40+08:00"
        },
        {
          id: 3052,
          groupId: 4,
          groupName: "CodeX Plus 年度",
          status: "active",
          dailyUsedUsd: 500.35,
          dailyLimitUsd: 500,
          weeklyUsedUsd: 1000.65,
          monthlyUsedUsd: 1000.65,
          expiresAt: "2027-05-18T22:42:23+08:00"
        }
      ]
    };

    const merged = mergeSubscriptionRecords(snapshotSubscriptions, summary);

    expect(merged).toHaveLength(2);
    expect(merged.map((item) => item.groupName)).toEqual(["CodeX Plus 月度", "CodeX Plus 年度"]);
    expect(merged[0]).toMatchObject({
      id: "summary-3365",
      groupId: 3,
      platform: "openai",
      daily: {
        current: 76.63,
        limit: 500,
        windowStart: null
      }
    });
    expect(merged[1]).toMatchObject({
      id: "sub-yearly",
      groupId: 4,
      platform: "openai",
      daily: {
        current: 500.35,
        limit: 500,
        windowStart: "2026-06-10T00:00:00+08:00"
      }
    });
  });
});

describe("getSubscriptionStatusPresentation", () => {
  it("maps active subscriptions to a green Chinese label", () => {
    expect(getSubscriptionStatusPresentation("active")).toEqual({
      label: "正常",
      tone: "ready"
    });
  });

  it("maps invalid subscriptions to a red Chinese label", () => {
    expect(getSubscriptionStatusPresentation("invalid")).toEqual({
      label: "已失效",
      tone: "critical"
    });
  });

  it("preserves Chinese labels for unknown backend statuses", () => {
    expect(getSubscriptionStatusPresentation("人工审核")).toEqual({
      label: "人工审核",
      tone: "neutral"
    });
  });
});

describe("buildTopbarSubscriptionPreviewRecords", () => {
  it("prefers overview subscriptions so the topbar can show multiple accounts", () => {
    const overviewSubscriptions: OverviewSubscriptionRecord[] = [
      {
        id: "sub-monthly",
        accountId: "account-1",
        accountLabel: "主账号",
        siteId: "site-1",
        siteName: "AI INPUT",
        groupId: 3,
        name: "CodeX Plus 月度",
        groupName: "CodeX Plus 月度",
        status: "active",
        expiresAt: "2027-06-10T13:54:40+08:00",
        daily: {
          current: 76.63,
          limit: 500,
          windowStart: "2026-06-10T00:00:00+08:00"
        },
        weekly: null,
        monthly: null,
        platform: "openai"
      },
      {
        id: "sub-yearly",
        accountId: "account-2",
        accountLabel: "副账号",
        siteId: "site-1",
        siteName: "AI INPUT",
        groupId: 4,
        name: "CodeX Plus 年度",
        groupName: "CodeX Plus 年度",
        status: "active",
        expiresAt: "2027-05-18T22:42:23+08:00",
        daily: null,
        weekly: {
          current: 1000.65,
          limit: 2000,
          windowStart: "2026-06-09T00:00:00+08:00"
        },
        monthly: null,
        platform: "openai"
      }
    ];

    const preview = buildTopbarSubscriptionPreviewRecords({
      overviewSubscriptions,
      fallbackSubscriptions: [],
      fallbackAccountLabel: "当前账号",
      fallbackSiteName: "当前站点"
    });

    expect(preview).toHaveLength(2);
    expect(preview).toMatchObject([
      {
        id: "sub-monthly",
        name: "CodeX Plus 月度",
        accountLabel: "主账号",
        siteName: "AI INPUT",
        quota: {
          label: "每日",
          used: 76.63,
          limit: 500
        }
      },
      {
        id: "sub-yearly",
        name: "CodeX Plus 年度",
        accountLabel: "副账号",
        siteName: "AI INPUT",
        quota: {
          label: "每周",
          used: 1000.65,
          limit: 2000
        }
      }
    ]);
  });

  it("falls back to the current account subscriptions when overview data is unavailable", () => {
    const fallbackSubscriptions: SubscriptionRecord[] = [
      {
        id: "sub-current",
        groupId: 7,
        name: "Starter",
        groupName: "Starter",
        status: "pending",
        expiresAt: null,
        platform: "openai",
        daily: null,
        weekly: null,
        monthly: {
          current: 88,
          limit: 300,
          windowStart: "2026-06-01T00:00:00+08:00"
        }
      }
    ];

    const preview = buildTopbarSubscriptionPreviewRecords({
      overviewSubscriptions: [],
      fallbackSubscriptions,
      fallbackAccountLabel: "主账号",
      fallbackSiteName: "AI INPUT"
    });

    expect(preview).toEqual([
      {
        id: "sub-current",
        name: "Starter",
        status: "pending",
        expiresAt: null,
        accountLabel: "主账号",
        siteName: "AI INPUT",
        quota: {
          label: "每月",
          used: 88,
          limit: 300
        }
      }
    ]);
  });
});

describe("getSubscriptionQuotaProgressMeta", () => {
  it("maps quota usage into the configured threshold buckets", () => {
    expect(getSubscriptionQuotaProgressMeta(9, 100)).toMatchObject({
      percent: 9,
      tone: "quota-tier-10"
    });
    expect(getSubscriptionQuotaProgressMeta(19, 100)).toMatchObject({
      percent: 19,
      tone: "quota-tier-20"
    });
    expect(getSubscriptionQuotaProgressMeta(20, 100)).toMatchObject({
      percent: 20,
      tone: "quota-tier-30"
    });
    expect(getSubscriptionQuotaProgressMeta(30, 100)).toMatchObject({
      percent: 30,
      tone: "quota-tier-40"
    });
    expect(getSubscriptionQuotaProgressMeta(40, 100)).toMatchObject({
      percent: 40,
      tone: "quota-tier-50"
    });
    expect(getSubscriptionQuotaProgressMeta(50, 100)).toMatchObject({
      percent: 50,
      tone: "quota-tier-60"
    });
    expect(getSubscriptionQuotaProgressMeta(60, 100)).toMatchObject({
      percent: 60,
      tone: "quota-tier-70"
    });
    expect(getSubscriptionQuotaProgressMeta(70, 100)).toMatchObject({
      percent: 70,
      tone: "quota-tier-80"
    });
    expect(getSubscriptionQuotaProgressMeta(80, 100)).toMatchObject({
      percent: 80,
      tone: "quota-tier-90"
    });
    expect(getSubscriptionQuotaProgressMeta(90, 100)).toMatchObject({
      percent: 90,
      tone: "quota-tier-100"
    });
    expect(getSubscriptionQuotaProgressMeta(120, 100)).toMatchObject({
      percent: 100,
      tone: "quota-tier-over"
    });
  });

  it("guards against zero or missing quota limits", () => {
    expect(getSubscriptionQuotaProgressMeta(0, 0)).toMatchObject({
      percent: 0,
      tone: "quota-tier-10"
    });
    expect(getSubscriptionQuotaProgressMeta(15, null)).toMatchObject({
      percent: 100,
      tone: "quota-tier-over"
    });
  });
});

describe("getTopbarSubscriptionIndicatorTone", () => {
  it("reuses percentage tiers when subscription preview exposes quota usage", () => {
    expect(
      getTopbarSubscriptionIndicatorTone({
        status: "active",
        quota: {
          label: "每日",
          used: 350,
          limit: 500
        }
      })
    ).toBe("quota-tier-80");
  });

  it("falls back to status dots when quota data is unavailable", () => {
    expect(
      getTopbarSubscriptionIndicatorTone({
        status: "invalid",
        quota: null
      })
    ).toBe("subscription-dot-critical");
  });
});

describe("buildSubscriptionUsageInsights", () => {
  it("builds stable subscription summary rows from summary payload", () => {
    const summary: SubscriptionSummaryPayload = {
      activeCount: 1,
      totalUsedUsd: 76.63,
      subscriptions: [
        {
          id: 3365,
          groupId: 3,
          groupName: "CodeX Plus 月度",
          status: "active",
          dailyUsedUsd: 76.63,
          dailyLimitUsd: 500,
          weeklyUsedUsd: 90.12,
          monthlyUsedUsd: 120.45,
          expiresAt: "2027-06-10T13:54:40+08:00"
        }
      ]
    };

    const result = buildSubscriptionUsageInsights({
      summary,
      snapshotSubscriptions: []
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      name: "CodeX Plus 月度",
      dailyUsedUsd: 76.63,
      weeklyUsedUsd: 90.12,
      monthlyUsedUsd: 120.45
    });
  });

  it("falls back to snapshot subscriptions when summary is unavailable", () => {
    const snapshotSubscriptions: SubscriptionRecord[] = [
      {
        id: "sub-current",
        groupId: 7,
        name: "Starter",
        groupName: "Starter",
        status: "pending",
        expiresAt: null,
        platform: "openai",
        daily: {
          current: 8,
          limit: 50,
          windowStart: "2026-06-10T00:00:00+08:00"
        },
        weekly: null,
        monthly: {
          current: 88,
          limit: 300,
          windowStart: "2026-06-01T00:00:00+08:00"
        }
      }
    ];

    const result = buildSubscriptionUsageInsights({
      summary: null,
      snapshotSubscriptions
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      name: "Starter",
      dailyUsedUsd: 8,
      dailyLimitUsd: 50,
      monthlyUsedUsd: 88
    });
  });
});
