import { accountProxyRequest } from "../../shared/transport/runtime";
import {
  normalizeDailyUsageRows,
  normalizeItems,
  normalizeModelsPayload,
  normalizePaginated,
  normalizeTrendPayload,
  normalizeUsageRow,
  normalizeUsageStats
} from "../../shared/transport/normalizers";

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
