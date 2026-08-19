import { useEffect, useRef, useState } from "react";

import { toDateValue } from "../../shared/lib/formatters";
import { ScopedResourceCache } from "../../shared/state/scoped-resource-cache";
import type {
  DataSyncTrigger,
  DailyUsagePoint,
  DashboardModelsPayload,
  KeyRecord,
  NavKey,
  ManagedKeyRecord,
  PaginatedResult,
  UsageAnalyticsPayload,
  UsageCursorPage,
  UsageExtremesPayload,
  UsageFacetField,
  UsageFacetPage,
  UsageFilter,
  UsageListRequest,
  UsageRow,
  UsageStatsRecord,
  UsageTrendPayload
} from "../../types";
import {
  getApiKeyDailyUsage,
  getDashboardModels,
  getDashboardTrend,
  getUsageAnalytics,
  getUsageExtremes,
  getUsageStats,
  listUsageFacets,
  listUsageRecords
} from "./client";
import {
  buildUsageFilterFromDraft,
  createEmptyUsageFilterDraft,
  type UsageFilterDraft
} from "./usage-filter-draft";
import {
  summarizeDashboardModels,
  type UsageModelSummary
} from "./model-summary";
import {
  buildUsageKeyDailyScopeKey,
  buildUsageScopeKey,
  usageScopeReferencesAccount,
  type UsageScopeSurface
} from "./usage-scope";

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

const DEFAULT_USAGE_PAGE_SIZE = 20;
const USAGE_PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
const KEY_USAGE_DAYS = 30;

type UsageRangePreset = (typeof USAGE_RANGE_PRESETS)[number]["key"];

type UsageSnapshot = {
  records: UsageCursorPage<UsageRow> | null;
  stats: UsageStatsRecord | null;
  extremes: UsageExtremesPayload | null;
  trend: UsageTrendPayload | null;
  models: DashboardModelsPayload | null;
  modelSummaries: UsageModelSummary[];
  analytics: UsageAnalyticsPayload | null;
};

type UsageCursorFrame = Pick<UsageListRequest, "cursor" | "direction">;

const FIRST_USAGE_CURSOR_FRAME: UsageCursorFrame = {
  cursor: null,
  direction: "next"
};

const EMPTY_USAGE_SNAPSHOT: UsageSnapshot = {
  records: null,
  stats: null,
  extremes: null,
  trend: null,
  models: null,
  modelSummaries: [],
  analytics: null
};

export type UsageSurfaceKey = "usage" | "modelStats" | "keyUsage" | "trends";
export type UsagePreloadSurface = "usage" | "modelStats";
export type UsageRefreshMode = "foreground" | "background";
export type UsageRefreshResult = "success" | "cancelled";

export type UsagePresentationState = {
  scopeKey: string | null;
  hasSnapshot: boolean;
  initialLoading: boolean;
  refreshing: boolean;
  lastError: string | null;
  updatedAt: number | null;
};

export function resolveUsageRefreshResult(options: {
  requestIsCurrent: boolean;
  blocked: boolean;
}): UsageRefreshResult {
  return options.requestIsCurrent && !options.blocked ? "success" : "cancelled";
}

