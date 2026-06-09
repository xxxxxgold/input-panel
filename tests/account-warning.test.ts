import { describe, expect, it } from "vitest";
import {
  DISABLED_BALANCE_WARNING,
  formatBalanceWarningSummary,
  isBalanceWarningDisabled,
  normalizeBalanceWarning
} from "../src/account-warning";

describe("account warning helpers", () => {
  it("uses -1 as the disabled default", () => {
    expect(DISABLED_BALANCE_WARNING).toBe(-1);
    expect(normalizeBalanceWarning(undefined)).toBe(-1);
    expect(normalizeBalanceWarning("")).toBe(-1);
  });

  it("keeps explicit numeric thresholds and recognizes disabled values", () => {
    expect(normalizeBalanceWarning("-1")).toBe(-1);
    expect(normalizeBalanceWarning(3.5)).toBe(3.5);
    expect(isBalanceWarningDisabled(-1)).toBe(true);
    expect(isBalanceWarningDisabled(0)).toBe(false);
  });

  it("formats disabled warning summary distinctly", () => {
    expect(formatBalanceWarningSummary(-1)).toBe("预警已关闭");
    expect(formatBalanceWarningSummary(5)).toBe("预警 $5.00");
  });
});
