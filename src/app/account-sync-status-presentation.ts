import type { AccountSyncStatusRecord } from "../types";

/** 当前账号同步状态的展示快照，避免跨账号复用旧结果。 */
export type AccountSyncStatusPresentation = {
  accountId: string | null;
  hasSnapshot: boolean;
  initialLoading: boolean;
  statuses: AccountSyncStatusRecord[];
  lastError: string | null;
};

export function createAccountSyncStatusPresentation(accountId: string | null): AccountSyncStatusPresentation {
  return {
    accountId,
    hasSnapshot: false,
    initialLoading: Boolean(accountId),
    statuses: [],
    lastError: null
  };
}

export function resolveAccountSyncStatusPresentation(
  presentation: AccountSyncStatusPresentation,
  accountId: string | null
) {
  return presentation.accountId === accountId
    ? presentation
    : createAccountSyncStatusPresentation(accountId);
}

export function beginAccountSyncStatusLoad(
  presentation: AccountSyncStatusPresentation,
  accountId: string | null
) {
  if (presentation.accountId !== accountId) {
    return createAccountSyncStatusPresentation(accountId);
  }

  return {
    ...presentation,
    initialLoading: !presentation.hasSnapshot,
    lastError: null
  };
}

export function replaceAccountSyncStatusSnapshot(
  presentation: AccountSyncStatusPresentation,
  accountId: string,
  statuses: AccountSyncStatusRecord[]
) {
  if (presentation.accountId !== accountId) {
    return presentation;
  }

  return {
    accountId,
    hasSnapshot: true,
    initialLoading: false,
    statuses,
    lastError: null
  };
}

export function failAccountSyncStatusLoad(
  presentation: AccountSyncStatusPresentation,
  accountId: string,
  error: string
) {
  if (presentation.accountId !== accountId) {
    return presentation;
  }

  return {
    ...presentation,
    initialLoading: false,
    lastError: error
  };
}
