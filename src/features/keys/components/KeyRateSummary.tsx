import { formatTime } from "../../../shared/lib/formatters";
import type { ManagedKeyRecord } from "../../../types";

export function KeyRateSummary({ keyRecord }: { keyRecord: ManagedKeyRecord }) {
  return (
    <div className="stack-list">
      <div className="summary-stat">
        <span>密钥名称</span>
        <strong>{keyRecord.name}</strong>
      </div>
      <div className="summary-stat">
        <span>状态</span>
        <strong>{keyRecord.status}</strong>
      </div>
      <div className="summary-stat">
        <span>额度 / 已用</span>
        <strong>
          ${Number(keyRecord.quota ?? 0).toFixed(2)} / ${Number(keyRecord.quotaUsed ?? 0).toFixed(2)}
        </strong>
      </div>
      <div className="summary-stat">
        <span>5h / 1d / 7d 限流</span>
        <strong>
          ${Number(keyRecord.rateLimit5h ?? 0).toFixed(2)} / ${Number(keyRecord.rateLimit1d ?? 0).toFixed(2)} / ${Number(keyRecord.rateLimit7d ?? 0).toFixed(2)}
        </strong>
      </div>
      <div className="summary-stat">
        <span>5h / 1d / 7d 已用</span>
        <strong>
          ${Number(keyRecord.usage5h ?? 0).toFixed(2)} / ${Number(keyRecord.usage1d ?? 0).toFixed(2)} / ${Number(keyRecord.usage7d ?? 0).toFixed(2)}
        </strong>
      </div>
      <div className="summary-stat">
        <span>过期时间</span>
        <strong>{keyRecord.expiresAt ? formatTime(keyRecord.expiresAt) : "无到期时间"}</strong>
      </div>
    </div>
  );
}
