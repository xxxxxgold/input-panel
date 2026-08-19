import type {
  SubscriptionQuotaAlertConfig,
  SubscriptionQuotaAlertSettingsPayload,
  SubscriptionQuotaAlertUpsertInput
} from "../../types";
import { desktopOrHttp } from "../../shared/transport/runtime";

export function querySubscriptionQuotaAlerts(accountId: string) {
  return desktopOrHttp<SubscriptionQuotaAlertSettingsPayload>({
    command: "query_subscription_quota_alerts",
    args: { accountId },
    url: `/api/accounts/${accountId}/subscription-quota-alerts/query`,
    init: { method: "POST" }
  });
}

export function upsertSubscriptionQuotaAlert(
  accountId: string,
  payload: SubscriptionQuotaAlertUpsertInput
) {
  return desktopOrHttp<SubscriptionQuotaAlertConfig>({
    command: "upsert_subscription_quota_alert",
    args: { accountId, payload },
    url: `/api/accounts/${accountId}/subscription-quota-alerts/upsert`,
    init: {
      method: "POST",
      body: JSON.stringify(payload)
    }
  });
}
