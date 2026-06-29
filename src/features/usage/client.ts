import type {
  DailyUsagePoint,
  DashboardModelsPayload,
  PaginatedResult,
  UsageRow,
  UsageStatsRecord,
  UsageTrendPayload
} from "../../types";
import { desktopOrHttp } from "../../shared/transport/runtime";

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
  return desktopOrHttp<PaginatedResult<UsageRow>>({
    command: "list_usage_records",
    args: {
      accountId,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
      apiKeyId: query.apiKeyId === null || query.apiKeyId === undefined || query.apiKeyId === "" ? null : String(query.apiKeyId),
      startDate: query.startDate ?? null,
      endDate: query.endDate ?? null
    },
    url: `/api/accounts/${accountId}/usage?${params.toString()}`
  });
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
  const suffix = params.toString();
  return desktopOrHttp<UsageStatsRecord>({
    command: "get_usage_stats",
    args: {
      accountId,
      period: query.period ?? null,
      apiKeyId: query.apiKeyId === null || query.apiKeyId === undefined || query.apiKeyId === "" ? null : String(query.apiKeyId),
      startDate: query.startDate ?? null,
      endDate: query.endDate ?? null
    },
    url: suffix ? `/api/accounts/${accountId}/usage/stats?${suffix}` : `/api/accounts/${accountId}/usage/stats`
  });
}

export function getDashboardModels(
  accountId: string,
  query: {
    days?: number;
    apiKeyId?: string | number | null;
    startDate?: string | null;
    endDate?: string | null;
  } = {}
) {
  const params = new URLSearchParams();
  params.set("days", String(query.days ?? 7));
  if (query.apiKeyId !== null && query.apiKeyId !== undefined && query.apiKeyId !== "") {
    params.set("api_key_id", String(query.apiKeyId));
  }
  if (query.startDate) {
    params.set("start_date", query.startDate);
  }
  if (query.endDate) {
    params.set("end_date", query.endDate);
  }
  return desktopOrHttp<DashboardModelsPayload>({
    command: "get_dashboard_models",
    args: {
      accountId,
      days: query.days ?? 7,
      apiKeyId: query.apiKeyId === null || query.apiKeyId === undefined || query.apiKeyId === "" ? null : String(query.apiKeyId),
      startDate: query.startDate ?? null,
      endDate: query.endDate ?? null
    },
    url: `/api/accounts/${accountId}/usage/models?${params.toString()}`
  });
}

export function getDashboardTrend(
  accountId: string,
  query: {
    days?: number;
    apiKeyId?: string | number | null;
    startDate?: string | null;
    endDate?: string | null;
  } = {}
) {
  const params = new URLSearchParams();
  params.set("days", String(query.days ?? 7));
  if (query.apiKeyId !== null && query.apiKeyId !== undefined && query.apiKeyId !== "") {
    params.set("api_key_id", String(query.apiKeyId));
  }
  if (query.startDate) {
    params.set("start_date", query.startDate);
  }
  if (query.endDate) {
    params.set("end_date", query.endDate);
  }
  return desktopOrHttp<UsageTrendPayload>({
    command: "get_dashboard_trend",
    args: {
      accountId,
      days: query.days ?? 7,
      apiKeyId: query.apiKeyId === null || query.apiKeyId === undefined || query.apiKeyId === "" ? null : String(query.apiKeyId),
      startDate: query.startDate ?? null,
      endDate: query.endDate ?? null
    },
    url: `/api/accounts/${accountId}/usage/trend?${params.toString()}`
  });
}

export function getApiKeyDailyUsage(accountId: string, keyId: string | number, days = 30) {
  return desktopOrHttp<DailyUsagePoint[]>({
    command: "get_key_daily_usage",
    args: { accountId, keyId: String(keyId), days },
    url: `/api/accounts/${accountId}/keys/${keyId}/daily-usage?days=${days}`
  });
}
