import { accountProxyRequest } from "../../shared/transport/runtime";
import {
  normalizeItems,
  normalizeOrderRecord,
  normalizePaginated,
  normalizePaymentConfig,
  normalizePlatformQuotas,
  normalizeProfile,
  normalizeSubscriptionSummary
} from "../../shared/transport/normalizers";
import type { ProfileUpdateInput } from "../../types";

export function getProfileRecord(accountId: string) {
  return accountProxyRequest<Record<string, unknown>>(accountId, "/api/v1/user/profile").then(normalizeProfile);
}

export function updateProfileRecord(accountId: string, payload: ProfileUpdateInput) {
  return accountProxyRequest<Record<string, unknown>>(accountId, "/api/v1/user", "PUT", {
    email: payload.email,
    username: payload.username,
    balance_notify_enabled: payload.balanceNotifyEnabled,
    balance_notify_threshold_type: payload.balanceNotifyThresholdType,
    balance_notify_threshold: payload.balanceNotifyThreshold
  }).then(normalizeProfile);
}

export function changeProfilePassword(accountId: string, oldPassword: string, newPassword: string) {
  return accountProxyRequest<{ success?: boolean }>(accountId, "/api/v1/user/password", "PUT", {
    old_password: oldPassword,
    new_password: newPassword
  });
}

export function getPlatformQuotas(accountId: string) {
  return accountProxyRequest<Record<string, unknown>>(accountId, "/api/v1/user/platform-quotas").then(normalizePlatformQuotas);
}

export function getSubscriptionSummary(accountId: string) {
  return accountProxyRequest<Record<string, unknown>>(accountId, "/api/v1/subscriptions/summary").then(normalizeSubscriptionSummary);
}

export function getPaymentConfig(accountId: string) {
  return accountProxyRequest<Record<string, unknown>>(accountId, "/api/v1/payment/config").then(normalizePaymentConfig);
}

export function listOrders(accountId: string, page = 1, pageSize = 20) {
  return accountProxyRequest<Record<string, unknown>>(
    accountId,
    `/api/v1/payment/orders/my?page=${page}&page_size=${pageSize}`
  ).then((raw) => normalizePaginated(raw, normalizeItems(raw).map(normalizeOrderRecord), page, pageSize));
}

export function sendNotifyEmailCode(accountId: string, email: string) {
  return accountProxyRequest<{ success?: boolean }>(
    accountId,
    "/api/v1/user/notify-email/send-code",
    "POST",
    { email }
  );
}

export function verifyNotifyEmail(accountId: string, email: string, code: string) {
  return accountProxyRequest<{ success?: boolean }>(
    accountId,
    "/api/v1/user/notify-email/verify",
    "POST",
    { email, code }
  );
}

export function removeNotifyEmail(accountId: string, email: string) {
  return accountProxyRequest<{ success?: boolean }>(
    accountId,
    "/api/v1/user/notify-email",
    "DELETE",
    { email }
  );
}

export function toggleNotifyEmail(accountId: string, email: string, disabled: boolean) {
  return accountProxyRequest<Record<string, unknown>>(
    accountId,
    "/api/v1/user/notify-email/toggle",
    "PUT",
    { email, disabled }
  ).then(normalizeProfile);
}

export function sendEmailBindingCode(accountId: string, email: string) {
  return accountProxyRequest<{ success?: boolean }>(
    accountId,
    "/api/v1/user/account-bindings/email/send-code",
    "POST",
    { email }
  );
}

export function bindEmailIdentity(
  accountId: string,
  payload: { email: string; code: string }
) {
  return accountProxyRequest<{ success?: boolean }>(
    accountId,
    "/api/v1/user/account-bindings/email",
    "POST",
    payload
  );
}

export function unbindAuthIdentity(accountId: string, provider: string) {
  return accountProxyRequest<{ success?: boolean }>(
    accountId,
    `/api/v1/user/account-bindings/${provider}`,
    "DELETE"
  );
}
