import type {
  AccountInput,
  AccountUsageStatsRecord,
  AccountRuntime,
  DailyUsagePoint,
  DashboardModelsPayload,
  GroupRecord,
  KeyMutationInput,
  LoginFlowResult,
  ManagedKeyRecord,
  OverviewPayload,
  OrderRecord,
  PaginatedResult,
  PaymentConfigRecord,
  PlatformQuotaPayload,
  ProfileUpdateInput,
  SiteInput,
  SiteRecord,
  SubscriptionSummaryPayload,
  UsageRow,
  UsageStatsRecord,
  UsageTrendPayload,
  UserProfileRecord
} from "./types";
import { invoke } from "@tauri-apps/api/core";

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function request<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

function pickPath(value: Record<string, unknown> | null | undefined, path: string): unknown {
  if (!value) return undefined;
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current && typeof current === "object" && segment in (current as Record<string, unknown>)) {
      return (current as Record<string, unknown>)[segment];
    }
    return undefined;
  }, value);
}

function pickString(value: Record<string, unknown> | null | undefined, keys: string[], fallback?: string) {
  for (const key of keys) {
    const next = pickPath(value, key);
    if (typeof next === "string" && next.trim()) {
      return next;
    }
  }
  return fallback;
}

function pickNumber(value: Record<string, unknown> | null | undefined, keys: string[], fallback = 0) {
  for (const key of keys) {
    const next = pickPath(value, key);
    if (typeof next === "number" && Number.isFinite(next)) {
      return next;
    }
    if (typeof next === "string" && next.trim() && !Number.isNaN(Number(next))) {
      return Number(next);
    }
  }
  return fallback;
}

function pickOptionalNumber(value: Record<string, unknown> | null | undefined, keys: string[]) {
  for (const key of keys) {
    const next = pickPath(value, key);
    if (typeof next === "number" && Number.isFinite(next)) {
      return next;
    }
    if (typeof next === "string" && next.trim() && !Number.isNaN(Number(next))) {
      return Number(next);
    }
  }
  return undefined;
}

function normalizeItems(value: unknown) {
  if (Array.isArray(value)) {
    return value as Record<string, unknown>[];
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["items", "data", "list", "subscriptions", "models", "trend", "platform_quotas"]) {
      if (Array.isArray(record[key])) {
        return record[key] as Record<string, unknown>[];
      }
    }
  }
  return [];
}

function normalizeGroupRecord(item: Record<string, unknown>): GroupRecord {
  return {
    id: pickNumber(item, ["id"], 0),
    name: pickString(item, ["name"], "未命名分组") ?? "未命名分组",
    description: pickString(item, ["description"]),
    platform: pickString(item, ["platform"], "unknown") ?? "unknown",
    rateMultiplier: pickNumber(item, ["rate_multiplier"], 1),
    subscriptionType: pickString(item, ["subscription_type"]),
    dailyLimitUsd: pickNumber(item, ["daily_limit_usd"], 0),
    weeklyLimitUsd: pickNumber(item, ["weekly_limit_usd"], 0),
    monthlyLimitUsd: pickNumber(item, ["monthly_limit_usd"], 0),
    allowMessagesDispatch: Boolean(pickPath(item, "allow_messages_dispatch"))
  };
}