export function useUsageWorkspace({
  nav,
  selectedAccountId,
  managedKeys,
  fallbackManagedKeys = [],
  setBusyText,
  setError
}: {
  nav: NavKey;
  selectedAccountId: string | null;
  managedKeys: PaginatedResult<ManagedKeyRecord> | null;
  fallbackManagedKeys?: KeyRecord[];
  setBusyText: (value: string | null) => void;
  setError: (value: string | null) => void;
}) {
  const [usagePageSize, setUsagePageSize] = useState<number>(DEFAULT_USAGE_PAGE_SIZE);
  const [usageFilterDraft, setUsageFilterDraft] = useState<UsageFilterDraft>(createEmptyUsageFilterDraft);
  const [usageAppliedFilter, setUsageAppliedFilter] = useState<UsageFilter>(() => {
    const range = buildPresetRange("today");
    return { startDate: range.startDate, endDate: range.endDate };
  });
  const [usageCursorFrame, setUsageCursorFrame] = useState<UsageCursorFrame>(FIRST_USAGE_CURSOR_FRAME);
  const [usageCursorHistory, setUsageCursorHistory] = useState<UsageCursorFrame[]>([]);
  const [usageFacetPages, setUsageFacetPages] = useState<Partial<Record<UsageFacetField, UsageFacetPage>>>({});
  const [usageFacetLoadingFields, setUsageFacetLoadingFields] = useState<UsageFacetField[]>([]);
  const [usageApiKeyFilter, setUsageApiKeyFilter] = useState<string>("");
  const [usageStartDate, setUsageStartDate] = useState<string>(() => buildPresetRange("today").startDate);
  const [usageEndDate, setUsageEndDate] = useState<string>(() => buildPresetRange("today").endDate);
  const [usageRangePickerOpen, setUsageRangePickerOpen] = useState(false);
  const [usageRangePreset, setUsageRangePreset] = useState<UsageRangePreset>("today");
  const [usageDraftRange, setUsageDraftRange] = useState(() => buildPresetRange("today"));
  const usageRangePickerRef = useRef<HTMLDivElement | null>(null);
  const [keyUsageKeyId, setKeyUsageKeyId] = useState<string>("");
  const [blockingUsageRequestCount, setBlockingUsageRequestCount] = useState(0);
  const usageCacheRef = useRef<ScopedResourceCache<UsageSnapshot> | null>(null);
  const keyUsageCacheRef = useRef<ScopedResourceCache<DailyUsagePoint[]> | null>(null);
  const selectedAccountIdRef = useRef(selectedAccountId);
  const previousUsageAccountIdRef = useRef(selectedAccountId);
  const keyUsagePendingRequestRef = useRef<{ keyId: string; scopeKey: string } | null>(null);
  const usageRequestSequenceRef = useRef(0);
  const usageScopeKeyRef = useRef<string | null>(null);
  const usageSurfaceRequestRef = useRef(new Map<UsageScopeSurface, {
    requestId: number;
    scopeKey: string;
  }>());
  const usageCursorFrameRef = useRef<UsageCursorFrame>(FIRST_USAGE_CURSOR_FRAME);
  const usageFacetRequestRef = useRef(new Map<UsageFacetField, number>());

  if (!usageCacheRef.current) {
    usageCacheRef.current = new ScopedResourceCache<UsageSnapshot>({ maxEntries: 180 });
  }
  if (!keyUsageCacheRef.current) {
    keyUsageCacheRef.current = new ScopedResourceCache<DailyUsagePoint[]>({ maxEntries: 160 });
  }
  const usageCache = usageCacheRef.current;
  const keyUsageCache = keyUsageCacheRef.current;
  const [, setCacheRevision] = useState(0);

  selectedAccountIdRef.current = selectedAccountId;
  const modelStatsPageActive = nav === "modelStats";
  const usageFeaturesActive = nav === "usage" || modelStatsPageActive || nav === "trends";
  const usageAutoLoadKey = usageFeaturesActive
    ? modelStatsPageActive
      ? `modelStats:${usageApiKeyFilter}`
      : nav
    : null;
  const analyticsLabActive = nav === "trends";
  const keyUsageActive = nav === "trends";
  const effectiveManagedKeys = managedKeys?.items?.length ? managedKeys.items : fallbackManagedKeys.map(coerceManagedKeyRecord);
  const defaultRange = buildPresetRange(usageRangePreset);
  const effectiveStart = usageStartDate || defaultRange.startDate;
  const effectiveEnd = usageEndDate || defaultRange.endDate;
  const currentSurface = resolveUsageSurface(nav);
  const currentFilter = currentSurface === "usage"
    ? usageAppliedFilter
    : buildAggregateUsageFilter(effectiveStart, effectiveEnd, usageApiKeyFilter);
  const usageScopeKey = selectedAccountId
    ? buildUsageScopeKey({
        accountId: selectedAccountId,
        surface: currentSurface,
        filter: currentFilter,
        pageSize: currentSurface === "usage" ? usagePageSize : undefined
      })
    : null;
  const keyUsageScopeKey = selectedAccountId && keyUsageKeyId
    ? buildUsageKeyDailyScopeKey({ accountId: selectedAccountId, keyId: keyUsageKeyId, days: KEY_USAGE_DAYS })
    : null;
  const usageEntry = usageScopeKey ? usageCache.peek(usageScopeKey) : null;
  const keyUsageEntry = keyUsageScopeKey ? keyUsageCache.peek(keyUsageScopeKey) : null;
  const currentScopeKey = usageScopeKey;
  const currentEntry = usageEntry;
  const snapshot = usageEntry?.data ?? EMPTY_USAGE_SNAPSHOT;
  const presentation: UsagePresentationState = {
    scopeKey: currentScopeKey,
    hasSnapshot: currentEntry?.hasSnapshot ?? false,
    initialLoading: currentEntry?.initialLoading ?? false,
    refreshing: currentEntry?.refreshing ?? false,
    lastError: currentEntry?.error ?? null,
    updatedAt: currentEntry?.updatedAt ?? null
  };
  const usageModelSummariesLoading = presentation.initialLoading || presentation.refreshing;
  const usageModelSummariesInitialLoading = presentation.initialLoading;
  usageScopeKeyRef.current = usageScopeKey;
  usageCursorFrameRef.current = usageCursorFrame;

  useEffect(() => {
    const unsubscribeUsage = usageCache.subscribe(() => {
      setCacheRevision((value) => value + 1);
    });
    const unsubscribeKeyUsage = keyUsageCache.subscribe(() => {
      setCacheRevision((value) => value + 1);
    });
    return () => {
      unsubscribeUsage();
      unsubscribeKeyUsage();
    };
  }, [keyUsageCache, usageCache]);

  useEffect(() => {
    if (previousUsageAccountIdRef.current !== selectedAccountId) {
      previousUsageAccountIdRef.current = selectedAccountId;
      usageRequestSequenceRef.current += 1;
      usageSurfaceRequestRef.current.clear();
      usageFacetRequestRef.current.clear();
      setUsageCursorFrame(FIRST_USAGE_CURSOR_FRAME);
      setUsageCursorHistory([]);
      setUsageFacetPages({});
      setUsageFacetLoadingFields([]);
    }
    if (!selectedAccountId) {
      usageCache.cancelWhere(() => true);
      keyUsageCache.cancelWhere(() => true);
      setUsageApiKeyFilter("");
      const range = buildPresetRange("today");
      setUsageFilterDraft(createEmptyUsageFilterDraft());
      setUsageAppliedFilter({ startDate: range.startDate, endDate: range.endDate });
      setUsageStartDate(range.startDate);
      setUsageEndDate(range.endDate);
      setUsageDraftRange(range);
      setUsagePageSize(DEFAULT_USAGE_PAGE_SIZE);
      setKeyUsageKeyId("");
      setBlockingUsageRequestCount(0);
      return;
    }
    if (!usageAutoLoadKey) {
      return;
    }

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
    if (usageScopeKey && usageCache.peek(usageScopeKey).hasSnapshot) {
      return;
    }
    void loadCurrentUsageScope({ mode: "background" });
  }, [selectedAccountId, usageAutoLoadKey]);

  useEffect(() => {
    if (!usageRangePickerOpen) {
      return;
    }
    function handlePointerDown(event: PointerEvent) {
      if (!usageRangePickerRef.current || usageRangePickerRef.current.contains(event.target as Node)) {
        return;
      }
      setUsageRangePickerOpen(false);
    }
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [usageRangePickerOpen]);

  useEffect(() => {
    if (nav === "trends") {
      return;
    }
    keyUsagePendingRequestRef.current = null;
  }, [nav]);

  useEffect(() => {
    if (!selectedAccountId || !keyUsageActive) {
      return;
    }
    const nextKeyId = resolveNextKeyUsageKeyId(effectiveManagedKeys, keyUsageKeyId);
    if (!nextKeyId) {
      setKeyUsageKeyId("");
      return;
    }
    if (nextKeyId !== keyUsageKeyId) {
      setKeyUsageKeyId(nextKeyId);
      return;
    }
    const key = buildUsageKeyDailyScopeKey({ accountId: selectedAccountId, keyId: nextKeyId, days: KEY_USAGE_DAYS });
    if (keyUsageCache.peek(key).hasSnapshot || keyUsagePendingRequestRef.current?.scopeKey === key) {
      return;
    }
    void loadKeyUsage(nextKeyId, false, { skipSync: analyticsLabActive });
  }, [analyticsLabActive, effectiveManagedKeys, keyUsageActive, keyUsageCache, keyUsageKeyId, selectedAccountId]);

  const usageRangeLabel = formatUsageRangeLabel(usageRangePreset, usageStartDate, usageEndDate);

  async function maybeSyncLatestUsageScope(options: {
    accountId: string;
    startDate: string;
    endDate: string;
    triggerSource: DataSyncTrigger;
    forceLatest?: boolean;
    suppressError?: boolean;
  }) {
    void options;
  }

  function beginBlockingUsageRequest() {
    setBlockingUsageRequestCount((count) => count + 1);
  }

  function endBlockingUsageRequest() {
    setBlockingUsageRequestCount((count) => Math.max(0, count - 1));
  }

  async function loadCurrentUsageScope(options: {
    mode: UsageRefreshMode;
    force?: boolean;
    pageSize?: number;
    surface?: UsageScopeSurface;
    keyId?: string;
    filter?: UsageFilter;
    cursorFrame?: UsageCursorFrame;
    startDate?: string;
    endDate?: string;
  }): Promise<UsageRefreshResult> {
    if (!selectedAccountId) {
      return "cancelled";
    }
    const surface = options.surface ?? currentSurface;
    const pageSize = options.pageSize ?? usagePageSize;
    const keyId = options.keyId ?? keyUsageKeyId;
    const usageFilter = options.filter ?? usageAppliedFilter;
    const cursorFrame = options.cursorFrame ?? usageCursorFrameRef.current;
    const startDate = surface === "usage"
      ? (usageFilter.startDate ?? usageStartDate) || toDateValue(new Date())
      : options.startDate || usageStartDate || toDateValue(new Date());
    const endDate = surface === "usage"
      ? (usageFilter.endDate ?? usageEndDate) || toDateValue(new Date())
      : options.endDate || usageEndDate || toDateValue(new Date());
    const filter = surface === "usage"
      ? usageFilter
      : buildAggregateUsageFilter(startDate, endDate, usageApiKeyFilter);
    if (surface === "keyUsage") {
      if (!keyId) {
        return "cancelled";
      }
      return await loadKeyUsage(keyId, false, {
        force: options.force,
        mode: options.mode,
        rethrow: true
      });
    }
    const scopeKey = buildUsageScopeKey({
      accountId: selectedAccountId,
      surface,
      filter,
      pageSize: surface === "usage" ? pageSize : undefined
    });
    const accountId = selectedAccountId;
    const previousSurfaceRequest = usageSurfaceRequestRef.current.get(surface);
    const surfaceRequest = {
      requestId: (previousSurfaceRequest?.requestId ?? 0) + 1,
      scopeKey
    };
    if (previousSurfaceRequest && previousSurfaceRequest.scopeKey !== scopeKey) {
      usageCache.cancel(previousSurfaceRequest.scopeKey);
    }
    usageSurfaceRequestRef.current.set(surface, surfaceRequest);
    const requestSequence = surface === "usage" ? ++usageRequestSequenceRef.current : null;
    if (surface === "usage" && options.filter) {
      usageScopeKeyRef.current = scopeKey;
    }
    const result = await usageCache.load(
      scopeKey,
      async () => await fetchUsageSnapshot({
        accountId,
        surface,
        startDate,
        endDate,
        pageSize,
        filter,
        cursorFrame
      }),
      { force: options.force }
    );
    const currentSurfaceRequest = usageSurfaceRequestRef.current.get(surface);
    const requestIsCurrent = selectedAccountIdRef.current === accountId
      && currentSurfaceRequest?.requestId === surfaceRequest.requestId
      && currentSurfaceRequest.scopeKey === scopeKey
      && (surface !== "usage"
        || (usageRequestSequenceRef.current === requestSequence && usageScopeKeyRef.current === scopeKey));
    if (result.status === "cancelled" || !requestIsCurrent) {
      return "cancelled";
    }
    if (result.status === "error") {
      if (options.mode === "foreground") {
        setError(result.error.message);
      }
      throw result.error;
    }
    if (options.mode === "foreground") {
      setError(null);
    }
    return "success";
  }

  async function fetchUsageSnapshot(input: {
    accountId: string;
    surface: UsageScopeSurface;
    startDate: string;
    endDate: string;
    pageSize: number;
    filter: UsageFilter;
    cursorFrame: UsageCursorFrame;
  }): Promise<UsageSnapshot> {
    if (input.surface === "modelStats") {
      const models = await getDashboardModels(
        input.accountId,
        input.filter
      ).catch(
        (cause) => optionalEndpointFallback<DashboardModelsPayload>(cause)
      );
      return {
        ...EMPTY_USAGE_SNAPSHOT,
        models,
        modelSummaries: summarizeDashboardModels(models)
      };
    }
    if (input.surface === "trends") {
      const analytics = await getUsageAnalytics(
        input.accountId,
        input.filter
      );
      const trend: UsageTrendPayload = {
        startDate: analytics.startDate,
        endDate: analytics.endDate,
        granularity: "day",
        trend: analytics.trend
      };
      const models: DashboardModelsPayload = {
        startDate: analytics.startDate,
        endDate: analytics.endDate,
        models: analytics.models.map((item) => ({
          model: item.label,
          requests: item.requests,
          inputTokens: item.inputTokens,
          outputTokens: item.outputTokens,
          cacheCreationTokens: item.cacheCreationTokens,
          cacheReadTokens: item.cacheReadTokens,
          totalTokens: item.totalTokens,
          cost: item.totalCost,
          actualCost: item.actualCost
        }))
      };
      return {
        ...EMPTY_USAGE_SNAPSHOT,
        stats: analytics.totals,
        trend,
        models,
        modelSummaries: summarizeDashboardModels(models),
        analytics
      };
    }
    const [stats, extremes, records, trend, models] = await Promise.all([
      getUsageStats(input.accountId, input.filter),
      getUsageExtremes(input.accountId, input.filter),
      fetchUsageRecordsPage(input.accountId, input.filter, input.pageSize, input.cursorFrame),
      getDashboardTrend(input.accountId, input.filter).catch(
        (cause) => optionalEndpointFallback<UsageTrendPayload>(cause)
      ),
      getDashboardModels(input.accountId, input.filter).catch(
        (cause) => optionalEndpointFallback<DashboardModelsPayload>(cause)
      )
    ]);
    return {
      ...EMPTY_USAGE_SNAPSHOT,
      records,
      stats: applyUsageRateFallback(stats, { startDate: input.startDate, endDate: input.endDate }),
      extremes,
      trend,
      models,
      modelSummaries: summarizeDashboardModels(models)
    };
  }

  async function fetchUsageRecordsPage(
    accountId: string,
    filter: UsageFilter,
    pageSize: number,
    cursorFrame: UsageCursorFrame
  ) {
    return await listUsageRecords(accountId, {
      filter,
      pageSize,
      cursor: cursorFrame.cursor,
      direction: cursorFrame.direction
    });
  }

  function resetUsageCursorHistory() {
    usageRequestSequenceRef.current += 1;
    usageCursorFrameRef.current = FIRST_USAGE_CURSOR_FRAME;
    setUsageCursorFrame(FIRST_USAGE_CURSOR_FRAME);
    setUsageCursorHistory([]);
  }

  function resetUsageCursorAndFacets() {
    resetUsageCursorHistory();
    usageFacetRequestRef.current.clear();
    setUsageFacetPages({});
    setUsageFacetLoadingFields([]);
  }

  function applyLegacyUsageFilterState(filter: UsageFilter) {
    setUsageApiKeyFilter(filter.apiKeyId === null || filter.apiKeyId === undefined ? "" : String(filter.apiKeyId));
  }

  async function loadUsageRecordsFrame(
    frame: UsageCursorFrame,
    pageSize: number,
    historyAction: "push" | "pop" | "reset"
  ) {
    if (!selectedAccountId) {
      return "cancelled" as const;
    }
    const accountId = selectedAccountId;
    const filter = usageAppliedFilter;
    const scopeKey = buildUsageScopeKey({
      accountId,
      surface: "usage",
      filter,
      pageSize
    });
    const requestSequence = ++usageRequestSequenceRef.current;
    const previousFrame = usageCursorFrameRef.current;
    const baseSnapshot = usageCache.peek(scopeKey).data ?? snapshot;
    usageScopeKeyRef.current = scopeKey;
    const result = await usageCache.load(
      scopeKey,
      async () => ({
        ...baseSnapshot,
        records: await fetchUsageRecordsPage(accountId, filter, pageSize, frame)
      }),
      { force: true }
    );
    const requestIsCurrent = selectedAccountIdRef.current === accountId
      && usageRequestSequenceRef.current === requestSequence
      && usageScopeKeyRef.current === scopeKey;
    if (result.status === "cancelled" || !requestIsCurrent) {
      return "cancelled" as const;
    }
    if (result.status === "error") {
      setError(result.error.message);
      throw result.error;
    }

    usageCursorFrameRef.current = frame;
    setUsageCursorFrame(frame);
    setUsageCursorHistory((history) => {
      if (historyAction === "push") {
        return [...history, previousFrame];
      }
      if (historyAction === "pop") {
        return history.slice(0, -1);
      }
      return [];
    });
    setError(null);
    return "success" as const;
  }

  async function loadUsageFacet(field: UsageFacetField, search = "", force = false) {
    if (!selectedAccountId) {
      return null;
    }
    if (!force && !search.trim() && usageFacetPages[field]) {
      return usageFacetPages[field] ?? null;
    }
    const accountId = selectedAccountId;
    const filter = usageAppliedFilter;
    const requestId = (usageFacetRequestRef.current.get(field) ?? 0) + 1;
    usageFacetRequestRef.current.set(field, requestId);
    setUsageFacetLoadingFields((fields) => fields.includes(field) ? fields : [...fields, field]);
    try {
      const page = await listUsageFacets(accountId, {
        filter,
        field,
        search: search.trim() || null,
        limit: 50
      });
      const requestIsCurrent = selectedAccountIdRef.current === accountId
        && usageFacetRequestRef.current.get(field) === requestId
        && usageScopeKeyRef.current === buildUsageScopeKey({
          accountId,
          surface: "usage",
          filter,
          pageSize: usagePageSize
        });
      if (!requestIsCurrent) {
        return null;
      }
      setUsageFacetPages((pages) => ({ ...pages, [field]: page }));
      return page;
    } catch (cause) {
      if (selectedAccountIdRef.current === accountId && usageFacetRequestRef.current.get(field) === requestId) {
        setError((cause as Error).message);
      }
      return null;
    } finally {
      if (usageFacetRequestRef.current.get(field) === requestId) {
        setUsageFacetLoadingFields((fields) => fields.filter((item) => item !== field));
      }
    }
  }

  async function handleUsageFilterReset() {
    if (!selectedAccountId) {
      return;
    }
    const draft = createEmptyUsageFilterDraft();
    const filter = buildUsageFilterFromDraft(draft, usageStartDate, usageEndDate);
    setUsageFilterDraft(draft);
    setUsageAppliedFilter(filter);
    applyLegacyUsageFilterState(filter);
    resetUsageCursorAndFacets();
    beginBlockingUsageRequest();
    setBusyText("正在重置用量筛选...");
    setError(null);
    try {
      await loadCurrentUsageScope({
        mode: "foreground",
        force: true,
        filter,
        cursorFrame: FIRST_USAGE_CURSOR_FRAME
      });
    } catch {
      // loadCurrentUsageScope 已写入当前请求错误。
    } finally {
      setBusyText(null);
      endBlockingUsageRequest();
    }
  }

  async function handleUsageSearch() {
    if (!selectedAccountId) {
      return;
    }
    if (currentSurface !== "usage") {
      beginBlockingUsageRequest();
      setBusyText("正在刷新用量聚合...");
      setError(null);
      try {
        await loadCurrentUsageScope({
          mode: "foreground",
          force: true,
          surface: currentSurface,
          startDate: usageStartDate,
          endDate: usageEndDate
        });
      } catch {
        // loadCurrentUsageScope 已将当前请求错误写入可见状态。
      } finally {
        setBusyText(null);
        endBlockingUsageRequest();
      }
      return;
    }
    let filter: UsageFilter;
    try {
      filter = buildUsageFilterFromDraft(usageFilterDraft, usageStartDate, usageEndDate);
    } catch (cause) {
      setError((cause as Error).message);
      return;
    }
    resetUsageCursorAndFacets();
    setUsageAppliedFilter(filter);
    applyLegacyUsageFilterState(filter);
    beginBlockingUsageRequest();
    setBusyText("正在刷新用量明细...");
    setError(null);
    try {
      await loadCurrentUsageScope({
        mode: "foreground",
        force: true,
        filter,
        cursorFrame: FIRST_USAGE_CURSOR_FRAME
      });
    } catch {
      // loadCurrentUsageScope 已将当前请求错误写入可见状态。
    } finally {
      setBusyText(null);
      endBlockingUsageRequest();
    }
  }

  async function handleUsageNextPage() {
    const cursor = snapshot.records?.nextCursor;
    if (!selectedAccountId || !snapshot.records?.hasNext || !cursor) {
      return;
    }
    beginBlockingUsageRequest();
    setBusyText("正在加载下一页用量记录...");
    setError(null);
    try {
      await loadUsageRecordsFrame(
        { cursor, direction: "next" },
        usagePageSize,
        "push"
      );
    } catch {
      // loadUsageRecordsFrame 保留当前页并写入可见错误。
    } finally {
      setBusyText(null);
      endBlockingUsageRequest();
    }
  }

  async function handleUsagePreviousPage() {
    const cursor = snapshot.records?.previousCursor;
    if (!selectedAccountId || !snapshot.records?.hasPrevious || !cursor) {
      return;
    }
    beginBlockingUsageRequest();
    setBusyText("正在加载上一页用量记录...");
    setError(null);
    try {
      await loadUsageRecordsFrame(
        { cursor, direction: "previous" },
        usagePageSize,
        "pop"
      );
    } catch {
      // loadUsageRecordsFrame 保留当前页并写入可见错误。
    } finally {
      setBusyText(null);
      endBlockingUsageRequest();
    }
  }

  async function handleUsagePageSizeChange(nextPageSize: number) {
    if (!selectedAccountId) {
      return;
    }
    const safePageSize = normalizeUsagePageSize(nextPageSize);
    if (safePageSize === usagePageSize) {
      return;
    }
    setUsagePageSize(safePageSize);
    resetUsageCursorHistory();
    beginBlockingUsageRequest();
    setBusyText(`正在切换为每页 ${safePageSize} 条...`);
    setError(null);
    try {
      await loadUsageRecordsFrame(FIRST_USAGE_CURSOR_FRAME, safePageSize, "reset");
    } catch {
      // 切换失败时保留原页数据，错误由 workspace 展示。
    } finally {
      setBusyText(null);
      endBlockingUsageRequest();
    }
  }

  function toggleUsageRangePicker() {
    if (usageRangePickerOpen) {
      setUsageRangePickerOpen(false);
      return;
    }
    setUsageDraftRange({ startDate: usageStartDate, endDate: usageEndDate });
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
    let filter = usageAppliedFilter;
    if (currentSurface === "usage") {
      try {
        filter = buildUsageFilterFromDraft(usageFilterDraft, nextStart, nextEnd);
      } catch (cause) {
        setError((cause as Error).message);
        return;
      }
    }
    setUsageStartDate(nextStart);
    setUsageEndDate(nextEnd);
    if (currentSurface === "usage") {
      resetUsageCursorAndFacets();
      setUsageAppliedFilter(filter);
      applyLegacyUsageFilterState(filter);
    }
    setUsageRangePickerOpen(false);
    beginBlockingUsageRequest();
    setBusyText("正在应用时间范围...");
    setError(null);
    try {
      await loadCurrentUsageScope({
        mode: "foreground",
        force: false,
        filter,
        cursorFrame: FIRST_USAGE_CURSOR_FRAME,
        startDate: nextStart,
        endDate: nextEnd
      });
    } catch {
      // loadCurrentUsageScope 已写入当前范围的可见错误。
    } finally {
      setBusyText(null);
      endBlockingUsageRequest();
    }
  }

  async function loadKeyUsage(
    keyId: string,
    announce = true,
    options?: {
      skipSync?: boolean;
      force?: boolean;
      mode?: UsageRefreshMode;
      rethrow?: boolean;
    }
  ): Promise<UsageRefreshResult> {
    if (!selectedAccountId || !keyId) {
      return "cancelled";
    }
    const accountId = selectedAccountId;
    const scopeKey = buildUsageKeyDailyScopeKey({ accountId, keyId, days: KEY_USAGE_DAYS });
    setKeyUsageKeyId(keyId);
    keyUsagePendingRequestRef.current = { keyId, scopeKey };
    if (announce) {
      setBusyText("正在加载单 Key 用量...");
      setError(null);
    }
    try {
      if (!options?.skipSync) {
        await maybeSyncLatestUsageScope({
          accountId,
          startDate: effectiveStart,
          endDate: effectiveEnd,
          triggerSource: announce ? "manual" : "stale_auto",
          forceLatest: true,
          suppressError: !announce
        });
      }
      const result = await keyUsageCache.load(scopeKey, () => getApiKeyDailyUsage(accountId, keyId, KEY_USAGE_DAYS), {
        force: options?.force ?? announce
      });
      if (result.status === "cancelled" || selectedAccountIdRef.current !== accountId) {
        return "cancelled";
      }
      if (result.status === "error") {
        throw result.error;
      }
      if ((options?.mode ?? (announce ? "foreground" : "background")) === "foreground") {
        setError(null);
      }
      return "success";
    } catch (cause) {
      const foreground = (options?.mode ?? (announce ? "foreground" : "background")) === "foreground";
      if (selectedAccountIdRef.current === accountId && foreground) {
        setError((cause as Error).message);
      }
      if (options?.rethrow) {
        throw cause;
      }
      return "cancelled";
    } finally {
      if (keyUsagePendingRequestRef.current?.scopeKey === scopeKey) {
        keyUsagePendingRequestRef.current = null;
      }
      if (announce) {
        setBusyText(null);
      }
    }
  }

  async function refreshUsageSurfaceSilently(
    surface: UsageSurfaceKey,
    options?: {
      forceFullUsageSurface?: boolean;
      mode?: UsageRefreshMode;
    }
  ): Promise<UsageRefreshResult> {
    if (!selectedAccountId || blockingUsageRequestCount > 0) {
      return "cancelled";
    }
    const mode = options?.mode ?? "background";
    try {
      if (surface === "usage" && nav === "overview" && !options?.forceFullUsageSurface) {
        const accountId = selectedAccountId;
        const today = toDateValue(new Date());
        const scopeKey = buildUsageScopeKey({
          accountId,
          surface: "overview"
        });
        const result = await usageCache.load(
          scopeKey,
          async () => ({
            ...EMPTY_USAGE_SNAPSHOT,
            stats: applyUsageRateFallback(
              await getUsageStats(accountId, { startDate: today, endDate: today }),
              { startDate: today, endDate: today }
            )
          }),
          { force: true }
        );
        if (result.status === "error") {
          throw result.error;
        }
        return result.status === "success" && selectedAccountIdRef.current === accountId
          ? "success"
          : "cancelled";
      }
      const explicitSurface: UsageScopeSurface = surface;
      const result = await loadCurrentUsageScope({
        mode,
        force: true,
        surface: explicitSurface,
        pageSize: explicitSurface === "usage" ? usagePageSize : undefined,
        filter: explicitSurface === "usage" ? usageAppliedFilter : undefined,
        cursorFrame: explicitSurface === "usage" ? usageCursorFrameRef.current : undefined
      });
      return result;
    } catch (cause) {
      if (mode === "foreground") {
        setError((cause as Error).message);
      }
      throw cause;
    }
  }

  async function preloadUsageSurface(surface: UsagePreloadSurface): Promise<UsageRefreshResult> {
    if (!selectedAccountId || blockingUsageRequestCount > 0) {
      return "cancelled";
    }

    const startDate = usageStartDate || toDateValue(new Date());
    const endDate = usageEndDate || toDateValue(new Date());
    const filter = surface === "usage"
      ? usageAppliedFilter
      : buildAggregateUsageFilter(startDate, endDate, usageApiKeyFilter);
    const scopeKey = buildUsageScopeKey({
      accountId: selectedAccountId,
      surface,
      filter,
      pageSize: surface === "usage" ? usagePageSize : undefined
    });

    if (usageCache.peek(scopeKey).hasSnapshot) {
      return "success";
    }

    return await loadCurrentUsageScope({
      mode: "background",
      force: false,
      surface,
      pageSize: surface === "usage" ? usagePageSize : undefined,
      filter: surface === "usage" ? usageAppliedFilter : undefined,
      cursorFrame: surface === "usage" ? usageCursorFrameRef.current : undefined
    });
  }

  async function refreshUsageWorkspaceSilently(options?: { mode?: UsageRefreshMode }) {
    const surface: UsageSurfaceKey = currentSurface === "modelStats"
      ? "modelStats"
      : currentSurface === "trends"
          ? "trends"
          : "usage";
    return await refreshUsageSurfaceSilently(surface, options);
  }

  function invalidateAccount(accountId: string) {
    usageCache.invalidateWhere((key) => usageScopeReferencesAccount(key, accountId));
    keyUsageCache.invalidateWhere((key) => usageScopeReferencesAccount(key, accountId));
    if (selectedAccountIdRef.current === accountId) {
      keyUsagePendingRequestRef.current = null;
      resetUsageCursorAndFacets();
      setBlockingUsageRequestCount(0);
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
    usageFilterDraft,
    setUsageFilterDraft,
    usageAppliedFilter,
    usageFacetPages,
    usageFacetLoadingFields,
    loadUsageFacet,
    handleUsageFilterReset,
    usageStats: snapshot.stats,
    usageExtremes: snapshot.extremes,
    usageModelSummaries: snapshot.modelSummaries,
    usageModelSummariesLoading,
    usageModelSummariesInitialLoading,
    usageRecords: snapshot.records,
    usageAnalytics: snapshot.analytics,
    usagePageSize,
    usagePageSizeOptions: [...USAGE_PAGE_SIZE_OPTIONS],
    handleUsageSearch,
    handleUsagePreviousPage,
    handleUsageNextPage,
    handleUsagePageSizeChange,
    usageCursorDepth: usageCursorHistory.length,
    usageTrend: snapshot.trend,
    usageModels: snapshot.models,
    keyUsageRows: keyUsageEntry?.data ?? [],
    keyUsageKeyId,
    presentation,
    loadKeyUsage,
    invalidateAccount,
    refreshUsageWorkspaceSilently,
    refreshUsageSurfaceSilently,
    preloadUsageSurface,
    usageStartDate,
    setUsageStartDate,
    usageEndDate,
    setUsageEndDate
  };
}

function resolveUsageSurface(nav: NavKey): UsageScopeSurface {
  if (nav === "modelStats") {
    return "modelStats";
  }
  if (nav === "trends") {
    return "trends";
  }
  if (nav === "overview") {
    return "overview";
  }
  return "usage";
}

function buildAggregateUsageFilter(
  startDate: string,
  endDate: string,
  apiKeyFilter: string
): UsageFilter {
  const normalizedApiKey = apiKeyFilter.trim();
  const apiKeyId = normalizedApiKey ? Number(normalizedApiKey) : undefined;
  return {
    startDate,
    endDate,
    ...(Number.isSafeInteger(apiKeyId) && (apiKeyId ?? -1) >= 0 ? { apiKeyId } : {})
  };
}

function optionalEndpointFallback<T>(cause: unknown): T | null {
  if (isOptionalEndpointUnavailable(cause)) {
    return null;
  }
  throw cause;
}

function isOptionalEndpointUnavailable(cause: unknown) {
  const message = (cause as Error)?.message ?? "";
  return message.includes("未找到可用的接口路径") || message.includes("404");
}

function applyUsageRateFallback(
  stats: UsageStatsRecord,
  _query: {
    period?: string | null;
    startDate?: string | null;
    endDate?: string | null;
  }
) {
  return stats;
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

function resolveNextKeyUsageKeyId(keys: ManagedKeyRecord[], currentKeyId: string) {
  return keys.find((item) => item.id === currentKeyId)?.id ?? pickDefaultKeyUsageKeyId(keys);
}

function coerceManagedKeyRecord(key: KeyRecord): ManagedKeyRecord {
  return {
    ...key,
    apiKeyId: key.id ? Number(key.id) : null
  };
}

function normalizeUsagePageSize(value: number) {
  return USAGE_PAGE_SIZE_OPTIONS.includes(value as (typeof USAGE_PAGE_SIZE_OPTIONS)[number])
    ? value
    : DEFAULT_USAGE_PAGE_SIZE;
}
