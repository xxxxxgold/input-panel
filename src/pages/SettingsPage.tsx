import type { KeyboardEvent } from "react";
import { Plus } from "lucide-react";

import type { AccountRuntime, SiteRecord, UsageHistoryRow } from "../types";
import { formatTime } from "../shared/lib/formatters";
import { DetailItem } from "../shared/ui/DetailItem";
import { EmptyState } from "../shared/ui/EmptyState";
import { SectionCard } from "../shared/ui/SectionCard";
import { ApiKeyList } from "../features/keys/components/ApiKeyList";
import { SubscriptionList } from "../features/subscriptions/components/SubscriptionList";

export function SettingsPage({
  siteSearch,
  onSiteSearchChange,
  filteredSites,
  accounts,
  selectedSite,
  visibleSnapshot,
  visibleHistory,
  latestHistory,
  selectedHistoryRow,
  onSelectHistoryRow,
  onOpenNewSite,
  onOpenSiteAccountManager,
  onOpenEditSite,
  onRemoveSite,
  onOpenNewAccount,
  onOpenAccountManager,
  handleActionKey
}: {
  siteSearch: string;
  onSiteSearchChange: (value: string) => void;
  filteredSites: SiteRecord[];
  accounts: AccountRuntime[];
  selectedSite: SiteRecord | null;
  visibleSnapshot: AccountRuntime["snapshot"] | null;
  visibleHistory: UsageHistoryRow[];
  latestHistory: UsageHistoryRow[];
  selectedHistoryRow: UsageHistoryRow | null;
  onSelectHistoryRow: (row: UsageHistoryRow) => void;
  onOpenNewSite: () => void;
  onOpenSiteAccountManager: (site: SiteRecord) => void;
  onOpenEditSite: (site: SiteRecord) => void;
  onRemoveSite: (siteId: string) => void;
  onOpenNewAccount: (siteId?: string) => void;
  onOpenAccountManager: (account: AccountRuntime) => void;
  handleActionKey: (event: KeyboardEvent<HTMLElement>, action: () => void) => void;
}) {
  return (
    <>
      <section className="management-grid">
        <SectionCard
          title="站点默认管理"
          subtitle="默认站点配置现在统一收口到站点账号配置页内维护。"
          actions={
            <button className="mini-button" onClick={onOpenNewSite} title="新增站点" aria-label="新增站点">
              <Plus size={14} />
            </button>
          }
        >
          <div className="context-section">
            <input
              className="search-input"
              value={siteSearch}
              onChange={(event) => onSiteSearchChange(event.target.value)}
              placeholder="搜索站点"
            />
            <div className="context-list">
              {filteredSites.map((site) => {
                const siteAccounts = accounts.filter((item) => item.siteId === site.id);
                const siteBalance = siteAccounts.reduce((sum, item) => sum + (item.snapshot?.balance ?? 0), 0);
                const activeCount = siteAccounts.filter((item) => item.sessionState === "ready").length;
                return (
                  <div
                    key={site.id}
                    className={`context-card ${selectedSite?.id === site.id ? "selected" : ""}`}
                    onClick={() => onOpenSiteAccountManager(site)}
                    onKeyDown={(event) => handleActionKey(event, () => onOpenSiteAccountManager(site))}
                    role="button"
                    tabIndex={0}
                    title={`打开 ${site.name} 的站点详情`}
                  >
                    <div className="context-card-head">
                      <strong>{site.name}</strong>
                      <span className="status-pill neutral">{activeCount}/{siteAccounts.length}</span>
                    </div>
                    <div className="context-card-body">
                      <span>{site.baseUrl}</span>
                      <span>余额 ${siteBalance.toFixed(2)}</span>
                    </div>
                    <div className="context-card-actions">
                      <button
                        className="inline-text-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenEditSite(site);
                        }}
                      >
                        编辑
                      </button>
                      <button
                        className="inline-text-button danger"
                        onClick={(event) => {
                          event.stopPropagation();
                          onRemoveSite(site.id);
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                );
              })}
              {filteredSites.length === 0 && (
                <EmptyState title="还没有站点" detail="先添加第一个 Sub2API 站点。" compact />
              )}
            </div>
          </div>
        </SectionCard>
      </section>

      <SectionCard title="当前账号详情" subtitle="当前所选账号的余额、全部订阅和全部 API Keys">
        {visibleSnapshot ? (
          <div className="stack-list">
            <div className="summary-stat">
              <span>余额</span>
              <strong>${visibleSnapshot.balance.toFixed(2)}</strong>
            </div>
            <div className="summary-stat">
              <span>订阅总数</span>
              <strong>{visibleSnapshot.subscriptions.length}</strong>
            </div>
            <div className="summary-stat">
              <span>Key 总数 / 活跃</span>
              <strong>{visibleSnapshot.stats.totalApiKeys} / {visibleSnapshot.stats.activeApiKeys}</strong>
            </div>
            <div className="account-detail-grid">
              <div className="account-detail-column">
                <div className="section-mini-title">全部订阅</div>
                <SubscriptionList subscriptions={visibleSnapshot.subscriptions} />
              </div>
              <div className="account-detail-column">
                <div className="section-mini-title">全部 API Keys</div>
                <ApiKeyList keys={visibleSnapshot.keys} />
              </div>
            </div>
            <div className="summary-stat">
              <span>本地累计请求记录</span>
              <strong>{visibleHistory.length}</strong>
            </div>
            <div className="summary-stat">
              <span>本次最新拉取</span>
              <strong>{latestHistory.length}</strong>
            </div>
          </div>
        ) : (
          <EmptyState title="还没有当前账号详情" detail="先登录并刷新当前账号。" compact />
        )}
      </SectionCard>

      <SectionCard title="请求记录详情" subtitle="本地累计存储, 新数据会持续追加并标记是否为本次最新">
        {visibleSnapshot ? (
          <div className="stack-list">
            <div className="detail-toolbar">
              <div className="summary-stat compact-stat">
                <span>最后刷新</span>
                <strong>{formatTime(visibleSnapshot.fetchedAt)}</strong>
              </div>
              <div className="summary-stat compact-stat">
                <span>最新命中</span>
                <strong>{latestHistory.length}</strong>
              </div>
            </div>
            <div className="table-list">
              {visibleHistory.slice(0, 16).map((row) => (
                <button
                  key={`${row.id}-${row.firstSeenAt}`}
                  type="button"
                  className={`history-row ${selectedHistoryRow?.id === row.id ? "selected" : ""}`}
                  onClick={() => onSelectHistoryRow(row)}
                >
                  <div className="history-main">
                    <div className="history-title-row">
                      <strong>{row.model}</strong>
                      <span className={`latest-pill ${row.isLatest ? "yes" : "no"}`}>
                        {row.isLatest ? "最新" : "历史"}
                      </span>
                    </div>
                    <p>{row.apiKeyName ?? "未知 Key"} / {row.endpoint ?? "-"}</p>
                    <small>
                      请求时间 {formatTime(row.createdAt)} · 首次入库 {formatTime(row.firstSeenAt)}
                    </small>
                  </div>
                  <div className="table-numbers">
                    <strong>${row.actualCost.toFixed(5)}</strong>
                    <span>{row.totalTokens.toLocaleString()} tokens</span>
                    <span>{row.platform ?? "unknown"}</span>
                  </div>
                </button>
              ))}
              {visibleHistory.length === 0 && (
                <EmptyState title="还没有请求记录" detail="下一次刷新成功后会把 usage 记录写入本地历史。" compact />
              )}
            </div>
            {selectedHistoryRow && (
              <div className="request-detail-card">
                <div className="request-detail-head">
                  <div>
                    <strong>{selectedHistoryRow.model}</strong>
                    <p>{selectedHistoryRow.subscriptionName ?? "未关联订阅"} / {selectedHistoryRow.platform ?? "unknown"}</p>
                  </div>
                  <span className={`latest-pill ${selectedHistoryRow.isLatest ? "yes" : "no"}`}>
                    {selectedHistoryRow.isLatest ? "当前最新数据" : "本地历史数据"}
                  </span>
                </div>
                <div className="request-detail-grid">
                  <DetailItem label="请求时间" value={formatTime(selectedHistoryRow.createdAt)} />
                  <DetailItem label="首次入库" value={formatTime(selectedHistoryRow.firstSeenAt)} />
                  <DetailItem label="最后命中" value={formatTime(selectedHistoryRow.lastSeenAt)} />
                  <DetailItem label="API Key" value={selectedHistoryRow.apiKeyName ?? "未知"} />
                  <DetailItem label="Endpoint" value={selectedHistoryRow.endpoint ?? "-"} />
                  <DetailItem label="实际成本" value={`$${selectedHistoryRow.actualCost.toFixed(6)}`} />
                  <DetailItem label="标准成本" value={`$${selectedHistoryRow.totalCost.toFixed(6)}`} />
                  <DetailItem label="输入 Tokens" value={selectedHistoryRow.inputTokens.toLocaleString()} />
                  <DetailItem label="输出 Tokens" value={selectedHistoryRow.outputTokens.toLocaleString()} />
                  <DetailItem label="总 Tokens" value={selectedHistoryRow.totalTokens.toLocaleString()} />
                  <DetailItem label="首 Token 延迟" value={selectedHistoryRow.firstTokenMs ? `${selectedHistoryRow.firstTokenMs} ms` : "-"} />
                  <DetailItem label="总耗时" value={selectedHistoryRow.durationMs ? `${selectedHistoryRow.durationMs} ms` : "-"} />
                </div>
              </div>
            )}
          </div>
        ) : (
          <EmptyState title="还没有请求记录详情" detail="先登录并刷新当前账号, 这里会展示本地累积的请求历史。" compact />
        )}
      </SectionCard>
    </>
  );
}
