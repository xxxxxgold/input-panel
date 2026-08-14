import { useEffect, useRef, useState } from "react";

import type {
  GroupRecord,
  ManagedKeyRecord,
  PaginatedResult,
  PlatformQuotaPayload,
  SubscriptionQuotaAlertConfig,
  SubscriptionQuotaAlertSettingsPayload,
  SubscriptionRecord,
  SubscriptionSwitchRuleRecord,
  SubscriptionSummaryPayload,
  UserProfileRecord
} from "../../types";
import {
  getAvailableGroups,
  getPlatformQuotas,
  getProfileRecord,
  getSubscriptions,
  getSubscriptionSummary,
  listSubscriptionSwitchRules,
  listManagedKeys,
  querySubscriptionQuotaAlerts
} from "../../api";
import {
  buildScopedResourceKey,
  ScopedResourceCache,
  type ScopedResourceEntry
} from "../../shared/state/scoped-resource-cache";

export type AccountDataResourceMode = boolean | "deferred";

export type AccountDataResources = {
  groups?: AccountDataResourceMode;
  managedKeys?: AccountDataResourceMode;
  subscriptions?: AccountDataResourceMode;
  subscriptionSummary?: AccountDataResourceMode;
  profileRecord?: AccountDataResourceMode;
  platformQuotas?: AccountDataResourceMode;
  subscriptionSwitchRules?: AccountDataResourceMode;
  subscriptionQuotaAlerts?: AccountDataResourceMode;
};

const DEFERRED_RESOURCE_DELAY_MS = 650;

export type AccountDataResourceKey = keyof AccountDataResources;
type AccountDataValueByResource = {
  groups: GroupRecord[];
  managedKeys: PaginatedResult<ManagedKeyRecord>;
  subscriptions: SubscriptionRecord[];
  subscriptionSummary: SubscriptionSummaryPayload | null;
  profileRecord: UserProfileRecord | null;
  platformQuotas: PlatformQuotaPayload | null;
  subscriptionSwitchRules: SubscriptionSwitchRuleRecord[];
  subscriptionQuotaAlerts: SubscriptionQuotaAlertSettingsPayload | null;
};

export type AccountDataRefreshMode = "foreground" | "background";
export type AccountDataRefreshFailure = {
  resource: AccountDataResourceKey;
  message: string;
};
export type AccountDataRefreshResult =
  | { status: "success"; failedResources: [] }
  | { status: "partial-failure"; failedResources: AccountDataRefreshFailure[] }
  | { status: "cancelled"; failedResources: [] };

export type AccountDataPresentationState = {
  accountId: string | null;
  hasSnapshot: boolean;
  initialLoading: boolean;
  refreshing: boolean;
  lastError: string | null;
  updatedAt: number | null;
};

export type AccountDataResourcePresentation = Pick<
  ScopedResourceEntry<unknown>,
  "hasSnapshot" | "initialLoading" | "refreshing" | "updatedAt"
> & {
  lastError: string | null;
};

export type AccountDataResourcePresentationByKey = Record<
  AccountDataResourceKey,
  AccountDataResourcePresentation
>;

export class AccountDataRefreshError extends Error {
  readonly result: Extract<AccountDataRefreshResult, { status: "partial-failure" }>;

  constructor(result: Extract<AccountDataRefreshResult, { status: "partial-failure" }>) {
    super(describeAccountDataRefreshFailures(result.failedResources));
    this.name = "AccountDataRefreshError";
    this.result = result;
  }
}

export function resolveAccountDataRefreshResult(options: {
  requestIsCurrent: boolean;
  taskResources: AccountDataResourceKey[];
  settlements: PromiseSettledResult<void | "cancelled">[];
}): AccountDataRefreshResult {
  if (!options.requestIsCurrent) {
    return { status: "cancelled", failedResources: [] };
  }

  const failedResources = options.settlements.flatMap((settlement, index) => {
    if (settlement.status === "fulfilled") {
      return [];
    }
    return [{
      resource: options.taskResources[index],
      message: toRefreshErrorMessage(settlement.reason)
    }];
  });

  if (
    failedResources.length === 0
    && options.settlements.length > 0
    && options.settlements.every(
      (settlement) => settlement.status === "fulfilled" && settlement.value === "cancelled"
    )
  ) {
    return { status: "cancelled", failedResources: [] };
  }

  return failedResources.length > 0
    ? { status: "partial-failure", failedResources }
    : { status: "success", failedResources: [] };
}

