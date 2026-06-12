import type { KeyMutationInput } from "../../generated/contracts";
import type { GroupRecord, ManagedKeyRecord, PaginatedResult } from "../../types";
import { desktopOrHttp } from "../../shared/transport/runtime";

export function getAvailableGroups(accountId: string) {
  return desktopOrHttp<GroupRecord[]>({
    command: "get_available_groups",
    args: { accountId },
    url: `/api/accounts/${accountId}/groups`
  });
}

export function listManagedKeys(accountId: string, page = 1, pageSize = 20) {
  return desktopOrHttp<PaginatedResult<ManagedKeyRecord>>({
    command: "list_managed_keys",
    args: { accountId, page, pageSize },
    url: `/api/accounts/${accountId}/keys?page=${page}&page_size=${pageSize}`
  });
}

export function getManagedKey(accountId: string, keyId: string | number) {
  return desktopOrHttp<ManagedKeyRecord>({
    command: "get_managed_key",
    args: { accountId, keyId: String(keyId) },
    url: `/api/accounts/${accountId}/keys/${keyId}`
  });
}

export function createManagedKey(accountId: string, payload: KeyMutationInput) {
  return desktopOrHttp<ManagedKeyRecord>({
    command: "create_managed_key",
    args: { accountId, payload },
    url: `/api/accounts/${accountId}/keys`,
    init: {
      method: "POST",
      body: JSON.stringify(payload)
    }
  });
}

export function updateManagedKey(
  accountId: string,
  keyId: string | number,
  payload: Partial<KeyMutationInput> & { resetQuota?: boolean; resetRateLimitUsage?: boolean }
) {
  return desktopOrHttp<ManagedKeyRecord>({
    command: "update_managed_key",
    args: { accountId, keyId: String(keyId), payload },
    url: `/api/accounts/${accountId}/keys/${keyId}`,
    init: {
      method: "PUT",
      body: JSON.stringify(payload)
    }
  });
}

export function deleteManagedKey(accountId: string, keyId: string | number) {
  return desktopOrHttp<boolean>({
    command: "delete_managed_key",
    args: { accountId, keyId: String(keyId) },
    url: `/api/accounts/${accountId}/keys/${keyId}`,
    init: {
      method: "DELETE"
    }
  });
}
