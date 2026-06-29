import { useEffect, useState } from "react";

import type {
  GroupRecord,
  ManagedKeyRecord,
  PaginatedResult,
  PlatformQuotaPayload,
  SubscriptionSummaryPayload,
  UserProfileRecord
} from "../../types";
import {
  getAvailableGroups,
  getPlatformQuotas,
  getProfileRecord,
  getSubscriptionSummary,
  listManagedKeys
} from "../../api";

type AccountDataResources = {
  groups?: boolean;
  managedKeys?: boolean;
  subscriptionSummary?: boolean;
  profileRecord?: boolean;
  platformQuotas?: boolean;
};

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
  const [groups, setGroups] = useState<GroupRecord[]>([]);
  const [managedKeys, setManagedKeys] = useState<PaginatedResult<ManagedKeyRecord> | null>(null);
  const [subscriptionSummary, setSubscriptionSummary] = useState<SubscriptionSummaryPayload | null>(null);
  const [profileRecord, setProfileRecord] = useState<UserProfileRecord | null>(null);
  const [platformQuotas, setPlatformQuotas] = useState<PlatformQuotaPayload | null>(null);
  const groupsEnabled = resources.groups ?? false;
  const managedKeysEnabled = resources.managedKeys ?? false;
  const subscriptionSummaryEnabled = resources.subscriptionSummary ?? false;
  const profileRecordEnabled = resources.profileRecord ?? false;
  const platformQuotasEnabled = resources.platformQuotas ?? false;

  useEffect(() => {
    if (!selectedAccountId) {
      setGroups([]);
      setManagedKeys(null);
      setSubscriptionSummary(null);
      setProfileRecord(null);
      setPlatformQuotas(null);
      return;
    }

    if (!groupsEnabled) {
      setGroups([]);
    }
    if (!managedKeysEnabled) {
      setManagedKeys(null);
    }
    if (!subscriptionSummaryEnabled) {
      setSubscriptionSummary(null);
    }
    if (!profileRecordEnabled) {
      setProfileRecord(null);
    }
    if (!platformQuotasEnabled) {
      setPlatformQuotas(null);
    }
  }, [selectedAccountId, groupsEnabled, managedKeysEnabled, subscriptionSummaryEnabled, profileRecordEnabled, platformQuotasEnabled]);

  useEffect(() => {
    if (!selectedAccountId || !enabled || !hasEnabledAccountDataResources(resources)) {
      return;
    }
    void loadAccountData(selectedAccountId);
  }, [
    enabled,
    groupsEnabled,
    managedKeysEnabled,
    platformQuotasEnabled,
    profileRecordEnabled,
    selectedAccountId,
    subscriptionSummaryEnabled
  ]);

  async function loadAccountData(accountId: string) {
    try {
      const loadOptional = async <T,>(loader: () => Promise<T>, fallback: T) => {
        try {
          return await loader();
        } catch (cause) {
          if (isOptionalEndpointUnavailable(cause)) {
            return fallback;
          }
          throw cause;
        }
      };

      const [
        nextGroups,
        nextKeys,
        nextProfile,
        nextPlatformQuotas,
        nextSubscriptionSummary
      ] = await Promise.all([
        groupsEnabled ? loadOptional(() => getAvailableGroups(accountId), []) : Promise.resolve([]),
        managedKeysEnabled ? listManagedKeys(accountId, 1, 100) : Promise.resolve(null),
        profileRecordEnabled ? getProfileRecord(accountId) : Promise.resolve(null),
        platformQuotasEnabled ? loadOptional(() => getPlatformQuotas(accountId), null) : Promise.resolve(null),
        subscriptionSummaryEnabled ? loadOptional(() => getSubscriptionSummary(accountId), null) : Promise.resolve(null)
      ]);

      setGroups(nextGroups);
      setManagedKeys(nextKeys);
      setProfileRecord(nextProfile);
      setPlatformQuotas(nextPlatformQuotas);
      setSubscriptionSummary(nextSubscriptionSummary);
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  async function refreshAccountData() {
    if (!selectedAccountId || !enabled || !hasEnabledAccountDataResources(resources)) {
      return;
    }
    await loadAccountData(selectedAccountId);
  }

  return {
    groups,
    managedKeys,
    subscriptionSummary,
    profileRecord,
    setProfileRecord,
    platformQuotas,
    refreshAccountData
  };
}

function isOptionalEndpointUnavailable(cause: unknown) {
  const message = (cause as Error)?.message ?? "";
  return message.includes("未找到可用的接口路径") || message.includes("404");
}

function hasEnabledAccountDataResources(resources: AccountDataResources) {
  return Boolean(
    resources.groups
    || resources.managedKeys
    || resources.subscriptionSummary
    || resources.profileRecord
    || resources.platformQuotas
  );
}
