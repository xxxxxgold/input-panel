import { describe, expect, it } from "vitest";

import { resolveAccountAvatarUrl } from "../src/shared/lib/account-avatar";
import type { UserProfileRecord } from "../src/types";

function buildProfileRecord(overrides: Partial<UserProfileRecord> = {}): UserProfileRecord {
  return {
    id: overrides.id ?? 1,
    email: overrides.email ?? "demo@example.com",
    username: overrides.username ?? null,
    avatarUrl: overrides.avatarUrl ?? null,
    role: overrides.role ?? "user",
    balance: overrides.balance ?? 0,
    concurrency: overrides.concurrency ?? 1,
    status: overrides.status ?? "active",
    lastActiveAt: overrides.lastActiveAt ?? null,
    createdAt: overrides.createdAt ?? null,
    updatedAt: overrides.updatedAt ?? null,
    totalRecharged: overrides.totalRecharged ?? null,
    rpmLimit: overrides.rpmLimit ?? null,
    balanceNotifyEnabled: overrides.balanceNotifyEnabled ?? false,
    balanceNotifyThresholdType: overrides.balanceNotifyThresholdType ?? null,
    balanceNotifyThreshold: overrides.balanceNotifyThreshold ?? null,
    balanceNotifyExtraEmails: overrides.balanceNotifyExtraEmails ?? null,
    identities: overrides.identities ?? {},
    authBindings: overrides.authBindings ?? {},
    identityBindings: overrides.identityBindings ?? {}
  };
}

describe("resolveAccountAvatarUrl", () => {
  it("prefers the explicit profile avatar when available", () => {
    expect(
      resolveAccountAvatarUrl({
        profileRecord: buildProfileRecord({ avatarUrl: "https://cdn.example.com/avatar.png" })
      })
    ).toBe("https://cdn.example.com/avatar.png");
  });

  it("returns null when sub2api profile does not provide avatar_url", () => {
    expect(
      resolveAccountAvatarUrl({
        profileRecord: buildProfileRecord({ avatarUrl: null })
      })
    ).toBeNull();
  });
});
