import { Bell } from "lucide-react";

import { formatTime } from "../../../shared/lib/formatters";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Modal } from "../../../shared/ui/Modal";
import type { SnapshotAlert } from "../../../types";
import type { AppNotificationItem } from "../../service-status/notifications";

export type AlertInboxItem = SnapshotAlert & {
  siteName?: string | null;
  accountLabel?: string | null;
};

export type NotificationInboxItem =
  | {
      source: "overview-alert";
      id: string;
      severity: "critical" | "high" | "medium" | "low";
      title: string;
      detail: string;
      createdAt: string;
      siteName?: string | null;
      accountLabel?: string | null;
      models?: string[];
    }
  | {
      source: "service-status";
      id: string;
      severity: AppNotificationItem["severity"];
      title: string;
      detail: string;
      createdAt: string;
      siteName?: string | null;
      accountLabel?: string | null;
      models?: string[];
    };

export function AlertInboxModal({
  items,
  onClose
}: {
  items: NotificationInboxItem[];
  onClose: () => void;
}) {
  return (
    <Modal
      title="消息盒子"
      onClose={onClose}
      size="wide"
      closeText={null}
      className="alert-inbox-modal"
      bodyClassName="alert-inbox-modal-body"
    >
      <section className="alert-inbox-hero">
        <div className="alert-inbox-hero-icon" aria-hidden="true">
          <Bell size={18} />
        </div>
        <div className="alert-inbox-hero-copy">
          <strong>{items.length === 0 ? "当前没有待处理消息" : `${items.length} 条待处理消息`}</strong>
          <p>{items.length === 0 ? "所有已刷新账号都处于健康状态。" : "集中查看低余额、会话失效和服务状态变更提醒。"}</p>
        </div>
      </section>

      {items.length > 0 ? (
        <div className="alert-inbox-list" role="list">
          {items.map((item) => (
            <article key={item.id} className={`alert-inbox-item ${resolveInboxTone(item)}`} role="listitem">
              <div className="alert-inbox-item-main">
                <div className={`alert-inbox-severity ${resolveInboxTone(item)}`}>
                  {resolveInboxLabel(item)}
                </div>
                <div className="alert-inbox-copy">
                  <strong>{item.title}</strong>
                  <p>{item.detail}</p>
                  {item.models && item.models.length > 0 ? (
                    <p className="alert-inbox-models">涉及模型: {item.models.join(", ")}</p>
                  ) : null}
                </div>
              </div>
              <div className="alert-inbox-meta">
                <span>{item.source === "service-status" ? "服务状态监控" : item.siteName ?? "未知站点"}</span>
                <span>{item.source === "service-status" ? "本地运行态" : item.accountLabel ?? "未知账号"}</span>
                <time dateTime={item.createdAt}>{formatTime(item.createdAt)}</time>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState title="没有待处理消息" detail="当前没有新的余额、订阅或登录异常。" compact />
      )}
    </Modal>
  );
}

function resolveInboxTone(item: NotificationInboxItem) {
  if (item.severity === "critical") {
    return "critical";
  }
  if (item.severity === "success") {
    return "success";
  }
  return "neutral";
}

function resolveInboxLabel(item: NotificationInboxItem) {
  if (item.source === "service-status") {
    return item.severity === "critical" ? "异常" : "恢复";
  }
  return item.severity === "critical" ? "紧急" : "提醒";
}
