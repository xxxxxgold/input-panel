export const DISABLED_BALANCE_WARNING = -1;
export const DEFAULT_LOW_BALANCE_THRESHOLD = 0;

export interface AccountAlertPreferenceDraft {
  lowBalanceEnabled: boolean;
  lowBalanceThreshold: number;
  subscriptionQuotaAlertsEnabled: boolean;
}

export function normalizeBalanceWarning(value: number | string | null | undefined) {
  if (value === null || value === undefined) {
    return DISABLED_BALANCE_WARNING;
  }
  if (typeof value === "string" && value.trim() === "") {
    return DISABLED_BALANCE_WARNING;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return DISABLED_BALANCE_WARNING;
  }
  return parsed < 0 ? DISABLED_BALANCE_WARNING : parsed;
}

export function isBalanceWarningDisabled(value: number) {
  return value < 0;
}

export function formatBalanceWarningSummary(value: number) {
  return isBalanceWarningDisabled(value) ? "预警已关闭" : `预警 $${value.toFixed(2)}`;
}

export function alertPreferencesFromLegacyBalanceWarning(
  value: number | string | null | undefined,
  subscriptionQuotaAlertsEnabled = true
): AccountAlertPreferenceDraft {
  const threshold = normalizeBalanceWarning(value);
  return {
    lowBalanceEnabled: threshold >= 0,
    lowBalanceThreshold: threshold >= 0 ? threshold : DEFAULT_LOW_BALANCE_THRESHOLD,
    subscriptionQuotaAlertsEnabled
  };
}

export function legacyBalanceWarningFromAlertPreferences(preferences: AccountAlertPreferenceDraft) {
  return preferences.lowBalanceEnabled
    ? preferences.lowBalanceThreshold
    : DISABLED_BALANCE_WARNING;
}
