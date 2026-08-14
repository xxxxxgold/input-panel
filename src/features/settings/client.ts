import type {
  SubscriptionSwitchEvaluationResult,
  SubscriptionSwitchRuleRecord,
  SubscriptionSwitchThresholdMode,
  SubscriptionSwitchRuleUpsertInput,
} from "../../generated/contracts";
import { desktopOrHttp } from "../../shared/transport/runtime";

export function listSubscriptionSwitchRules(accountId: string) {
  return desktopOrHttp<SubscriptionSwitchRuleRecord[]>({
    command: "list_subscription_switch_rules",
    args: { accountId },
    url: `/api/accounts/${accountId}/subscription-switch-rules`,
  });
}

export function upsertSubscriptionSwitchRule(
  accountId: string,
  keyId: string,
  payload: SubscriptionSwitchRuleUpsertInput,
) {
  return desktopOrHttp<SubscriptionSwitchRuleRecord>({
    command: "upsert_subscription_switch_rule",
    args: { accountId, keyId, payload },
    url: `/api/accounts/${accountId}/subscription-switch-rules/${keyId}`,
    init: {
      method: "PUT",
      body: JSON.stringify(payload),
    },
  });
}

export function deleteSubscriptionSwitchRule(accountId: string, keyId: string) {
  return desktopOrHttp<boolean>({
    command: "delete_subscription_switch_rule",
    args: { accountId, keyId },
    url: `/api/accounts/${accountId}/subscription-switch-rules/${keyId}`,
    init: {
      method: "DELETE",
    },
  });
}

export function evaluateSubscriptionSwitchRules(accountId: string) {
  return desktopOrHttp<SubscriptionSwitchEvaluationResult[]>({
    command: "evaluate_subscription_switch_rules",
    args: { accountId },
    url: `/api/accounts/${accountId}/subscription-switch-rules`,
    init: {
      method: "POST",
    },
  });
}

export const DEFAULT_SUBSCRIPTION_SWITCH_THRESHOLD_MODE: SubscriptionSwitchThresholdMode = "usage_percent";
export const DEFAULT_SUBSCRIPTION_SWITCH_THRESHOLD_VALUE = 99;