export function describeAccountDataRefreshFailures(failures: AccountDataRefreshFailure[]) {
  return failures
    .map((failure) => `${ACCOUNT_DATA_RESOURCE_LABELS[failure.resource]}: ${failure.message}`)
    .join("；");
}

const ACCOUNT_DATA_RESOURCE_LABELS: Record<AccountDataResourceKey, string> = {
  groups: "分组",
  managedKeys: "API 密钥",
  subscriptions: "订阅",
  subscriptionSummary: "订阅摘要",
  profileRecord: "账号资料",
  platformQuotas: "平台额度",
  subscriptionSwitchRules: "切换规则",
  subscriptionQuotaAlerts: "额度提醒配置"
};

const ACCOUNT_RESOURCE_KEYS = Object.keys(ACCOUNT_DATA_RESOURCE_LABELS) as AccountDataResourceKey[];

function createAccountResourceCache() {
  return new ScopedResourceCache<AccountDataValueByResource[AccountDataResourceKey]>({
    maxEntries: 220
  });
}

function getAccountResourceCacheKey(accountId: string, resource: AccountDataResourceKey) {
  return buildScopedResourceKey(`account-data:${resource}`, { accountId });
}

function getAccountResourceEntry<T extends AccountDataResourceKey>(
  cache: ScopedResourceCache<AccountDataValueByResource[AccountDataResourceKey]>,
  accountId: string | null,
  resource: T
): ScopedResourceEntry<AccountDataValueByResource[T]> {
  if (!accountId) {
    return {
      hasSnapshot: false,
      data: undefined,
      status: "idle",
      initialLoading: false,
      refreshing: false,
      error: null,
      updatedAt: null,
      requestId: 0
    };
  }
  return cache.peek(getAccountResourceCacheKey(accountId, resource)) as ScopedResourceEntry<AccountDataValueByResource[T]>;
}