function normalizeManagedKeyRecord(item: Record<string, unknown>): ManagedKeyRecord {
  return {
    id: String(pickNumber(item, ["id"], 0)),
    userId: pickNumber(item, ["user_id"], 0),
    rawKey: pickString(item, ["key"]),
    name: pickString(item, ["name"], "Unnamed Key") ?? "Unnamed Key",
    groupId: pickNumber(item, ["group_id"], 0),
    status: pickString(item, ["status"], "unknown") ?? "unknown",
    platform: pickString(item, ["group.platform", "platform"]),
    groupName: pickString(item, ["group.name", "group_name"]),
    expiresAt: pickString(item, ["expires_at"]),
    lastUsedAt: pickString(item, ["last_used_at"]),
    quota: pickNumber(item, ["quota"], 0),
    quotaUsed: pickNumber(item, ["quota_used"], 0),
    rateLimit5h: pickNumber(item, ["rate_limit_5h"], 0),
    rateLimit1d: pickNumber(item, ["rate_limit_1d"], 0),
    rateLimit7d: pickNumber(item, ["rate_limit_7d"], 0),
    usage5h: pickNumber(item, ["usage_5h"], 0),
    usage1d: pickNumber(item, ["usage_1d"], 0),
    usage7d: pickNumber(item, ["usage_7d"], 0),
    ipWhitelist: pickString(item, ["ip_whitelist"]),
    ipBlacklist: pickString(item, ["ip_blacklist"]),
    window5hStart: pickString(item, ["window_5h_start"]),
    window1dStart: pickString(item, ["window_1d_start"]),
    window7dStart: pickString(item, ["window_7d_start"])
  };
}

function normalizeUsageRow(item: Record<string, unknown>): UsageRow {
  const inputTokens = pickNumber(item, ["input_tokens"], 0);
  const outputTokens = pickNumber(item, ["output_tokens"], 0);
  const inputCost = pickOptionalNumber(item, ["input_cost"]);
  const outputCost = pickOptionalNumber(item, ["output_cost"]);
  const cacheCreationTokens = pickNumber(item, ["cache_creation_tokens"], 0);
  const cacheReadTokens = pickNumber(item, ["cache_read_tokens", "total_cache_tokens"], 0);
  const cacheCreationCost = pickOptionalNumber(item, ["cache_creation_cost"]);
  const cacheReadCost = pickOptionalNumber(item, ["cache_read_cost"]);
  return {
    id: String(pickNumber(item, ["id"], 0) || pickString(item, ["request_id"], crypto.randomUUID())),
    apiKeyId: pickNumber(item, ["api_key_id"], 0),
    createdAt: pickString(item, ["created_at"], new Date().toISOString()) ?? new Date().toISOString(),
    model: pickString(item, ["model"], "unknown") ?? "unknown",
    reasoningEffort: pickString(item, ["reasoning_effort"]),
    endpoint: pickString(item, ["inbound_endpoint", "endpoint"]),
    upstreamEndpoint: pickString(item, ["upstream_endpoint"]),
    actualCost: pickNumber(item, ["actual_cost", "total_actual_cost"], 0),
    totalCost: pickNumber(item, ["total_cost", "cost"], 0),
    inputTokens,
    outputTokens,
    inputCost,
    outputCost,
    cacheCreationTokens,
    cacheReadTokens,
    cacheCreationCost,
    cacheReadCost,
    totalTokens: Math.max(
      pickNumber(item, ["total_tokens"], 0),
      inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens
    ),
    firstTokenMs: pickNumber(item, ["first_token_ms"], 0),
    durationMs: pickNumber(item, ["duration_ms"], 0),
    billingMode: pickString(item, ["billing_mode"]),
    requestType: pickString(item, ["request_type"]),
    stream: Boolean(pickPath(item, "stream")),
    billingType: pickNumber(item, ["billing_type"], 0),
    rateMultiplier: pickNumber(item, ["rate_multiplier"], 1),
    userAgent: pickString(item, ["user_agent"]),
    apiKeyName: pickString(item, ["api_key.name", "api_key_name"]),
    platform: pickString(item, ["group.platform", "platform"]),
    subscriptionName: pickString(item, ["subscription.group.name", "subscription_name", "group.name"]),
    groupName: pickString(item, ["group.name", "group_name"]),
    subscriptionType: pickString(item, ["group.subscription_type", "subscription.subscription_type"])
  };
}

function normalizePaginated<T>(raw: Record<string, unknown>, items: T[], page: number, pageSize: number): PaginatedResult<T> {
  const total = pickNumber(raw, ["total", "pagination.total"], items.length);
  return {
    items,
    page,
    pageSize,
    total,
    pages: pickNumber(raw, ["pages", "pagination.pages"], Math.max(1, Math.ceil(total / Math.max(pageSize, 1))))
  };
}

