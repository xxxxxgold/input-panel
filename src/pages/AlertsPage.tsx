import type { AccountAlert } from "../types";
import { formatTime } from "../shared/lib/formatters";
import { EmptyState } from "../shared/ui/EmptyState";
import { SectionCard } from "../shared/ui/SectionCard";

export function AlertsPage({ alerts }: { alerts: AccountAlert[] }) {
  return (
    <SectionCard title="提醒列表" subtitle="把需要你关注的问题集中列出来, 方便快速处理">
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
          <EmptyState title="当前没有待处理提醒" detail="现在一切正常, 暂时不需要你处理。" compact />
        )}
      </div>
    </SectionCard>
  );
}
