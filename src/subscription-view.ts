import type {
  OverviewSubscriptionRecord,
  SubscriptionRecord,
  SubscriptionSummaryPayload,
  SubscriptionSummaryRecord,
  UsageHistoryRow,
  UsageRow
} from "./types";

export type SubscriptionStatusTone = "ready" | "critical" | "neutral";
export type SubscriptionQuotaProgressTone =
  | "quota-tier-20"
  | "quota-tier-40"
  | "quota-tier-60"
  | "quota-tier-80"
  | "quota-tier-90"
  | "quota-tier-100"
  | "quota-tier-over";
export type SubscriptionIndicatorTone =
  | SubscriptionQuotaProgressTone
  | "subscription-dot-ready"
  | "subscription-dot-neutral"
  | "subscription-dot-critical";

export interface SubscriptionQuotaPreview {
  label: "每日" | "每周" | "每月";
  used: number;
  limit: number;
}

export interface SubscriptionQuotaProgressMeta {
  percent: number;
  rawPercent: number;
  tone: SubscriptionQuotaProgressTone;
}

export interface TopbarSubscriptionPreviewRecord {
  id: string;
  name: string;
  status: string;
  expiresAt: string | null;
  accountLabel: string | null;
  siteName: string | null;
  quota: SubscriptionQuotaPreview | null;
}

export interface SubscriptionUsageInsightsRow {
  id: string;
  name: string;
  status: string;
  expiresAt: string | null;
  dailyUsedUsd: number;
  dailyLimitUsd: number;
  weeklyUsedUsd: number;
  monthlyUsedUsd: number;
  attributedRequests: number;
  attributedTokens: number;
  attributedInputTokens: number;
  attributedOutputTokens: number;
  attributedActualCost: number;
}

export interface SubscriptionUsageInsights {
  rows: SubscriptionUsageInsightsRow[];
  totalAttributedRequests: number;
  totalAttributedTokens: number;
  totalAttributedActualCost: number;
  sourceLabel: string;
}

type SubscriptionStatusPresentation = {
  label: string;
  tone: SubscriptionStatusTone;
};

type TopbarSubscriptionSourceRecord = Pick<
  SubscriptionRecord,
  "id" | "name" | "groupName" | "status" | "expiresAt" | "daily" | "weekly" | "monthly"
> & {
  accountLabel?: string | null;
  siteName?: string | null;
};

type AttributedUsageRow = Pick<
  UsageRow,
  "subscriptionName" | "groupName" | "actualCost" | "totalTokens" | "inputTokens" | "outputTokens"
>;

type SubscriptionAttributionMetrics = Pick<
  SubscriptionUsageInsightsRow,
  | "attributedRequests"
  | "attributedTokens"
  | "attributedInputTokens"
  | "attributedOutputTokens"
  | "attributedActualCost"
>;

export function mergeSubscriptionRecords(
  snapshotSubscriptions: SubscriptionRecord[],
  summary: SubscriptionSummaryPayload | null
) {
  if (!summary?.subscriptions.length) {
    return snapshotSubscriptions;
  }

  const remainingSnapshots = [...snapshotSubscriptions];
  const fallbackPlatform = remainingSnapshots.find((item) => item.platform)?.platform ?? null;
  const merged = summary.subscriptions.map((summaryRecord) => {
    const matchIndex = remainingSnapshots.findIndex((item) => matchesSummaryRecord(item, summaryRecord));
    const snapshotRecord = matchIndex >= 0 ? remainingSnapshots.splice(matchIndex, 1)[0] : null;
    return buildSummarySubscriptionRecord(summaryRecord, snapshotRecord, fallbackPlatform);
  });

  return [...merged, ...remainingSnapshots];
}

export function getSubscriptionStatusPresentation(status?: string | null): SubscriptionStatusPresentation {
  const normalizedStatus = normalizeSubscriptionKey(status);
  if (!normalizedStatus) {
    return { label: "未知状态", tone: "neutral" };
  }

  const mappedStatus = SUBSCRIPTION_STATUS_MAP[normalizedStatus];
  if (mappedStatus) {
    return mappedStatus;
  }

  return {
    label: /[\u4e00-\u9fff]/.test(status ?? "") ? (status?.trim() ?? "未知状态") : "未知状态",
    tone: "neutral"
  };
}