function normalizeUsageStats(raw: Record<string, unknown>): UsageStatsRecord {
  return {
    totalRequests: pickNumber(raw, ["total_requests"], 0),
    totalInputTokens: pickNumber(raw, ["total_input_tokens"], 0),
    totalOutputTokens: pickNumber(raw, ["total_output_tokens"], 0),
    totalCacheTokens: pickNumber(raw, ["total_cache_tokens"], 0),
    totalCacheCreationTokens: pickNumber(raw, ["total_cache_creation_tokens"], 0),
    totalCacheReadTokens: pickNumber(raw, ["total_cache_read_tokens"], 0),
    totalTokens: pickNumber(raw, ["total_tokens"], 0),
    totalCost: pickNumber(raw, ["total_cost"], 0),
    totalActualCost: pickNumber(raw, ["total_actual_cost"], 0),
    averageDurationMs: pickNumber(raw, ["average_duration_ms"], 0),
    rpm: pickNumber(raw, ["rpm"], 0),
    tpm: pickNumber(raw, ["tpm"], 0)
  };
}

function normalizeTrendPayload(raw: Record<string, unknown>): UsageTrendPayload {
  return {
    startDate: pickString(raw, ["start_date"], "") ?? "",
    endDate: pickString(raw, ["end_date"], "") ?? "",
    granularity: pickString(raw, ["granularity"]),
    trend: normalizeItems(raw.trend).map((item) => ({
      date: pickString(item, ["date"], "") ?? "",
      requests: pickNumber(item, ["requests"], 0),
      inputTokens: pickNumber(item, ["input_tokens"], 0),
      outputTokens: pickNumber(item, ["output_tokens"], 0),
      cacheReadTokens: pickNumber(item, ["cache_read_tokens"], 0),
      cacheWriteTokens: pickNumber(item, ["cache_creation_tokens", "cache_write_tokens"], 0),
      totalTokens: pickNumber(item, ["total_tokens"], 0),
      actualCost: pickNumber(item, ["actual_cost"], 0),
      totalCost: pickNumber(item, ["cost", "total_cost"], 0)
    }))
  };
}

function normalizeModelsPayload(raw: Record<string, unknown>): DashboardModelsPayload {
  return {
    startDate: pickString(raw, ["start_date"], "") ?? "",
    endDate: pickString(raw, ["end_date"], "") ?? "",
    models: normalizeItems(raw.models).map((item) => ({
      model: pickString(item, ["model"], "unknown") ?? "unknown",
      requests: pickNumber(item, ["requests"], 0),
      inputTokens: pickNumber(item, ["input_tokens"], 0),
      outputTokens: pickNumber(item, ["output_tokens"], 0),
      cacheCreationTokens: pickNumber(item, ["cache_creation_tokens"], 0),
      cacheReadTokens: pickNumber(item, ["cache_read_tokens"], 0),
      totalTokens: pickNumber(item, ["total_tokens"], 0),
      cost: pickNumber(item, ["cost"], 0),
      actualCost: pickNumber(item, ["actual_cost"], 0)
    }))
  };
}

function normalizeDailyUsageRows(items: Record<string, unknown>[]): DailyUsagePoint[] {
  return items.map((item) => ({
    date: pickString(item, ["date", "bucket", "day"], "") ?? "",
    requests: pickNumber(item, ["requests", "request_count"], 0),
    inputTokens: pickNumber(item, ["input_tokens"], 0),
    outputTokens: pickNumber(item, ["output_tokens"], 0),
    cacheReadTokens: pickNumber(item, ["cache_read_tokens"], 0),
    cacheWriteTokens: pickNumber(item, ["cache_creation_tokens"], 0),
    totalTokens: pickNumber(item, ["total_tokens", "tokens"], 0),
    actualCost: pickNumber(item, ["actual_cost", "total_actual_cost"], 0),
    totalCost: pickNumber(item, ["cost", "total_cost"], 0)
  }));
}

