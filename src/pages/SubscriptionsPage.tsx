import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ManagedKeyRecord,
  SubscriptionKeyUsageItem,
  SubscriptionKeyUsagePayload,
  SubscriptionQuotaAlertConfig,
  SubscriptionQuotaAlertRule,
  SubscriptionQuotaAlertSettingsPayload,
  SubscriptionRecord,
  SubscriptionSummaryPayload
} from "../types";
import {
  formatDateTimeFull,
  formatPercent,
  formatRemainingDaysLabel,
  formatTime,
  formatUsd
} from "../shared/lib/formatters";
import { EmptyState } from "../shared/ui/EmptyState";
import { Modal } from "../shared/ui/Modal";
import { SectionCard } from "../shared/ui/SectionCard";
import { TitleHint } from "../shared/ui/TitleHint";
import { useMonitorStore } from "../shared/state/monitor-store";
import { SubscriptionList } from "../features/subscriptions/components/SubscriptionList";
import { SubscriptionQuotaAlertEditor } from "../features/subscriptions/components/SubscriptionQuotaAlertEditor";
import {
  DEFAULT_SUBSCRIPTION_QUOTA_ALERT_RULE,
  resolveEffectiveSubscriptionQuotaAlertRule
} from "../features/subscriptions/quota-alert-config";
import { getSubscriptionKeyUsage } from "../features/usage/client";
import "../features/subscriptions/components/SubscriptionsPage.css";
import {
  buildSubscriptionDetailRecords,
  buildSubscriptionUsageInsights,
  getSubscriptionQuotaProgressMeta,
  getSubscriptionStatusPresentation,
  mergeSubscriptionRecords,
  type SubscriptionDetailRecord
} from "../subscription-view";

const SUBSCRIPTION_USAGE_RANGE_PRESETS = [
  { key: "today", label: "今天" },
  { key: "last7Days", label: "近 7 天" },
  { key: "last30Days", label: "近 30 天" },
  { key: "thisMonth", label: "本月" },
  { key: "custom", label: "自定义" }
] as const;