export function useAccountDataWorkspace({
  selectedAccountId,
  resources,
  enabled,
  setError
}: {
  selectedAccountId: string | null;
  resources: AccountDataResources;
  enabled: boolean;
  setError: (value: string | null) => void;
}) {
  const cacheRef = useRef<ScopedResourceCache<AccountDataValueByResource[AccountDataResourceKey]> | null>(null);
  if (!cacheRef.current) {
    cacheRef.current = createAccountResourceCache();
  }
  const cache = cacheRef.current;
  const [, setRevision] = useState(0);
  const selectedAccountIdRef = useRef(selectedAccountId);
  selectedAccountIdRef.current = selectedAccountId;
  const groupsEnabled = isAccountDataResourceEnabled(resources.groups);
  const managedKeysEnabled = isAccountDataResourceEnabled(resources.managedKeys);
  const subscriptionsEnabled = isAccountDataResourceEnabled(resources.subscriptions);
  const subscriptionSummaryEnabled = isAccountDataResourceEnabled(resources.subscriptionSummary);
  const profileRecordEnabled = isAccountDataResourceEnabled(resources.profileRecord);
  const platformQuotasEnabled = isAccountDataResourceEnabled(resources.platformQuotas);
  const subscriptionSwitchRulesEnabled = isAccountDataResourceEnabled(resources.subscriptionSwitchRules);
  const subscriptionQuotaAlertsEnabled = isAccountDataResourceEnabled(resources.subscriptionQuotaAlerts);
  const deferredResources = resolveDeferredAccountDataResources(resources);
  const immediateResources = resolveImmediateAccountDataResources(resources);

  useEffect(() => {
    return cache.subscribe(() => {
      setRevision((value) => value + 1);
    });
  }, [cache]);

  useEffect(() => {
    const enabledByResource: Record<AccountDataResourceKey, boolean> = {
      groups: groupsEnabled,
      managedKeys: managedKeysEnabled,
      subscriptions: subscriptionsEnabled,
      subscriptionSummary: subscriptionSummaryEnabled,
      profileRecord: profileRecordEnabled,
      platformQuotas: platformQuotasEnabled,
      subscriptionSwitchRules: subscriptionSwitchRulesEnabled,
      subscriptionQuotaAlerts: subscriptionQuotaAlertsEnabled
    };
    for (const resource of ACCOUNT_RESOURCE_KEYS) {
      if (!enabledByResource[resource]) {
        cache.cancelWhere((key) => key.startsWith(`account-data:${resource}:`));
      }
    }
  }, [
    cache,
    groupsEnabled,
    managedKeysEnabled,
    platformQuotasEnabled,
    profileRecordEnabled,
    subscriptionSummaryEnabled,
    subscriptionQuotaAlertsEnabled,
    subscriptionSwitchRulesEnabled,
    subscriptionsEnabled
  ]);

  useEffect(() => {
    if (!selectedAccountId || !enabled || !hasEnabledAccountDataResources(resources)) {
      return;
    }

    let cancelled = false;

    const runLoadSequence = async () => {
      if (hasEnabledAccountDataResources(immediateResources)) {
        try {
          await loadAccountData(selectedAccountId, immediateResources);
        } catch {
          // 首次前台加载已经存入资源级错误；延迟资源仍可独立继续加载。
        }
      }

      if (cancelled || !hasEnabledAccountDataResources(deferredResources)) {
        return;
      }

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, DEFERRED_RESOURCE_DELAY_MS);
      });

      if (cancelled) {
        return;
      }

      try {
        await loadAccountData(selectedAccountId, deferredResources, {
          clearError: false,
          mode: "background"
        });
      } catch {
        // 延迟后台加载的错误已记录到对应资源，不生成全局提示或未处理 Promise。
      }
    };

    void runLoadSequence();

    return () => {
      cancelled = true;
    };
  }, [
    deferredResources.groups,
    deferredResources.managedKeys,
    deferredResources.platformQuotas,
    deferredResources.profileRecord,
    deferredResources.subscriptions,
    deferredResources.subscriptionSummary,
    deferredResources.subscriptionSwitchRules,
    deferredResources.subscriptionQuotaAlerts,
    enabled,
    immediateResources.groups,
    immediateResources.managedKeys,
    immediateResources.platformQuotas,
    immediateResources.profileRecord,
    immediateResources.subscriptions,
    immediateResources.subscriptionSwitchRules,
    immediateResources.subscriptionQuotaAlerts,
    immediateResources.subscriptionSummary,
    selectedAccountId
  ]);

  const groupsEntry = groupsEnabled ? getAccountResourceEntry(cache, selectedAccountId, "groups") : null;
  const managedKeysEntry = managedKeysEnabled ? getAccountResourceEntry(cache, selectedAccountId, "managedKeys") : null;
  const subscriptionsEntry = subscriptionsEnabled ? getAccountResourceEntry(cache, selectedAccountId, "subscriptions") : null;
  const subscriptionSummaryEntry = subscriptionSummaryEnabled
    ? getAccountResourceEntry(cache, selectedAccountId, "subscriptionSummary")
    : null;
  const profileRecordEntry = profileRecordEnabled ? getAccountResourceEntry(cache, selectedAccountId, "profileRecord") : null;
  const platformQuotasEntry = platformQuotasEnabled ? getAccountResourceEntry(cache, selectedAccountId, "platformQuotas") : null;
  const subscriptionSwitchRulesEntry = subscriptionSwitchRulesEnabled
    ? getAccountResourceEntry(cache, selectedAccountId, "subscriptionSwitchRules")
    : null;
  const subscriptionQuotaAlertsEntry = subscriptionQuotaAlertsEnabled
    ? getAccountResourceEntry(cache, selectedAccountId, "subscriptionQuotaAlerts")
    : null;
  const visibleEntries = [
    groupsEntry,
    managedKeysEntry,
    subscriptionsEntry,
    subscriptionSummaryEntry,
    profileRecordEntry,
    platformQuotasEntry,
    subscriptionSwitchRulesEntry,
    subscriptionQuotaAlertsEntry
  ];

  const presentation = resolveAccountDataPresentation(selectedAccountId, visibleEntries);
  const resourcePresentation = Object.fromEntries(
    ACCOUNT_RESOURCE_KEYS.map((resource) => [
      resource,
      toAccountDataResourcePresentation(getAccountResourceEntry(cache, selectedAccountId, resource))
    ])
  ) as AccountDataResourcePresentationByKey;

  async function loadAccountData(
    accountId: string,
    requestedResources: AccountDataResources,
    options?: {
      clearError?: boolean;
      force?: boolean;
      mode?: AccountDataRefreshMode;
    }
  ): Promise<AccountDataRefreshResult> {
    const mode = options?.mode ?? "foreground";
    if (mode === "foreground" && (options?.clearError ?? true)) {
      setError(null);
    }

    const tasks: Array<{
      resource: AccountDataResourceKey;
      run: () => Promise<void | "cancelled">;
    }> = [];
    const addTask = <T extends AccountDataResourceKey>(
      resource: T,
      loader: () => Promise<AccountDataValueByResource[T]>
    ) => {
      const key = getAccountResourceCacheKey(accountId, resource);
      tasks.push({
        resource,
        run: async () => {
          const result = await cache.load(
            key,
            loader as () => Promise<AccountDataValueByResource[AccountDataResourceKey]>,
            { force: options?.force }
          );
          if (result.status === "error") {
            throw result.error;
          }
          if (result.status === "cancelled") {
            return "cancelled";
          }
        }
      });
    };

    if (isAccountDataResourceEnabled(requestedResources.groups)) {
      addTask("groups", () => loadOptional(() => getAvailableGroups(accountId), []));
    }
    if (isAccountDataResourceEnabled(requestedResources.managedKeys)) {
      addTask("managedKeys", () => listManagedKeys(accountId, 1, 100, options?.force ?? false));
    }
    if (isAccountDataResourceEnabled(requestedResources.subscriptions)) {
      addTask("subscriptions", () => getSubscriptions(accountId, options?.force ?? false));
    }
    if (isAccountDataResourceEnabled(requestedResources.profileRecord)) {
      addTask("profileRecord", () => getProfileRecord(accountId, options?.force ?? false));
    }
    if (isAccountDataResourceEnabled(requestedResources.platformQuotas)) {
      addTask("platformQuotas", () => loadOptional(() => getPlatformQuotas(accountId), null));
    }
    if (isAccountDataResourceEnabled(requestedResources.subscriptionSummary)) {
      addTask("subscriptionSummary", () => loadOptional(() => getSubscriptionSummary(accountId), null));
    }
    if (isAccountDataResourceEnabled(requestedResources.subscriptionSwitchRules)) {
      addTask("subscriptionSwitchRules", () => loadOptional(() => listSubscriptionSwitchRules(accountId), []));
    }
    if (isAccountDataResourceEnabled(requestedResources.subscriptionQuotaAlerts)) {
      addTask("subscriptionQuotaAlerts", () => querySubscriptionQuotaAlerts(accountId));
    }

    const settlements = await Promise.allSettled(tasks.map((task) => task.run()));
    const result = resolveAccountDataRefreshResult({
      requestIsCurrent: selectedAccountIdRef.current === accountId,
      taskResources: tasks.map((task) => task.resource),
      settlements
    });

    if (result.status === "partial-failure") {
      if (mode === "background") {
        throw new AccountDataRefreshError(result);
      }
      setError(describeAccountDataRefreshFailures(result.failedResources));
    }

    return result;
  }

  async function refreshAccountData(options?: {
    clearError?: boolean;
    force?: boolean;
    mode?: AccountDataRefreshMode;
  }): Promise<AccountDataRefreshResult> {
    if (!selectedAccountId || !enabled || !hasEnabledAccountDataResources(resources)) {
      return { status: "cancelled", failedResources: [] };
    }
    return await loadAccountData(selectedAccountId, materializeImmediateAccountDataResources(resources), {
      ...options,
      force: options?.force ?? true
    });
  }

  async function refreshResources(
    requestedResources: AccountDataResources,
    options?: {
      clearError?: boolean;
      force?: boolean;
      mode?: AccountDataRefreshMode;
    }
  ): Promise<AccountDataRefreshResult> {
    if (!selectedAccountId || !hasEnabledAccountDataResources(requestedResources)) {
      return { status: "cancelled", failedResources: [] };
    }
    return await loadAccountData(selectedAccountId, materializeImmediateAccountDataResources(requestedResources), options);
  }

  async function preloadResources(requestedResources: AccountDataResources): Promise<AccountDataRefreshResult> {
    if (!selectedAccountId) {
      return { status: "cancelled", failedResources: [] };
    }

    const missingResources: AccountDataResources = {};
    for (const resource of ACCOUNT_RESOURCE_KEYS) {
      if (
        isAccountDataResourceEnabled(requestedResources[resource])
        && !cache.peek(getAccountResourceCacheKey(selectedAccountId, resource)).hasSnapshot
      ) {
        missingResources[resource] = true;
      }
    }

    if (!hasEnabledAccountDataResources(missingResources)) {
      return { status: "success", failedResources: [] };
    }

    return await loadAccountData(selectedAccountId, missingResources, {
      force: false,
      mode: "background"
    });
  }

  function setProfileRecord(next: UserProfileRecord | null, accountId: string) {
    cache.setSnapshot(getAccountResourceCacheKey(accountId, "profileRecord"), next);
  }

  function applySubscriptionQuotaAlertConfig(
    accountId: string,
    next: SubscriptionQuotaAlertConfig
  ) {
    const entry = getAccountResourceEntry(cache, accountId, "subscriptionQuotaAlerts");
    if (!entry.hasSnapshot || !entry.data) {
      return false;
    }
    cache.setSnapshot(getAccountResourceCacheKey(accountId, "subscriptionQuotaAlerts"), {
      ...entry.data,
      overrides: [
        ...entry.data.overrides.filter((item) => item.subscriptionKey !== next.subscriptionKey),
        next
      ]
    });
    return true;
  }

  function invalidateAccount(accountId: string) {
    const accountKeys = new Set(
      ACCOUNT_RESOURCE_KEYS.map((resource) => getAccountResourceCacheKey(accountId, resource))
    );
    cache.invalidateWhere((key) => accountKeys.has(key));
  }

  return {
    groups: groupsEntry?.data ?? [],
    managedKeys: managedKeysEntry?.data ?? null,
    subscriptions: subscriptionsEntry?.data ?? null,
    subscriptionSummary: subscriptionSummaryEntry?.data ?? null,
    profileRecord: profileRecordEntry?.data ?? null,
    setProfileRecord,
    platformQuotas: platformQuotasEntry?.data ?? null,
    subscriptionSwitchRules: subscriptionSwitchRulesEntry?.data ?? [],
    subscriptionQuotaAlerts: subscriptionQuotaAlertsEntry?.data ?? null,
    applySubscriptionQuotaAlertConfig,
    presentation,
    resourcePresentation,
    invalidateAccount,
    refreshAccountData,
    refreshResources,
    preloadResources
  };
}

