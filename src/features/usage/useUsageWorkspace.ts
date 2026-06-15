import { useEffect, useRef, useState } from "react";

import { toDateValue } from "../../shared/lib/formatters";
import type {
  DailyUsagePoint,
  DashboardModelsPayload,
  NavKey,
  ManagedKeyRecord,
  PaginatedResult,
  UsageRow,
  UsageStatsRecord,
  UsageTrendPayload
} from "../../types";
import {
  getApiKeyDailyUsage,
  getDashboardModels,
  getDashboardTrend,
  getUsageStats,
  listUsageRecords
} from "./client";
import {
  summarizeDashboardModels,
  type UsageModelSummary
} from "./model-summary";

const USAGE_RANGE_PRESETS = [
  { key: "today", label: "今天" },
  { key: "yesterday", label: "昨天" },
  { key: "last24Hours", label: "近24小时" },
  { key: "last7Days", label: "近 7 天" },
  { key: "last14Days", label: "近 14 天" },
  { key: "last30Days", label: "近 30 天" },
  { key: "thisMonth", label: "本月" },
  { key: "lastMonth", label: "上月" }
] as const;

const ANALYTICS_USAGE_PAGE_SIZE = 500;
const ANALYTICS_USAGE_BATCH_SIZE = 4;

type UsageRangePreset = (typeof USAGE_RANGE_PRESETS)[number]["key"];

