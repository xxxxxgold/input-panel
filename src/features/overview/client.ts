import { invoke } from "@tauri-apps/api/core";

import type {
  DataSyncScope,
  DataSyncTrigger,
  CodexRadarFastRadarPayload,
  CodexRadarInsightsPayload,
  CodexRadarIntelligencePayload,
  CodexRadarModelIqPayload,
  OverviewDashboardStatsPayload,
  OverviewPayload
} from "../../types";
import { desktopOrHttp, isTauriRuntime, request } from "../../shared/transport/runtime";

export function getOverview() {
  if (isTauriRuntime()) {
    return invoke<OverviewPayload>("get_overview").then(normalizeOverviewPayload);
  }
  return request<OverviewPayload>("/api/dashboard/overview").then(normalizeOverviewPayload);
}

export function getOverviewShell() {
  if (isTauriRuntime()) {
    return invoke<OverviewPayload>("get_overview_shell").then(normalizeOverviewPayload);
  }
  return request<OverviewPayload>("/api/dashboard/overview-shell").then(normalizeOverviewPayload);
}

export function getOverviewShellLite() {
  if (isTauriRuntime()) {
    return invoke<OverviewPayload>("get_overview_shell_lite").then(normalizeOverviewPayload);
  }
  return request<OverviewPayload>("/api/dashboard/overview-shell-lite").then(normalizeOverviewPayload);
}

export function getOverviewDashboardStats(accountId: string, force = false) {
  if (isTauriRuntime()) {
    return invoke<OverviewDashboardStatsPayload>("get_overview_dashboard_stats", { accountId, force });
  }
  const suffix = force ? "?force=true" : "";
  return request<OverviewDashboardStatsPayload>(`/api/accounts/${accountId}/usage/dashboard/stats${suffix}`);
}

export function getCodexRadarModelIq() {
  return desktopOrHttp<CodexRadarModelIqPayload>({
    command: "get_codex_radar_model_iq",
    url: "/api/codex-radar/model-iq"
  });
}

export function getCodexRadarIntelligence() {
  return desktopOrHttp<CodexRadarIntelligencePayload>({
    command: "get_codex_radar_intelligence",
    url: "/api/codex-radar/intelligence"
  });
}

export function getCodexRadarFast() {
  return desktopOrHttp<CodexRadarFastRadarPayload>({
    command: "get_codex_radar_fast",
    url: "/api/codex-radar/fast"
  });
}

export function getCodexRadarInsights(force = false) {
  return desktopOrHttp<CodexRadarInsightsPayload>({
    command: "get_codex_radar_insights",
    args: { force },
    url: `/api/codex-radar/insights${force ? "?force=true" : ""}`
  });
}

export function refreshAllAccounts() {
  if (isTauriRuntime()) {
    return invoke<OverviewPayload>("refresh_all_accounts");
  }
  return request<OverviewPayload>("/api/accounts/refresh-all", {
    method: "POST"
  });
}

export function syncAllAccounts(scope: DataSyncScope = "full", triggerSource: DataSyncTrigger = "manual") {
  if (isTauriRuntime()) {
    return invoke<OverviewPayload>("sync_all_accounts", {
      payload: {
        scope,
        triggerSource
      }
    });
  }
  return request<OverviewPayload>("/api/accounts/sync-all", {
    method: "POST",
    body: JSON.stringify({
      scope,
      triggerSource
    })
  });
}

function normalizeOverviewPayload(payload: OverviewPayload) {
  return {
    ...payload,
    accounts: payload.accounts.map((account) => {
      if (account.cacheView) {
        return account;
      }

      const rawAccount = account as typeof account & {
        snapshot?: typeof account.cacheView;
      };

      if (!rawAccount.snapshot) {
        return account;
      }

      return {
        ...account,
        cacheView: rawAccount.snapshot
      };
    })
  };
}

