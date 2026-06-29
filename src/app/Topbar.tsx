import { Activity, Bell, ChevronDown, Crown, RefreshCw, Search, Server, Settings2, UserRound } from "lucide-react";
import { useEffect, useState, type MutableRefObject } from "react";

import type { AccountRuntime, ServiceStatusPayload, SiteRecord, AccountAlert } from "../types";
import { formatLiveClockDate, formatLiveClockTime, formatMilliseconds, formatPercent, formatTime, formatUsd, maskEmail } from "../shared/lib/formatters";
import { getSubscriptionStatusPresentation, type TopbarSubscriptionPreviewRecord } from "../subscription-view";
import { StatusBadge } from "../shared/ui/StatusBadge";

export function Topbar({
  onReload,
  serviceStatus,
  serviceStatusLastSyncedAt,
  serviceStatusRefreshing,
  topbarServiceStatusExpanded,
  setTopbarServiceStatusExpanded,
  topbarServiceStatusRef,
  alertCount,
  topbarAlertsExpanded,
  setTopbarAlertsExpanded,
  topbarAlertsRef,
  topbarAlertPreview,
  latestUnreadAlertSeverity,
  closeTopbarAccountMenu,
  setTopbarSubscriptionsExpanded,
  topbarSubscriptionsExpanded,
  topbarSubscriptionsRef,
  previewTopbarPeek,
  clearTopbarPeekPreview,
  toggleTopbarPeek,
  usageStatusLabel,
  usageStatusHint,
  subscriptionSpend,
  subscriptionCount,
  subscriptionPreviewRecords,
  closeTopbarPeekPanels,
  onRefreshServiceStatus,
  serviceStatusRefreshIntervalSeconds,
  onTriggerTestNotification,
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
  serviceStatus: ServiceStatusPayload | null;
  serviceStatusLastSyncedAt?: number | null;
  serviceStatusRefreshing: boolean;
  topbarServiceStatusExpanded: boolean;
  setTopbarServiceStatusExpanded: (value: boolean) => void;
  topbarServiceStatusRef: MutableRefObject<HTMLDivElement | null>;
  alertCount: number;
  topbarAlertsExpanded: boolean;
  setTopbarAlertsExpanded: (value: boolean) => void;
  topbarAlertsRef: MutableRefObject<HTMLDivElement | null>;
  topbarAlertPreview: AccountAlert[];
  latestUnreadAlertSeverity: "critical" | "high" | "medium" | "low" | "success" | "info" | null;
  closeTopbarAccountMenu: () => void;
  setTopbarSubscriptionsExpanded: (value: boolean) => void;
  topbarSubscriptionsExpanded: boolean;
  topbarSubscriptionsRef: MutableRefObject<HTMLDivElement | null>;
  previewTopbarPeek: (key: "serviceStatus" | "alerts" | "subscriptions") => void;
  clearTopbarPeekPreview: (key: "serviceStatus" | "alerts" | "subscriptions") => void;
  toggleTopbarPeek: (key: "serviceStatus" | "alerts" | "subscriptions") => void;
  usageStatusLabel: string;
  usageStatusHint: string;
  subscriptionSpend: number;
  subscriptionCount: number;
  subscriptionPreviewRecords: TopbarSubscriptionPreviewRecord[];
  closeTopbarPeekPanels: () => void;
  onRefreshServiceStatus: () => void;
  serviceStatusRefreshIntervalSeconds: number;
  onTriggerTestNotification: (kind: "down" | "recovered") => void;
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
  const [clockNow, setClockNow] = useState(() => new Date());

  useEffect(() => {
    setAvatarLoadFailed(false);
  }, [selectedAccountAvatarUrl]);

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setClockNow(new Date());
    }, 1000);

    return () => {
      window.clearInterval(timerId);
    };
  }, []);

  const avatarFallback = (selectedAccount?.label || selectedAccount?.email || "A").slice(0, 1).toUpperCase();
  const avatarUrl = selectedAccountAvatarUrl && !avatarLoadFailed ? selectedAccountAvatarUrl : null;
  const serviceStatusRecords = serviceStatus?.services ?? [];
  const serviceStatusOnlineCount = serviceStatusRecords.filter((item) => item.last?.ok).length;
  const serviceStatusSyncLabel = serviceStatus
    ? formatLiveClockTime(
      new Date(serviceStatusLastSyncedAt ?? serviceStatus.generatedAt * 1000)
    )
    : "";
  const alertBadgeToneClass = resolveAlertBadgeToneClass(latestUnreadAlertSeverity);
  const serviceStatusUnavailable = !selectedAccount;
  const subscriptionSummary = resolveSubscriptionSummaryMeta({
    usageStatusLabel,
    subscriptionCount,
    subscriptionPreviewRecords
  });

  function handlePeekMouseEnter(key: "serviceStatus" | "alerts" | "subscriptions") {
    closeTopbarAccountMenu();
    previewTopbarPeek(key);
  }

  function handlePeekMouseLeave(key: "serviceStatus" | "alerts" | "subscriptions") {
    clearTopbarPeekPreview(key);
  }

  function handlePeekClick(key: "serviceStatus" | "alerts" | "subscriptions") {
    toggleTopbarPeek(key);
  }

  return (
    <header className="global-topbar">
      <div className="topbar-leading">
        <div className="topbar-card topbar-context-card topbar-clock-card" aria-live="polite">
          <div className="topbar-clock-indicator" aria-hidden="true">
            <span className="topbar-clock-dot" />
          </div>
          <div className="topbar-card-copy topbar-clock-copy">
            <p className="topbar-clock-meta">{formatLiveClockDate(clockNow)}</p>
            <strong className="topbar-clock-time">{formatLiveClockTime(clockNow)}</strong>
          </div>
        </div>
      </div>
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
          <button
            type="button"
            className="topbar-peek-trigger topbar-test-trigger critical"
            onClick={() => onTriggerTestNotification("down")}
            aria-label="测试红色通知"
            title="测试红色通知"
          >
            <Bell size={16} />
          </button>
          <button
            type="button"
            className="topbar-peek-trigger topbar-test-trigger success"
            onClick={() => onTriggerTestNotification("recovered")}
            aria-label="测试绿色通知"
            title="测试绿色通知"
          >
            <Bell size={16} />
          </button>

          <div
            className={`topbar-peek-card peek-align-right ${topbarServiceStatusExpanded ? "expanded" : ""}`}
            ref={topbarServiceStatusRef}
            onMouseEnter={() => handlePeekMouseEnter("serviceStatus")}
            onMouseLeave={() => handlePeekMouseLeave("serviceStatus")}
          >
            <button
              type="button"
              className="topbar-peek-trigger"
              onClick={() => handlePeekClick("serviceStatus")}
              aria-expanded={topbarServiceStatusExpanded}
              aria-label="服务状态详情"
            >
              <Activity size={18} />
              {serviceStatusRecords.length > 0 && (
                <span className="topbar-subscription-dots topbar-service-status-dots" aria-hidden="true">
                  {serviceStatusRecords.map((service) => (
                    <span
                      key={service.model}
                      className={`topbar-subscription-dot ${service.last?.ok ? "subscription-dot-ready" : "subscription-dot-critical"}`}
                    />
                  ))}
                </span>
              )}
            </button>
            <div className="topbar-card topbar-peek-panel topbar-subscription-panel topbar-service-status-panel">
              <div className="topbar-subscription-head">
                <div className="topbar-card-icon">
                  <Activity size={18} />
                </div>
                <div className="topbar-card-copy">
                  <span className="topbar-card-label">服务状态</span>
                  <strong>{serviceStatusUnavailable ? "未配置账号" : serviceStatus ? serviceStatus.allOk ? `${serviceStatusOnlineCount} / ${serviceStatusRecords.length} 正常` : `${serviceStatusOnlineCount} / ${serviceStatusRecords.length} 正常, 存在异常` : "等待同步"}</strong>
                  <p>
                    {serviceStatusUnavailable
                      ? "先登录一个账号后再自动监控服务状态"
                      : serviceStatus
                        ? `每 ${serviceStatusRefreshIntervalSeconds} 秒刷新一次最新探测结果 · 上次同步 ${serviceStatusSyncLabel}`
                        : "等待服务状态接口返回"}
                  </p>
                </div>
                <span className="topbar-metric">
                  {serviceStatusUnavailable ? "-" : serviceStatus ? `${serviceStatusRecords.length} 模型` : "-"}
                </span>
              </div>
              {serviceStatusUnavailable ? (
                <p className="topbar-alert-empty">未配置账号时不启动服务状态监控</p>
              ) : serviceStatusRecords.length > 0 ? (
                <div className="topbar-subscription-list">
                  {serviceStatusRecords.map((service) => (
                    <div key={service.model} className="topbar-subscription-item topbar-service-status-item">
                      <div className="topbar-subscription-item-head">
                        <div className="topbar-subscription-item-copy">
                          <strong>{service.model}</strong>
                          <p>
                            {service.last?.ok ? "最新探测正常" : "最新探测失败"}
                            {service.last ? ` · ${formatTime(new Date(service.last.ts * 1000).toISOString())}` : ""}
                          </p>
                        </div>
                        <span className={`status-pill ${service.last?.ok ? "ready" : "critical"}`}>
                          {service.last?.ok ? "正常" : "失败"}
                        </span>
                      </div>
                      <div className="topbar-subscription-amounts topbar-service-status-amounts">
                        <span>可用率 {service.uptimePct.toFixed(2)}%</span>
                        <strong>{formatMilliseconds(service.last?.latencyMs)}</strong>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="topbar-alert-empty">当前没有服务状态数据</p>
              )}
              <button type="button" className="topbar-peek-action" onClick={onRefreshServiceStatus} disabled={serviceStatusUnavailable}>
                {serviceStatusRefreshing ? "刷新中..." : "立即刷新服务状态"}
              </button>
            </div>
          </div>

          <div
            className={`topbar-peek-card peek-align-right ${topbarAlertsExpanded ? "expanded" : ""}`}
            ref={topbarAlertsRef}
            onMouseEnter={() => handlePeekMouseEnter("alerts")}
            onMouseLeave={() => handlePeekMouseLeave("alerts")}
          >
            <button
              type="button"
              className="topbar-peek-trigger"
              onClick={() => handlePeekClick("alerts")}
              aria-expanded={topbarAlertsExpanded}
              aria-label="消息盒子"
            >
              <Bell size={18} />
              {alertBadgeToneClass ? (
                <span
                  className={`topbar-alert-badge ${alertBadgeToneClass}`}
                  aria-hidden="true"
                />
              ) : null}
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
                    <button
                      key={alert.id}
                      type="button"
                      className={`topbar-alert-item topbar-alert-item-button ${alert.severity}`}
                      onClick={onOpenAlerts}
                      aria-label={`打开消息盒子: ${alert.title}`}
                    >
                      <div className="topbar-alert-copy">
                        <strong>{alert.title}</strong>
                        <p>{alert.detail}</p>
                      </div>
                      <span className="topbar-alert-time">{formatTime(alert.createdAt)}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="topbar-alert-empty">当前没有新的余额或订阅告警</p>
              )}
              <button type="button" className="topbar-peek-action" onClick={onOpenAlerts}>
                打开消息盒子
              </button>
            </div>
          </div>

          <div
            className={`topbar-peek-card peek-align-right ${topbarSubscriptionsExpanded ? "expanded" : ""}`}
            ref={topbarSubscriptionsRef}
            onMouseEnter={() => handlePeekMouseEnter("subscriptions")}
            onMouseLeave={() => handlePeekMouseLeave("subscriptions")}
          >
            <button
              type="button"
              className="topbar-peek-trigger"
              onClick={() => handlePeekClick("subscriptions")}
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
              <div className="topbar-subscription-head topbar-subscription-summary-head">
                <div className="topbar-card-icon">
                  <Crown size={18} />
                </div>
                <div className="topbar-card-copy">
                  <span className="topbar-card-label">订阅使用情况</span>
                  <div className="topbar-subscription-summary-line">
                    <span className={`status-pill ${subscriptionSummary.statusTone}`}>
                      {subscriptionSummary.statusLabel}
                    </span>
                    <span className="topbar-subscription-summary-count">{subscriptionSummary.countLabel}</span>
                  </div>
                  <p>{usageStatusHint}</p>
                </div>
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
                            <span>{`${subscription.quota.label} ${formatPercent(subscription.quotaProgress.rawPercent, 1)}`}</span>
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
        {selectedAccount ? (
          <div
            className={`topbar-account-menu ${topbarAccountMenuOpen ? "open" : ""}`}
            ref={topbarAccountMenuRef}
            onMouseEnter={() => closeTopbarPeekPanels()}
          >
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
        ) : (
          <button
            type="button"
            className="topbar-account-trigger topbar-account-login-trigger"
            onClick={() => {
              closeTopbarPeekPanels();
              onOpenSettings();
            }}
            aria-label="登录并前往站点账号配置"
          >
            <div className="topbar-account-trigger-copy">
              <strong>登录</strong>
              <span>前往站点账号配置</span>
            </div>
            <div className="topbar-account-avatar topbar-account-login-avatar" aria-hidden="true">
              <UserRound size={14} />
            </div>
          </button>
        )}
      </div>
    </header>
  );
}

