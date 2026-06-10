import type { KeyMutationInput } from "../../generated/contracts";
import { accountProxyRequest } from "../../shared/transport/runtime";
import {
  normalizeGroupRecord,
  normalizeItems,
  normalizeManagedKeyRecord,
  normalizePaginated
} from "../../shared/transport/normalizers";

export function getAvailableGroups(accountId: string) {
  return accountProxyRequest<Record<string, unknown>[]>(accountId, "/api/v1/groups/available").then((items) =>
    items.map(normalizeGroupRecord)
  );
}

export function listManagedKeys(accountId: string, page = 1, pageSize = 20) {
  return accountProxyRequest<Record<string, unknown>>(
    accountId,
    `/api/v1/keys?page=${page}&page_size=${pageSize}`
  ).then((raw) => normalizePaginated(raw, normalizeItems(raw).map(normalizeManagedKeyRecord), page, pageSize));
}

export function getManagedKey(accountId: string, keyId: string | number) {
  return accountProxyRequest<Record<string, unknown>>(accountId, `/api/v1/keys/${keyId}`).then(normalizeManagedKeyRecord);
}

export function createManagedKey(accountId: string, payload: KeyMutationInput) {
  return accountProxyRequest<Record<string, unknown>>(accountId, "/api/v1/keys", "POST", {
    name: payload.name,
    group_id: payload.groupId,
    custom_key: payload.customKey,
    ip_whitelist: payload.ipWhitelist,
    ip_blacklist: payload.ipBlacklist,
    quota: payload.quota,
    expires_in_days: payload.expiresInDays,
    status: payload.status,
    rate_limit_5h: payload.rateLimit5h,
    rate_limit_1d: payload.rateLimit1d,
    rate_limit_7d: payload.rateLimit7d
  }).then(normalizeManagedKeyRecord);
}

export function updateManagedKey(
  accountId: string,
  keyId: string | number,
  payload: Partial<KeyMutationInput> & { resetQuota?: boolean; resetRateLimitUsage?: boolean }
) {
  return accountProxyRequest<Record<string, unknown>>(accountId, `/api/v1/keys/${keyId}`, "PUT", {
    name: payload.name,
    group_id: payload.groupId,
    custom_key: payload.customKey,
    ip_whitelist: payload.ipWhitelist,
    ip_blacklist: payload.ipBlacklist,
    quota: payload.quota,
    expires_in_days: payload.expiresInDays,
    status: payload.status,
    rate_limit_5h: payload.rateLimit5h,
    rate_limit_1d: payload.rateLimit1d,
    rate_limit_7d: payload.rateLimit7d,
    reset_quota: payload.resetQuota,
    reset_rate_limit_usage: payload.resetRateLimitUsage
  }).then(normalizeManagedKeyRecord);
}

export function deleteManagedKey(accountId: string, keyId: string | number) {
  return accountProxyRequest<{ success?: boolean }>(accountId, `/api/v1/keys/${keyId}`, "DELETE");
}
