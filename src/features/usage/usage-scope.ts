import { buildScopedResourceKey } from "../../shared/state/scoped-resource-cache";
import type { UsageFilter } from "../../types";

export type UsageScopeSurface = "overview" | "usage" | "modelStats" | "keyUsage" | "trends";

export type UsageScopeInput = {
  accountId: string;
  surface: UsageScopeSurface;
  pageSize?: number;
  filter?: UsageFilter;
  keyId?: string | null;
  days?: number;
};

export function buildUsageScopeKey(input: UsageScopeInput) {
  const baseIdentity = {
    accountId: input.accountId,
    surface: input.surface
  };
  if (input.surface === "overview") {
    return buildScopedResourceKey("usage-workspace", baseIdentity);
  }
  if (input.surface === "keyUsage") {
    return buildScopedResourceKey("usage-workspace", {
      ...baseIdentity,
      keyId: input.keyId ?? null,
      days: input.days ?? null
    });
  }
  if (input.surface === "usage") {
    return buildScopedResourceKey("usage-workspace", {
      ...baseIdentity,
      filter: input.filter ?? {},
      pageSize: input.pageSize ?? null
    });
  }

  return buildScopedResourceKey("usage-workspace", {
    ...baseIdentity,
    filter: input.filter ?? {}
  });
}

export function buildUsageKeyDailyScopeKey(input: {
  accountId: string;
  keyId: string;
  days: number;
}) {
  return buildScopedResourceKey("usage-key-daily", input);
}

export function usageScopeReferencesAccount(scopeKey: string, accountId: string) {
  const normalizedAccountId = accountId.trim();
  if (!normalizedAccountId) {
    return false;
  }

  const separatorIndex = scopeKey.indexOf(":");
  if (separatorIndex < 1) {
    return false;
  }

  const resource = scopeKey.slice(0, separatorIndex);
  if (resource !== "usage-workspace" && resource !== "usage-key-daily") {
    return false;
  }

  try {
    const identity = JSON.parse(scopeKey.slice(separatorIndex + 1));
    return Boolean(
      identity
      && typeof identity === "object"
      && !Array.isArray(identity)
      && (identity as { accountId?: unknown }).accountId === normalizedAccountId
    );
  } catch {
    return false;
  }
}
