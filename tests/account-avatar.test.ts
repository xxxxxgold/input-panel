import { describe, expect, it } from "vitest";

import { buildQqAvatarUrl, resolveAccountAvatarUrl } from "../src/shared/lib/account-avatar";
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

describe("buildQqAvatarUrl", () => {
  it("builds a qq avatar url for qq mailbox accounts", () => {
    expect(buildQqAvatarUrl("2906036532@qq.com")).toBe("https://q1.qlogo.cn/g?b=qq&nk=2906036532&s=100");
  });

  it("returns null for non-qq mailboxes", () => {
    expect(buildQqAvatarUrl("demo@example.com")).toBeNull();
  });
});

describe("resolveAccountAvatarUrl", () => {
  it("prefers the explicit profile avatar when available", () => {
    expect(
      resolveAccountAvatarUrl({
        accountEmail: "2906036532@qq.com",
        profileRecord: buildProfileRecord({ avatarUrl: "https://cdn.example.com/avatar.png" })
      })
    ).toBe("https://cdn.example.com/avatar.png");
  });

  it("falls back to qq avatar resolution from the account email", () => {
    expect(
      resolveAccountAvatarUrl({
        accountEmail: "2906036532@qq.com",
        profileRecord: buildProfileRecord({ avatarUrl: null })
      })
    ).toBe("https://q1.qlogo.cn/g?b=qq&nk=2906036532&s=100");
  });
});
