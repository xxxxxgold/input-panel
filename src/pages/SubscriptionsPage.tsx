import { useMemo, useState } from "react";
import type { SubscriptionRecord, SubscriptionSummaryPayload } from "../types";
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
import { SubscriptionList } from "../features/subscriptions/components/SubscriptionList";
import "../features/subscriptions/components/SubscriptionsPage.css";
import {
  buildSubscriptionDetailRecords,
  buildSubscriptionUsageInsights,
  getSubscriptionQuotaProgressMeta,
  getSubscriptionStatusPresentation,
  mergeSubscriptionRecords,
  type SubscriptionDetailRecord
} from "../subscription-view";

export function SubscriptionsPage({
  subscriptions,
  subscriptionSummary
}: {
  subscriptions: SubscriptionRecord[];
  subscriptionSummary: SubscriptionSummaryPayload | null;
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
  const [selectedSubscriptionId, setSelectedSubscriptionId] = useState<string | null>(null);
  const selectedDetailRecord = selectedSubscriptionId
    ? detailRecords.find((item) => item.id === selectedSubscriptionId) ?? null
    : null;

  return (
    <section className="stack-list subscriptions-page-layout">
      <SectionCard title="订阅摘要" subtitle="对齐 subscriptions/summary 接口">
        {summary ? (
          <div className="stack-list">
            <p className="quota-hint subscription-summary-lead">
              当前只展示订阅接口原生可确认的数据: 金额、日/周/月额度、状态与到期信息。未再展示按 usage 归因的请求数或 Tokens。
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
          <EmptyState title="当前没有订阅摘要" detail="站点未返回 subscriptions/summary 数据。" compact />
        )}
      </SectionCard>
      <section className="content-grid subscriptions-content-grid">
        <SectionCard title="订阅视图" subtitle="当前账号全部订阅与订阅摘要">
          {subscriptions.length > 0 ? (
            <div className="stack-list">
              <p className="quota-hint subscription-detail-trigger-hint">
                点击任意订阅卡片, 弹出该订阅的每日、每周、每月额度与到期详情。
              </p>
              <SubscriptionList
                subscriptions={mergedSubscriptions}
                selectedSubscriptionId={selectedSubscriptionId}
                onSelectSubscription={(subscription) => {
                  setSelectedSubscriptionId(subscription.id);
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
          onClose={() => setSelectedSubscriptionId(null)}
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

function SubscriptionDetailModal({
  record,
  onClose
}: {
  record: SubscriptionDetailRecord;
  onClose: () => void;
}) {
  const statusPresentation = getSubscriptionStatusPresentation(record.status);
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
          <p>{record.groupName && record.groupName !== record.name ? record.groupName : "当前订阅详情"}</p>
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