function normalizeSubscriptionSummary(raw: Record<string, unknown>): SubscriptionSummaryPayload {
  return {
    activeCount: pickNumber(raw, ["active_count"], 0),
    totalUsedUsd: pickNumber(raw, ["total_used_usd"], 0),
    subscriptions: normalizeItems(raw.subscriptions).map((item) => ({
      id: pickNumber(item, ["id"], 0),
      groupId: pickNumber(item, ["group_id"], 0),
      groupName: pickString(item, ["group_name"], "") ?? "",
      status: pickString(item, ["status"], "unknown") ?? "unknown",
      dailyUsedUsd: pickNumber(item, ["daily_used_usd"], 0),
      dailyLimitUsd: pickNumber(item, ["daily_limit_usd"], 0),
      weeklyUsedUsd: pickNumber(item, ["weekly_used_usd"], 0),
      monthlyUsedUsd: pickNumber(item, ["monthly_used_usd"], 0),
      expiresAt: pickString(item, ["expires_at"])
    }))
  };
}

function normalizeBindings(value: unknown) {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      {
        provider: pickString(item as Record<string, unknown>, ["provider"], "unknown") ?? "unknown",
        bound: Boolean(pickPath(item as Record<string, unknown>, "bound")),
        boundCount: pickNumber(item as Record<string, unknown>, ["bound_count"], 0),
        displayName: pickString(item as Record<string, unknown>, ["display_name"]),
        subjectHint: pickString(item as Record<string, unknown>, ["subject_hint"]),
        providerKey: pickString(item as Record<string, unknown>, ["provider_key"]),
        verifiedAt: pickString(item as Record<string, unknown>, ["verified_at"]),
        canBind: Boolean(pickPath(item as Record<string, unknown>, "can_bind")),
        canUnbind: Boolean(pickPath(item as Record<string, unknown>, "can_unbind")),
        note: pickString(item as Record<string, unknown>, ["note"]),
        noteKey: pickString(item as Record<string, unknown>, ["note_key"])
      }
    ])
  );
}

function normalizeProfile(raw: Record<string, unknown>): UserProfileRecord {
  return {
    id: pickNumber(raw, ["id"], 0),
    email: pickString(raw, ["email"], "") ?? "",
    username: pickString(raw, ["username"]),
    role: pickString(raw, ["role"], "user") ?? "user",
    balance: pickNumber(raw, ["balance"], 0),
    concurrency: pickNumber(raw, ["concurrency"], 0),
    status: pickString(raw, ["status"], "unknown") ?? "unknown",
    lastActiveAt: pickString(raw, ["last_active_at"]),
    createdAt: pickString(raw, ["created_at"]),
    updatedAt: pickString(raw, ["updated_at"]),
    totalRecharged: pickNumber(raw, ["total_recharged"], 0),
    rpmLimit: pickNumber(raw, ["rpm_limit"], 0),
    balanceNotifyEnabled: Boolean(pickPath(raw, "balance_notify_enabled")),
    balanceNotifyThresholdType: pickString(raw, ["balance_notify_threshold_type"]),
    balanceNotifyThreshold: pickNumber(raw, ["balance_notify_threshold"], 0),
    balanceNotifyExtraEmails: Array.isArray(pickPath(raw, "balance_notify_extra_emails"))
      ? (pickPath(raw, "balance_notify_extra_emails") as string[])
      : [],
    identities: normalizeBindings(pickPath(raw, "identities")),
    authBindings: normalizeBindings(pickPath(raw, "auth_bindings")),
    identityBindings: normalizeBindings(pickPath(raw, "identity_bindings"))
  };
}

