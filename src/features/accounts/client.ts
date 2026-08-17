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
  SiteCooldownClearInput,
  SiteEndpointTestInput,
  SiteEndpointTestResult,
  SiteFailoverStatusPayload,
  SiteFailoverTransitionBatch,
  SiteInput,
  SitePatchInput,
  SiteRecord
} from "../../types";
import {
  desktopOrHttp,
  isTauriRuntime,
  request,
  requestErrorFromUnknown
} from "../../shared/transport/runtime";
import { refreshSiteFailoverTransitionsAfter } from "../../shared/site-failover-transition";

export function createSite(payload: SiteInput) {
  return desktopOrHttp<SiteRecord>({
    command: "create_site",
    args: { payload },
    url: "/api/sites",
    init: {
      method: "POST",
      body: JSON.stringify(payload)
    }
  });
}

export function updateSite(siteId: string, payload: SitePatchInput) {
  return desktopOrHttp<SiteRecord>({
    command: "update_site",
    args: { siteId, payload },
    url: `/api/sites/${siteId}`,
    init: {
      method: "PATCH",
      body: JSON.stringify(payload)
    }
  });
}

export function removeSite(siteId: string) {
  return desktopOrHttp<boolean | { ok: true }>({
    command: "remove_site",
    args: { siteId },
    url: `/api/sites/${siteId}`,
    init: { method: "DELETE" }
  }).then(() => ({ ok: true as const }));
}

export function getSiteFailoverStatus(siteId: string) {
  return desktopOrHttp<SiteFailoverStatusPayload>({
    command: "get_site_failover_status",
    args: { siteId },
    url: `/api/sites/${siteId}/failover-status`
  });
}

export function testSiteEndpoint(siteId: string, payload: SiteEndpointTestInput) {
  return desktopOrHttp<SiteEndpointTestResult>({
    command: "test_site_endpoint",
    args: { siteId, payload },
    url: `/api/sites/${siteId}/failover/test`,
    init: {
      method: "POST",
      body: JSON.stringify(payload)
    }
  });
}

export function clearSiteFailoverCooldown(siteId: string, payload: SiteCooldownClearInput) {
  return desktopOrHttp<SiteFailoverStatusPayload>({
    command: "clear_site_failover_cooldown",
    args: { siteId, payload },
    url: `/api/sites/${siteId}/failover/clear-cooldown`,
    init: {
      method: "POST",
      body: JSON.stringify(payload)
    }
  });
}

export function listSiteFailoverTransitions(afterRevision: number) {
  const query = new URLSearchParams({ afterRevision: String(afterRevision) });
  return desktopOrHttp<SiteFailoverTransitionBatch>({
    command: "list_site_failover_transitions",
    args: { afterRevision },
    url: `/api/site-failover/transitions?${query.toString()}`
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

export function loginAccount(accountId: string, password: string): Promise<LoginFlowResult> {
  if (isTauriRuntime()) {
    return refreshSiteFailoverTransitionsAfter(desktopOrHttp<LoginFlowResult>({
      command: "login_account",
      args: { accountId, password },
      url: ""
    }));
  }

  return refreshSiteFailoverTransitionsAfter(loginAccountHttp(accountId, password));
}

async function loginAccountHttp(accountId: string, password: string): Promise<LoginFlowResult> {
  const response = await fetch(`/api/accounts/${accountId}/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ password })
  });
  const data = (await response.json().catch(() => null)) as
    | { error?: string; tempToken?: string; originBaseUrl?: string; emailMasked?: string }
    | AccountRuntime
    | null;
  if (response.ok) {
    return {
      type: "success",
      account: data as AccountRuntime
    };
  }
  if (response.status === 409 && data && "tempToken" in data && typeof data.tempToken === "string") {
    if (!("originBaseUrl" in data) || typeof data.originBaseUrl !== "string") {
      throw new Error("2FA 响应缺少来源站点地址。");
    }
    return {
      type: "2fa",
      tempToken: data.tempToken,
      originBaseUrl: data.originBaseUrl,
      emailMasked: data.emailMasked ?? null,
      message: data.error
    };
  }
  throw requestErrorFromUnknown(data, response.status);
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

export function completeAccount2fa(
  accountId: string,
  tempToken: string,
  code: string,
  originBaseUrl: string
) {
  return refreshSiteFailoverTransitionsAfter(desktopOrHttp<AccountRuntime>({
    command: "login_account_2fa",
    args: { accountId, tempToken, code, originBaseUrl },
    url: `/api/accounts/${accountId}/login/2fa`,
    init: {
      method: "POST",
      body: JSON.stringify({ tempToken, code, originBaseUrl })
    }
  }));
}

export function refreshAccount(
  accountId: string,
  triggerSource: RefreshTriggerSource = "manual"
) {
  const operation = desktopOrHttp<RefreshAccountTaskResponse>({
    command: "refresh_account",
    args: { accountId, triggerSource },
    url: `/api/accounts/${accountId}/refresh`,
    init: {
      method: "POST",
      body: JSON.stringify({ triggerSource })
    }
  }).then((result) => result.account);
  return refreshSiteFailoverTransitionsAfter(operation);
}

export function syncAccountData(
  accountId: string,
  payload: {
    scope: DataSyncScope;
    triggerSource?: DataSyncTrigger;
  }
) {
  const normalizedPayload = {
    scope: payload.scope,
    triggerSource: payload.triggerSource ?? "manual"
  };
  return refreshSiteFailoverTransitionsAfter(desktopOrHttp<AccountSyncStatusPayload>({
    command: "sync_account_data",
    args: {
      accountId,
      payload: normalizedPayload
    },
    url: `/api/accounts/${accountId}/sync`,
    init: {
      method: "POST",
      body: JSON.stringify({
        scope: normalizedPayload.scope,
        triggerSource: normalizedPayload.triggerSource
      })
    }
  }));
}

export function getAccountSyncStatus(accountId: string) {
  if (isTauriRuntime()) {
    return invoke<AccountSyncStatusPayload>("get_account_sync_status", { accountId });
  }
  return request<AccountSyncStatusPayload>(`/api/accounts/${accountId}/sync-status`);
}

