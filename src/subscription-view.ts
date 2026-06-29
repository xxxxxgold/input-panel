import type {
  OverviewSubscriptionRecord,
  SubscriptionRecord,
  SubscriptionSummaryPayload,
  SubscriptionSummaryRecord
} from "./types";
import { formatRemainingDaysLabel } from "./shared/lib/formatters";

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
  statusLabel: string;
  expiresAt: string | null;
  remainingDaysLabel: string;
  accountLabel: string | null;
  siteName: string | null;
  quota: SubscriptionQuotaPreview | null;
  quotaProgress: SubscriptionQuotaProgressMeta | null;
  indicatorTone: SubscriptionIndicatorTone;
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
}

export interface SubscriptionUsageInsights {
  rows: SubscriptionUsageInsightsRow[];
}

export interface SubscriptionDetailRecord {
  id: string;
  name: string;
  status: string;
  platform: string | null;
  groupName: string | null;
  expiresAt: string | null;
  dailyUsedUsd: number;
  dailyLimitUsd: number;
  dailyWindowStart: string | null;
  weeklyUsedUsd: number;
  weeklyLimitUsd: number | null;
  weeklyWindowStart: string | null;
  monthlyUsedUsd: number;
  monthlyLimitUsd: number | null;
  monthlyWindowStart: string | null;
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

export function mergeSubscriptionRecords(
  cacheViewSubscriptions: SubscriptionRecord[],
  summary: SubscriptionSummaryPayload | null
) {
  if (!summary?.subscriptions.length) {
    return cacheViewSubscriptions;
  }

  const remainingCacheViews = [...cacheViewSubscriptions];
  const fallbackPlatform = remainingCacheViews.find((item) => item.platform)?.platform ?? null;
  const merged = summary.subscriptions.map((summaryRecord) => {
    const matchIndex = remainingCacheViews.findIndex((item) => matchesSummaryRecord(item, summaryRecord));
    const cacheViewRecord = matchIndex >= 0 ? remainingCacheViews.splice(matchIndex, 1)[0] : null;
    return buildSummarySubscriptionRecord(summaryRecord, cacheViewRecord, fallbackPlatform);
  });

  return [...merged, ...remainingCacheViews];
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

  return sourceRecords.map((record) => {
    const quota = resolveTopbarSubscriptionQuota(record);
    const quotaProgress = quota ? getSubscriptionQuotaProgressMeta(quota.used, quota.limit) : null;
    const statusPresentation = getSubscriptionStatusPresentation(record.status);
    const indicatorTone = quotaProgress
      ? quotaProgress.tone
      : statusPresentation.tone === "ready"
        ? "subscription-dot-ready"
        : statusPresentation.tone === "critical"
          ? "subscription-dot-critical"
          : "subscription-dot-neutral";

    return {
      id: record.id,
      name: record.groupName || record.name || "当前订阅",
      status: record.status || "unknown",
      statusLabel: statusPresentation.label,
      expiresAt: record.expiresAt ?? null,
      remainingDaysLabel: formatRemainingDaysLabel(record.expiresAt ?? null),
      accountLabel: record.accountLabel ?? null,
      siteName: record.siteName ?? null,
      quota,
      quotaProgress,
      indicatorTone
    };
  });
}

export function buildSubscriptionUsageInsights(input: {
  summary: SubscriptionSummaryPayload | null;
  cacheViewSubscriptions: SubscriptionRecord[];
}): SubscriptionUsageInsights {
  const rows = input.summary?.subscriptions.length
    ? input.summary.subscriptions.map((summaryRecord) =>
        buildUsageInsightsRowFromSummary(summaryRecord)
      )
    : input.cacheViewSubscriptions.map((subscriptionRecord) =>
        buildUsageInsightsRowFromCacheView(subscriptionRecord)
      );

  return {
    rows
  };
}

export function buildSubscriptionDetailRecords(input: {
  summary: SubscriptionSummaryPayload | null;
  cacheViewSubscriptions: SubscriptionRecord[];
}): SubscriptionDetailRecord[] {
  const mergedSubscriptions = mergeSubscriptionRecords(input.cacheViewSubscriptions, input.summary);
  const summaryRecords = input.summary?.subscriptions ?? [];

  return mergedSubscriptions.map((subscriptionRecord) => {
    const summaryRecord = summaryRecords.find((item) => matchesSummaryRecord(subscriptionRecord, item));

    return {
      id: subscriptionRecord.id,
      name: subscriptionRecord.groupName ?? subscriptionRecord.name,
      status: summaryRecord?.status ?? subscriptionRecord.status,
      platform: subscriptionRecord.platform ?? null,
      groupName: subscriptionRecord.groupName ?? null,
      expiresAt: summaryRecord?.expiresAt ?? subscriptionRecord.expiresAt ?? null,
      dailyUsedUsd: summaryRecord?.dailyUsedUsd ?? subscriptionRecord.daily?.current ?? 0,
      dailyLimitUsd: summaryRecord?.dailyLimitUsd ?? subscriptionRecord.daily?.limit ?? 0,
      dailyWindowStart: subscriptionRecord.daily?.windowStart ?? null,
      weeklyUsedUsd: summaryRecord?.weeklyUsedUsd ?? subscriptionRecord.weekly?.current ?? 0,
      weeklyLimitUsd: subscriptionRecord.weekly?.limit ?? null,
      weeklyWindowStart: subscriptionRecord.weekly?.windowStart ?? null,
      monthlyUsedUsd: summaryRecord?.monthlyUsedUsd ?? subscriptionRecord.monthly?.current ?? 0,
      monthlyLimitUsd: subscriptionRecord.monthly?.limit ?? null,
      monthlyWindowStart: subscriptionRecord.monthly?.windowStart ?? null
    };
  });
}

function matchesSummaryRecord(
  cacheViewRecord: SubscriptionRecord,
  summaryRecord: SubscriptionSummaryRecord
) {
  if (
    typeof cacheViewRecord.groupId === "number" &&
    cacheViewRecord.groupId > 0 &&
    cacheViewRecord.groupId === summaryRecord.groupId
  ) {
    return true;
  }

  const cacheViewKey = normalizeSubscriptionKey(cacheViewRecord.groupName ?? cacheViewRecord.name);
  const summaryKey = normalizeSubscriptionKey(summaryRecord.groupName);
  return cacheViewKey.length > 0 && cacheViewKey === summaryKey;
}

function buildSummarySubscriptionRecord(
  summaryRecord: SubscriptionSummaryRecord,
  cacheViewRecord: SubscriptionRecord | null,
  fallbackPlatform: string | null
): SubscriptionRecord {
  const summaryDailyWindow = summaryRecord.dailyLimitUsd > 0
    ? {
        current: summaryRecord.dailyUsedUsd,
        limit: summaryRecord.dailyLimitUsd,
        windowStart: cacheViewRecord?.daily?.windowStart ?? null
      }
    : cacheViewRecord?.daily ?? null;

  return {
    id: cacheViewRecord?.id ?? buildSummaryRecordId(summaryRecord),
    groupId: summaryRecord.groupId > 0 ? summaryRecord.groupId : (cacheViewRecord?.groupId ?? null),
    name: cacheViewRecord?.name ?? summaryRecord.groupName,
    status: summaryRecord.status || cacheViewRecord?.status || "unknown",
    groupName: summaryRecord.groupName || cacheViewRecord?.groupName || cacheViewRecord?.name || "未分组",
    platform: cacheViewRecord?.platform ?? fallbackPlatform,
    expiresAt: summaryRecord.expiresAt ?? cacheViewRecord?.expiresAt ?? null,
    daily: summaryDailyWindow,
    weekly: cacheViewRecord?.weekly ?? null,
    monthly: cacheViewRecord?.monthly ?? null
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
  summaryRecord: SubscriptionSummaryRecord
): SubscriptionUsageInsightsRow {
  return {
    id: buildSummaryRecordId(summaryRecord),
    name: summaryRecord.groupName,
    status: summaryRecord.status,
    expiresAt: summaryRecord.expiresAt ?? null,
    dailyUsedUsd: summaryRecord.dailyUsedUsd,
    dailyLimitUsd: summaryRecord.dailyLimitUsd,
    weeklyUsedUsd: summaryRecord.weeklyUsedUsd,
    monthlyUsedUsd: summaryRecord.monthlyUsedUsd
  };
}

function buildUsageInsightsRowFromCacheView(
  subscriptionRecord: SubscriptionRecord
): SubscriptionUsageInsightsRow {
  return {
    id: subscriptionRecord.id,
    name: subscriptionRecord.groupName ?? subscriptionRecord.name,
    status: subscriptionRecord.status,
    expiresAt: subscriptionRecord.expiresAt ?? null,
    dailyUsedUsd: subscriptionRecord.daily?.current ?? 0,
    dailyLimitUsd: subscriptionRecord.daily?.limit ?? 0,
    weeklyUsedUsd: subscriptionRecord.weekly?.current ?? 0,
    monthlyUsedUsd: subscriptionRecord.monthly?.current ?? 0
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
