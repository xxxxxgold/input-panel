import { buildScopedResourceKey } from "../../shared/state/scoped-resource-cache";

export type OverviewRealtimeScopeInput =
  | {
      mode: "selected-account";
      accountId: string | null | undefined;
      startDate: string;
      endDate: string;
    }
  | {
      mode: "all-accounts";
      readyAccountIds: readonly string[];
      startDate: string;
      endDate: string;
    };

/** 全账号余额汇总使用的单账号实时资料快照。 */
export type OverviewAccountBalanceRecord = {
  accountId: string;
  balance: number;
  fetchedAt: string;
};

function normalizeAccountId(accountId: string | null | undefined) {
  const normalized = accountId?.trim() ?? "";
  return normalized || null;
}

function normalizeReadyAccountIds(accountIds: readonly string[]) {
  return accountIds
    .map((accountId) => accountId.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

type OverviewScopeIdentity = {
  accountId?: unknown;
  readyAccountIds?: unknown;
};

function parseOverviewScopeIdentity(scopeKey: string): OverviewScopeIdentity | null {
  const separatorIndex = scopeKey.indexOf(":");
  if (separatorIndex < 1) {
    return null;
  }

  const resource = scopeKey.slice(0, separatorIndex);
  if (
    resource !== "overview-realtime"
    && resource !== "overview-all-account-keys"
    && resource !== "overview-all-account-balances"
  ) {
    return null;
  }

  try {
    const identity = JSON.parse(scopeKey.slice(separatorIndex + 1));
    return identity && typeof identity === "object" && !Array.isArray(identity)
      ? identity as OverviewScopeIdentity
      : null;
  } catch {
    return null;
  }
}

export function overviewScopeReferencesAccount(scopeKey: string, accountId: string) {
  const normalizedAccountId = normalizeAccountId(accountId);
  if (!normalizedAccountId) {
    return false;
  }

  const identity = parseOverviewScopeIdentity(scopeKey);
  if (!identity) {
    return false;
  }

  if (identity.accountId === normalizedAccountId) {
    return true;
  }

  return Array.isArray(identity.readyAccountIds)
    && identity.readyAccountIds.some((candidate) => candidate === normalizedAccountId);
}

export function buildOverviewRealtimeScopeKey(input: OverviewRealtimeScopeInput): string | null {
  if (input.mode === "selected-account") {
    const accountId = normalizeAccountId(input.accountId);
    if (!accountId) {
      return null;
    }
    return buildScopedResourceKey("overview-realtime", {
      mode: input.mode,
      accountId,
      startDate: input.startDate,
      endDate: input.endDate
    });
  }

  const readyAccountIds = normalizeReadyAccountIds(input.readyAccountIds);
  if (readyAccountIds.length === 0) {
    return null;
  }
  return buildScopedResourceKey("overview-realtime", {
    mode: input.mode,
    readyAccountIds,
    startDate: input.startDate,
    endDate: input.endDate
  });
}

export function buildOverviewAllAccountKeysScopeKey(
  readyAccountIds: readonly string[]
): string | null {
  const normalizedAccountIds = normalizeReadyAccountIds(readyAccountIds);
  if (normalizedAccountIds.length === 0) {
    return null;
  }
  return buildScopedResourceKey("overview-all-account-keys", {
    readyAccountIds: normalizedAccountIds
  });
}

export function buildOverviewAllAccountBalancesScopeKey(
  readyAccountIds: readonly string[]
): string | null {
  const normalizedAccountIds = normalizeReadyAccountIds(readyAccountIds);
  if (normalizedAccountIds.length === 0) {
    return null;
  }
  return buildScopedResourceKey("overview-all-account-balances", {
    readyAccountIds: normalizedAccountIds
  });
}