function normalizePlatformQuotas(raw: Record<string, unknown>): PlatformQuotaPayload {
  return {
    platformQuotas: normalizeItems(raw.platform_quotas).map((item) => ({
      platform: pickString(item, ["platform"]),
      quota: pickNumber(item, ["quota"], 0),
      used: pickNumber(item, ["used"], 0),
      remaining: pickNumber(item, ["remaining"], 0)
    }))
  };
}

function normalizePaymentConfig(raw: Record<string, unknown>): PaymentConfigRecord {
  return {
    enabled: Boolean(pickPath(raw, "enabled")),
    minAmount: pickNumber(raw, ["min_amount"], 0),
    maxAmount: pickNumber(raw, ["max_amount"], 0),
    dailyLimit: pickNumber(raw, ["daily_limit"], 0),
    orderTimeoutMinutes: pickNumber(raw, ["order_timeout_minutes"], 0),
    maxPendingOrders: pickNumber(raw, ["max_pending_orders"], 0),
    enabledPaymentTypes: Array.isArray(pickPath(raw, "enabled_payment_types"))
      ? (pickPath(raw, "enabled_payment_types") as string[])
      : []
  };
}

function normalizeOrderRecord(item: Record<string, unknown>): OrderRecord {
  return {
    id: pickNumber(item, ["id"], 0),
    status: pickString(item, ["status"], "unknown") ?? "unknown",
    amount: pickNumber(item, ["amount"], 0),
    providerInstanceId: pickNumber(item, ["provider_instance_id"], 0),
    outTradeNo: pickString(item, ["out_trade_no"]),
    createdAt: pickString(item, ["created_at"]),
    updatedAt: pickString(item, ["updated_at"]),
    paidAt: pickString(item, ["paid_at"]),
    refundedAt: pickString(item, ["refunded_at"]),
    productName: pickString(item, ["product_name", "plan_name", "name"])
  };
}

export function getOverview() {
  if (isTauriRuntime()) {
    return invoke<OverviewPayload>("get_overview");
  }
  return request<OverviewPayload>("/api/dashboard/overview");
}

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

export function completeAccount2fa(accountId: string, tempToken: string, code: string) {
  if (isTauriRuntime()) {
    return invoke<AccountRuntime>("login_account_2fa", { accountId, tempToken, code });
  }
  return request<AccountRuntime>(`/api/accounts/${accountId}/login/2fa`, {
    method: "POST",
    body: JSON.stringify({ tempToken, code })
  });
}

