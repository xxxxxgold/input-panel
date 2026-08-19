import type { NavKey } from "../types";

export type PagePreloadTarget =
  | "systemSettings"
  | "usage"
  | "keys"
  | "subscriptions"
  | "serviceStatus"
  | "modelStats";

export type PagePreloadResult = "completed" | "failed" | "skipped" | "skipped-budget";
export type PagePreloadPriority = "idle" | "intent" | "navigate";

export type PagePreloadTask = () => Promise<void | "skipped">;

const PAGE_PRELOAD_CANDIDATES: Partial<Record<NavKey, readonly PagePreloadTarget[]>> = {
  overview: ["usage", "keys", "subscriptions"],
  usage: ["modelStats", "keys"],
  modelStats: ["usage"],
  keys: ["subscriptions"],
  subscriptions: ["keys"]
};

export function getPagePreloadCandidates(nav: NavKey) {
  return [...(PAGE_PRELOAD_CANDIDATES[nav] ?? [])];
}

export function getIdlePagePreloadCandidate(nav: NavKey) {
  return getPagePreloadCandidates(nav)[0] ?? null;
}

export function shouldStartPagePreload(options: {
  isAppFocused: boolean;
  saveData?: boolean;
  effectiveType?: string | null;
}) {
  if (!options.isAppFocused || options.saveData) {
    return false;
  }
  return options.effectiveType !== "slow-2g" && options.effectiveType !== "2g";
}

export { PagePreloadCoordinator } from "./page-preload-coordinator";
