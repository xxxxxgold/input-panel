import { formatTime } from "../../../shared/lib/formatters";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { StatusBadge } from "../../../shared/ui/StatusBadge";
import type { KeyRecord } from "../../../types";
import "./ApiKeyList.css";

export function ApiKeyList({ keys }: { keys: KeyRecord[] }) {
  if (keys.length === 0) {
    return <EmptyState title="当前没有 Key 数据" detail="该账号没有返回 API keys 列表。" compact />;
  }
  return (
    <div className="table-list wide api-key-summary-list">
      {keys.map((key) => {
        const platformTone = (key.platform ?? "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
        const statusState = key.status === "active" ? "ready" : "expired";
        return (
          <div key={key.id} className="table-row wide key-row api-key-summary-row">
            <div className="row-main key-row-main">
              <div className="key-heading-row">
                <div className="key-title-cluster">
                  <StatusBadge state={statusState} />
                  <strong>{key.name}</strong>
                </div>
                <div className="key-secret-line api-key-summary-context">
                  <span className="key-context-name">{key.groupName ?? "未分组"}</span>
                  <span className={`key-platform-pill ${platformTone}`}>{key.platform ?? "unknown"}</span>
                </div>
              </div>
              <div className="key-secret-row api-key-summary-secret-row">
                <small className="key-secret-text">{key.status}</small>
              </div>
              <div className="row-meta key-row-meta api-key-summary-meta">
                <span>{key.lastUsedAt ? `最后使用时间：${formatTime(key.lastUsedAt)}` : "最近未使用"}</span>
              </div>
            </div>
            <div className="row-actions key-row-actions api-key-summary-actions">
              <span className="api-key-summary-status-text">{key.status}</span>
              <span>{key.lastUsedAt ? formatTime(key.lastUsedAt) : "最近未使用"}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