export function refreshAccount(accountId: string) {
  if (isTauriRuntime()) {
    return invoke<AccountRuntime>("refresh_account", { accountId });
  }
  return request<AccountRuntime>(`/api/accounts/${accountId}/refresh`, {
    method: "POST"
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

async function accountProxyRequest<T>(
  accountId: string,
  path: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
  payload?: unknown
) {
  if (isTauriRuntime()) {
    return invoke<T>("account_proxy_request", {
      accountId,
      path,
      method,
      payload
    });
  }
  return request<T>(`/api/accounts/${accountId}/proxy`, {
    method: "POST",
    body: JSON.stringify({
      path,
      method,
      payload
    })
  });
}

export function getAvailableGroups(accountId: string) {
  return accountProxyRequest<Record<string, unknown>[]>(accountId, "/api/v1/groups/available").then((items) =>
    items.map(normalizeGroupRecord)
  );
}

export function listManagedKeys(accountId: string, page = 1, pageSize = 20) {
  return accountProxyRequest<Record<string, unknown>>( 
    accountId,
    `/api/v1/keys?page=${page}&page_size=${pageSize}`
  ).then((raw) => normalizePaginated(raw, normalizeItems(raw).map(normalizeManagedKeyRecord), page, pageSize));
}

export function getManagedKey(accountId: string, keyId: string | number) {
  return accountProxyRequest<Record<string, unknown>>(accountId, `/api/v1/keys/${keyId}`).then(normalizeManagedKeyRecord);
}

export function createManagedKey(accountId: string, payload: KeyMutationInput) {
  return accountProxyRequest<Record<string, unknown>>(accountId, "/api/v1/keys", "POST", {
    name: payload.name,
    group_id: payload.groupId,
    custom_key: payload.customKey,
    ip_whitelist: payload.ipWhitelist,
    ip_blacklist: payload.ipBlacklist,
    quota: payload.quota,
    expires_in_days: payload.expiresInDays,
    status: payload.status,
    rate_limit_5h: payload.rateLimit5h,
    rate_limit_1d: payload.rateLimit1d,
    rate_limit_7d: payload.rateLimit7d
  }).then(normalizeManagedKeyRecord);
}

export function updateManagedKey(
  accountId: string,
  keyId: string | number,
  payload: Partial<KeyMutationInput> & { resetQuota?: boolean; resetRateLimitUsage?: boolean }
) {
  return accountProxyRequest<Record<string, unknown>>(accountId, `/api/v1/keys/${keyId}`, "PUT", {
    name: payload.name,
    group_id: payload.groupId,
    custom_key: payload.customKey,
    ip_whitelist: payload.ipWhitelist,
    ip_blacklist: payload.ipBlacklist,
    quota: payload.quota,
    expires_in_days: payload.expiresInDays,
    status: payload.status,
    rate_limit_5h: payload.rateLimit5h,
    rate_limit_1d: payload.rateLimit1d,
    rate_limit_7d: payload.rateLimit7d,
    reset_quota: payload.resetQuota,
    reset_rate_limit_usage: payload.resetRateLimitUsage
  }).then(normalizeManagedKeyRecord);
}

export function deleteManagedKey(accountId: string, keyId: string | number) {
  return accountProxyRequest<{ success?: boolean }>(accountId, `/api/v1/keys/${keyId}`, "DELETE");
}

export function listUsageRecords(
  accountId: string,
  query: {
    page?: number;
    pageSize?: number;
    apiKeyId?: string | number | null;
    startDate?: string | null;
    endDate?: string | null;
  } = {}
) {
  const params = new URLSearchParams();
  params.set("page", String(query.page ?? 1));
  params.set("page_size", String(query.pageSize ?? 20));
  if (query.apiKeyId !== null && query.apiKeyId !== undefined && query.apiKeyId !== "") {
    params.set("api_key_id", String(query.apiKeyId));
  }
  if (query.startDate) {
    params.set("start_date", query.startDate);
  }
  if (query.endDate) {
    params.set("end_date", query.endDate);
  }
  return accountProxyRequest<Record<string, unknown>>(accountId, `/api/v1/usage?${params.toString()}`).then((raw) =>
    normalizePaginated(raw, normalizeItems(raw).map(normalizeUsageRow), query.page ?? 1, query.pageSize ?? 20)
  );
}

export function getUsageStats(
  accountId: string,
  query: {
    period?: string;
    apiKeyId?: string | number | null;
    startDate?: string | null;
    endDate?: string | null;
  } = {}
) {
  const params = new URLSearchParams();
  if (query.period) {
    params.set("period", query.period);
  }
  if (query.apiKeyId !== null && query.apiKeyId !== undefined && query.apiKeyId !== "") {
    params.set("api_key_id", String(query.apiKeyId));
  }
  if (query.startDate) {
    params.set("start_date", query.startDate);
  }
  if (query.endDate) {
    params.set("end_date", query.endDate);
  }
  return accountProxyRequest<Record<string, unknown>>(accountId, `/api/v1/usage/stats?${params.toString()}`).then(normalizeUsageStats);
}

export function getDashboardModels(accountId: string, days = 7) {
  return accountProxyRequest<Record<string, unknown>>(
    accountId,
    `/api/v1/usage/dashboard/models?days=${days}`
  ).then(normalizeModelsPayload);
}

export function getDashboardTrend(accountId: string, days = 7) {
  return accountProxyRequest<Record<string, unknown>>(
    accountId,
    `/api/v1/usage/dashboard/trend?days=${days}`
  ).then(normalizeTrendPayload);
}

export function getApiKeyDailyUsage(accountId: string, keyId: string | number, days = 30) {
  return accountProxyRequest<Record<string, unknown>[]>( 
    accountId,
    `/api/v1/user/api-keys/${keyId}/usage/daily?days=${days}`
  ).then((raw) => normalizeDailyUsageRows(normalizeItems(raw)));
}

export function getProfileRecord(accountId: string) {
  return accountProxyRequest<Record<string, unknown>>(accountId, "/api/v1/user/profile").then(normalizeProfile);
}

export function updateProfileRecord(accountId: string, payload: ProfileUpdateInput) {
  return accountProxyRequest<Record<string, unknown>>(accountId, "/api/v1/user", "PUT", {
    email: payload.email,
    username: payload.username,
    balance_notify_enabled: payload.balanceNotifyEnabled,
    balance_notify_threshold_type: payload.balanceNotifyThresholdType,
    balance_notify_threshold: payload.balanceNotifyThreshold
  }).then(normalizeProfile);
}

export function changeProfilePassword(accountId: string, oldPassword: string, newPassword: string) {
  return accountProxyRequest<{ success?: boolean }>(accountId, "/api/v1/user/password", "PUT", {
    old_password: oldPassword,
    new_password: newPassword
  });
}

export function getPlatformQuotas(accountId: string) {
  return accountProxyRequest<Record<string, unknown>>(accountId, "/api/v1/user/platform-quotas").then(normalizePlatformQuotas);
}

export function getSubscriptionSummary(accountId: string) {
  return accountProxyRequest<Record<string, unknown>>(accountId, "/api/v1/subscriptions/summary").then(normalizeSubscriptionSummary);
}

export function getPaymentConfig(accountId: string) {
  return accountProxyRequest<Record<string, unknown>>(accountId, "/api/v1/payment/config").then(normalizePaymentConfig);
}

export function listOrders(accountId: string, page = 1, pageSize = 20) {
  return accountProxyRequest<Record<string, unknown>>(
    accountId,
    `/api/v1/payment/orders/my?page=${page}&page_size=${pageSize}`
  ).then((raw) => normalizePaginated(raw, normalizeItems(raw).map(normalizeOrderRecord), page, pageSize));
}

export function sendNotifyEmailCode(accountId: string, email: string) {
  return accountProxyRequest<{ success?: boolean }>(
    accountId,
    "/api/v1/user/notify-email/send-code",
    "POST",
    { email }
  );
}

export function verifyNotifyEmail(accountId: string, email: string, code: string) {
  return accountProxyRequest<{ success?: boolean }>(
    accountId,
    "/api/v1/user/notify-email/verify",
    "POST",
    { email, code }
  );
}

export function removeNotifyEmail(accountId: string, email: string) {
  return accountProxyRequest<{ success?: boolean }>(
    accountId,
    "/api/v1/user/notify-email",
    "DELETE",
    { email }
  );
}

export function toggleNotifyEmail(accountId: string, email: string, disabled: boolean) {
  return accountProxyRequest<Record<string, unknown>>(
    accountId,
    "/api/v1/user/notify-email/toggle",
    "PUT",
    { email, disabled }
  ).then(normalizeProfile);
}

export function sendEmailBindingCode(accountId: string, email: string) {
  return accountProxyRequest<{ success?: boolean }>(
    accountId,
    "/api/v1/user/account-bindings/email/send-code",
    "POST",
    { email }
  );
}

export function bindEmailIdentity(
  accountId: string,
  payload: { email: string; code: string }
) {
  return accountProxyRequest<{ success?: boolean }>(
    accountId,
    "/api/v1/user/account-bindings/email",
    "POST",
    payload
  );
}

export function unbindAuthIdentity(accountId: string, provider: string) {
  return accountProxyRequest<{ success?: boolean }>(
    accountId,
    `/api/v1/user/account-bindings/${provider}`,
    "DELETE"
  );
}
