import { useEffect, useRef, useState } from "react";

import { toDateValue } from "../../shared/lib/formatters";
import type {
  DailyUsagePoint,
  DashboardModelsPayload,
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
import { summarizeUsageRowsByModel, type UsageModelSummary } from "./model-summary";

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

type UsageRangePreset = (typeof USAGE_RANGE_PRESETS)[number]["key"];

export function useUsageWorkspace({
  selectedAccountId,
  managedKeys,
  setBusyText,
  setError
}: {
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

  useEffect(() => {
    if (!selectedAccountId) {
      setUsageRecords(null);
      setUsageStats(null);
      setUsageTrend(null);
      setUsageModels(null);
      setUsageModelSummaries([]);
      setUsageModelSummariesLoading(false);
      setKeyUsageRows([]);
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
  }, [selectedAccountId]);

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
    if (!selectedAccountId) {
      return;
    }

    const keys = managedKeys?.items ?? [];
    if (keys.length === 0) {
      setKeyUsageRows([]);
      return;
    }

    const nextKeyId = keys.find((item) => item.id === keyUsageKeyId)?.id ?? keys[0]?.id ?? "";
    if (!nextKeyId) {
      setKeyUsageRows([]);
      return;
    }
    if (nextKeyId === keyUsageKeyId && keyUsageRows.length > 0) {
      return;
    }

    void loadKeyUsage(nextKeyId, false);
  }, [selectedAccountId, managedKeys]);

  const usageRangeLabel = formatUsageRangeLabel(usageRangePreset, usageStartDate, usageEndDate);

  async function loadUsageWorkspace(accountId: string, startDate: string, endDate: string) {
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

      setUsageStats(nextUsageStats);
      setUsageTrend(nextUsageTrend);
      setUsageModels(nextUsageModels);

      await Promise.all([
        loadUsageRecordsForFilters(accountId, startDate, endDate, usageApiKeyFilter, usagePage),
        loadUsageModelSummaries(accountId, startDate, endDate, usageApiKeyFilter)
      ]);
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  async function loadUsageRecordsForFilters(
    accountId: string,
    startDate: string,
    endDate: string,
    apiKeyId: string,
    page = 1
  ) {
    const next = await listUsageRecords(accountId, {
      page,
      pageSize: 20,
      apiKeyId,
      startDate,
      endDate
    });
    setUsageRecords(next);
  }

  async function loadUsageModelSummaries(
    accountId: string,
    startDate: string,
    endDate: string,
    apiKeyId: string
  ) {
    setUsageModelSummariesLoading(true);
    try {
      const pageSize = 20;
      const firstPage = await listUsageRecords(accountId, {
        page: 1,
        pageSize,
        apiKeyId,
        startDate,
        endDate
      });
      const remainingPages = Array.from({ length: Math.max(firstPage.pages - 1, 0) }, (_, index) => index + 2);
      const pageResults = remainingPages.length
        ? await Promise.all(
            remainingPages.map((page) =>
              listUsageRecords(accountId, {
                page,
                pageSize,
                apiKeyId,
                startDate,
                endDate
              })
            )
          )
        : [];
      const allItems = [...firstPage.items, ...pageResults.flatMap((page) => page.items)];
      setUsageModelSummaries(summarizeUsageRowsByModel(allItems));
    } finally {
      setUsageModelSummariesLoading(false);
    }
  }

  async function handleUsageSearch() {
    if (!selectedAccountId) {
      return;
    }

    setBusyText("正在刷新用量明细...");
    setError(null);
    try {
      setUsagePage(1);
      const [stats] = await Promise.all([
        getUsageStats(selectedAccountId, {
          startDate: usageStartDate,
          endDate: usageEndDate,
          apiKeyId: usageApiKeyFilter || null
        }),
        loadUsageRecordsForFilters(selectedAccountId, usageStartDate, usageEndDate, usageApiKeyFilter, 1),
        loadUsageModelSummaries(selectedAccountId, usageStartDate, usageEndDate, usageApiKeyFilter)
      ]);
      setUsageStats(stats);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleUsagePageChange(nextPage: number) {
    if (!selectedAccountId || !usageRecords) {
      return;
    }

    const safePage = Math.min(Math.max(1, nextPage), Math.max(usageRecords.pages, 1));
    setBusyText(`正在加载第 ${safePage} 页用量记录...`);
    setError(null);
    try {
      await loadUsageRecordsForFilters(
        selectedAccountId,
        usageStartDate,
        usageEndDate,
        usageApiKeyFilter,
        safePage
      );
      setUsagePage(safePage);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
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
    try {
      const [stats] = await Promise.all([
        getUsageStats(selectedAccountId, {
          startDate: nextStart,
          endDate: nextEnd,
          apiKeyId: usageApiKeyFilter || null
        }),
        loadUsageRecordsForFilters(selectedAccountId, nextStart, nextEnd, usageApiKeyFilter, 1),
        loadUsageModelSummaries(selectedAccountId, nextStart, nextEnd, usageApiKeyFilter)
      ]);
      setUsageStats(stats);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function loadKeyUsage(keyId: string, announce = true) {
    if (!selectedAccountId || !keyId) {
      return;
    }

    if (announce) {
      setBusyText("正在加载单 Key 用量...");
      setError(null);
    }
    try {
      setKeyUsageKeyId(keyId);
      const daily = await getApiKeyDailyUsage(selectedAccountId, keyId, 30);
      setKeyUsageRows(daily);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      if (announce) {
        setBusyText(null);
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
    keyUsageRows,
    keyUsageKeyId,
    loadKeyUsage,
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
