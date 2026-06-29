import type { AccountAlert } from "../types";
import { formatTime } from "../shared/lib/formatters";
import { EmptyState } from "../shared/ui/EmptyState";
import { SectionCard } from "../shared/ui/SectionCard";

export function AlertsPage({ alerts }: { alerts: AccountAlert[] }) {
  return (
    <SectionCard title="告警列表" subtitle="按严重级别集中处理低余额、失效和拉取失败">
      <div className="stack-list">
        {alerts.map((alert) => (
          <div key={alert.id} className={`alert-item ${alert.severity}`}>
            <div>
              <strong>{alert.title}</strong>
              <p>{alert.detail}</p>
            </div>
            <span>{formatTime(alert.createdAt)}</span>
          </div>
        ))}
        {alerts.length === 0 && (
          <EmptyState title="没有待处理告警" detail="所有已刷新账号都处于健康状态。" compact />
        )}
      </div>
    </SectionCard>
  );
}