export function SubscriptionsPage({
  subscriptions,
  subscriptionSummary,
  subscriptionQuotaAlerts,
  selectedAccountId,
  managedKeys,
  onRefreshSubscriptionQuotaAlerts
}: {
  subscriptions: SubscriptionRecord[];
  subscriptionSummary: SubscriptionSummaryPayload | null;
  subscriptionQuotaAlerts?: SubscriptionQuotaAlertSettingsPayload | null;
  selectedAccountId: string | null;
  managedKeys: ManagedKeyRecord[];
  onRefreshSubscriptionQuotaAlerts?: (
    saved: SubscriptionQuotaAlertConfig,
    accountId: string
  ) => Promise<unknown> | unknown;
}) {
  const summary = subscriptionSummary;
  const mergedSubscriptions = useMemo(
    () => mergeSubscriptionRecords(subscriptions, summary),
    [summary, subscriptions]
  );
  const subscriptionUsageInsights = buildSubscriptionUsageInsights({
    summary,
    cacheViewSubscriptions: subscriptions
  });
  const detailRecords = useMemo(
    () =>
      buildSubscriptionDetailRecords({
        summary,
        cacheViewSubscriptions: subscriptions
      }),
    [summary, subscriptions]
  );
  const [selectedSubscriptionIdentity, setSelectedSubscriptionIdentity] = useState<{
    accountId: string | null;
    id: string;
    subscriptionKey: string;
  } | null>(null);
  const selectedDetailRecord = selectedSubscriptionIdentity?.accountId === selectedAccountId
    ? detailRecords.find((item) =>
        item.id === selectedSubscriptionIdentity.id
        && item.subscriptionKey === selectedSubscriptionIdentity.subscriptionKey
      ) ?? null
    : null;

  useEffect(() => {
    setSelectedSubscriptionIdentity(null);
  }, [selectedAccountId]);

  return (
    <section className="stack-list subscriptions-page-layout">
      <SectionCard title="订阅摘要" subtitle="快速查看当前订阅的使用情况和到期时间">
        {summary ? (
          <div className="stack-list">
            <p className="quota-hint subscription-summary-lead">
              这里会集中展示订阅金额、每日/每周/每月额度、状态和到期时间, 方便快速判断还剩多少可用空间。
            </p>
            <div className="subscription-summary-grid">
              <div className="summary-stat">
                <span>活跃订阅数</span>
                <strong>{summary.activeCount}</strong>
              </div>
              <div className="summary-stat">
                <span>累计已用金额</span>
                <strong>{formatUsd(summary.totalUsedUsd, 4)}</strong>
              </div>
              <div className="summary-stat">
                <span>日额度总量</span>
                <strong>{formatUsd(sum(subscriptionUsageInsights.rows.map((item) => item.dailyLimitUsd)), 2)}</strong>
              </div>
              <div className="summary-stat">
                <span>日已用总量</span>
                <strong>{formatUsd(sum(subscriptionUsageInsights.rows.map((item) => item.dailyUsedUsd)), 2)}</strong>
              </div>
              <div className="summary-stat">
                <span>日额度总占用</span>
                <strong>{formatPercent(computePercent(
                  sum(subscriptionUsageInsights.rows.map((item) => item.dailyUsedUsd)),
                  sum(subscriptionUsageInsights.rows.map((item) => item.dailyLimitUsd))
                ))}</strong>
              </div>
              <div className="summary-stat">
                <span>最近到期</span>
                <strong>{resolveNearestExpiryLabel(subscriptionUsageInsights.rows)}</strong>
              </div>
            </div>
          </div>
        ) : (
          <EmptyState title="当前没有订阅摘要" detail="刷新账号后, 这里会显示订阅的使用概况。" compact />
        )}
      </SectionCard>
      <section className="content-grid subscriptions-content-grid">
        <SectionCard title="订阅列表" subtitle="查看每个订阅的额度、状态和剩余时间">
          {mergedSubscriptions.length > 0 ? (
            <div className="stack-list">
              <p className="quota-hint subscription-detail-trigger-hint">
                点击任意订阅卡片, 查看这个订阅更详细的额度和到期信息。
              </p>
              <SubscriptionList
                subscriptions={mergedSubscriptions}
                quotaAlertSettings={subscriptionQuotaAlerts}
                selectedSubscriptionId={selectedDetailRecord?.id ?? null}
                onSelectSubscription={(subscription) => {
                  setSelectedSubscriptionIdentity({
                    accountId: selectedAccountId,
                    id: subscription.id,
                    subscriptionKey: subscription.subscriptionKey
                  });
                }}
              />
            </div>
          ) : (
            <EmptyState title="当前没有订阅数据" detail="先登录并刷新当前账号。" compact />
          )}
        </SectionCard>
      </section>
      {selectedDetailRecord && (
        <SubscriptionDetailModal
          record={selectedDetailRecord}
          selectedAccountId={selectedAccountId}
          managedKeys={managedKeys}
          quotaAlertRule={resolveEffectiveSubscriptionQuotaAlertRule(
            subscriptionQuotaAlerts,
            selectedDetailRecord.subscriptionKey
          )}
          onQuotaAlertSaved={onRefreshSubscriptionQuotaAlerts}
          onClose={() => setSelectedSubscriptionIdentity(null)}
        />
      )}
    </section>
  );
}

function sum(values: number[]) {
  return values.reduce((accumulator, value) => accumulator + value, 0);
}

function computePercent(used: number, limit: number) {
  if (!Number.isFinite(limit) || limit <= 0) {
    return null;
  }
  return (used / limit) * 100;
}

function resolveNearestExpiryLabel(
  rows: Array<{ expiresAt: string | null }>
) {
  const values = rows
    .map((item) => item.expiresAt)
    .filter((value): value is string => Boolean(value))
    .map((value) => ({ raw: value, time: new Date(value).getTime() }))
    .filter((item) => !Number.isNaN(item.time))
    .sort((left, right) => left.time - right.time);

  if (values.length === 0) {
    return "暂无到期时间";
  }

  return formatRemainingDaysLabel(values[0].raw);
}