function loadOptional<T>(loader: () => Promise<T>, fallback: T) {
  return loader().catch((cause) => {
    if (isOptionalEndpointUnavailable(cause)) {
      return fallback;
    }
    throw cause;
  });
}

function resolveAccountDataPresentation(
  accountId: string | null,
  entries: Array<ScopedResourceEntry<unknown> | null>
): AccountDataPresentationState {
  const visibleEntries = entries.filter((entry): entry is ScopedResourceEntry<unknown> => entry !== null);
  return {
    accountId,
    hasSnapshot: visibleEntries.some((entry) => entry.hasSnapshot),
    initialLoading: visibleEntries.some((entry) => entry.initialLoading),
    refreshing: visibleEntries.some((entry) => entry.refreshing),
    lastError: visibleEntries.map((entry) => entry.error).find((message): message is string => Boolean(message)) ?? null,
    updatedAt: visibleEntries.reduce<number | null>(
      (latest, entry) => Math.max(latest ?? 0, entry.updatedAt ?? 0) || null,
      null
    )
  };
}

function toAccountDataResourcePresentation(
  entry: ScopedResourceEntry<unknown>
): AccountDataResourcePresentation {
  return {
    hasSnapshot: entry.hasSnapshot,
    initialLoading: entry.initialLoading,
    refreshing: entry.refreshing,
    lastError: entry.error,
    updatedAt: entry.updatedAt
  };
}

