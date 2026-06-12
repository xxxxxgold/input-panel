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
});