export function SubscriptionDetailModal({
  record,
  selectedAccountId,
  managedKeys,
  quotaAlertRule = DEFAULT_SUBSCRIPTION_QUOTA_ALERT_RULE,
  onQuotaAlertSaved,
  onClose
}: {
  record: SubscriptionDetailRecord;
  selectedAccountId: string | null;
  managedKeys: ManagedKeyRecord[];
  quotaAlertRule?: SubscriptionQuotaAlertRule;
  onQuotaAlertSaved?: (
    saved: SubscriptionQuotaAlertConfig,
    accountId: string
  ) => Promise<unknown> | unknown;
  onClose: () => void;
}) {
  const pushToast = useMonitorStore((state) => state.pushToast);
  const statusPresentation = getSubscriptionStatusPresentation(record.status);
  const [keyUsageLoading, setKeyUsageLoading] = useState(false);
  const [keyUsageRefreshing, setKeyUsageRefreshing] = useState(false);
  const [keyUsageError, setKeyUsageError] = useState<string | null>(null);
  const [keyUsagePayload, setKeyUsagePayload] = useState<SubscriptionKeyUsagePayload | null>(null);
  const [keyUsageSearch, setKeyUsageSearch] = useState("");
  const [keyUsageStatusFilter, setKeyUsageStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [keyUsageSort, setKeyUsageSort] = useState<"cost" | "requests" | "tokens">("cost");
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const lastLoadedSubscriptionIdentityRef = useRef<string | null>(null);
  const keyUsagePayloadRef = useRef<SubscriptionKeyUsagePayload | null>(null);
  const [keyUsageRangePreset, setKeyUsageRangePreset] = useState<(typeof SUBSCRIPTION_USAGE_RANGE_PRESETS)[number]["key"]>("today");
  const [keyUsageStartDate, setKeyUsageStartDate] = useState(() => buildSubscriptionUsagePresetRange("today").startDate);
  const [keyUsageEndDate, setKeyUsageEndDate] = useState(() => buildSubscriptionUsagePresetRange("today").endDate);
  const [keyUsageDraftRange, setKeyUsageDraftRange] = useState(() => buildSubscriptionUsagePresetRange("today"));

  const relatedKeys = useMemo(
    () =>
      managedKeys.filter((item) => {
        if (typeof record.sourceGroupId === "number" && item.groupId === record.sourceGroupId) {
          return true;
        }
        const normalizedSubscriptionGroup = (record.groupName ?? "").trim().toLowerCase();
        const normalizedKeyGroup = (item.groupName ?? "").trim().toLowerCase();
        return normalizedSubscriptionGroup.length > 0 && normalizedSubscriptionGroup === normalizedKeyGroup;
      }),
    [managedKeys, record.groupName, record.sourceGroupId]
  );
  const relatedKeyIdsSignature = useMemo(
    () =>
      relatedKeys
        .map((item) => item.id)
        .sort((left, right) => left.localeCompare(right))
        .join("|"),
    [relatedKeys]
  );
  const keyUsageScopeIdentity = useMemo(
    () => buildSubscriptionKeyUsageScopeKey({
      accountId: selectedAccountId,
      subscriptionId: record.id,
      subscriptionKey: record.subscriptionKey,
      relatedKeyIdsSignature,
      startDate: keyUsageStartDate,
      endDate: keyUsageEndDate
    }),
    [
      keyUsageEndDate,
      keyUsageStartDate,
      record.id,
      record.subscriptionKey,
      relatedKeyIdsSignature,
      selectedAccountId
    ]
  );
  const keyUsageRangeLabel = useMemo(
    () => `${keyUsageStartDate} - ${keyUsageEndDate}`,
    [keyUsageEndDate, keyUsageStartDate]
  );

  useEffect(() => {
    keyUsagePayloadRef.current = keyUsagePayload;
  }, [keyUsagePayload]);

  useEffect(() => {
    const nextRange = buildSubscriptionUsagePresetRange("today");
    setKeyUsageRangePreset("today");
    setKeyUsageStartDate(nextRange.startDate);
    setKeyUsageEndDate(nextRange.endDate);
    setKeyUsageDraftRange(nextRange);
  }, [record.id]);

  useEffect(() => {
    if (!selectedAccountId) {
      setKeyUsagePayload(null);
      setKeyUsageError("当前未选中账号，无法加载关联 Key 用量。");
      setKeyUsageLoading(false);
      setKeyUsageRefreshing(false);
      lastLoadedSubscriptionIdentityRef.current = null;
      return;
    }
    if (relatedKeys.length === 0) {
      setKeyUsagePayload({
        items: [],
        totalRequests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        totalActualCost: 0,
        activeKeyCount: 0,
        inactiveKeyCount: 0
      });
      setKeyUsageError(null);
      setKeyUsageLoading(false);
      setKeyUsageRefreshing(false);
      lastLoadedSubscriptionIdentityRef.current = keyUsageScopeIdentity;
      return;
    }

    const isSameScope = lastLoadedSubscriptionIdentityRef.current === keyUsageScopeIdentity;
    let cancelled = false;
    if (isSameScope && keyUsagePayloadRef.current) {
      setKeyUsageRefreshing(true);
    } else {
      setKeyUsagePayload(null);
      setKeyUsageError(null);
      setKeyUsageLoading(true);
      setKeyUsageRefreshing(false);
    }
    void getSubscriptionKeyUsage(
      selectedAccountId,
      relatedKeys.map((item) => item.id),
      {
        startDate: keyUsageStartDate,
        endDate: keyUsageEndDate
      }
    )
      .then((payload) => {
        if (!cancelled) {
          const mergedItems = mergeSubscriptionKeyUsageItems(payload.items, relatedKeys);
          setKeyUsagePayload({
            ...payload,
            items: mergedItems
          });
          setKeyUsageError(null);
          lastLoadedSubscriptionIdentityRef.current = keyUsageScopeIdentity;
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          if (!isSameScope || !keyUsagePayloadRef.current) {
            setKeyUsagePayload(null);
            setKeyUsageError((cause as Error).message);
          }
        }
      })
      .finally(() => {
        if (!cancelled) {
          setKeyUsageLoading(false);
          setKeyUsageRefreshing(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [keyUsageScopeIdentity, relatedKeyIdsSignature, relatedKeys, selectedAccountId]);

  const filteredKeyUsageItems = useMemo(() => {
    const search = keyUsageSearch.trim().toLowerCase();
    const items = keyUsagePayload?.items ?? [];
    const next = items
      .filter((item) => {
        const matchesSearch =
          search.length === 0 ||
          item.keyName.toLowerCase().includes(search) ||
          item.keyId.toLowerCase().includes(search);
        const matchesStatus = keyUsageStatusFilter === "all" || item.status === keyUsageStatusFilter;
        return matchesSearch && matchesStatus;
      })
      .sort((left, right) => {
        if (keyUsageSort === "requests") {
          return right.requests - left.requests;
        }
        if (keyUsageSort === "tokens") {
          return right.totalTokens - left.totalTokens;
        }
        return right.actualCost - left.actualCost;
      });
    return next;
  }, [keyUsagePayload?.items, keyUsageSearch, keyUsageSort, keyUsageStatusFilter]);
  useEffect(() => {
    if (filteredKeyUsageItems.length === 0) {
      setSelectedKeyId(null);
      return;
    }
    if (!selectedKeyId || !filteredKeyUsageItems.some((item) => item.keyId === selectedKeyId)) {
      setSelectedKeyId(filteredKeyUsageItems[0].keyId);
    }
  }, [filteredKeyUsageItems, selectedKeyId]);

  const selectedKeyUsageItem =
    filteredKeyUsageItems.find((item) => item.keyId === selectedKeyId) ??
    filteredKeyUsageItems[0] ??
    null;

  function applyKeyUsagePreset(preset: (typeof SUBSCRIPTION_USAGE_RANGE_PRESETS)[number]["key"]) {
    setKeyUsageRangePreset(preset);
    if (preset === "custom") {
      return;
    }
    const nextRange = buildSubscriptionUsagePresetRange(preset);
    setKeyUsageDraftRange(nextRange);
    setKeyUsageStartDate(nextRange.startDate);
    setKeyUsageEndDate(nextRange.endDate);
  }

function applyCustomKeyUsageRange() {
    const nextStart = keyUsageDraftRange.startDate || keyUsageStartDate;
    const nextEnd = keyUsageDraftRange.endDate || keyUsageEndDate;
    if (!nextStart || !nextEnd) {
      return;
    }
    if (nextStart > nextEnd) {
      return;
    }
    setKeyUsageRangePreset("custom");
    setKeyUsageStartDate(nextStart);
    setKeyUsageEndDate(nextEnd);
  }

  return (
    <Modal
      title={record.name}
      onClose={onClose}
      size="wide"
      closeText="关闭"
      className="subscription-detail-modal"
      bodyClassName="subscription-detail-modal-body"
    >
      <section className="subscription-detail-modal-hero">
        <div className="subscription-detail-modal-copy">
          <div className="subscription-detail-modal-title-row">
            <strong>{record.name}</strong>
            <span className={`status-pill ${statusPresentation.tone}`}>{statusPresentation.label}</span>
          </div>
          <p>{record.groupName && record.groupName !== record.name ? record.groupName : "查看这个订阅的详细情况"}</p>
        </div>
        <div className="subscription-detail-modal-meta">
          <div className="summary-stat compact-stat">
            <span>平台</span>
            <strong>{record.platform ?? "未知"}</strong>
          </div>
          <div className="summary-stat compact-stat">
            <span>剩余时间</span>
            <strong>{formatRemainingDaysLabel(record.expiresAt)}</strong>
          </div>
          <div className="summary-stat compact-stat">
            <span>到期时间</span>
            <strong>{record.expiresAt ? formatTime(record.expiresAt) : "无到期时间"}</strong>
          </div>
        </div>
      </section>
      <section className="subscription-detail-window-grid">
        <SubscriptionWindowCard
          title="每日额度"
          used={record.dailyUsedUsd}
          limit={record.dailyLimitUsd}
          windowStart={record.dailyWindowStart}
          expiresAt={record.expiresAt}
        />
        <SubscriptionWindowCard
          title="每周额度"
          used={record.weeklyUsedUsd}
          limit={record.weeklyLimitUsd}
          windowStart={record.weeklyWindowStart}
        />
        <SubscriptionWindowCard
          title="每月额度"
          used={record.monthlyUsedUsd}
          limit={record.monthlyLimitUsd}
          windowStart={record.monthlyWindowStart}
        />
      </section>
      <SubscriptionQuotaAlertEditor
        accountId={selectedAccountId}
        subscriptionKey={record.subscriptionKey ?? ""}
        identityAmbiguous={Boolean(record.identityAmbiguous)}
        rule={quotaAlertRule}
        onSaved={onQuotaAlertSaved}
        onSaveFeedback={pushToast}
      />
      <section className="section-card subscription-detail-key-usage">
        <header className="section-card-header">
          <div className="title-with-hint">
            <h3>当前 Key 用量</h3>
            <TitleHint
              content="展示当前选中的 Key 数据。下方列表支持筛选，点击任意 Key 可切换详情。"
              label="查看当前 Key 用量说明"
            />
          </div>
        </header>
        <div className="stack-list">
          <div className="subscription-key-usage-toolbar">
            <div className="subscription-key-selection-copy">
              <strong>{selectedKeyUsageItem?.keyName ?? "未选中 Key"}</strong>
              <span>
                {selectedKeyUsageItem
                  ? `${selectedKeyUsageItem.keyId} · ${selectedKeyUsageItem.status} · ${keyUsageRangeLabel}`
                  : `共 ${relatedKeys.length} 个关联 Key · ${keyUsageRangeLabel}`}
              </span>
            </div>
            <div className="subscription-key-usage-chip">
              {keyUsageRefreshing
                ? "后台刷新中..."
                : `已选 ${selectedKeyUsageItem ? 1 : 0} / 关联 Key ${relatedKeys.length}`}
            </div>
          </div>
          <div className="subscription-key-usage-range-shell">
            <div className="subscription-key-usage-range-presets">
              {SUBSCRIPTION_USAGE_RANGE_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  className={`subscription-key-usage-range-preset ${keyUsageRangePreset === preset.key ? "active" : ""}`}
                  onClick={() => applyKeyUsagePreset(preset.key)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="subscription-key-usage-range-fields">
              <label className="field">
                <span>开始日期</span>
                <input
                  type="date"
                  value={keyUsageDraftRange.startDate}
                  onChange={(event) =>
                    setKeyUsageDraftRange((prev) => ({ ...prev, startDate: event.target.value }))
                  }
                />
              </label>
              <label className="field">
                <span>结束日期</span>
                <input
                  type="date"
                  value={keyUsageDraftRange.endDate}
                  onChange={(event) =>
                    setKeyUsageDraftRange((prev) => ({ ...prev, endDate: event.target.value }))
                  }
                />
              </label>
              <button type="button" className="primary-button" onClick={applyCustomKeyUsageRange}>
                应用范围
              </button>
            </div>
          </div>
          <div className="subscription-key-usage-summary-grid">
            <div className="summary-stat compact-stat">
              <span>当前 Key</span>
              <strong>{selectedKeyUsageItem?.keyName ?? "--"}</strong>
            </div>
            <div className="summary-stat compact-stat">
              <span>请求数</span>
              <strong>{selectedKeyUsageItem ? selectedKeyUsageItem.requests.toLocaleString() : "--"}</strong>
            </div>
            <div className="summary-stat compact-stat">
              <span>总 Tokens</span>
              <strong>{selectedKeyUsageItem ? formatLargeNumber(selectedKeyUsageItem.totalTokens) : "--"}</strong>
            </div>
            <div className="summary-stat compact-stat">
              <span>总实际消耗</span>
              <strong>{selectedKeyUsageItem ? formatUsd(selectedKeyUsageItem.actualCost, 4) : "--"}</strong>
            </div>
            <div className="summary-stat compact-stat">
              <span>Input Tokens</span>
              <strong>{selectedKeyUsageItem ? formatLargeNumber(selectedKeyUsageItem.inputTokens) : "--"}</strong>
            </div>
            <div className="summary-stat compact-stat">
              <span>Output Tokens</span>
              <strong>{selectedKeyUsageItem ? formatLargeNumber(selectedKeyUsageItem.outputTokens) : "--"}</strong>
            </div>
          </div>
          {keyUsagePayload && keyUsagePayload.items.some((item) => !item.rawKeyAvailable) && (
            <p className="quota-hint">
              部分 Key 未返回原始密钥，无法按真实 `Bearer sk-...` 查询 `/v1/usage`，这些行会显示为 0 或空值。
            </p>
          )}
          <div className="subscription-key-usage-filters">
            <input
              value={keyUsageSearch}
              onChange={(event) => setKeyUsageSearch(event.target.value)}
              className="input"
              placeholder="搜索 Key 名称或 ID"
            />
            <select
              value={keyUsageStatusFilter}
              onChange={(event) => setKeyUsageStatusFilter(event.target.value as "all" | "active" | "inactive")}
              className="input"
            >
              <option value="all">全部状态</option>
              <option value="active">仅 active</option>
              <option value="inactive">仅 inactive</option>
            </select>
            <select
              value={keyUsageSort}
              onChange={(event) => setKeyUsageSort(event.target.value as "cost" | "requests" | "tokens")}
              className="input"
            >
              <option value="cost">按消耗排序</option>
              <option value="requests">按请求数排序</option>
              <option value="tokens">按 Tokens 排序</option>
            </select>
          </div>
          {keyUsageLoading && !keyUsagePayload ? (
            <p className="quota-hint">正在加载关联 Key 的完整用量...</p>
          ) : keyUsageError && !keyUsagePayload ? (
            <EmptyState title="关联 Key 用量加载失败" detail={keyUsageError} compact />
          ) : filteredKeyUsageItems.length === 0 ? (
            <EmptyState title="当前没有关联 Key 用量数据" detail="该订阅下暂未匹配到 Key，或筛选条件过滤为空。" compact />
          ) : (
            <div className="subscription-key-usage-table-wrap">
              <table className="subscription-key-usage-table">
                <thead>
                  <tr>
                    <th>Key 名称</th>
                    <th>状态</th>
                    <th>请求数</th>
                    <th>Input Tokens</th>
                    <th>Output Tokens</th>
                    <th>Total Tokens</th>
                    <th>实际消耗</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredKeyUsageItems.map((item) => (
                    <tr
                      key={item.keyId}
                      className={selectedKeyUsageItem?.keyId === item.keyId ? "selected" : undefined}
                      onClick={() => setSelectedKeyId(item.keyId)}
                    >
                      <td>
                        <div className="subscription-key-name-cell">
                          <strong>{item.keyName}</strong>
                          <span>{item.keyId}</span>
                        </div>
                      </td>
                      <td>
                        <span className={`status-pill ${item.status === "active" ? "ready" : "neutral"}`}>
                          {item.status}
                        </span>
                      </td>
                      <td>{item.requests.toLocaleString()}</td>
                      <td>{formatLargeNumber(item.inputTokens)}</td>
                      <td>{formatLargeNumber(item.outputTokens)}</td>
                      <td>{formatLargeNumber(item.totalTokens)}</td>
                      <td>{formatUsd(item.actualCost, 4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </Modal>
  );
}

function SubscriptionWindowCard({
  title,
  used,
  limit,
  windowStart,
  expiresAt
}: {
  title: string;
  used: number;
  limit: number | null;
  windowStart: string | null;
  expiresAt?: string | null;
}) {
  const hasLimit = Number.isFinite(limit) && Number(limit) > 0;
  const progressMeta = hasLimit ? getSubscriptionQuotaProgressMeta(used, limit) : null;
  const remaining = hasLimit ? Math.max((limit ?? 0) - used, 0) : null;

  return (
    <article className="subscription-window-card">
      <div className="subscription-window-card-head">
        <div className="bar-label-copy">
          <span>{title}</span>
          {progressMeta && (
            <small className={`quota-progress-percent ${progressMeta.tone}`}>
              {formatPercent(progressMeta.rawPercent, 1)}
            </small>
          )}
        </div>
        <strong>{hasLimit ? `${formatUsd(used, 2)} / ${formatUsd(limit, 2)}` : formatUsd(used, 2)}</strong>
      </div>
      {progressMeta && (
        <div className={`bar-track ${progressMeta.tone}`}>
          <div className={`bar-fill ${progressMeta.tone}`} style={{ width: `${progressMeta.percent}%` }} />
        </div>
      )}
      <div className="subscription-window-metrics">
        <div className="summary-stat compact-stat">
          <span>已用</span>
          <strong>{formatUsd(used, 2)}</strong>
        </div>
        <div className="summary-stat compact-stat">
          <span>{hasLimit ? "剩余" : "额度"}</span>
          <strong>{hasLimit ? formatUsd(remaining, 2) : "未返回"}</strong>
        </div>
        <div className="summary-stat compact-stat">
          <span>统计起点</span>
          <strong>{windowStart ? formatDateTimeFull(windowStart) : "未返回"}</strong>
        </div>
      </div>
      {title === "每日额度" && expiresAt && (
        <p className="quota-hint">到期时间: {formatDateTimeFull(expiresAt)}</p>
      )}
    </article>
  );
}

function mergeSubscriptionKeyUsageItems(
  items: SubscriptionKeyUsageItem[],
  relatedKeys: ManagedKeyRecord[]
) {
  const statsByKeyId = new Map(items.map((item) => [item.keyId, item]));
  return relatedKeys.map((key) => {
    const stat = statsByKeyId.get(key.id);
    return {
      keyId: key.id,
      apiKeyId: key.apiKeyId ?? stat?.apiKeyId ?? null,
      rawKeyAvailable: stat?.rawKeyAvailable ?? Boolean(key.rawKey?.trim()),
      keyName: key.name,
      status: key.status,
      platform: key.platform ?? stat?.platform ?? null,
      groupName: key.groupName ?? stat?.groupName ?? null,
      planName: stat?.planName ?? null,
      quotaMode: stat?.quotaMode ?? null,
      quotaRemaining: stat?.quotaRemaining ?? null,
      quotaLimit: stat?.quotaLimit ?? null,
      requests: stat?.requests ?? 0,
      inputTokens: stat?.inputTokens ?? 0,
      outputTokens: stat?.outputTokens ?? 0,
      totalTokens: stat?.totalTokens ?? 0,
      actualCost: stat?.actualCost ?? 0
    } satisfies SubscriptionKeyUsageItem;
  });
}

function formatLargeNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "--";
  }
  if (Math.abs(value) >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return value.toLocaleString();
}

export function buildSubscriptionKeyUsageScopeKey(input: {
  accountId: string | null;
  subscriptionId: string;
  subscriptionKey: string;
  relatedKeyIdsSignature: string;
  startDate: string;
  endDate: string;
}) {
  return JSON.stringify(input);
}

function buildSubscriptionUsagePresetRange(
  preset: (typeof SUBSCRIPTION_USAGE_RANGE_PRESETS)[number]["key"],
  now = new Date()
) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const toDateValue = (date: Date) => {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, "0");
    const day = `${date.getDate()}`.padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  switch (preset) {
    case "last7Days": {
      const start = new Date(today);
      start.setDate(start.getDate() - 6);
      return { startDate: toDateValue(start), endDate: toDateValue(today) };
    }
    case "last30Days": {
      const start = new Date(today);
      start.setDate(start.getDate() - 29);
      return { startDate: toDateValue(start), endDate: toDateValue(today) };
    }
    case "thisMonth": {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      return { startDate: toDateValue(start), endDate: toDateValue(today) };
    }
    case "custom":
      return { startDate: "", endDate: "" };
    case "today":
    default:
      return { startDate: toDateValue(today), endDate: toDateValue(today) };
  }
}