export function getSubscriptionQuotaProgressMeta(
  current?: number | null,
  limit?: number | null
): SubscriptionQuotaProgressMeta {
  const safeCurrent = Number.isFinite(current) ? Math.max(0, Number(current)) : 0;
  const safeLimit = Number.isFinite(limit) && Number(limit) > 0 ? Number(limit) : 0.0001;
  const rawPercent = (safeCurrent / safeLimit) * 100;
  const percent = Math.min(100, rawPercent);

  if (rawPercent < 20) {
    return { percent, rawPercent, tone: "quota-tier-20" };
  }
  if (rawPercent < 40) {
    return { percent, rawPercent, tone: "quota-tier-40" };
  }
  if (rawPercent < 60) {
    return { percent, rawPercent, tone: "quota-tier-60" };
  }
  if (rawPercent < 80) {
    return { percent, rawPercent, tone: "quota-tier-80" };
  }
  if (rawPercent < 90) {
    return { percent, rawPercent, tone: "quota-tier-90" };
  }
  if (rawPercent <= 100) {
    return { percent, rawPercent, tone: "quota-tier-100" };
  }
  return { percent, rawPercent, tone: "quota-tier-over" };
}

export function getTopbarSubscriptionIndicatorTone(
  subscription: Pick<TopbarSubscriptionPreviewRecord, "quota" | "status">
): SubscriptionIndicatorTone {
  if (subscription.quota) {
    return getSubscriptionQuotaProgressMeta(subscription.quota.used, subscription.quota.limit).tone;
  }

  const statusTone = getSubscriptionStatusPresentation(subscription.status).tone;
  if (statusTone === "ready") {
    return "subscription-dot-ready";
  }
  if (statusTone === "critical") {
    return "subscription-dot-critical";
  }
  return "subscription-dot-neutral";
}

export function buildTopbarSubscriptionPreviewRecords(input: {
  overviewSubscriptions: OverviewSubscriptionRecord[];
  fallbackSubscriptions: SubscriptionRecord[];
  fallbackAccountLabel?: string | null;
  fallbackSiteName?: string | null;
}): TopbarSubscriptionPreviewRecord[] {
  const sourceRecords: TopbarSubscriptionSourceRecord[] = input.overviewSubscriptions.length > 0
    ? input.overviewSubscriptions
    : input.fallbackSubscriptions.map((record) => ({
        ...record,
        accountLabel: input.fallbackAccountLabel ?? null,
        siteName: input.fallbackSiteName ?? null
      }));

  return sourceRecords.map((record) => ({
    id: record.id,
    name: record.groupName || record.name || "当前订阅",
    status: record.status || "unknown",
    expiresAt: record.expiresAt ?? null,
    accountLabel: record.accountLabel ?? null,
    siteName: record.siteName ?? null,
    quota: resolveTopbarSubscriptionQuota(record)
  }));
}

export function buildSubscriptionUsageInsights(input: {
  summary: SubscriptionSummaryPayload | null;
  snapshotSubscriptions: SubscriptionRecord[];
  requestHistory: UsageHistoryRow[];
  recentUsage: UsageRow[];
}): SubscriptionUsageInsights {
  const attributionSource = input.requestHistory.length > 0 ? input.requestHistory : input.recentUsage;
  const attributionMap = buildSubscriptionAttributionMap(attributionSource);
  const rows = input.summary?.subscriptions.length
    ? input.summary.subscriptions.map((summaryRecord) =>
        buildUsageInsightsRowFromSummary(summaryRecord, attributionMap.get(normalizeSubscriptionKey(summaryRecord.groupName)))
      )
    : input.snapshotSubscriptions.map((subscriptionRecord) =>
        buildUsageInsightsRowFromSnapshot(
          subscriptionRecord,
          attributionMap.get(normalizeSubscriptionKey(subscriptionRecord.groupName ?? subscriptionRecord.name))
        )
      );
  const totals = rows.reduce(
    (accumulator, row) => ({
      totalAttributedRequests: accumulator.totalAttributedRequests + row.attributedRequests,
      totalAttributedTokens: accumulator.totalAttributedTokens + row.attributedTokens,
      totalAttributedActualCost: accumulator.totalAttributedActualCost + row.attributedActualCost
    }),
    {
      totalAttributedRequests: 0,
      totalAttributedTokens: 0,
      totalAttributedActualCost: 0
    }
  );

  return {
    rows,
    ...totals,
    sourceLabel: input.requestHistory.length > 0
      ? "按已采集历史 usage 聚合"
      : input.recentUsage.length > 0
        ? "按最近 usage 样本聚合"
        : "暂无可归因的 usage 数据"
  };
}