function isOptionalEndpointUnavailable(cause: unknown) {
  const message = (cause as Error)?.message ?? "";
  return message.includes("未找到可用的接口路径") || message.includes("404");
}

function toRefreshErrorMessage(cause: unknown) {
  const message = (cause as Error)?.message?.trim();
  return message || "请求失败";
}

export function isAccountDataResourceEnabled(mode: AccountDataResourceMode | undefined) {
  return mode === true || mode === "deferred";
}

export function shouldClearAccountDataForSelectionChange(
  previousAccountId: string | null,
  nextAccountId: string | null
) {
  return previousAccountId !== nextAccountId;
}

export function resolveImmediateAccountDataResources(resources: AccountDataResources): AccountDataResources {
  return {
    groups: resources.groups === true,
    managedKeys: resources.managedKeys === true,
    subscriptions: resources.subscriptions === true,
    subscriptionSummary: resources.subscriptionSummary === true,
    profileRecord: resources.profileRecord === true,
    platformQuotas: resources.platformQuotas === true,
    subscriptionSwitchRules: resources.subscriptionSwitchRules === true,
    subscriptionQuotaAlerts: resources.subscriptionQuotaAlerts === true
  };
}

export function resolveDeferredAccountDataResources(resources: AccountDataResources): AccountDataResources {
  return {
    groups: resources.groups === "deferred",
    managedKeys: resources.managedKeys === "deferred",
    subscriptions: resources.subscriptions === "deferred",
    subscriptionSummary: resources.subscriptionSummary === "deferred",
    profileRecord: resources.profileRecord === "deferred",
    platformQuotas: resources.platformQuotas === "deferred",
    subscriptionSwitchRules: resources.subscriptionSwitchRules === "deferred",
    subscriptionQuotaAlerts: resources.subscriptionQuotaAlerts === "deferred"
  };
}

export function materializeImmediateAccountDataResources(resources: AccountDataResources): AccountDataResources {
  return {
    groups: isAccountDataResourceEnabled(resources.groups),
    managedKeys: isAccountDataResourceEnabled(resources.managedKeys),
    subscriptions: isAccountDataResourceEnabled(resources.subscriptions),
    subscriptionSummary: isAccountDataResourceEnabled(resources.subscriptionSummary),
    profileRecord: isAccountDataResourceEnabled(resources.profileRecord),
    platformQuotas: isAccountDataResourceEnabled(resources.platformQuotas),
    subscriptionSwitchRules: isAccountDataResourceEnabled(resources.subscriptionSwitchRules),
    subscriptionQuotaAlerts: isAccountDataResourceEnabled(resources.subscriptionQuotaAlerts)
  };
}

export function hasEnabledAccountDataResources(resources: AccountDataResources) {
  return Object.values(resources).some(isAccountDataResourceEnabled);
}