function resolveAlertBadgeToneClass(severity: "critical" | "high" | "medium" | "low" | "success" | "info" | null) {
  if (!severity) {
    return null;
  }
  if (severity === "critical" || severity === "high") {
    return "topbar-alert-badge-critical";
  }
  if (severity === "success" || severity === "low") {
    return "topbar-alert-badge-success";
  }
  return "topbar-alert-badge-neutral";
}

function resolveSubscriptionSummaryMeta(input: {
  usageStatusLabel: string;
  subscriptionCount: number;
  subscriptionPreviewRecords: TopbarSubscriptionPreviewRecord[];
}) {
  const countLabel = input.subscriptionCount > 0
    ? /^\d+\s*个/.test(input.usageStatusLabel.trim())
      ? input.usageStatusLabel.trim()
      : `${input.subscriptionCount} 个订阅`
    : "暂无订阅";
  const subscriptionStatusPresentations = input.subscriptionPreviewRecords.map((record) =>
    getSubscriptionStatusPresentation(record.status)
  );

  if (subscriptionStatusPresentations.some((item) => item.tone === "critical")) {
    return {
      statusLabel: "异常",
      statusTone: "critical" as const,
      countLabel
    };
  }

  if (subscriptionStatusPresentations.some((item) => item.tone === "neutral")) {
    return {
      statusLabel: "待生效",
      statusTone: "neutral" as const,
      countLabel
    };
  }

  if (subscriptionStatusPresentations.length > 0) {
    return {
      statusLabel: "正常",
      statusTone: "ready" as const,
      countLabel
    };
  }

  if (input.usageStatusLabel.includes("等待")) {
    return {
      statusLabel: "等待同步",
      statusTone: "neutral" as const,
      countLabel
    };
  }

  if (input.usageStatusLabel.includes("同步")) {
    return {
      statusLabel: "已同步",
      statusTone: "ready" as const,
      countLabel
    };
  }

  const statusPresentation = getSubscriptionStatusPresentation(input.usageStatusLabel);
  if (statusPresentation.label !== "未知状态") {
    return {
      statusLabel: statusPresentation.label,
      statusTone: statusPresentation.tone,
      countLabel
    };
  }

  return {
    statusLabel: "等待同步",
    statusTone: "neutral" as const,
    countLabel
  };
}
