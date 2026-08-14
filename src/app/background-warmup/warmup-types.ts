import type { NavKey } from "../../types";
import type { AutoRefreshScope } from "../refresh-policy";

export const WARMUP_RESOURCE_KEYS = [
  "overview",
  "subscriptions",
  "keys",
  "usage",
  "modelStats",
  "keyUsage",
  "serviceStatus",
  "settings"
] as const;

export type WarmupResourceKey = (typeof WARMUP_RESOURCE_KEYS)[number];

export type WarmupStatus = "idle" | "warming" | "warm" | "stale" | "failed" | "cancelled";
export type WarmupTaskResult = "success" | "cancelled";
export type WarmupGroupPolicy = {
  enabled: boolean;
  intervalMs: number;
};

export type WarmupState = {
  status: WarmupStatus;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  errorCount: number;
  lastError: string | null;
};

export type WarmupTask = {
  key: WarmupResourceKey;
  run: () => Promise<WarmupTaskResult | void>;
};

export type WarmupSnapshot = Record<WarmupResourceKey, WarmupState>;

export type WarmupEnvironment = {
  nav: NavKey;
  isAppFocused: boolean;
  overviewReady: boolean;
  selectedAccountId: string | null;
  selectedAccountReady: boolean;
  groupPolicies: Record<Exclude<AutoRefreshScope, "none">, WarmupGroupPolicy>;
  serviceStatusPolicy: WarmupGroupPolicy;
};
