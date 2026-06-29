import { invoke } from "@tauri-apps/api/core";

import type { DataSyncScope, OverviewPayload, DataSyncTrigger } from "../../types";
import { isTauriRuntime, request } from "../../shared/transport/runtime";

export function getOverview() {
  if (isTauriRuntime()) {
    return invoke<OverviewPayload>("get_overview").then(normalizeOverviewPayload);
  }
  return request<OverviewPayload>("/api/dashboard/overview").then(normalizeOverviewPayload);
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

