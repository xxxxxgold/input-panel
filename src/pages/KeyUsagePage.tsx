import type { DailyUsagePoint, ManagedKeyRecord, PaginatedResult } from "../types";
import { compact } from "../shared/lib/formatters";
import { EmptyState } from "../shared/ui/EmptyState";
import { SectionCard } from "../shared/ui/SectionCard";
import { KeyRateSummary } from "../features/keys/components/KeyRateSummary";

export function KeyUsagePage({
  keyUsageRows,
  keyUsageKeyId,
  managedKeys,
  onLoadKeyUsage
}: {
  keyUsageRows: DailyUsagePoint[];
  keyUsageKeyId: string;
  managedKeys: PaginatedResult<ManagedKeyRecord> | null;
  onLoadKeyUsage: (keyId: string) => void;
}) {
  const selectedKey = managedKeys?.items.find((item) => item.id === keyUsageKeyId) ?? null;

  return (
    <section className="content-grid content-grid-align-start">
      <SectionCard title="单 Key 用量" subtitle="对齐 key-usage 页面与 daily usage 接口">
        <div className="filter-grid">
          <label className="field">
            <span>选择 API Key</span>
            <select value={keyUsageKeyId} onChange={(event) => onLoadKeyUsage(event.target.value)}>
              <option value="">请选择</option>
              {(managedKeys?.items ?? []).map((key) => (
                <option key={key.id} value={key.id}>
                  {key.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="table-list">
          {keyUsageRows.map((row) => (
            <div key={row.date} className="table-row">
              <div>
                <strong>{row.date}</strong>
                <p>{row.requests.toLocaleString()} 请求</p>
              </div>
              <div className="table-numbers">
                <span>{compact(row.totalTokens ?? 0)} tokens</span>
                <strong>${Number(row.actualCost ?? row.totalCost ?? 0).toFixed(4)}</strong>
              </div>
            </div>
          ))}
          {keyUsageRows.length === 0 && (
            <EmptyState
              title={selectedKey ? "当前 Key 最近 30 天没有 daily usage" : "当前没有单 Key 用量"}
              detail={
                selectedKey
                  ? "这个 Key 已经选中, 但上游接口暂时没有返回最近 30 天的每日用量。"
                  : "选择一个密钥后会查询最近 30 天的每日用量。"
              }
              compact
            />
          )}
        </div>
      </SectionCard>
      <SectionCard title="当前 Key 概览" subtitle="额度与限流命中情况">
        {selectedKey ? (
          <KeyRateSummary keyRecord={selectedKey} />
        ) : (
          <EmptyState title="还没有选中密钥" detail="先从左侧选择账号，再在这里选择一个 API Key。" compact />
        )}
      </SectionCard>
    </section>
  );
}
