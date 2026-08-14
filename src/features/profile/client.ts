import type {
  EmailIdentityBindInput,
  PlatformQuotaPayload,
  ProfileUpdateInput,
  SubscriptionRecord,
  SubscriptionSummaryPayload,
  UserProfileRecord
} from "../../types";
import { desktopOrHttp } from "../../shared/transport/runtime";

export function getProfileRecord(accountId: string, force = false) {
  return desktopOrHttp<UserProfileRecord>({
    command: "get_profile_record",
    args: { accountId, force },
    url: `/api/accounts/${accountId}/profile${force ? "?force=true" : ""}`
  });
}

export function updateProfileRecord(accountId: string, payload: ProfileUpdateInput) {
  return desktopOrHttp<UserProfileRecord>({
    command: "update_profile_record",
    args: { accountId, payload },
    url: `/api/accounts/${accountId}/profile`,
    init: {
      method: "PUT",
      body: JSON.stringify(payload)
    }
  });
}

export function changeProfilePassword(accountId: string, oldPassword: string, newPassword: string) {
  return desktopOrHttp<boolean>({
    command: "change_profile_password",
    args: { accountId, oldPassword, newPassword },
    url: `/api/accounts/${accountId}/profile/password`,
    init: {
      method: "PUT",
      body: JSON.stringify({
        oldPassword,
        newPassword
      })
    }
  });
}

export function getPlatformQuotas(accountId: string) {
  return desktopOrHttp<PlatformQuotaPayload>({
    command: "get_platform_quotas",
    args: { accountId },
    url: `/api/accounts/${accountId}/profile/platform-quotas`
  });
}

export function getSubscriptions(accountId: string, force = false) {
  return desktopOrHttp<SubscriptionRecord[]>({
    command: "get_subscriptions",
    args: { accountId, force },
    url: `/api/accounts/${accountId}/subscriptions${force ? "?force=true" : ""}`
  });
}

export function getSubscriptionSummary(accountId: string) {
  return desktopOrHttp<SubscriptionSummaryPayload>({
    command: "get_subscription_summary",
    args: { accountId },
    url: `/api/accounts/${accountId}/subscriptions/summary`
  });
}

export function sendNotifyEmailCode(accountId: string, email: string) {
  return desktopOrHttp<boolean>({
    command: "send_notify_email_code",
    args: { accountId, email },
    url: `/api/accounts/${accountId}/notify-email/send-code`,
    init: {
      method: "POST",
      body: JSON.stringify({ email })
    }
  });
}

export function verifyNotifyEmail(accountId: string, email: string, code: string) {
  return desktopOrHttp<boolean>({
    command: "verify_notify_email",
    args: { accountId, email, code },
    url: `/api/accounts/${accountId}/notify-email/verify`,
    init: {
      method: "POST",
      body: JSON.stringify({ email, code })
    }
  });
}

export function removeNotifyEmail(accountId: string, email: string) {
  return desktopOrHttp<boolean>({
    command: "remove_notify_email",
    args: { accountId, email },
    url: `/api/accounts/${accountId}/notify-email`,
    init: {
      method: "DELETE",
      body: JSON.stringify({ email })
    }
  });
}

export function toggleNotifyEmail(accountId: string, email: string, disabled: boolean) {
  return desktopOrHttp<UserProfileRecord>({
    command: "toggle_notify_email",
    args: { accountId, email, disabled },
    url: `/api/accounts/${accountId}/notify-email`,
    init: {
      method: "PATCH",
      body: JSON.stringify({ email, disabled })
    }
  });
}

export function sendEmailBindingCode(accountId: string, email: string) {
  return desktopOrHttp<boolean>({
    command: "send_email_binding_code",
    args: { accountId, email },
    url: `/api/accounts/${accountId}/identity-bindings/email/send-code`,
    init: {
      method: "POST",
      body: JSON.stringify({ email })
    }
  });
}

export function bindEmailIdentity(accountId: string, payload: EmailIdentityBindInput) {
  return desktopOrHttp<UserProfileRecord>({
    command: "bind_email_identity",
    args: { accountId, payload },
    url: `/api/accounts/${accountId}/identity-bindings/email`,
    init: {
      method: "POST",
      body: JSON.stringify(payload)
    }
  });
}

export function unbindAuthIdentity(accountId: string, provider: string) {
  return desktopOrHttp<boolean>({
    command: "unbind_auth_identity",
    args: { accountId, provider },
    url: `/api/accounts/${accountId}/identity-bindings/${provider}`,
    init: {
      method: "DELETE"
    }
  });
}
