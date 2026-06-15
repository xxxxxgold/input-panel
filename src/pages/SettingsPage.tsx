import type { KeyboardEvent } from "react";
import { Plus } from "lucide-react";

import type { AccountRuntime, SiteRecord } from "../types";
import { formatTime } from "../shared/lib/formatters";
import { DetailItem } from "../shared/ui/DetailItem";
import { EmptyState } from "../shared/ui/EmptyState";
import { SectionCard } from "../shared/ui/SectionCard";
import { StatusBadge } from "../shared/ui/StatusBadge";
import { ApiKeyList } from "../features/keys/components/ApiKeyList";
import { SubscriptionList } from "../features/subscriptions/components/SubscriptionList";

export function runSiteCardAction({
  site,
  selectedSiteId,
  onSelectSite,
  onOpenSiteAccountManager
}: {
  site: SiteRecord;
  selectedSiteId: string | null;
  onSelectSite: (siteId: string) => void;
  onOpenSiteAccountManager: (site: SiteRecord) => void;
}) {
  if (selectedSiteId === site.id) {
    onOpenSiteAccountManager(site);
    return;
  }
  onSelectSite(site.id);
}

export function runSiteAccountRowAction({
  account,
  onSelectAccount,
  onEditAccount
}: {
  account: AccountRuntime;
  onSelectAccount: (account: AccountRuntime) => void;
  onEditAccount: (account: AccountRuntime) => void;
}) {
  return {
    handleClick: () => onSelectAccount(account),
    handleDoubleClick: () => onEditAccount(account)
  };
}