function matchesSummaryRecord(
  snapshotRecord: SubscriptionRecord,
  summaryRecord: SubscriptionSummaryRecord
) {
  if (
    typeof snapshotRecord.groupId === "number" &&
    snapshotRecord.groupId > 0 &&
    snapshotRecord.groupId === summaryRecord.groupId
  ) {
    return true;
  }

  const snapshotKey = normalizeSubscriptionKey(snapshotRecord.groupName ?? snapshotRecord.name);
  const summaryKey = normalizeSubscriptionKey(summaryRecord.groupName);
  return snapshotKey.length > 0 && snapshotKey === summaryKey;
}

function buildSummarySubscriptionRecord(
  summaryRecord: SubscriptionSummaryRecord,
  snapshotRecord: SubscriptionRecord | null,
  fallbackPlatform: string | null
): SubscriptionRecord {
  const summaryDailyWindow = summaryRecord.dailyLimitUsd > 0
    ? {
        current: summaryRecord.dailyUsedUsd,
        limit: summaryRecord.dailyLimitUsd,
        windowStart: snapshotRecord?.daily?.windowStart ?? null
      }
    : snapshotRecord?.daily ?? null;

  return {
    id: snapshotRecord?.id ?? buildSummaryRecordId(summaryRecord),
    groupId: summaryRecord.groupId > 0 ? summaryRecord.groupId : (snapshotRecord?.groupId ?? null),
    name: snapshotRecord?.name ?? summaryRecord.groupName,
    status: summaryRecord.status || snapshotRecord?.status || "unknown",
    groupName: summaryRecord.groupName || snapshotRecord?.groupName || snapshotRecord?.name || "未分组",
    platform: snapshotRecord?.platform ?? fallbackPlatform,
    expiresAt: summaryRecord.expiresAt ?? snapshotRecord?.expiresAt ?? null,
    daily: summaryDailyWindow,
    weekly: snapshotRecord?.weekly ?? null,
    monthly: snapshotRecord?.monthly ?? null
  };
}

function buildSummaryRecordId(summaryRecord: SubscriptionSummaryRecord) {
  if (summaryRecord.id > 0) {
    return `summary-${summaryRecord.id}`;
  }
  if (summaryRecord.groupId > 0) {
    return `summary-group-${summaryRecord.groupId}`;
  }
  return `summary-${normalizeSubscriptionKey(summaryRecord.groupName) || "subscription"}`;
}

function buildUsageInsightsRowFromSummary(
  summaryRecord: SubscriptionSummaryRecord,
  metrics: SubscriptionAttributionMetrics | undefined
): SubscriptionUsageInsightsRow {
  return {
    id: buildSummaryRecordId(summaryRecord),
    name: summaryRecord.groupName,
    status: summaryRecord.status,
    expiresAt: summaryRecord.expiresAt ?? null,
    dailyUsedUsd: summaryRecord.dailyUsedUsd,
    dailyLimitUsd: summaryRecord.dailyLimitUsd,
    weeklyUsedUsd: summaryRecord.weeklyUsedUsd,
    monthlyUsedUsd: summaryRecord.monthlyUsedUsd,
    ...withDefaultAttributionMetrics(metrics)
  };
}

