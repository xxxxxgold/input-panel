import type {
  DailyUsagePoint,
  DashboardModelsPayload,
  GroupRecord,
  ManagedKeyRecord,
  OrderRecord,
  PaginatedResult,
  PaymentConfigRecord,
  PlatformQuotaPayload,
  SubscriptionSummaryPayload,
  UsageRow,
  UsageStatsRecord,
  UsageTrendPayload,
  UserProfileRecord
} from "../../types";

export function pickPath(value: Record<string, unknown> | null | undefined, path: string): unknown {
  if (!value) return undefined;
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current && typeof current === "object" && segment in (current as Record<string, unknown>)) {
      return (current as Record<string, unknown>)[segment];
    }
    return undefined;
  }, value);
}

export function pickString(value: Record<string, unknown> | null | undefined, keys: string[], fallback?: string) {
  for (const key of keys) {
    const next = pickPath(value, key);
    if (typeof next === "string" && next.trim()) {
      return next;
    }
  }
  return fallback;
}

export function pickNumber(value: Record<string, unknown> | null | undefined, keys: string[], fallback = 0) {
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

export function pickOptionalNumber(value: Record<string, unknown> | null | undefined, keys: string[]) {
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

export function normalizeItems(value: unknown) {
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

export function normalizeGroupRecord(item: Record<string, unknown>): GroupRecord {
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

export function normalizeManagedKeyRecord(item: Record<string, unknown>): ManagedKeyRecord {
  return {
    id: String(pickNumber(item, ["id"], 0) || pickString(item, ["id"], "")),
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

export function normalizeUsageRow(item: Record<string, unknown>): UsageRow {
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

export function normalizePaginated<T>(raw: Record<string, unknown>, items: T[], page: number, pageSize: number): PaginatedResult<T> {
  const total = pickNumber(raw, ["total", "pagination.total"], items.length);
  return {
    items,
    page,
    pageSize,
    total,
    pages: pickNumber(raw, ["pages", "pagination.pages"], Math.max(1, Math.ceil(total / Math.max(pageSize, 1))))
  };
}

export function normalizeUsageStats(raw: Record<string, unknown>): UsageStatsRecord {
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

export function normalizeTrendPayload(raw: Record<string, unknown>): UsageTrendPayload {
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

export function normalizeModelsPayload(raw: Record<string, unknown>): DashboardModelsPayload {
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

export function normalizeDailyUsageRows(items: Record<string, unknown>[]): DailyUsagePoint[] {
  return items.map((item) => ({
    date: pickString(item, ["date", "bucket", "day"], "") ?? "",
    requests: pickNumber(item, ["requests", "request_count"], 0),
    inputTokens: pickNumber(item, ["input_tokens"], 0),
    outputTokens: pickNumber(item, ["output_tokens"], 0),
    cacheReadTokens: pickNumber(item, ["cache_read_tokens"], 0),
    cacheWriteTokens: pickNumber(item, ["cache_creation_tokens", "cache_write_tokens"], 0),
    totalTokens: pickNumber(item, ["total_tokens", "tokens"], 0),
    actualCost: pickNumber(item, ["actual_cost", "total_actual_cost"], 0),
    totalCost: pickNumber(item, ["cost", "total_cost"], 0)
  }));
}

export function normalizeSubscriptionSummary(raw: Record<string, unknown>): SubscriptionSummaryPayload {
  const subscriptionItems = Array.isArray(raw.subscriptions)
    ? normalizeItems(raw.subscriptions)
    : normalizeItems(raw);
  const subscriptions = subscriptionItems.map((item) => ({
    id: pickNumber(item, ["id"], 0),
    groupId: pickNumber(item, ["group_id"], 0),
    groupName: pickString(item, ["group_name", "group.name", "name"], "") ?? "",
    status: pickString(item, ["status"], "unknown") ?? "unknown",
    dailyUsedUsd: pickNumber(item, ["daily_used_usd", "daily.current", "daily_usage_usd"], 0),
    dailyLimitUsd: pickNumber(item, ["daily_limit_usd", "daily.limit", "group.daily_limit_usd"], 0),
    weeklyUsedUsd: pickNumber(item, ["weekly_used_usd", "weekly.current"], 0),
    monthlyUsedUsd: pickNumber(item, ["monthly_used_usd", "monthly.current"], 0),
    expiresAt: pickString(item, ["expires_at"])
  }));
  const derivedActiveCount = subscriptions.filter((item) => item.status === "active").length;
  const derivedTotalUsedUsd = subscriptions.reduce((sum, item) => sum + item.dailyUsedUsd, 0);

  return {
    activeCount: pickNumber(raw, ["active_count"], derivedActiveCount),
    totalUsedUsd: pickNumber(raw, ["total_used_usd"], derivedTotalUsedUsd),
    subscriptions
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

export function normalizeProfile(raw: Record<string, unknown>): UserProfileRecord {
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

export function normalizePlatformQuotas(raw: Record<string, unknown>): PlatformQuotaPayload {
  return {
    platformQuotas: normalizeItems(raw.platform_quotas).map((item) => ({
      platform: pickString(item, ["platform"]),
      quota: pickNumber(item, ["quota"], 0),
      used: pickNumber(item, ["used"], 0),
      remaining: pickNumber(item, ["remaining"], 0)
    }))
  };
}

export function normalizePaymentConfig(raw: Record<string, unknown>): PaymentConfigRecord {
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

export function normalizeOrderRecord(item: Record<string, unknown>): OrderRecord {
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
