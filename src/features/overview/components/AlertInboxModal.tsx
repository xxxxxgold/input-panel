import { Check } from "lucide-react";

import { formatTime } from "../../../shared/lib/formatters";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Modal } from "../../../shared/ui/Modal";
import type { AccountAlert } from "../../../types";
import type { AppNotificationItem } from "../../service-status/notifications";

export type AlertInboxItem = AccountAlert & {
  siteName?: string | null;
  accountLabel?: string | null;
};

export type NotificationInboxItem =
  | {
      notificationKey: string;
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
      notificationKey: string;
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
  onClose,
  onAcknowledge
}: {
  items: NotificationInboxItem[];
  onClose: () => void;
  onAcknowledge: (item: NotificationInboxItem) => void;
}) {
  return (
    <Modal
      title="消息盒子"
      onClose={onClose}
      size="wide"
      hideCloseButton
      className="alert-inbox-modal"
      bodyClassName="alert-inbox-modal-body"
    >
      {items.length > 0 ? (
        <div className="alert-inbox-list motion-stagger-grid" role="list">
          {items.map((item, index) => (
            <article
              key={item.id}
              className={`alert-inbox-item motion-stagger-item ${resolveInboxTone(item)}`}
              role="listitem"
              style={{ ["--motion-order" as string]: index }}
            >
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
              <time className="alert-inbox-time" dateTime={item.createdAt}>
                {formatTime(item.createdAt)}
              </time>
              <footer className="alert-inbox-item-footer">
                <div className="alert-inbox-context" aria-label="消息来源">
                  <span>{item.source === "service-status" ? "服务状态" : item.siteName ?? "未知站点"}</span>
                  <span>{item.source === "service-status" ? "自动监控" : item.accountLabel ?? "未知账号"}</span>
                </div>
                <button
                  type="button"
                  className="ghost-button alert-inbox-dismiss"
                  onClick={() => onAcknowledge(item)}
                  aria-label={`将“${item.title}”标记为已处理`}
                >
                  <Check size={14} aria-hidden="true" />
                  <span>标记已处理</span>
                </button>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState title="没有待处理消息" detail="当前没有新的提醒需要处理。" compact />
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
