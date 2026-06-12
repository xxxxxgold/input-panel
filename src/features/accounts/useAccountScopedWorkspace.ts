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

export function useAccountScopedWorkspace({
  selectedAccountId,
  setError
}: {
  selectedAccountId: string | null;
  setError: (value: string | null) => void;
}) {
  const [groups, setGroups] = useState<GroupRecord[]>([]);
  const [managedKeys, setManagedKeys] = useState<PaginatedResult<ManagedKeyRecord> | null>(null);
  const [subscriptionSummary, setSubscriptionSummary] = useState<SubscriptionSummaryPayload | null>(null);
  const [profileRecord, setProfileRecord] = useState<UserProfileRecord | null>(null);
  const [platformQuotas, setPlatformQuotas] = useState<PlatformQuotaPayload | null>(null);

  useEffect(() => {
    if (!selectedAccountId) {
      setGroups([]);
      setManagedKeys(null);
      setSubscriptionSummary(null);
      setProfileRecord(null);
      setPlatformQuotas(null);
      return;
    }

    setGroups([]);
    setManagedKeys(null);
    setSubscriptionSummary(null);
    setProfileRecord(null);
    setPlatformQuotas(null);
    void loadAccountScopedData(selectedAccountId);
  }, [selectedAccountId]);

  async function loadAccountScopedData(accountId: string) {
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
        loadOptional(() => getAvailableGroups(accountId), []),
        listManagedKeys(accountId, 1, 100),
        getProfileRecord(accountId),
        loadOptional(() => getPlatformQuotas(accountId), null),
        loadOptional(() => getSubscriptionSummary(accountId), null)
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

  async function refreshAccountScopedData() {
    if (!selectedAccountId) {
      return;
    }
    await loadAccountScopedData(selectedAccountId);
  }

  return {
    groups,
    managedKeys,
    subscriptionSummary,
    profileRecord,
    setProfileRecord,
    platformQuotas,
    refreshAccountScopedData
  };
}

function isOptionalEndpointUnavailable(cause: unknown) {
  const message = (cause as Error)?.message ?? "";
  return message.includes("未找到可用的接口路径") || message.includes("404");
}
