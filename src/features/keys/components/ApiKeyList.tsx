import { formatTime } from "../../../shared/lib/formatters";
import { EmptyState } from "../../../shared/ui/EmptyState";
import type { KeyRecord } from "../../../types";

export function ApiKeyList({ keys }: { keys: KeyRecord[] }) {
  if (keys.length === 0) {
    return <EmptyState title="当前没有 Key 数据" detail="该账号没有返回 API keys 列表。" compact />;
  }
  return (
    <div className="table-list">
      {keys.map((key) => (
        <div key={key.id} className="table-row">
          <div>
            <strong>{key.name}</strong>
            <p>{key.groupName ?? "未分组"} / {key.platform ?? "unknown"}</p>
          </div>
          <div className="table-numbers">
            <span>{key.status}</span>
            <span>{key.lastUsedAt ? formatTime(key.lastUsedAt) : "最近未使用"}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