export function useUsageWorkspace({
  nav,
  selectedAccountId,
  managedKeys,
  setBusyText,
  setError
}: {
  nav: NavKey;
  selectedAccountId: string | null;
  managedKeys: PaginatedResult<ManagedKeyRecord> | null;
  setBusyText: (value: string | null) => void;
  setError: (value: string | null) => void;
}) {
  const [usageRecords, setUsageRecords] = useState<PaginatedResult<UsageRow> | null>(null);
  const [usagePage, setUsagePage] = useState(1);
  const [usageStats, setUsageStats] = useState<UsageStatsRecord | null>(null);
  const [usageTrend, setUsageTrend] = useState<UsageTrendPayload | null>(null);
  const [usageModels, setUsageModels] = useState<DashboardModelsPayload | null>(null);
  const [usageScopeRows, setUsageScopeRows] = useState<UsageRow[]>([]);
  const [usageScopeMeta, setUsageScopeMeta] = useState<{
    total: number;
    pages: number;
    loadedPages: number;
    pageSize: number;
  } | null>(null);
  const [usageModelSummaries, setUsageModelSummaries] = useState<UsageModelSummary[]>([]);
  const [usageModelSummariesLoading, setUsageModelSummariesLoading] = useState(false);
  const [usageApiKeyFilter, setUsageApiKeyFilter] = useState<string>("");
  const [usageStartDate, setUsageStartDate] = useState<string>("");
  const [usageEndDate, setUsageEndDate] = useState<string>("");
  const [usageRangePickerOpen, setUsageRangePickerOpen] = useState(false);
  const [usageRangePreset, setUsageRangePreset] = useState<UsageRangePreset>("today");
  const [usageDraftRange, setUsageDraftRange] = useState({ startDate: "", endDate: "" });
  const usageRangePickerRef = useRef<HTMLDivElement | null>(null);
  const [keyUsageKeyId, setKeyUsageKeyId] = useState<string>("");
  const [keyUsageRows, setKeyUsageRows] = useState<DailyUsagePoint[]>([]);
  const usageRequestSequenceRef = useRef(0);
  const usageFeaturesActive = nav === "usage" || nav === "trends" || nav === "keyUsage";
  const overviewUsageStatsActive = nav === "overview";
  const keyUsageActive = nav === "keyUsage" || nav === "trends";

  function beginUsageRequest() {
    usageRequestSequenceRef.current += 1;
    return usageRequestSequenceRef.current;
  }

  function isLatestUsageRequest(sequence: number) {
    return usageRequestSequenceRef.current === sequence;
  }

  useEffect(() => {
    if (!selectedAccountId) {
      setUsageRecords(null);
      setUsageStats(null);
      setUsageTrend(null);
      setUsageModels(null);
      setUsageScopeRows([]);
      setUsageScopeMeta(null);
      setUsageModelSummaries([]);
      setUsageModelSummariesLoading(false);
      setUsageApiKeyFilter("");
      setUsagePage(1);
      setKeyUsageKeyId("");
      setKeyUsageRows([]);
      return;
    }
    if (!usageFeaturesActive) {
      return;
    }

    const today = new Date();
    const effectiveStart = usageStartDate || toDateValue(today);
    const effectiveEnd = usageEndDate || toDateValue(today);

    if (!usageStartDate) {
      setUsageStartDate(effectiveStart);
    }
    if (!usageEndDate) {
      setUsageEndDate(effectiveEnd);
    }
    setUsageDraftRange((current) => ({
      startDate: current.startDate || effectiveStart,
      endDate: current.endDate || effectiveEnd
    }));

    void loadUsageWorkspace(selectedAccountId, effectiveStart, effectiveEnd);
  }, [selectedAccountId, usageFeaturesActive]);

  useEffect(() => {
    if (!selectedAccountId) {
      return;
    }
    if (!overviewUsageStatsActive) {
      return;
    }

    void loadOverviewUsageStats(selectedAccountId);
  }, [selectedAccountId, overviewUsageStatsActive]);

  useEffect(() => {
    if (!usageRangePickerOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!usageRangePickerRef.current) {
        return;
      }
      if (usageRangePickerRef.current.contains(event.target as Node)) {
        return;
      }
      setUsageRangePickerOpen(false);
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [usageRangePickerOpen]);

  useEffect(() => {
    const keys = managedKeys?.items ?? [];
    if (!usageApiKeyFilter) {
      return;
    }
    if (keys.some((item) => item.apiKeyId !== null && item.apiKeyId !== undefined && String(item.apiKeyId) === usageApiKeyFilter)) {
      return;
    }
    setUsageApiKeyFilter("");
  }, [managedKeys, usageApiKeyFilter]);

  useEffect(() => {
    if (!selectedAccountId) {
      return;
    }
    if (!keyUsageActive) {
      return;
    }

    const keys = managedKeys?.items ?? [];
    if (keys.length === 0) {
      if (keyUsageKeyId) {
        setKeyUsageKeyId("");
      }
      setKeyUsageRows([]);
      return;
    }

    const nextKeyId =
      keys.find((item) => item.id === keyUsageKeyId)?.id ??
      pickDefaultKeyUsageKeyId(keys);
    if (!nextKeyId) {
      setKeyUsageRows([]);
      return;
    }
    if (nextKeyId === keyUsageKeyId && keyUsageRows.length > 0) {
      return;
    }

    void loadKeyUsage(nextKeyId, false);
  }, [selectedAccountId, managedKeys, keyUsageActive, keyUsageKeyId, keyUsageRows.length, usageApiKeyFilter]);

  const usageRangeLabel = formatUsageRangeLabel(usageRangePreset, usageStartDate, usageEndDate);

  async function loadUsageWorkspace(accountId: string, startDate: string, endDate: string) {
    const requestSequence = beginUsageRequest();
    setUsageModelSummariesLoading(true);
    try {
      const loadOptional = async <T,>(loader: () => Promise<T>, fallback: T) => {
        try {
          return await loader();
        } catch (cause) {
          if (isOptionalEndpointUnavailable(cause)) {
            return fallback;
          }
          throw cause;
        }
      };

      const [nextUsageStats, nextUsageTrend, nextUsageModels] = await Promise.all([
        loadOptional(() => getUsageStats(accountId, { period: "today" }), {
          totalRequests: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheTokens: 0,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          totalTokens: 0,
          totalCost: 0,
          totalActualCost: 0,
          averageDurationMs: 0,
          rpm: 0,
          tpm: 0
        }),
        loadOptional(() => getDashboardTrend(accountId, 7), null),
        loadOptional(() => getDashboardModels(accountId, 7), null)
      ]);

      if (!isLatestUsageRequest(requestSequence)) {
        return;
      }

      setUsageStats(
        applyUsageRateFallback(nextUsageStats, {
          startDate,
          endDate
        })
      );
      setUsageTrend(nextUsageTrend);
      setUsageModels(nextUsageModels);
      setUsageModelSummaries(summarizeDashboardModels(nextUsageModels));

      await Promise.all([
        loadUsageRecordsForFilters(accountId, startDate, endDate, usageApiKeyFilter, usagePage, requestSequence),
        loadUsageScopeRowsForFilters(accountId, startDate, endDate, usageApiKeyFilter, requestSequence)
      ]);
      if (!isLatestUsageRequest(requestSequence)) {
        return;
      }
      setError(null);
    } catch (cause) {
      if (!isLatestUsageRequest(requestSequence)) {
        return;
      }
      setError((cause as Error).message);
    } finally {
      if (isLatestUsageRequest(requestSequence)) {
        setUsageModelSummariesLoading(false);
      }
    }
  }

  async function loadOverviewUsageStats(accountId: string) {
    const requestSequence = beginUsageRequest();
    try {
      const nextUsageStats = await getUsageStats(accountId, { period: "today" });
      if (!isLatestUsageRequest(requestSequence)) {
        return;
      }
      setUsageStats(applyUsageRateFallback(nextUsageStats, { period: "today" }));
    } catch (cause) {
      if (!isLatestUsageRequest(requestSequence)) {
        return;
      }
      setError((cause as Error).message);
    }
  }

  async function loadUsageRecordsForFilters(
    accountId: string,
    startDate: string,
    endDate: string,
    apiKeyId: string,
    page = 1,
    requestSequence = usageRequestSequenceRef.current
  ) {
    const next = await fetchUsageRecordsPage(accountId, startDate, endDate, apiKeyId, page, 20);
    if (!isLatestUsageRequest(requestSequence)) {
      return next;
    }
    setUsageRecords(next);
    return next;
  }

  async function fetchUsageRecordsPage(
    accountId: string,
    startDate: string,
    endDate: string,
    apiKeyId: string,
    page: number,
    pageSize: number
  ) {
    return await listUsageRecords(accountId, {
      page,
      pageSize,
      apiKeyId,
      startDate,
      endDate
    });
  }

  async function loadUsageScopeRowsForFilters(
    accountId: string,
    startDate: string,
    endDate: string,
    apiKeyId: string,
    requestSequence = usageRequestSequenceRef.current
  ) {
    const firstPage = await fetchUsageRecordsPage(
      accountId,
      startDate,
      endDate,
      apiKeyId,
      1,
      ANALYTICS_USAGE_PAGE_SIZE
    );
    if (!isLatestUsageRequest(requestSequence)) {
      return firstPage.items;
    }
    const totalPages = Math.max(firstPage.pages, 1);
    const rows = [...firstPage.items];

    for (let pageStart = 2; pageStart <= totalPages; pageStart += ANALYTICS_USAGE_BATCH_SIZE) {
      const batchPages = Array.from(
        { length: Math.min(ANALYTICS_USAGE_BATCH_SIZE, totalPages - pageStart + 1) },
        (_, index) => pageStart + index
      );
      const batchResults = await Promise.all(
        batchPages.map((page) =>
          fetchUsageRecordsPage(
            accountId,
            startDate,
            endDate,
            apiKeyId,
            page,
            ANALYTICS_USAGE_PAGE_SIZE
          )
        )
      );
      if (!isLatestUsageRequest(requestSequence)) {
        return rows;
      }
      for (const result of batchResults) {
        rows.push(...result.items);
      }
    }

    if (!isLatestUsageRequest(requestSequence)) {
      return rows;
    }
    setUsageScopeRows(rows);
    setUsageScopeMeta({
      total: firstPage.total,
      pages: totalPages,
      loadedPages: totalPages,
      pageSize: ANALYTICS_USAGE_PAGE_SIZE
    });
    return rows;
  }

  async function handleUsageSearch() {
    if (!selectedAccountId) {
      return;
    }

    setBusyText("正在刷新用量明细...");
    setError(null);
    setUsageModelSummariesLoading(true);
    const requestSequence = beginUsageRequest();
    try {
      setUsagePage(1);
      const [stats, , , trend, models] = await Promise.all([
        getUsageStats(selectedAccountId, {
          startDate: usageStartDate,
          endDate: usageEndDate,
          apiKeyId: usageApiKeyFilter || null
        }),
        loadUsageRecordsForFilters(selectedAccountId, usageStartDate, usageEndDate, usageApiKeyFilter, 1, requestSequence),
        loadUsageScopeRowsForFilters(selectedAccountId, usageStartDate, usageEndDate, usageApiKeyFilter, requestSequence),
        getDashboardTrend(selectedAccountId, 7).catch((cause) => {
          if (isOptionalEndpointUnavailable(cause)) {
            return null;
          }
          throw cause;
        }),
        getDashboardModels(selectedAccountId, 7).catch((cause) => {
          if (isOptionalEndpointUnavailable(cause)) {
            return null;
          }
          throw cause;
        })
      ]);
      if (!isLatestUsageRequest(requestSequence)) {
        return;
      }
      setUsageStats(
        applyUsageRateFallback(stats, {
          startDate: usageStartDate,
          endDate: usageEndDate
        })
      );
      setUsageTrend(trend);
      setUsageModels(models);
      setUsageModelSummaries(summarizeDashboardModels(models));
    } catch (cause) {
      if (!isLatestUsageRequest(requestSequence)) {
        return;
      }
      setError((cause as Error).message);
    } finally {
      if (isLatestUsageRequest(requestSequence)) {
        setUsageModelSummariesLoading(false);
        setBusyText(null);
      }
    }
  }

  async function handleUsagePageChange(nextPage: number) {
    if (!selectedAccountId || !usageRecords) {
      return;
    }

    const safePage = Math.min(Math.max(1, nextPage), Math.max(usageRecords.pages, 1));
    setBusyText(`正在加载第 ${safePage} 页用量记录...`);
    setError(null);
    const requestSequence = beginUsageRequest();
    try {
      await loadUsageRecordsForFilters(
        selectedAccountId,
        usageStartDate,
        usageEndDate,
        usageApiKeyFilter,
        safePage,
        requestSequence
      );
      if (!isLatestUsageRequest(requestSequence)) {
        return;
      }
      setUsagePage(safePage);
    } catch (cause) {
      if (!isLatestUsageRequest(requestSequence)) {
        return;
      }
      setError((cause as Error).message);
    } finally {
      if (isLatestUsageRequest(requestSequence)) {
        setBusyText(null);
      }
    }
  }

  function toggleUsageRangePicker() {
    if (usageRangePickerOpen) {
      setUsageRangePickerOpen(false);
      return;
    }
    setUsageDraftRange({
      startDate: usageStartDate,
      endDate: usageEndDate
    });
    setUsageRangePickerOpen(true);
  }

  function applyUsagePreset(preset: UsageRangePreset) {
    const range = buildPresetRange(preset);
    setUsageRangePreset(preset);
    setUsageDraftRange(range);
  }

  async function applyUsageRange() {
    if (!selectedAccountId) {
      return;
    }

    const nextStart = usageDraftRange.startDate || usageStartDate;
    const nextEnd = usageDraftRange.endDate || usageEndDate;
    setUsageStartDate(nextStart);
    setUsageEndDate(nextEnd);
    setUsagePage(1);
    setUsageRangePickerOpen(false);
    setBusyText("正在应用时间范围...");
    setError(null);
    setUsageModelSummariesLoading(true);
    const requestSequence = beginUsageRequest();
    try {
      const [stats, , , trend, models] = await Promise.all([
        getUsageStats(selectedAccountId, {
          startDate: nextStart,
          endDate: nextEnd,
          apiKeyId: usageApiKeyFilter || null
        }),
        loadUsageRecordsForFilters(selectedAccountId, nextStart, nextEnd, usageApiKeyFilter, 1, requestSequence),
        loadUsageScopeRowsForFilters(selectedAccountId, nextStart, nextEnd, usageApiKeyFilter, requestSequence),
        getDashboardTrend(selectedAccountId, 7).catch((cause) => {
          if (isOptionalEndpointUnavailable(cause)) {
            return null;
          }
          throw cause;
        }),
        getDashboardModels(selectedAccountId, 7).catch((cause) => {
          if (isOptionalEndpointUnavailable(cause)) {
            return null;
          }
          throw cause;
        })
      ]);
      if (!isLatestUsageRequest(requestSequence)) {
        return;
      }
      setUsageStats(
        applyUsageRateFallback(stats, {
          startDate: nextStart,
          endDate: nextEnd
        })
      );
      setUsageTrend(trend);
      setUsageModels(models);
      setUsageModelSummaries(summarizeDashboardModels(models));
    } catch (cause) {
      if (!isLatestUsageRequest(requestSequence)) {
        return;
      }
      setError((cause as Error).message);
    } finally {
      if (isLatestUsageRequest(requestSequence)) {
        setUsageModelSummariesLoading(false);
        setBusyText(null);
      }
    }
  }

  async function loadKeyUsage(keyId: string, announce = true) {
    if (!selectedAccountId || !keyId) {
      return;
    }

    const requestSequence = beginUsageRequest();
    if (announce) {
      setBusyText("正在加载单 Key 用量...");
      setError(null);
    }
    try {
      setKeyUsageKeyId(keyId);
      const daily = await getApiKeyDailyUsage(selectedAccountId, keyId, 30);
      if (!isLatestUsageRequest(requestSequence)) {
        return;
      }
      setKeyUsageRows(daily);
    } catch (cause) {
      if (!isLatestUsageRequest(requestSequence)) {
        return;
      }
      setError((cause as Error).message);
    } finally {
      if (announce && isLatestUsageRequest(requestSequence)) {
        setBusyText(null);
      }
    }
  }

  async function refreshUsageWorkspaceSilently() {
    if (!selectedAccountId) {
      return;
    }

    const requestSequence = beginUsageRequest();
    setUsageModelSummariesLoading(true);
    try {
      if (nav === "overview") {
        const stats = await getUsageStats(selectedAccountId, { period: "today" });
        if (!isLatestUsageRequest(requestSequence)) {
          return;
        }
        setUsageStats(applyUsageRateFallback(stats, { period: "today" }));
        setError(null);
        return;
      }

      const effectiveStart = usageStartDate || toDateValue(new Date());
      const effectiveEnd = usageEndDate || toDateValue(new Date());
      const targetUsagePage = usageRecords?.page ?? usagePage;

      const [stats, records, scopeRows, trend, models] = await Promise.all([
        getUsageStats(selectedAccountId, {
          startDate: effectiveStart,
          endDate: effectiveEnd,
          apiKeyId: usageApiKeyFilter || null
        }),
        loadUsageRecordsForFilters(
          selectedAccountId,
          effectiveStart,
          effectiveEnd,
          usageApiKeyFilter,
          targetUsagePage,
          requestSequence
        ),
        loadUsageScopeRowsForFilters(
          selectedAccountId,
          effectiveStart,
          effectiveEnd,
          usageApiKeyFilter,
          requestSequence
        ),
        getDashboardTrend(selectedAccountId, 7).catch((cause) => {
          if (isOptionalEndpointUnavailable(cause)) {
            return null;
          }
          throw cause;
        }),
        getDashboardModels(selectedAccountId, 7).catch((cause) => {
          if (isOptionalEndpointUnavailable(cause)) {
            return null;
          }
          throw cause;
        })
      ]);

      if (!isLatestUsageRequest(requestSequence)) {
        return;
      }

      setUsageStats(
        applyUsageRateFallback(stats, {
          startDate: effectiveStart,
          endDate: effectiveEnd
        })
      );
      setUsageRecords(records ?? null);
      setUsageScopeRows(scopeRows ?? []);
      setUsageTrend(trend);
      setUsageModels(models);
      setUsageModelSummaries(summarizeDashboardModels(models));

      if ((nav === "keyUsage" || nav === "trends") && keyUsageKeyId) {
        const daily = await getApiKeyDailyUsage(selectedAccountId, keyUsageKeyId, 30);
        if (!isLatestUsageRequest(requestSequence)) {
          return;
        }
        setKeyUsageRows(daily);
      }

      setError(null);
    } catch (cause) {
      if (!isLatestUsageRequest(requestSequence)) {
        return;
      }
      setError((cause as Error).message);
    } finally {
      if (isLatestUsageRequest(requestSequence)) {
        setUsageModelSummariesLoading(false);
      }
    }
  }

  return {
    usageApiKeyFilter,
    setUsageApiKeyFilter,
    usageRangePickerRef,
    usageRangePickerOpen,
    toggleUsageRangePicker,
    usageRangeLabel,
    usageRangePreset,
    applyUsagePreset,
    usageDraftRange,
    setUsageDraftRange,
    applyUsageRange,
    usageStats,
    usageModelSummaries,
    usageModelSummariesLoading,
    usageRecords,
    handleUsageSearch,
    handleUsagePageChange,
    usageTrend,
    usageModels,
    usageScopeRows,
    usageScopeMeta,
    keyUsageRows,
    keyUsageKeyId,
    loadKeyUsage,
    refreshUsageWorkspaceSilently,
    usageStartDate,
    setUsageStartDate,
    usageEndDate,
    setUsageEndDate
  };
}

function isOptionalEndpointUnavailable(cause: unknown) {
  const message = (cause as Error)?.message ?? "";
  return message.includes("未找到可用的接口路径") || message.includes("404");
}

function applyUsageRateFallback(
  stats: UsageStatsRecord,
  query: {
    period?: string | null;
    startDate?: string | null;
    endDate?: string | null;
  }
) {
  if (stats.rpm !== null && stats.rpm !== undefined && stats.tpm !== null && stats.tpm !== undefined) {
    return stats;
  }

  const windowMinutes = inferUsageWindowMinutes(query);
  if (!windowMinutes) {
    return stats;
  }

  return {
    ...stats,
    rpm: stats.rpm ?? stats.totalRequests / windowMinutes,
    tpm: stats.tpm ?? stats.totalTokens / windowMinutes
  };
}

function inferUsageWindowMinutes(query: {
  period?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}) {
  const now = new Date();
  const today = toDateValue(now);
  const periodDay = query.period === "today" ? today : null;
  const startDate = query.startDate || periodDay || query.endDate;
  const endDate = query.endDate || periodDay || query.startDate || startDate;
  if (!startDate || !endDate) {
    return null;
  }

  const start = new Date(`${startDate}T00:00:00`);
  const end =
    endDate >= today
      ? now
      : new Date(`${endDate}T23:59:59`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() < start.getTime()) {
    return null;
  }

  return Math.max((end.getTime() - start.getTime()) / 60000, 1);
}

function buildPresetRange(preset: UsageRangePreset) {
  const today = new Date();
  const start = new Date(today);
  const end = new Date(today);

  switch (preset) {
    case "today":
      break;
    case "yesterday":
      start.setDate(today.getDate() - 1);
      end.setDate(today.getDate() - 1);
      break;
    case "last24Hours":
      start.setDate(today.getDate() - 1);
      break;
    case "last7Days":
      start.setDate(today.getDate() - 6);
      break;
    case "last14Days":
      start.setDate(today.getDate() - 13);
      break;
    case "last30Days":
      start.setDate(today.getDate() - 29);
      break;
    case "thisMonth":
      start.setDate(1);
      break;
    case "lastMonth":
      start.setMonth(today.getMonth() - 1, 1);
      end.setMonth(today.getMonth(), 0);
      break;
  }

  return {
    startDate: toDateValue(start),
    endDate: toDateValue(end)
  };
}

function formatUsageRangeLabel(preset: UsageRangePreset, startDate: string, endDate: string) {
  const presetLabel = USAGE_RANGE_PRESETS.find((item) => item.key === preset)?.label;
  if (presetLabel) {
    return presetLabel;
  }
  if (startDate && endDate) {
    return `${startDate} - ${endDate}`;
  }
  return "选择时间范围";
}

function pickDefaultKeyUsageKeyId(keys: ManagedKeyRecord[]) {
  const sorted = [...keys].sort((left, right) => {
    const leftTime = left.lastUsedAt ? Date.parse(left.lastUsedAt) : Number.NEGATIVE_INFINITY;
    const rightTime = right.lastUsedAt ? Date.parse(right.lastUsedAt) : Number.NEGATIVE_INFINITY;
    return rightTime - leftTime;
  });
  return sorted[0]?.id ?? "";
}
