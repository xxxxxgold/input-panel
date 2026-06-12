import { formatTime } from "../../../shared/lib/formatters";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { getSubscriptionQuotaProgressMeta } from "../../../subscription-view";
import type { SubscriptionRecord } from "../../../types";

export function SubscriptionList({ subscriptions }: { subscriptions: SubscriptionRecord[] }) {
  if (subscriptions.length === 0) {
    return <EmptyState title="当前没有订阅数据" detail="该账号未返回有效订阅或套餐信息。" compact />;
  }
  return (
    <div className="stack-list">
      {subscriptions.map((subscription) => (
        <div key={subscription.id} className="subscription-card">
          <div className="subscription-card-head">
            <div>
              <strong>{subscription.name}</strong>
              <p>
                {subscription.groupName ?? "未分组"} / {subscription.platform ?? "unknown"}
              </p>
            </div>
            <div className="table-numbers">
              <span>{subscription.status}</span>
              <strong>
                {subscription.expiresAt ? formatTime(subscription.expiresAt) : "无到期时间"}
              </strong>
            </div>
          </div>
          {renderQuotaWindow("每日额度", subscription.daily)}
          {renderQuotaWindow("每周额度", subscription.weekly)}
          {renderQuotaWindow("每月额度", subscription.monthly)}
        </div>
      ))}
    </div>
  );
}

function renderQuotaWindow(
  label: string,
  windowValue:
    | {
        current: number;
        limit: number;
        windowStart?: string | null;
      }
    | null
    | undefined
) {
  if (!windowValue) return null;
  const progressMeta = getSubscriptionQuotaProgressMeta(windowValue.current, windowValue.limit);
  return (
    <div className="quota-row">
      <div className="bar-label">
        <span>{label}</span>
        <strong>
          ${windowValue.current.toFixed(2)} / ${windowValue.limit.toFixed(2)}
        </strong>
      </div>
      <div className="bar-track">
        <div className={`bar-fill ${progressMeta.tone}`} style={{ width: `${progressMeta.percent}%` }} />
      </div>
      {windowValue.windowStart && <p className="quota-hint">{label}统计起点: {formatTime(windowValue.windowStart)}</p>}
    </div>
  );
}
