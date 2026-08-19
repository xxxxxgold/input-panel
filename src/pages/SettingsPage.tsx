import { type KeyboardEvent } from "react";
import {
  KeyRound,
  Layers3,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  UserPlus,
  Users,
  WalletCards
} from "lucide-react";

import type {
  AccountRuntime,
  SiteRecord,
  SubscriptionRecord
} from "../types";
import type { AccountSyncStatusPresentation } from "../app/account-sync-status-presentation";
import { formatTime } from "../shared/lib/formatters";
import { DetailItem } from "../shared/ui/DetailItem";
import { EmptyState } from "../shared/ui/EmptyState";
import { SectionCard } from "../shared/ui/SectionCard";
import { StatusBadge } from "../shared/ui/StatusBadge";
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
  currentAccountBalance,
  currentAccountTotalKeys,
  currentAccountActiveKeys,
  currentAccountSubscriptions,
  currentAccountSyncStatusPresentation,
  onOpenNewSite,
  onSelectSite,
  onOpenSiteAccountManager,
  onOpenEditSite,
  onRemoveSite,
  onOpenNewAccount,
  onSelectAccount,
  onEditAccount,
  onRemoveAccount,
  handleActionKey
}: {
  siteSearch: string;
  onSiteSearchChange: (value: string) => void;
  filteredSites: SiteRecord[];
  accounts: AccountRuntime[];
  selectedSite: SiteRecord | null;
  selectedAccountId: string | null;
  currentAccountBalance: number | null;
  currentAccountTotalKeys: number;
  currentAccountActiveKeys: number;
  currentAccountSubscriptions: SubscriptionRecord[];
  currentAccountSyncStatusPresentation: AccountSyncStatusPresentation;
  onOpenNewSite: () => void;
  onSelectSite: (siteId: string) => void;
  onOpenSiteAccountManager: (site: SiteRecord) => void;
  onOpenEditSite: (site: SiteRecord) => void;
  onRemoveSite: (siteId: string) => void;
  onOpenNewAccount: (siteId?: string) => void;
  onSelectAccount: (account: AccountRuntime) => void;
  onEditAccount: (account: AccountRuntime) => void;
  onRemoveAccount: (accountId: string) => void;
  handleActionKey: (event: KeyboardEvent<HTMLElement>, action: () => void) => void;
}) {
  const resolveAccountBalance = (account: AccountRuntime) =>
    account.id === selectedAccountId && currentAccountBalance !== null
      ? currentAccountBalance
      : account.cacheView?.balance ?? null;
  const selectedSiteAccounts = selectedSite ? accounts.filter((item) => item.siteId === selectedSite.id) : [];
  const selectedSiteBalance = selectedSiteAccounts.reduce((sum, item) => sum + (resolveAccountBalance(item) ?? 0), 0);
  const selectedSiteReadyCount = selectedSiteAccounts.filter((item) => item.sessionState === "ready").length;
  const selectedSiteLatestFetchedAt = selectedSiteAccounts
    .map((item) => item.cacheView?.fetchedAt ?? null)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.localeCompare(left))[0] ?? null;
  const currentAccount = accounts.find((item) => item.id === selectedAccountId) ?? null;
  const currentAccountDisplayName = currentAccount?.label.trim() || currentAccount?.email || "未命名账号";
  const currentAccountSiteName = currentAccount?.site?.name ?? selectedSite?.name ?? "未关联站点";
  const currentAccountSyncSummary = buildCurrentAccountSyncSummary(currentAccountSyncStatusPresentation);
  const siteSearchActive = siteSearch.trim().length > 0;

  return (
    <div className="settings-workbench">
      <section className="management-grid settings-site-management">
        <SectionCard
          title="站点管理"
          subtitle="在这里管理你的站点, 并查看每个站点下的账号情况"
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
                const siteBalance = siteAccounts.reduce((sum, item) => sum + (resolveAccountBalance(item) ?? 0), 0);
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
                    className={`context-card motion-surface-card ${siteCardSelected ? "selected" : ""}`}
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
                        <Pencil size={13} aria-hidden="true" />
                        编辑
                      </button>
                      <button
                        className="inline-text-button danger"
                        onClick={(event) => {
                          event.stopPropagation();
                          onRemoveSite(site.id);
                        }}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                        删除
                      </button>
                    </div>
                  </div>
                );
              })}
              {filteredSites.length === 0 && (
                <EmptyState
                  title={siteSearchActive ? "没有匹配的站点" : "还没有站点"}
                  detail={siteSearchActive ? "换个站点名称或 URL 试试。" : "先添加第一个站点, 再继续配置账号。"}
                  compact
                />
              )}
            </div>
            <div className={`request-detail-card site-detail-card ${selectedSite ? "detail-reveal-visible" : ""}`.trim()}>
              {selectedSite ? (
                <>
                  <div className="request-detail-head site-detail-head">
                    <div>
                      <strong>{selectedSite.name}</strong>
                      <p>{selectedSite.baseUrl}</p>
                    </div>
                    <div className="inline-actions wrap-actions">
                      <button type="button" className="inline-text-button" onClick={() => onOpenEditSite(selectedSite)}>
                        <Pencil size={13} aria-hidden="true" />
                        编辑站点
                      </button>
                      <button
                        type="button"
                        className="inline-text-button"
                        onClick={() => onOpenNewAccount(selectedSite.id)}
                      >
                        <UserPlus size={13} aria-hidden="true" />
                        加账号
                      </button>
                      <button
                        type="button"
                        className="inline-text-button"
                        onClick={() => onOpenSiteAccountManager(selectedSite)}
                      >
                        <Users size={13} aria-hidden="true" />
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
                      {selectedSiteAccounts.map((account) => {
                        const isSelected = selectedAccountId === account.id;
                        const accountBalance = resolveAccountBalance(account);
                        const totalKeys = isSelected
                          ? currentAccountTotalKeys
                          : account.cacheView?.stats.totalApiKeys ?? 0;
                        const activeKeys = isSelected
                          ? currentAccountActiveKeys
                          : account.cacheView?.stats.activeApiKeys ?? 0;
                        const siteAccountRowAction = runSiteAccountRowAction({
                          account,
                          onSelectAccount,
                          onEditAccount
                        });
                        return (
                          <div
                            key={account.id}
                            className={`table-row wide account-row-trigger site-account-row motion-surface-card ${isSelected ? "selected" : ""}`}
                            onClick={siteAccountRowAction.handleClick}
                            onDoubleClick={siteAccountRowAction.handleDoubleClick}
                            onKeyDown={(event) => handleActionKey(event, siteAccountRowAction.handleClick)}
                            role="button"
                            aria-pressed={isSelected}
                            tabIndex={0}
                            title={`${account.label}: 单击选中, 双击编辑`}
                          >
                            <div className="row-main">
                              <strong>{account.label}</strong>
                              <p>{account.email}</p>
                              <small>{account.cacheView ? `最近同步 ${formatTime(account.cacheView.fetchedAt)}` : "当前还没有同步"}</small>
                            </div>
                            <div className="row-meta">
                              <span>余额 {accountBalance !== null ? `$${accountBalance.toFixed(2)}` : "-"}</span>
                              <span>Keys {totalKeys} / 活跃 {activeKeys}</span>
                            </div>
                            <div className="row-actions">
                              <StatusBadge state={account.sessionState} />
                              <button
                                type="button"
                                className="inline-text-button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onEditAccount(account);
                                }}
                              >
                                <Pencil size={13} aria-hidden="true" />
                                编辑
                              </button>
                              <button
                                type="button"
                                className="inline-text-button danger"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onRemoveAccount(account.id);
                                }}
                              >
                                <Trash2 size={13} aria-hidden="true" />
                                删除
                              </button>
                            </div>
                          </div>
                        );
                      })}
                      {selectedSiteAccounts.length === 0 && (
                        <EmptyState title="当前站点还没有账号" detail="先在这个站点下添加一个账号。" compact />
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <EmptyState title="先选择一个站点" detail="点击上面的站点卡片, 这里会显示这个站点的账号和基本信息。" compact />
              )}
            </div>
          </div>
        </SectionCard>
      </section>

      <div className="settings-account-detail">
        <SectionCard
          title="当前账号详情"
          subtitle={currentAccount ? `${currentAccountDisplayName} / ${currentAccountSiteName}` : "尚未选择账号"}
        >
          <div className="stack-list">
            {currentAccount && (
              <div className="settings-account-identity">
                <span className="settings-account-avatar" aria-hidden="true">
                  {currentAccountDisplayName.slice(0, 1).toUpperCase()}
                </span>
                <div className="settings-account-identity-copy">
                  <span>当前账号</span>
                  <strong>{currentAccountDisplayName}</strong>
                  <p>{currentAccount.email}</p>
                </div>
                <div className="settings-account-identity-meta">
                  <StatusBadge state={currentAccount.sessionState} />
                  <span className="settings-account-site">{currentAccountSiteName}</span>
                  <button
                    type="button"
                    className="inline-text-button"
                    onClick={() => onEditAccount(currentAccount)}
                  >
                    <Pencil size={13} />
                    编辑账号
                  </button>
                </div>
              </div>
            )}
            <div className="settings-account-sync">
              <span className="settings-account-sync-icon" aria-hidden="true">
                <RefreshCw size={17} />
              </span>
              <div className="settings-account-sync-copy">
                <span>同步状态</span>
                <strong>{currentAccountSyncSummary.label}</strong>
              </div>
              {currentAccountSyncSummary.detail && (
                <div className="settings-account-sync-detail">
                  <span>{currentAccountSyncSummary.detailLabel}</span>
                  <strong>{currentAccountSyncSummary.detail}</strong>
                </div>
              )}
            </div>
            {currentAccountBalance !== null ? (
              <>
                <div className="account-detail-summary-grid">
                  <div className="summary-stat compact-stat settings-account-stat">
                    <WalletCards size={18} aria-hidden="true" />
                    <div>
                      <span>余额</span>
                      <strong>${currentAccountBalance.toFixed(2)}</strong>
                    </div>
                  </div>
                  <div className="summary-stat compact-stat settings-account-stat">
                    <Layers3 size={18} aria-hidden="true" />
                    <div>
                      <span>订阅总数</span>
                      <strong>{currentAccountSubscriptions.length}</strong>
                    </div>
                  </div>
                  <div className="summary-stat compact-stat settings-account-stat">
                    <KeyRound size={18} aria-hidden="true" />
                    <div>
                      <span>Key 总数 / 活跃</span>
                      <strong>{currentAccountTotalKeys} / {currentAccountActiveKeys}</strong>
                    </div>
                  </div>
                </div>
                <div className="stack-list account-detail-stack">
                  <div className="account-detail-column">
                    <div className="settings-account-section-head">
                      <div>
                        <span>订阅概览</span>
                        <strong>全部订阅</strong>
                      </div>
                      <span>{currentAccountSubscriptions.length} 项</span>
                    </div>
                    <SubscriptionList subscriptions={currentAccountSubscriptions} />
                  </div>
                </div>
              </>
            ) : (
              <EmptyState
                title="还没有当前账号详情"
                detail={buildCurrentAccountEmptyStateDetail(currentAccountSyncSummary)}
                compact
              />
            )}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

