import type {
  SubscriptionQuotaAlertRule,
  SubscriptionQuotaAlertSettingsPayload
} from "../../types";

export const DEFAULT_SUBSCRIPTION_QUOTA_ALERT_RULE: SubscriptionQuotaAlertRule = {
  enabled: true,
  thresholdMode: "usage_percent",
  thresholdValue: 98,
  revision: 0
};

export function createDefaultSubscriptionQuotaAlertSettings(): SubscriptionQuotaAlertSettingsPayload {
  return {
    defaultRule: { ...DEFAULT_SUBSCRIPTION_QUOTA_ALERT_RULE },
    overrides: []
  };
}

export function resolveEffectiveSubscriptionQuotaAlertRule(
  settings: SubscriptionQuotaAlertSettingsPayload | null | undefined,
  subscriptionKey: string
): SubscriptionQuotaAlertRule {
  return settings?.overrides.find((config) => config.subscriptionKey === subscriptionKey)?.rule
    ?? settings?.defaultRule
    ?? DEFAULT_SUBSCRIPTION_QUOTA_ALERT_RULE;
}

export function formatSubscriptionQuotaAlertSummary(rule: SubscriptionQuotaAlertRule) {
  if (!rule.enabled) {
    return "已关闭";
  }
  if (rule.thresholdMode === "amount_usd") {
    return `$${formatThresholdValue(rule.thresholdValue)}`;
  }
  return `${formatThresholdValue(rule.thresholdValue)}%`;
}

function formatThresholdValue(value: number) {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
