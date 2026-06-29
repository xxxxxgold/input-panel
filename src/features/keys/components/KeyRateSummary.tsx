import { formatTime } from "../../../shared/lib/formatters";
import type { ManagedKeyRecord } from "../../../types";

function describeKeyStatus(status: string) {
  const normalized = status.trim().toLowerCase();

  if (normalized === "active" || normalized === "enabled" || normalized === "ok" || normalized === "normal") {
    return { label: "已启用", tone: "ready" as const };
  }

  if (
    normalized === "inactive" ||
    normalized === "disabled" ||
    normalized === "revoked" ||
    normalized === "expired" ||
    normalized === "blocked"
  ) {
    return { label: normalized === "expired" ? "已失效" : "已停用", tone: "critical" as const };
  }

  return { label: "未知状态", tone: "neutral" as const };
}

export function KeyRateSummary({ keyRecord }: { keyRecord: ManagedKeyRecord }) {
  const statusPresentation = describeKeyStatus(keyRecord.status);

  return (
    <div className="stack-list">
      <div className="summary-stat">
        <span>密钥名称</span>
        <strong>{keyRecord.name}</strong>
      </div>
      <div className="summary-stat">
        <span>状态</span>
        <span className={`status-pill ${statusPresentation.tone}`}>{statusPresentation.label}</span>
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
