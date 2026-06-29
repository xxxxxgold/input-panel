import { invoke } from "@tauri-apps/api/core";

import type {
  AccountSyncStatusPayload,
  AccountInput,
  AccountRuntime,
  DataSyncScope,
  LoginFlowResult,
  DataSyncTrigger,
  RefreshAccountTaskResponse,
  RefreshTriggerSource,
  SiteInput,
  SiteRecord
} from "../../types";
import { isTauriRuntime, request } from "../../shared/transport/runtime";

export function createSite(payload: SiteInput) {
  if (isTauriRuntime()) {
    return invoke<SiteRecord>("create_site", { payload });
  }
  return request<SiteRecord>("/api/sites", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateSite(siteId: string, payload: Partial<SiteInput>) {
  if (isTauriRuntime()) {
    return invoke<SiteRecord>("update_site", {
      siteId,
      name: payload.name,
      baseUrl: payload.baseUrl
    });
  }
  return request<SiteRecord>(`/api/sites/${siteId}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function removeSite(siteId: string) {
  if (isTauriRuntime()) {
    return invoke<boolean>("remove_site", { siteId }).then(() => ({ ok: true as const }));
  }
  return request<{ ok: true }>(`/api/sites/${siteId}`, {
    method: "DELETE"
  });
}

export function createAccount(payload: AccountInput) {
  if (isTauriRuntime()) {
    return invoke<AccountRuntime>("create_account", { payload });
  }
  return request<AccountRuntime>("/api/accounts", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateAccount(
  accountId: string,
  payload: Partial<Omit<AccountInput, "siteId">>
) {
  if (isTauriRuntime()) {
    return invoke<AccountRuntime>("update_account", {
      accountId,
      label: payload.label,
      email: payload.email,
      balanceWarning: payload.balanceWarning
    });
  }
  return request<AccountRuntime>(`/api/accounts/${accountId}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function removeAccount(accountId: string) {
  if (isTauriRuntime()) {
    return invoke<boolean>("remove_account", { accountId }).then(() => ({ ok: true as const }));
  }
  return request<{ ok: true }>(`/api/accounts/${accountId}`, {
    method: "DELETE"
  });
}

export async function loginAccount(accountId: string, password: string): Promise<LoginFlowResult> {
  if (isTauriRuntime()) {
    return invoke<LoginFlowResult>("login_account", { accountId, password });
  }
  const response = await fetch(`/api/accounts/${accountId}/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ password })
  });
  const data = (await response.json().catch(() => null)) as
    | { error?: string; tempToken?: string; emailMasked?: string }
    | AccountRuntime
    | null;
  if (response.ok) {
    return {
      type: "success",
      account: data as AccountRuntime
    };
  }
  if (response.status === 409 && data && "tempToken" in data && typeof data.tempToken === "string") {
    return {
      type: "2fa",
      tempToken: data.tempToken,
      emailMasked: data.emailMasked ?? null,
      message: data.error
    };
  }
  throw new Error((data as { error?: string } | null)?.error ?? `Request failed: ${response.status}`);
}

export function persistAccountCredential(accountId: string, password: string) {
  if (isTauriRuntime()) {
    return invoke<boolean>("persist_account_credential", { accountId, password });
  }
  return request<{ ok: true }>(`/api/accounts/${accountId}/credential`, {
    method: "POST",
    body: JSON.stringify({ password })
  });
}

export function completeAccount2fa(accountId: string, tempToken: string, code: string) {
  if (isTauriRuntime()) {
    return invoke<AccountRuntime>("login_account_2fa", { accountId, tempToken, code });
  }
  return request<AccountRuntime>(`/api/accounts/${accountId}/login/2fa`, {
    method: "POST",
    body: JSON.stringify({ tempToken, code })
  });
}

export function refreshAccount(
  accountId: string,
  triggerSource: RefreshTriggerSource = "manual"
) {
  if (isTauriRuntime()) {
    return invoke<RefreshAccountTaskResponse>("refresh_account", {
      accountId,
      triggerSource
    }).then((result) => result.account);
  }
  return request<RefreshAccountTaskResponse>(`/api/accounts/${accountId}/refresh`, {
    method: "POST",
    body: JSON.stringify({ triggerSource })
  }).then((result) => result.account);
}

export function syncAccountData(
  accountId: string,
  payload: {
    scope: DataSyncScope;
    triggerSource?: DataSyncTrigger;
  }
) {
  if (isTauriRuntime()) {
    return invoke<AccountSyncStatusPayload>("sync_account_data", {
      accountId,
      payload: {
        scope: payload.scope,
        triggerSource: payload.triggerSource ?? "manual"
      }
    });
  }
  return request<AccountSyncStatusPayload>(`/api/accounts/${accountId}/sync`, {
    method: "POST",
    body: JSON.stringify({
      scope: payload.scope,
      triggerSource: payload.triggerSource ?? "manual"
    })
  });
}

export function getAccountSyncStatus(accountId: string) {
  if (isTauriRuntime()) {
    return invoke<AccountSyncStatusPayload>("get_account_sync_status", { accountId });
  }
  return request<AccountSyncStatusPayload>(`/api/accounts/${accountId}/sync-status`);
}

