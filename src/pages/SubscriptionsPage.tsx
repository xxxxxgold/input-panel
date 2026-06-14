import type { AccountSnapshot, SubscriptionSummaryPayload } from "../types";
import {
  formatPercent,
  formatRemainingDaysLabel,
  formatTime,
  formatUsd
} from "../shared/lib/formatters";
import { EmptyState } from "../shared/ui/EmptyState";
import { SectionCard } from "../shared/ui/SectionCard";
import { SubscriptionList } from "../features/subscriptions/components/SubscriptionList";
import {
  buildSubscriptionUsageInsights,
  getSubscriptionStatusPresentation
} from "../subscription-view";

export function SubscriptionsPage({
  visibleSnapshot,
  subscriptionSummary
}: {
  visibleSnapshot: AccountSnapshot | null;
  subscriptionSummary: SubscriptionSummaryPayload | null;
}) {
  const subscriptionUsageInsights = buildSubscriptionUsageInsights({
    summary: subscriptionSummary,
    snapshotSubscriptions: visibleSnapshot?.subscriptions ?? []
  });

  return (
    <section className="content-grid">
      <SectionCard title="订阅视图" subtitle="当前账号全部订阅与订阅摘要">
        {visibleSnapshot ? (
          <SubscriptionList subscriptions={visibleSnapshot.subscriptions} />
        ) : (
          <EmptyState title="当前没有订阅数据" detail="先登录并刷新当前账号。" compact />
        )}
      </SectionCard>
      <SectionCard title="订阅摘要" subtitle="对齐 subscriptions/summary 接口">
        {subscriptionSummary ? (
          <div className="stack-list">
            <div className="subscription-summary-grid">
              <div className="summary-stat">
                <span>活跃订阅数</span>
                <strong>{subscriptionSummary.activeCount}</strong>
              </div>
              <div className="summary-stat">
                <span>累计已用金额</span>
                <strong>{formatUsd(subscriptionSummary.totalUsedUsd, 4)}</strong>
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
            <p className="quota-hint">
              当前只展示订阅接口原生可确认的数据: 金额、日/周/月额度、状态与到期信息。未再展示按 usage 归因的请求数或 Tokens。
            </p>
            <div className="table-list wide">
              {subscriptionUsageInsights.rows.map((item) => {
                const statusPresentation = getSubscriptionStatusPresentation(item.status);
                return (
                  <div key={item.id} className="table-row wide subscription-summary-row">
                    <div className="subscription-summary-main">
                      <strong>{item.name}</strong>
                      <p>{statusPresentation.label}</p>
                      <small>{item.expiresAt ? formatRemainingDaysLabel(item.expiresAt) : "暂无到期时间"}</small>
                    </div>
                    <div className="subscription-metric-grid">
                      <div className="table-numbers subscription-metric-card">
                        <span>日用量</span>
                        <strong>{formatUsd(item.dailyUsedUsd, 2)} / {formatUsd(item.dailyLimitUsd, 2)}</strong>
                      </div>
                      <div className="table-numbers subscription-metric-card">
                        <span>日剩余</span>
                        <strong>{formatUsd(Math.max(item.dailyLimitUsd - item.dailyUsedUsd, 0), 2)}</strong>
                      </div>
                      <div className="table-numbers subscription-metric-card">
                        <span>日占用</span>
                        <strong>{formatPercent(computePercent(item.dailyUsedUsd, item.dailyLimitUsd))}</strong>
                      </div>
                      <div className="table-numbers subscription-metric-card">
                        <span>周用量</span>
                        <strong>{formatUsd(item.weeklyUsedUsd, 2)}</strong>
                      </div>
                      <div className="table-numbers subscription-metric-card">
                        <span>月用量</span>
                        <strong>{formatUsd(item.monthlyUsedUsd, 2)}</strong>
                      </div>
                      <div className="table-numbers subscription-metric-card">
                        <span>到期时间</span>
                        <strong>{item.expiresAt ? formatTime(item.expiresAt) : "无到期时间"}</strong>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <EmptyState title="当前没有订阅摘要" detail="站点未返回 subscriptions/summary 数据。" compact />
        )}
      </SectionCard>
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
