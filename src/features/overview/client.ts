import { invoke } from "@tauri-apps/api/core";

import type { OverviewPayload } from "../../types";
import { isTauriRuntime, request } from "../../shared/transport/runtime";

export function getOverview() {
  if (isTauriRuntime()) {
    return invoke<OverviewPayload>("get_overview");
  }
  return request<OverviewPayload>("/api/dashboard/overview");
}

export function refreshAllAccounts() {
  if (isTauriRuntime()) {
    return invoke<OverviewPayload>("refresh_all_accounts");
  }
  return request<OverviewPayload>("/api/accounts/refresh-all", {
    method: "POST"
  });
}