function buildCurrentAccountSyncSummary(presentation: AccountSyncStatusPresentation) {
  if (!presentation.hasSnapshot) {
    if (presentation.lastError) {
      return {
        label: "同步状态暂不可读取",
        detailLabel: "读取失败",
        detail: presentation.lastError
      };
    }

    return {
      label: "正在读取同步状态",
      detailLabel: "",
      detail: ""
    };
  }

  const syncStatuses = presentation.statuses;
  const withRetainedRefreshError = (summary: {
    label: string;
    detailLabel: string;
    detail: string;
  }) => presentation.lastError
    ? {
        ...summary,
        detailLabel: "刷新失败",
        detail: `已保留上次读取结果: ${presentation.lastError}`
      }
    : summary;

  if (syncStatuses.length === 0) {
    return withRetainedRefreshError({
      label: "从未同步",
      detailLabel: "",
      detail: ""
    });
  }

  const running = syncStatuses.filter((item) => item.state === "running");
  if (running.length > 0) {
    return withRetainedRefreshError({
      label: `同步中 (${running.length})`,
      detailLabel: "当前作用域",
      detail: running.map((item) => item.scope).join(", ")
    });
  }

  const failed = syncStatuses.find((item) => item.state === "failed");
  if (failed) {
    return {
      label: `同步失败 (${failed.scope})`,
      detailLabel: "失败原因",
      detail: failed.lastError ?? "请稍后重试"
    };
  }

  const latestSuccess = syncStatuses
    .map((item) => item.lastSuccessAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);

  return withRetainedRefreshError({
    label: latestSuccess ? `最近成功 ${formatTime(latestSuccess)}` : "已同步",
    detailLabel: "",
    detail: ""
  });
}

function buildCurrentAccountEmptyStateDetail(
  syncSummary: ReturnType<typeof buildCurrentAccountSyncSummary>
) {
  if (syncSummary.label.startsWith("同步中")) {
    return "当前账号正在更新数据, 完成后这里会显示余额和订阅。";
  }

  if (syncSummary.label.startsWith("同步失败")) {
    return syncSummary.detail
      ? `最近一次同步失败: ${syncSummary.detail}`
      : "最近一次同步失败, 请稍后重试。";
  }

  if (syncSummary.label === "同步状态暂不可读取") {
    return syncSummary.detail
      ? `同步状态读取失败: ${syncSummary.detail}`
      : "同步状态暂不可读取, 请稍后重试。";
  }

  if (syncSummary.label === "从未同步") {
    return "先登录并刷新账号, 这里才会显示详细内容。";
  }

  return "当前账号已经有更新记录, 但暂时还没有可展示的详情。";
}
