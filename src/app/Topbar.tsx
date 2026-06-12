import { Bell, ChevronDown, Crown, RefreshCw, Search, Server, Settings2, UserRound } from "lucide-react";
import { useEffect, useState, type MutableRefObject } from "react";

import type { AccountRuntime, SiteRecord, SnapshotAlert } from "../types";
import { formatTime, formatUsd, maskEmail } from "../shared/lib/formatters";
import type { TopbarSubscriptionPreviewRecord } from "../subscription-view";
import { StatusBadge } from "../shared/ui/StatusBadge";

export function Topbar({
  onReload,
  alertCount,
  topbarAlertsExpanded,
  setTopbarAlertsExpanded,
  topbarAlertsRef,
  topbarAlertPreview,
  closeTopbarAccountMenu,
  setTopbarSubscriptionsExpanded,
  topbarSubscriptionsExpanded,
  topbarSubscriptionsRef,
  usageStatusLabel,
  usageStatusHint,
  subscriptionSpend,
  subscriptionCount,
  subscriptionPreviewRecords,
  closeTopbarPeekPanels,
  onOpenAlerts,
  onOpenSubscriptions,
  selectedAccount,
  topbarAccountMenuOpen,
  setTopbarAccountMenuOpen,
  topbarAccountMenuRef,
  selectedAccountStatusLabel,
  selectedAccountAvatarUrl,
  selectedSite,
  topbarFilteredAccounts,
  accounts,
  topbarAccountSearch,
  setTopbarAccountSearch,
  onAccountSelect,
  onOpenProfileModal,
  onOpenSystemSettings,
  onOpenSettings,
  onRefreshSelectedAccount,
  onOpenSelectedAccountLogin
}: {
  onReload: () => void;
  alertCount: number;
  topbarAlertsExpanded: boolean;
  setTopbarAlertsExpanded: (value: boolean) => void;
  topbarAlertsRef: MutableRefObject<HTMLDivElement | null>;
  topbarAlertPreview: SnapshotAlert[];
  closeTopbarAccountMenu: () => void;
  setTopbarSubscriptionsExpanded: (value: boolean) => void;
  topbarSubscriptionsExpanded: boolean;
  topbarSubscriptionsRef: MutableRefObject<HTMLDivElement | null>;
  usageStatusLabel: string;
  usageStatusHint: string;
  subscriptionSpend: number;
  subscriptionCount: number;
  subscriptionPreviewRecords: TopbarSubscriptionPreviewRecord[];
  closeTopbarPeekPanels: () => void;
  onOpenAlerts: () => void;
  onOpenSubscriptions: () => void;
  selectedAccount: AccountRuntime | null;
  topbarAccountMenuOpen: boolean;
  setTopbarAccountMenuOpen: (value: boolean) => void;
  topbarAccountMenuRef: MutableRefObject<HTMLDivElement | null>;
  selectedAccountStatusLabel: string;
  selectedAccountAvatarUrl: string | null;
  selectedSite: SiteRecord | null;
  topbarFilteredAccounts: AccountRuntime[];
  accounts: AccountRuntime[];
  topbarAccountSearch: string;
  setTopbarAccountSearch: (value: string) => void;
  onAccountSelect: (account: AccountRuntime) => void;
  onOpenProfileModal: () => void;
  onOpenSystemSettings: () => void;
  onOpenSettings: () => void;
  onRefreshSelectedAccount: () => void;
  onOpenSelectedAccountLogin: () => void;
}) {
  const [avatarLoadFailed, setAvatarLoadFailed] = useState(false);

  useEffect(() => {
    setAvatarLoadFailed(false);
  }, [selectedAccountAvatarUrl]);

  const avatarFallback = (selectedAccount?.label || selectedAccount?.email || "A").slice(0, 1).toUpperCase();
  const avatarUrl = selectedAccountAvatarUrl && !avatarLoadFailed ? selectedAccountAvatarUrl : null;

  return (
    <header className="global-topbar">
      <div className="header-actions global-topbar-actions">
        <div className="global-topbar-grid">
          <button
            type="button"
            className="topbar-peek-trigger topbar-quick-action"
            onClick={onReload}
            aria-label="重新加载"
            title="重新加载"
          >
            <RefreshCw size={16} />
          </button>

          <div className={`topbar-peek-card peek-align-right ${topbarAlertsExpanded ? "expanded" : ""}`} ref={topbarAlertsRef}>
            <button
              type="button"
              className="topbar-peek-trigger"
              onClick={() => {
                const nextOpen = !topbarAlertsExpanded;
                if (nextOpen) {
                  closeTopbarAccountMenu();
                }
                setTopbarAlertsExpanded(nextOpen);
                setTopbarSubscriptionsExpanded(false);
              }}
              aria-expanded={topbarAlertsExpanded}
              aria-label="通知详情"
            >
              <Bell size={18} />
            </button>
            <div className="topbar-card topbar-peek-panel topbar-alert-panel">
              <div className="topbar-alert-head">
                <div className="topbar-card-icon">
                  <Bell size={18} />
                </div>
                <div className="topbar-card-copy">
                  <span className="topbar-card-label">通知</span>
                  <strong>{alertCount === 0 ? "全部正常" : `${alertCount} 条待处理`}</strong>
                  <p>{alertCount === 0 ? "当前没有新的余额或订阅告警" : "以下是当前最需要处理的告警"}</p>
                </div>
                <span className={`status-pill ${alertCount > 0 ? "critical" : "ready"}`}>
                  {alertCount === 0 ? "静默" : "提醒"}
                </span>
              </div>
              {topbarAlertPreview.length > 0 ? (
                <div className="topbar-alert-list">
                  {topbarAlertPreview.map((alert) => (
                    <div key={alert.id} className={`topbar-alert-item ${alert.severity}`}>
                      <div className="topbar-alert-copy">
                        <strong>{alert.title}</strong>
                        <p>{alert.detail}</p>
                      </div>
                      <span className="topbar-alert-time">{formatTime(alert.createdAt)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="topbar-alert-empty">当前没有新的余额或订阅告警</p>
              )}
              <button type="button" className="topbar-peek-action" onClick={onOpenAlerts}>
                打开告警中心
              </button>
            </div>
          </div>

          <div
            className={`topbar-peek-card peek-align-right ${topbarSubscriptionsExpanded ? "expanded" : ""}`}
            ref={topbarSubscriptionsRef}
            onMouseEnter={() => {
              closeTopbarAccountMenu();
              setTopbarAlertsExpanded(false);
              setTopbarSubscriptionsExpanded(true);
            }}
            onMouseLeave={() => setTopbarSubscriptionsExpanded(false)}
          >
            <button
              type="button"
              className="topbar-peek-trigger"
              onClick={() => {
                const nextOpen = !topbarSubscriptionsExpanded;
                if (nextOpen) {
                  closeTopbarAccountMenu();
                }
                setTopbarSubscriptionsExpanded(nextOpen);
                setTopbarAlertsExpanded(false);
              }}
              aria-expanded={topbarSubscriptionsExpanded}
              aria-label="订阅使用情况详情"
            >
              <Crown size={18} />
              {subscriptionPreviewRecords.length > 0 && (
                <span className="topbar-subscription-dots" aria-hidden="true">
                  {subscriptionPreviewRecords.map((subscription) => (
                    <span
                      key={subscription.id}
                      className={`topbar-subscription-dot ${subscription.indicatorTone}`}
                    />
                  ))}
                </span>
              )}
            </button>
            <div className="topbar-card topbar-peek-panel topbar-subscription-panel">
              <div className="topbar-subscription-head">
                <div className="topbar-card-icon">
                  <Crown size={18} />
                </div>
                <div className="topbar-card-copy">
                  <span className="topbar-card-label">订阅使用情况</span>
                  <strong>{usageStatusLabel}</strong>
                  <p>{usageStatusHint}</p>
                </div>
                <span className="topbar-metric">
                  {subscriptionSpend > 0 ? formatUsd(subscriptionSpend, 2) : subscriptionCount.toString()}
                </span>
              </div>
              {subscriptionPreviewRecords.length > 0 ? (
                <div className="topbar-subscription-list">
                  {subscriptionPreviewRecords.map((subscription) => (
                    <div key={subscription.id} className="topbar-subscription-item">
                      <div className="topbar-subscription-item-head">
                        <div className="topbar-subscription-item-copy">
                          <strong>{subscription.name}</strong>
                          <p>{subscription.remainingDaysLabel}</p>
                        </div>
                        <span className={`status-pill ${subscription.quotaProgress ? "ready" : subscription.indicatorTone.replace("subscription-dot-", "")}`}>
                          {subscription.quota ? subscription.quota.label : subscription.statusLabel}
                        </span>
                      </div>
                      {subscription.quota && subscription.quotaProgress ? (
                        <>
                          <div className="topbar-subscription-amounts">
                            <span>{subscription.quota.label}</span>
                            <strong>{formatUsd(subscription.quota.used, 2)} / {formatUsd(subscription.quota.limit, 2)}</strong>
                          </div>
                          <div className="topbar-subscription-bar-track">
                            <div
                              className={`topbar-subscription-bar-fill ${subscription.quotaProgress.tone}`}
                              style={{ width: `${subscription.quotaProgress.percent}%` }}
                            />
                          </div>
                        </>
                      ) : (
                        <p className="topbar-subscription-status-note">{subscription.statusLabel}</p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="topbar-alert-empty">当前没有订阅数据</p>
              )}
              <button type="button" className="topbar-peek-action" onClick={onOpenSubscriptions}>
                打开订阅页
              </button>
            </div>
          </div>
        </div>
        {selectedAccount && (
          <div className={`topbar-account-menu ${topbarAccountMenuOpen ? "open" : ""}`} ref={topbarAccountMenuRef}>
            <button
              type="button"
              className="topbar-account-trigger"
              onClick={() => {
                if (topbarAccountMenuOpen) {
                  closeTopbarAccountMenu();
                  return;
                }
                closeTopbarPeekPanels();
                setTopbarAccountMenuOpen(true);
              }}
              aria-expanded={topbarAccountMenuOpen}
              aria-label="当前账号菜单"
            >
              <div className="topbar-account-trigger-copy">
                <strong>{selectedAccount.label || "当前账号"}</strong>
                <span>{selectedAccountStatusLabel}</span>
              </div>
              <div className={`topbar-account-avatar ${avatarUrl ? "has-image" : ""}`} aria-hidden="true">
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt=""
                    loading="eager"
                    referrerPolicy="no-referrer"
                    onError={() => setAvatarLoadFailed(true)}
                  />
                ) : (
                  avatarFallback
                )}
              </div>
              <ChevronDown size={16} className={`site-picker-icon ${topbarAccountMenuOpen ? "open" : ""}`} />
            </button>
            {topbarAccountMenuOpen && (
              <div className="topbar-account-dropdown">
                <div className="topbar-account-summary">
                  <strong>{selectedAccount.label || "当前账号"}</strong>
                  <p>{selectedAccount.site?.name ?? selectedSite?.name ?? "未知站点"}</p>
                </div>
                <div className="topbar-account-switcher">
                  <div className="topbar-account-section-head">
                    <strong>切换账号</strong>
                    <span>
                      {topbarFilteredAccounts.length === accounts.length
                        ? "全部账号"
                        : `${topbarFilteredAccounts.length} / ${accounts.length}`}
                    </span>
                  </div>
                  <label className="topbar-account-search-field" aria-label="筛选账号">
                    <Search size={14} />
                    <input
                      type="text"
                      autoFocus
                      value={topbarAccountSearch}
                      onChange={(event) => setTopbarAccountSearch(event.target.value)}
                      placeholder="搜索账号 / 站点 / 邮箱"
                    />
                  </label>
                  <div className="topbar-account-switcher-list">
                    {topbarFilteredAccounts.map((account) => (
                      <button
                        key={account.id}
                        type="button"
                        className={`topbar-account-option ${selectedAccount.id === account.id ? "selected" : ""}`}
                        onClick={() => onAccountSelect(account)}
                      >
                        <div className="topbar-account-option-copy">
                          <strong>{account.label || maskEmail(account.email)}</strong>
                          <span>{`${account.site?.name ?? "未知站点"} · ${account.email}`}</span>
                        </div>
                        <StatusBadge state={account.sessionState} />
                      </button>
                    ))}
                    {topbarFilteredAccounts.length === 0 && (
                      <div className="topbar-account-empty">没有匹配的账号, 试试搜索站点名或邮箱。</div>
                    )}
                  </div>
                </div>
                <div className="topbar-account-divider" />
                <button type="button" className="topbar-account-item" onClick={onOpenProfileModal}>
                  <UserRound size={16} />
                  <span>个人中心</span>
                </button>
                <button type="button" className="topbar-account-item" onClick={onOpenSystemSettings}>
                  <Settings2 size={16} />
                  <span>设置</span>
                </button>
                <button type="button" className="topbar-account-item" onClick={onOpenSettings}>
                  <Server size={16} />
                  <span>站点账号配置</span>
                </button>
                <button type="button" className="topbar-account-item" onClick={onRefreshSelectedAccount}>
                  <RefreshCw size={16} />
                  <span>刷新账号</span>
                </button>
                <button type="button" className="topbar-account-item danger" onClick={onOpenSelectedAccountLogin}>
                  <UserRound size={16} />
                  <span>登录当前账号</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
