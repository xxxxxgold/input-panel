import type {
  SubscriptionKeyUsagePayload,
  DailyUsagePoint,
  DashboardModelsPayload,
  KeyUsageSummaryPayload,
  UsageAnalyticsPayload,
  UsageCursorPage,
  UsageExtremesPayload,
  UsageFacetPage,
  UsageFacetRequest,
  UsageFilter,
  UsageRow,
  UsageListRequest,
  UsageStatsRecord,
  UsageInsightsPayload,
  UsageTrendPayload
} from "../../types";
import { desktopOrHttp } from "../../shared/transport/runtime";

export function listUsageRecords(
  accountId: string,
  request: UsageListRequest
) {
  return desktopOrHttp<UsageCursorPage<UsageRow>>({
    command: "list_usage_records",
    args: { accountId, request },
    url: `/api/accounts/${accountId}/usage`,
    init: {
      method: "POST",
      body: JSON.stringify(request)
    }
  });
}

export function listUsageFacets(accountId: string, request: UsageFacetRequest) {
  return desktopOrHttp<UsageFacetPage>({
    command: "list_usage_facets",
    args: { accountId, request },
    url: `/api/accounts/${accountId}/usage/facets`,
    init: {
      method: "POST",
      body: JSON.stringify(request)
    }
  });
}

function postUsageAggregate<T>(
  accountId: string,
  endpoint: string,
  command: string,
  filter: UsageFilter
) {
  return desktopOrHttp<T>({
    command,
    args: { accountId, filter },
    url: `/api/accounts/${accountId}/usage/${endpoint}`,
    init: {
      method: "POST",
      body: JSON.stringify(filter)
    }
  });
}

export function getUsageStats(accountId: string, filter: UsageFilter) {
  return postUsageAggregate<UsageStatsRecord>(accountId, "stats", "get_usage_stats", filter);
}

export function getUsageAnalytics(accountId: string, filter: UsageFilter) {
  return postUsageAggregate<UsageAnalyticsPayload>(accountId, "analytics", "get_usage_analytics", filter);
}

export function getUsageExtremes(accountId: string, filter: UsageFilter) {
  return postUsageAggregate<UsageExtremesPayload>(accountId, "extremes", "get_usage_extremes", filter);
}

export function getDashboardModels(accountId: string, filter: UsageFilter) {
  return postUsageAggregate<DashboardModelsPayload>(accountId, "models", "get_dashboard_models", filter);
}

export function getDashboardTrend(accountId: string, filter: UsageFilter) {
  return postUsageAggregate<UsageTrendPayload>(accountId, "trend", "get_dashboard_trend", filter);
}

export function getUsageInsights(accountId: string, filter: UsageFilter) {
  return postUsageAggregate<UsageInsightsPayload>(accountId, "insights", "get_usage_insights", filter);
}

export function getApiKeyDailyUsage(accountId: string, keyId: string | number, days = 30) {
  return desktopOrHttp<DailyUsagePoint[]>({
    command: "get_key_daily_usage",
    args: { accountId, keyId: String(keyId), days },
    url: `/api/accounts/${accountId}/keys/${keyId}/daily-usage?days=${days}`
  });
}

export function getApiKeyUsageSummary(
  accountId: string,
  keyId: string | number,
  days = 30,
  query: {
    startDate?: string | null;
    endDate?: string | null;
  } = {}
) {
  const params = new URLSearchParams();
  params.set("days", String(days));
  if (query.startDate) {
    params.set("start_date", query.startDate);
  }
  if (query.endDate) {
    params.set("end_date", query.endDate);
  }
  return desktopOrHttp<KeyUsageSummaryPayload>({
    command: "get_key_usage_summary",
    args: {
      accountId,
      keyId: String(keyId),
      days,
      startDate: query.startDate ?? null,
      endDate: query.endDate ?? null
    },
    url: `/api/accounts/${accountId}/keys/${keyId}/usage-summary?${params.toString()}`
  });
}

export function getSubscriptionKeyUsage(
  accountId: string,
  keyIds: string[],
  query: {
    startDate?: string | null;
    endDate?: string | null;
  } = {}
) {
  return desktopOrHttp<SubscriptionKeyUsagePayload>({
    command: "get_subscription_key_usage",
    args: {
      accountId,
      keyIds,
      startDate: query.startDate ?? null,
      endDate: query.endDate ?? null
    },
    url: `/api/accounts/${accountId}/usage/subscription-key-usage`,
    init: {
      method: "POST",
      body: JSON.stringify({
        keyIds,
        startDate: query.startDate ?? null,
        endDate: query.endDate ?? null
      })
    }
  });
}
