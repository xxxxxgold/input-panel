import type { AccountSnapshot, SubscriptionSummaryPayload } from "../types";
import { compact, formatTime, formatUsd } from "../shared/lib/formatters";
import { EmptyState } from "../shared/ui/EmptyState";
import { SectionCard } from "../shared/ui/SectionCard";
import { SubscriptionList } from "../features/subscriptions/components/SubscriptionList";
import { buildSubscriptionUsageInsights } from "../subscription-view";

export function SubscriptionsPage({
  visibleSnapshot,
  subscriptionSummary
}: {
  visibleSnapshot: AccountSnapshot | null;
  subscriptionSummary: SubscriptionSummaryPayload | null;
}) {
  const subscriptionUsageInsights = buildSubscriptionUsageInsights({
    summary: subscriptionSummary,
    snapshotSubscriptions: visibleSnapshot?.subscriptions ?? [],
    requestHistory: visibleSnapshot?.requestHistory ?? [],
    recentUsage: visibleSnapshot?.recentUsage ?? []
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
            <div className="summary-stat">
              <span>活跃订阅数</span>
              <strong>{subscriptionSummary.activeCount}</strong>
            </div>
            <div className="summary-stat">
              <span>累计已用金额</span>
              <strong>${subscriptionSummary.totalUsedUsd.toFixed(4)}</strong>
            </div>
            <div className="summary-stat">
              <span>已归因请求数</span>
              <strong>{subscriptionUsageInsights.totalAttributedRequests.toLocaleString()}</strong>
            </div>
            <div className="summary-stat">
              <span>已归因总 Tokens</span>
              <strong>{compact(subscriptionUsageInsights.totalAttributedTokens)}</strong>
            </div>
            <div className="summary-stat">
              <span>已归因累计成本</span>
              <strong>{formatUsd(subscriptionUsageInsights.totalAttributedActualCost, 4)}</strong>
            </div>
            <p className="quota-hint">
              统计口径: {subscriptionUsageInsights.sourceLabel}。当前订阅接口只返回金额/配额摘要, 请求数与 Tokens 为按订阅标签归因后的累计值。
            </p>
            <div className="table-list">
              {subscriptionUsageInsights.rows.map((item) => (
                <div key={item.id} className="table-row">
                  <div>
                    <strong>{item.name}</strong>
                    <p>{item.status}</p>
                  </div>
                  <div className="table-numbers">
                    <span>日用量 ${item.dailyUsedUsd.toFixed(2)} / ${item.dailyLimitUsd.toFixed(2)}</span>
                    <span>周用量 ${item.weeklyUsedUsd.toFixed(2)} / 月用量 ${item.monthlyUsedUsd.toFixed(2)}</span>
                    <span>累计 {item.attributedRequests.toLocaleString()} 请求 / {compact(item.attributedTokens)} Tokens</span>
                    <span>归因成本 {formatUsd(item.attributedActualCost, 4)}</span>
                    <span>{item.expiresAt ? formatTime(item.expiresAt) : "无到期时间"}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <EmptyState title="当前没有订阅摘要" detail="站点未返回 subscriptions/summary 数据。" compact />
        )}
      </SectionCard>
    </section>
  );
}