function buildUsageInsightsRowFromSnapshot(
  subscriptionRecord: SubscriptionRecord,
  metrics: SubscriptionAttributionMetrics | undefined
): SubscriptionUsageInsightsRow {
  return {
    id: subscriptionRecord.id,
    name: subscriptionRecord.groupName ?? subscriptionRecord.name,
    status: subscriptionRecord.status,
    expiresAt: subscriptionRecord.expiresAt ?? null,
    dailyUsedUsd: subscriptionRecord.daily?.current ?? 0,
    dailyLimitUsd: subscriptionRecord.daily?.limit ?? 0,
    weeklyUsedUsd: subscriptionRecord.weekly?.current ?? 0,
    monthlyUsedUsd: subscriptionRecord.monthly?.current ?? 0,
    ...withDefaultAttributionMetrics(metrics)
  };
}

function buildSubscriptionAttributionMap(rows: AttributedUsageRow[]) {
  const metricsBySubscription = new Map<string, SubscriptionAttributionMetrics>();

  for (const row of rows) {
    const key = normalizeSubscriptionKey(row.subscriptionName ?? row.groupName);
    if (!key) {
      continue;
    }

    const current = metricsBySubscription.get(key) ?? withDefaultAttributionMetrics();
    current.attributedRequests += 1;
    current.attributedTokens += row.totalTokens;
    current.attributedInputTokens += row.inputTokens;
    current.attributedOutputTokens += row.outputTokens;
    current.attributedActualCost += row.actualCost;
    metricsBySubscription.set(key, current);
  }

  return metricsBySubscription;
}

function withDefaultAttributionMetrics(
  metrics?: Partial<SubscriptionAttributionMetrics>
): SubscriptionAttributionMetrics {
  return {
    attributedRequests: metrics?.attributedRequests ?? 0,
    attributedTokens: metrics?.attributedTokens ?? 0,
    attributedInputTokens: metrics?.attributedInputTokens ?? 0,
    attributedOutputTokens: metrics?.attributedOutputTokens ?? 0,
    attributedActualCost: metrics?.attributedActualCost ?? 0
  };
}

function normalizeSubscriptionKey(value?: string | null) {
  return value?.trim().toLowerCase() ?? "";
}

function resolveTopbarSubscriptionQuota(
  subscriptionRecord: Pick<SubscriptionRecord, "daily" | "weekly" | "monthly">
): SubscriptionQuotaPreview | null {
  const windows = [
    { label: "每日", value: subscriptionRecord.daily },
    { label: "每周", value: subscriptionRecord.weekly },
    { label: "每月", value: subscriptionRecord.monthly }
  ] as const;

  const firstWindow = windows.find((item) => item.value && item.value.limit > 0);
  if (!firstWindow?.value) {
    return null;
  }

  return {
    label: firstWindow.label,
    used: firstWindow.value.current,
    limit: firstWindow.value.limit
  };
}

const SUBSCRIPTION_STATUS_MAP: Record<string, SubscriptionStatusPresentation> = {
  active: { label: "正常", tone: "ready" },
  ready: { label: "正常", tone: "ready" },
  enabled: { label: "正常", tone: "ready" },
  valid: { label: "正常", tone: "ready" },
  normal: { label: "正常", tone: "ready" },
  ok: { label: "正常", tone: "ready" },
  expired: { label: "已失效", tone: "critical" },
  invalid: { label: "已失效", tone: "critical" },
  inactive: { label: "已停用", tone: "critical" },
  disabled: { label: "已停用", tone: "critical" },
  suspended: { label: "已停用", tone: "critical" },
  canceled: { label: "已取消", tone: "critical" },
  cancelled: { label: "已取消", tone: "critical" },
  error: { label: "异常", tone: "critical" },
  failed: { label: "异常", tone: "critical" },
  quota_exhausted: { label: "异常", tone: "critical" },
  pending: { label: "待生效", tone: "neutral" },
  processing: { label: "待生效", tone: "neutral" },
  trialing: { label: "试用中", tone: "neutral" },
  unknown: { label: "未知状态", tone: "neutral" }
};
