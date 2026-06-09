export const DISABLED_BALANCE_WARNING = -1;

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