export function SettingsPage({
  siteSearch,
  onSiteSearchChange,
  filteredSites,
  accounts,
  selectedSite,
  selectedAccountId,
  visibleSnapshot,
  onOpenNewSite,
  onSelectSite,
  onOpenSiteAccountManager,
  onOpenEditSite,
  onRemoveSite,
  onOpenNewAccount,
  onSelectAccount,
  onEditAccount,
  handleActionKey
}: {
  siteSearch: string;
  onSiteSearchChange: (value: string) => void;
  filteredSites: SiteRecord[];
  accounts: AccountRuntime[];
  selectedSite: SiteRecord | null;
  visibleSnapshot: AccountRuntime["snapshot"] | null;
  onOpenNewSite: () => void;
  onSelectSite: (siteId: string) => void;
  onOpenSiteAccountManager: (site: SiteRecord) => void;
  onOpenEditSite: (site: SiteRecord) => void;
  onRemoveSite: (siteId: string) => void;
  onOpenNewAccount: (siteId?: string) => void;
  onOpenAccountManager: (account: AccountRuntime) => void;
  handleActionKey: (event: KeyboardEvent<HTMLElement>, action: () => void) => void;
}) {
  const selectedSiteAccounts = selectedSite ? accounts.filter((item) => item.siteId === selectedSite.id) : [];
  const selectedSiteBalance = selectedSiteAccounts.reduce((sum, item) => sum + (item.snapshot?.balance ?? 0), 0);
  const selectedSiteReadyCount = selectedSiteAccounts.filter((item) => item.sessionState === "ready").length;
  const selectedSiteLatestFetchedAt = selectedSiteAccounts
    .map((item) => item.snapshot?.fetchedAt ?? null)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.localeCompare(left))[0] ?? null;

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
                const siteCardSelected = selectedSite?.id === site.id;
                const siteCardTitle = siteCardSelected
                  ? `打开 ${site.name} 的账号管理`
                  : `选中 ${site.name} 并查看下方详情`;
                const handleSiteCardAction = () =>
                  runSiteCardAction({
                    site,
                    selectedSiteId: selectedSite?.id ?? null,
                    onSelectSite,
                    onOpenSiteAccountManager
                  });
                return (
                  <div
                    key={site.id}
                    className={`context-card ${siteCardSelected ? "selected" : ""}`}
                    onClick={handleSiteCardAction}
                    onKeyDown={(event) => handleActionKey(event, handleSiteCardAction)}
                    role="button"
                    aria-pressed={siteCardSelected}
                    tabIndex={0}
                    title={siteCardTitle}
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
            <div className="request-detail-card site-detail-card">
              {selectedSite ? (
                <>
                  <div className="request-detail-head site-detail-head">
                    <div>
                      <strong>{selectedSite.name}</strong>
                      <p>{selectedSite.baseUrl}</p>
                    </div>
                    <div className="inline-actions wrap-actions">
                      <button type="button" className="inline-text-button" onClick={() => onOpenEditSite(selectedSite)}>
                        编辑站点
                      </button>
                      <button
                        type="button"
                        className="inline-text-button"
                        onClick={() => onOpenNewAccount(selectedSite.id)}
                      >
                        加账号
                      </button>
                      <button
                        type="button"
                        className="inline-text-button"
                        onClick={() => onOpenSiteAccountManager(selectedSite)}
                      >
                        管理账号
                      </button>
                    </div>
                  </div>
                  <div className="request-detail-grid site-detail-grid">
                    <DetailItem label="站点 URL" value={selectedSite.baseUrl} />
                    <DetailItem label="账号总数" value={String(selectedSiteAccounts.length)} />
                    <DetailItem label="已连接账号" value={String(selectedSiteReadyCount)} />
                    <DetailItem label="站点余额汇总" value={`$${selectedSiteBalance.toFixed(2)}`} />
                    <DetailItem
                      label="最近同步"
                      value={selectedSiteLatestFetchedAt ? formatTime(selectedSiteLatestFetchedAt) : "当前还没有同步记录"}
                    />
                    <DetailItem
                      label="当前账号详情联动"
                      value={selectedSiteAccounts.length > 0 ? "下方账号详情会跟随当前站点切换" : "先为当前站点添加账号"}
                    />
                  </div>
                  <div className="site-account-list">
                    <div className="section-mini-title">当前站点账号</div>
                    <div className="table-list wide">
                      {selectedSiteAccounts.map((account) => (
                        <div
                          key={account.id}
                          className="table-row wide account-row-trigger site-account-row"
                          onClick={() => onOpenAccountManager(account)}
                          onKeyDown={(event) => handleActionKey(event, () => onOpenAccountManager(account))}
                          role="button"
                          tabIndex={0}
                          title={`打开 ${account.label} 的账号管理`}
                        >
                          <div className="row-main">
                            <strong>{account.label}</strong>
                            <p>{account.email}</p>
                            <small>{account.snapshot ? `最近同步 ${formatTime(account.snapshot.fetchedAt)}` : "当前还没有同步"}</small>
                          </div>
                          <div className="row-meta">
                            <span>余额 {account.snapshot ? `$${account.snapshot.balance.toFixed(2)}` : "-"}</span>
                            <span>Keys {account.snapshot?.stats.totalApiKeys ?? 0} / 活跃 {account.snapshot?.stats.activeApiKeys ?? 0}</span>
                          </div>
                          <div className="row-actions">
                            <StatusBadge state={account.sessionState} />
                            <button
                              type="button"
                              className="inline-text-button"
                              onClick={(event) => {
                                event.stopPropagation();
                                onOpenAccountManager(account);
                              }}
                            >
                              打开
                            </button>
                          </div>
                        </div>
                      ))}
                      {selectedSiteAccounts.length === 0 && (
                        <EmptyState title="当前站点还没有账号" detail="先在这个站点下添加一个账号。" compact />
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <EmptyState title="先选择一个站点" detail="点击上面的站点卡片, 这里会展示该站点的基础信息和账号列表。" compact />
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
          </div>
        ) : (
          <EmptyState title="还没有当前账号详情" detail="先登录并刷新当前账号。" compact />
        )}
      </SectionCard>
    </>
  );
}
