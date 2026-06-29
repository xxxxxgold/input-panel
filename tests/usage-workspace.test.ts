import { describe, expect, it } from "vitest";

import type { ManagedKeyRecord } from "../src/types";

function pickDefaultKeyUsageKeyId(keys: ManagedKeyRecord[]) {
  const sorted = [...keys].sort((left, right) => {
    const leftTime = left.lastUsedAt ? Date.parse(left.lastUsedAt) : Number.NEGATIVE_INFINITY;
    const rightTime = right.lastUsedAt ? Date.parse(right.lastUsedAt) : Number.NEGATIVE_INFINITY;
    return rightTime - leftTime;
  });
  return sorted[0]?.id ?? "";
}

function shouldResetUsageApiKeyFilter(keys: ManagedKeyRecord[], usageApiKeyFilter: string) {
  if (!usageApiKeyFilter) {
    return false;
  }
  return !keys.some((item) => item.apiKeyId !== null && item.apiKeyId !== undefined && String(item.apiKeyId) === usageApiKeyFilter);
}

function normalizeUsagePageSize(value: number) {
  return [10, 20, 50, 100].includes(value) ? value : 20;
}

function buildUsageDashboardQuery(
  usageApiKeyFilter: string,
  startDate: string,
  endDate: string
) {
  return {
    days: 7,
    apiKeyId: usageApiKeyFilter || null,
    startDate,
    endDate
  };
}

function shouldSyncTodayUsageWindow(
  startDate: string,
  endDate: string,
  today = "2026-06-29"
) {
  if (!startDate || !endDate) {
    return true;
  }
  return startDate <= today && endDate >= today;
}

describe("usage workspace key selection helpers", () => {
  it("prefers the most recently used key for default daily usage selection", () => {
    const keys: ManagedKeyRecord[] = [
      {
        id: "5524",
        apiKeyId: 5524,
        name: "codex++",
        status: "active",
        lastUsedAt: "2026-06-11T20:27:25.80647+08:00"
      },
      {
        id: "3641",
        apiKeyId: 3641,
        name: "codex",
        status: "active",
        lastUsedAt: "2026-06-13T00:38:44.766686+08:00"
      }
    ];

    expect(pickDefaultKeyUsageKeyId(keys)).toBe("3641");
  });

  it("resets the usage filter when the selected api key id is no longer present", () => {
    const keys: ManagedKeyRecord[] = [
      {
        id: "3641",
        apiKeyId: 3641,
        name: "codex",
        status: "active"
      }
    ];

    expect(shouldResetUsageApiKeyFilter(keys, "5524")).toBe(true);
    expect(shouldResetUsageApiKeyFilter(keys, "3641")).toBe(false);
    expect(shouldResetUsageApiKeyFilter(keys, "")).toBe(false);
  });

  it("normalizes unsupported usage page sizes back to the default", () => {
    expect(normalizeUsagePageSize(10)).toBe(10);
    expect(normalizeUsagePageSize(50)).toBe(50);
    expect(normalizeUsagePageSize(999)).toBe(20);
  });

  it("builds dashboard queries from the active usage filters", () => {
    expect(buildUsageDashboardQuery("", "2026-06-28", "2026-06-28")).toEqual({
      days: 7,
      apiKeyId: null,
      startDate: "2026-06-28",
      endDate: "2026-06-28"
    });
    expect(buildUsageDashboardQuery("3641", "2026-06-24", "2026-06-28")).toEqual({
      days: 7,
      apiKeyId: "3641",
      startDate: "2026-06-24",
      endDate: "2026-06-28"
    });
  });

  it("syncs latest usage only when the selected window still covers today", () => {
    expect(shouldSyncTodayUsageWindow("", "", "2026-06-29")).toBe(true);
    expect(shouldSyncTodayUsageWindow("2026-06-29", "2026-06-29", "2026-06-29")).toBe(true);
    expect(shouldSyncTodayUsageWindow("2026-06-28", "2026-06-29", "2026-06-29")).toBe(true);
    expect(shouldSyncTodayUsageWindow("2026-06-27", "2026-06-28", "2026-06-29")).toBe(false);
  });
});
