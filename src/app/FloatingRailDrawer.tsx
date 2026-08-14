import { Activity, CheckCheck, CircleAlert, Copy, Crown, Radar, Server } from "lucide-react";
import { useEffect, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from "react";

import type {
  CodexRadarModelIqPayload,
  PublicEndpointRecord,
  ServiceStatusPayload,
  SitePublicEndpointsPayload,
  SiteRecord
} from "../types";
import { formatLiveClockTime, formatMilliseconds, formatPercent, formatTime, formatUsd } from "../shared/lib/formatters";
import { copyTextToClipboard } from "../shared/lib/clipboard";
import { CodexRadarEffortPill } from "../features/overview/CodexRadarEffortPill";
import {
  getCodexRadarModelDisplayName,
  getCodexRadarStatusPresentation
} from "../features/overview/codex-radar-presentation";
import { type TopbarSubscriptionPreviewRecord } from "../subscription-view";

export type FloatingRailDrawerPanelKey = "siteEndpoints" | "serviceStatus" | "codexRadar" | "subscriptions";

const DEFAULT_PANEL: FloatingRailDrawerPanelKey = "siteEndpoints";
const DRAWER_SCROLL_REVEAL_DELAY_MS = 240;

export function FloatingRailDrawer({
  activePanel,
  onActivePanelChange,
  selectedSite,
  sitePublicEndpoints = null,
  sitePublicEndpointsLoading = false,
  sitePublicEndpointsSyncing = false,
  sitePublicEndpointsPinging = false,
  sitePublicEndpointsLastError = null,
  onRetrySitePublicEndpoints,
  serviceStatus,
  serviceStatusLastSyncedAt,
  serviceStatusLoading = false,
  serviceStatusRequestInFlight = false,
  serviceStatusLastError = null,
  serviceStatusRefreshIntervalSeconds,
  codexRadarModelIq = null,
  codexRadarModelIqLoading = false,
  codexRadarModelIqRefreshing = false,
  codexRadarModelIqIsStale,
  codexRadarModelIqLastError = null,
  usageStatusLabel,
  subscriptionCount,
  subscriptionPreviewRecords,
  onRefreshServiceStatus,
  onRefreshCodexRadarModelIq,
  onOpenServiceStatus,
  onOpenSubscriptions
}: {
  activePanel: FloatingRailDrawerPanelKey | null;
  onActivePanelChange: (value: FloatingRailDrawerPanelKey | null) => void;
  selectedSite: SiteRecord | null;
  sitePublicEndpoints?: SitePublicEndpointsPayload | null;
  sitePublicEndpointsLoading?: boolean;
  sitePublicEndpointsSyncing?: boolean;
  sitePublicEndpointsPinging?: boolean;
  sitePublicEndpointsLastError?: string | null;
  onRetrySitePublicEndpoints?: () => void;
  serviceStatus: ServiceStatusPayload | null;
  serviceStatusLastSyncedAt?: number | null;
  serviceStatusLoading?: boolean;
  serviceStatusRequestInFlight?: boolean;
  serviceStatusLastError?: string | null;
  serviceStatusRefreshIntervalSeconds: number;
  codexRadarModelIq?: CodexRadarModelIqPayload | null;
  codexRadarModelIqLoading?: boolean;
  codexRadarModelIqRefreshing?: boolean;
  codexRadarModelIqIsStale: boolean;
  codexRadarModelIqLastError?: string | null;
  usageStatusLabel: string;
  subscriptionCount: number;
  subscriptionPreviewRecords: TopbarSubscriptionPreviewRecord[];
  onRefreshServiceStatus: () => void;
  onRefreshCodexRadarModelIq?: () => void;
  onOpenServiceStatus: () => void;
  onOpenSubscriptions: () => void;
}) {
  const open = activePanel !== null;
  const selectedPanel = activePanel ?? DEFAULT_PANEL;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelScrollRef = useRef<HTMLDivElement | null>(null);
  const focusPanelOnOpenRef = useRef(false);
  const [endpointCopyFeedback, setEndpointCopyFeedback] = useState<{
    key: string;
    state: "copied" | "failed";
  } | null>(null);
  const endpointCopyTimerRef = useRef<number | null>(null);
  const cardScrollDelayTimerRef = useRef<number | null>(null);
  const cardScrollFrameRef = useRef<number | null>(null);
  const cardScrollRevealFrameRef = useRef<number | null>(null);

  function cancelPendingDrawerCardScroll() {
    if (cardScrollDelayTimerRef.current != null) {
      window.clearTimeout(cardScrollDelayTimerRef.current);
      cardScrollDelayTimerRef.current = null;
    }
    if (cardScrollFrameRef.current != null) {
      window.cancelAnimationFrame(cardScrollFrameRef.current);
      cardScrollFrameRef.current = null;
    }
    if (cardScrollRevealFrameRef.current != null) {
      window.cancelAnimationFrame(cardScrollRevealFrameRef.current);
      cardScrollRevealFrameRef.current = null;
    }
  }

  useEffect(() => {
    if (!open || !focusPanelOnOpenRef.current) {
      return;
    }
    focusPanelOnOpenRef.current = false;
    const firstButton = panelRef.current?.querySelector<HTMLButtonElement>("button");
    if (firstButton) {
      firstButton.focus();
      return;
    }
    panelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    return () => {
      if (endpointCopyTimerRef.current != null) {
        window.clearTimeout(endpointCopyTimerRef.current);
      }
      cancelPendingDrawerCardScroll();
    };
  }, []);

  function openDrawer(panel: FloatingRailDrawerPanelKey = selectedPanel, { focusPanel = false } = {}) {
    if (!open && panelScrollRef.current) {
      panelScrollRef.current.scrollTop = 0;
    }
    focusPanelOnOpenRef.current = focusPanel;
    onActivePanelChange(panel);
  }

  function closeDrawer() {
    cancelPendingDrawerCardScroll();
    focusPanelOnOpenRef.current = false;
    onActivePanelChange(null);
  }

  function scrollDrawerCardIntoView(panel: FloatingRailDrawerPanelKey) {
    const card = panelRef.current?.querySelector<HTMLElement>(`[data-floating-rail-card="${panel}"]`);
    const scrollContainer = panelScrollRef.current;
    const reducedMotion = typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    if (!card || !scrollContainer) {
      return;
    }

    const scrollToCard = () => {
      const scrollContainerTop = scrollContainer.getBoundingClientRect().top;
      const cardTop = card.getBoundingClientRect().top;
      const scrollOptions: ScrollToOptions = {
        top: Math.max(0, scrollContainer.scrollTop + cardTop - scrollContainerTop),
        behavior: reducedMotion ? "auto" : "smooth"
      };
      scrollContainer.scrollTo(scrollOptions);
    };

    cancelPendingDrawerCardScroll();

    if (reducedMotion) {
      scrollToCard();
      return;
    }

    cardScrollDelayTimerRef.current = window.setTimeout(() => {
      cardScrollDelayTimerRef.current = null;
      cardScrollFrameRef.current = window.requestAnimationFrame(() => {
        cardScrollFrameRef.current = null;
        cardScrollRevealFrameRef.current = window.requestAnimationFrame(() => {
          cardScrollRevealFrameRef.current = null;
          scrollToCard();
        });
      });
    }, DRAWER_SCROLL_REVEAL_DELAY_MS);
  }

  function handleDrawerTabClick(panel: FloatingRailDrawerPanelKey) {
    openDrawer(panel, { focusPanel: true });
    scrollDrawerCardIntoView(panel);
  }

  function handlePointerLeave(event: PointerEvent<HTMLElement>) {
    const activeElement = event.currentTarget.ownerDocument.activeElement;
    if (activeElement && event.currentTarget.contains(activeElement)) {
      return;
    }
    closeDrawer();
  }

  function handleBlur(event: FocusEvent<HTMLElement>) {
    const nextTarget = event.relatedTarget;
    if (nextTarget && event.currentTarget.contains(nextTarget)) {
      return;
    }
    closeDrawer();
  }

  async function handleCopyEndpoint(record: PublicEndpointRecord) {
    const feedbackKey = buildPublicEndpointCopyKey(record);
    try {
      await copyTextToClipboard(record.endpoint);
      setEndpointCopyFeedback({
        key: feedbackKey,
        state: "copied"
      });
    } catch {
      setEndpointCopyFeedback({
        key: feedbackKey,
        state: "failed"
      });
    }

    if (endpointCopyTimerRef.current != null) {
      window.clearTimeout(endpointCopyTimerRef.current);
    }
    endpointCopyTimerRef.current = window.setTimeout(() => {
      setEndpointCopyFeedback((current) => (current?.key === feedbackKey ? null : current));
    }, 1600);
  }

  const sitePublicEndpointRecords = sitePublicEndpoints?.endpoints ?? [];
  const serviceStatusRecords = serviceStatus?.services ?? [];
  const codexRadarModelIqItems = (codexRadarModelIq?.items ?? []).slice(0, 5);
  const serviceStatusOnlineCount = serviceStatusRecords.filter((item) => item.last?.ok).length;
  const serviceStatusSyncLabel = serviceStatus
    ? formatLiveClockTime(
      new Date(serviceStatusLastSyncedAt ?? serviceStatus.generatedAt * 1000)
    )
    : "";
  const serviceStatusLoadingState = serviceStatusLoading || serviceStatusRequestInFlight;
  const serviceStatusHeadline = serviceStatus
    ? serviceStatus.allOk
      ? `${serviceStatusOnlineCount} / ${serviceStatusRecords.length} 正常`
      : `${serviceStatusOnlineCount} / ${serviceStatusRecords.length} 正常, 存在异常`
    : serviceStatusLastError
      ? "同步失败"
      : serviceStatusLoadingState
        ? "正在同步"
        : "等待同步";
  const serviceStatusHint = serviceStatus
    ? `每 ${serviceStatusRefreshIntervalSeconds} 秒自动更新一次 · 上次更新 ${serviceStatusSyncLabel}`
    : serviceStatusLastError
      ? "服务状态读取失败, 请重新尝试。"
      : serviceStatusLoadingState
        ? "正在获取服务状态"
        : "服务状态尚未同步";
  const codexRadarLoadingState = codexRadarModelIqLoading || codexRadarModelIqRefreshing;
  const codexRadarSnapshotIsStale = Boolean(codexRadarModelIq?.isStale || codexRadarModelIqIsStale);
  const codexRadarHint = codexRadarModelIq
    ? `${codexRadarSnapshotIsStale ? "上次同步数据" : "源数据更新"} · ${formatTime(codexRadarModelIq.sourceUpdatedAt)}`
    : codexRadarModelIqLastError
      ? "模型测评读取失败, 请重新尝试。"
      : codexRadarLoadingState
        ? "正在读取 Codex Radar 测评"
        : "模型测评尚未读取";
  const codexRadarIndicatorTones = Array.from({ length: 5 }, (_, index) => {
    const item = codexRadarModelIqItems[index];
    if (!item) {
      return codexRadarModelIqLastError ? "critical" : "neutral";
    }
    return codexRadarSnapshotIsStale ? "warning" : getCodexRadarStatusPresentation(item.status).tone;
  });
  const subscriptionCountLabel = resolveSubscriptionSummaryMeta({
    usageStatusLabel,
    subscriptionCount
  });
  const subscriptionDailyQuotaSummary = resolveSubscriptionDailyQuotaSummary(subscriptionPreviewRecords);
  const drawerTabs: Array<{
    key: FloatingRailDrawerPanelKey;
    label: string;
    icon: ReactNode;
    indicator?: ReactNode;
  }> = [
    {
      key: "serviceStatus",
      label: "服务状态详情",
      icon: <Activity size={18} />,
      indicator: serviceStatusRecords.length > 0 ? (
        <span className="topbar-subscription-dots topbar-service-status-dots" aria-hidden="true">
          {serviceStatusRecords.map((service) => (
            <span
              key={service.model}
              className={`topbar-subscription-dot ${service.last?.ok ? "subscription-dot-ready" : "subscription-dot-critical"}`}
            />
          ))}
        </span>
      ) : null
    },
    {
      key: "codexRadar",
      label: "降智雷达详情",
      icon: <Radar size={18} />,
      indicator: (
        <span className="topbar-subscription-dots topbar-codex-radar-dots" aria-hidden="true">
          {codexRadarIndicatorTones.map((tone, index) => (
            <span key={index} className={`topbar-subscription-dot topbar-codex-radar-indicator ${tone}`} />
          ))}
        </span>
      )
    },
    {
      key: "subscriptions",
      label: "订阅使用情况详情",
      icon: <Crown size={18} />,
      indicator: subscriptionPreviewRecords.length > 0 ? (
        <span className="topbar-subscription-dots" aria-hidden="true">
          {subscriptionPreviewRecords.map((subscription) => (
            <span
              key={subscription.id}
              className={`topbar-subscription-dot ${subscription.indicatorTone}`}
            />
          ))}
        </span>
      ) : null
    },
    {
      key: "siteEndpoints",
      label: "站点 API 入口",
      icon: <Server size={18} />,
      indicator: sitePublicEndpointRecords.length > 0 ? (
        <span className="topbar-subscription-dots topbar-endpoint-latency-dots" aria-hidden="true">
          {sitePublicEndpointRecords.map((record) => {
            const probeMeta = resolvePublicEndpointProbeMeta(record, sitePublicEndpointsPinging);
            return (
              <span
                key={buildPublicEndpointCopyKey(record)}
                className={`topbar-subscription-dot topbar-endpoint-latency-indicator ${probeMeta.latencyTone}`}
              />
            );
          })}
        </span>
      ) : null
    }
  ];

  return (
    <aside
      className={`floating-rail-drawer ${open ? "open" : ""}`}
      aria-label="悬浮导航抽屉"
      onPointerLeave={handlePointerLeave}
      onBlur={handleBlur}
    >
      <div
        id="floating-rail-drawer-panel"
        className="floating-rail-drawer-panel"
        ref={panelRef}
        tabIndex={-1}
        aria-label="快捷详情抽屉"
        aria-hidden={!open}
      >
        <div className="floating-rail-drawer-panel-scroll" ref={panelScrollRef}>
          <div data-floating-rail-card="serviceStatus" className="topbar-card topbar-subscription-panel topbar-service-status-panel floating-rail-drawer-card">
            <div className="topbar-subscription-head">
              <div className="topbar-card-icon">
                <Activity size={18} />
              </div>
              <div className="topbar-card-copy">
                <div className="topbar-service-status-heading">
                  <div className="topbar-service-status-title-row">
                    <span className="topbar-card-label">服务状态</span>
                    <span className="topbar-service-status-hint">{serviceStatusHint}</span>
                  </div>
                  <strong className="topbar-service-status-summary">{serviceStatusHeadline}</strong>
                </div>
              </div>
            </div>
            {serviceStatus && serviceStatusLastError ? (
              <p className="topbar-alert-empty" role="alert">服务状态刷新失败, 当前展示上次同步的数据。</p>
            ) : null}
            {serviceStatusRecords.length > 0 ? (
              <div className="topbar-subscription-list">
                {serviceStatusRecords.map((service) => (
                  <button
                    key={service.model}
                    type="button"
                    className="topbar-subscription-item topbar-service-status-item topbar-detail-card-action"
                    onClick={onOpenServiceStatus}
                    aria-label={`打开服务状态页: ${service.model}`}
                  >
                    <div className="topbar-service-status-row">
                      <strong className="topbar-service-status-model">{service.model}</strong>
                      <span className={`status-pill ${service.last?.ok ? "ready" : "critical"}`}>
                        {service.last?.ok ? "正常" : "失败"}
                      </span>
                      <strong className="topbar-service-status-latency">{formatMilliseconds(service.last?.latencyMs)}</strong>
                    </div>
                    <p className="topbar-service-status-detail">
                      <span>
                          {service.last?.ok ? "最新探测正常" : "最新探测失败"}
                          {service.last ? ` · ${formatTime(new Date(service.last.ts * 1000).toISOString())}` : ""}
                      </span>
                      <span>可用率 {service.uptimePct.toFixed(2)}%</span>
                    </p>
                  </button>
                ))}
              </div>
            ) : serviceStatus ? (
              <p className="topbar-alert-empty">当前没有服务状态数据</p>
            ) : serviceStatusLastError ? (
              <p className="topbar-alert-empty" role="alert">服务状态读取失败, 请重新尝试。</p>
            ) : serviceStatusLoadingState ? (
              <p className="topbar-alert-empty" role="status" aria-live="polite">正在获取服务状态...</p>
            ) : (
              <p className="topbar-alert-empty">服务状态尚未同步</p>
            )}
            <button
              type="button"
              className={`topbar-peek-action ${serviceStatusRequestInFlight ? "is-refreshing" : ""}`}
              onClick={onRefreshServiceStatus}
              disabled={serviceStatusRequestInFlight}
              aria-busy={serviceStatusRequestInFlight || undefined}
            >
              {serviceStatusRequestInFlight ? (
                <>
                  刷新中
                  <span className="topbar-refresh-loading-dots" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                </>
              ) : "立即刷新服务状态"}
            </button>
          </div>

          <div data-floating-rail-card="codexRadar" className="topbar-card topbar-subscription-panel topbar-codex-radar-panel floating-rail-drawer-card">
            <div className="topbar-subscription-head">
              <div className="topbar-card-icon">
                <Radar size={18} />
              </div>
              <div className="topbar-card-copy">
                <div className="topbar-codex-radar-heading">
                  <span className="topbar-card-label">降智雷达 · IQ Top 5</span>
                  <span className="topbar-codex-radar-hint">{codexRadarHint}</span>
                </div>
              </div>
            </div>
            {codexRadarModelIq && codexRadarModelIqLastError ? (
              <p className="topbar-alert-empty" role="alert">模型测评刷新失败, 当前展示上次同步的数据。</p>
            ) : null}
            {codexRadarModelIqItems.length > 0 ? (
              <div className="topbar-subscription-list">
                {codexRadarModelIqItems.map((item, index) => (
                    <div key={item.id} className="topbar-subscription-item topbar-codex-radar-item">
                      <div className="topbar-subscription-item-head">
                        <div className="topbar-subscription-item-copy">
                          <div className="topbar-codex-radar-title-row">
                            <div className="topbar-codex-radar-model">
                              <strong>
                                <span className="topbar-codex-radar-rank">{index + 1}</span>
                                {getCodexRadarModelDisplayName(item.label, item.reasoningEffort)}
                              </strong>
                              <CodexRadarEffortPill effort={item.reasoningEffort} />
                            </div>
                            <div className="topbar-codex-radar-summary">
                              <span className={`status-pill ${getCodexRadarStatusPresentation(item.status).tone} topbar-codex-radar-score`}>
                                {`IQ ${item.score.toFixed(1)}`}
                              </span>
                              <strong className="topbar-codex-radar-cost">{`${formatUsd(item.averageCostUsd, 2)} / 任务`}</strong>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            ) : codexRadarModelIq ? (
              <p className="topbar-alert-empty">当前没有可展示的模型测评数据</p>
            ) : codexRadarModelIqLastError ? (
              <p className="topbar-alert-empty" role="alert">模型测评读取失败, 请重新尝试。</p>
            ) : codexRadarLoadingState ? (
              <p className="topbar-alert-empty" role="status" aria-live="polite">正在读取模型测评...</p>
            ) : (
              <p className="topbar-alert-empty">模型测评尚未读取</p>
            )}
            <p className="topbar-codex-radar-attribution">数据来自 Codex 雷达</p>
            {onRefreshCodexRadarModelIq ? (
              <button
                type="button"
                className={`topbar-peek-action ${codexRadarModelIqRefreshing ? "is-refreshing" : ""}`}
                onClick={onRefreshCodexRadarModelIq}
                disabled={codexRadarLoadingState}
                aria-busy={codexRadarLoadingState || undefined}
              >
                {codexRadarModelIqRefreshing ? (
                  <>
                    刷新中
                    <span className="topbar-refresh-loading-dots" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                  </>
                ) : "刷新模型测评"}
              </button>
            ) : null}
          </div>

          <div data-floating-rail-card="subscriptions" className="topbar-card topbar-subscription-panel floating-rail-drawer-card">
            <div className="topbar-subscription-head topbar-subscription-summary-head">
              <div className="topbar-card-icon">
                <Crown size={18} />
              </div>
              <div className="topbar-card-copy topbar-subscription-summary-copy">
                <div className="topbar-subscription-summary-line">
                  <span className="topbar-card-label">订阅</span>
                  <span className="topbar-subscription-summary-meta">
                    <span className="topbar-subscription-summary-count">{subscriptionCountLabel}</span>
                    <span className="topbar-subscription-summary-hint">
                      {subscriptionDailyQuotaSummary
                        ? `今日余额 ${formatUsd(subscriptionDailyQuotaSummary.remaining, 2)}`
                        : "今日额度待同步"}
                    </span>
                    <span className="topbar-subscription-summary-total-used">
                      {subscriptionDailyQuotaSummary
                        ? `总已用 ${formatPercent(subscriptionDailyQuotaSummary.usedPercent, 1)}`
                        : "总已用 待同步"}
                    </span>
                  </span>
                </div>
              </div>
            </div>
            {subscriptionPreviewRecords.length > 0 ? (
              <div className="topbar-subscription-list">
                {subscriptionPreviewRecords.map((subscription) => (
                  <button
                    key={subscription.id}
                    type="button"
                    className="topbar-subscription-item topbar-detail-card-action"
                    onClick={onOpenSubscriptions}
                    aria-label={`打开订阅页: ${subscription.name}`}
                  >
                    <div className="topbar-subscription-item-copy">
                      <div className="topbar-subscription-name-line">
                        <strong>{subscription.name}</strong>
                        <span className={`status-pill ${subscription.quotaProgress ? "ready" : subscription.indicatorTone.replace("subscription-dot-", "")}`}>
                          {subscription.quota ? subscription.quota.label : subscription.statusLabel}
                        </span>
                        <span className="topbar-subscription-remaining-days">{subscription.remainingDaysLabel}</span>
                      </div>
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
                  </button>
                ))}
              </div>
            ) : (
              <p className="topbar-alert-empty">当前没有订阅数据</p>
            )}
          </div>

          <div data-floating-rail-card="siteEndpoints" className="topbar-card topbar-subscription-panel topbar-site-endpoints-panel floating-rail-drawer-card">
            <div className="topbar-subscription-head">
              <div className="topbar-card-icon">
                <Server size={18} />
              </div>
              <div className="topbar-card-copy">
                <span className="topbar-card-label">API端点地址</span>
              </div>
            </div>
            {selectedSite && sitePublicEndpointRecords.length > 0 ? (
              <>
                <div className="topbar-endpoint-list">
                  {sitePublicEndpointRecords.map((record) => {
                    const feedbackKey = buildPublicEndpointCopyKey(record);
                    const copyState = endpointCopyFeedback?.key === feedbackKey ? endpointCopyFeedback.state : null;
                    const probeMeta = resolvePublicEndpointProbeMeta(record, sitePublicEndpointsPinging);
                    return (
                      <button
                        key={feedbackKey}
                        type="button"
                        className={`topbar-endpoint-item topbar-endpoint-chip topbar-endpoint-card-action ${copyState === "copied" ? "copied" : ""}`}
                        onClick={() => void handleCopyEndpoint(record)}
                        title={copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制地址"}
                        aria-label={`${copyState === "copied" ? "已复制" : "复制"} ${record.name} 地址`}
                      >
                        <span className="topbar-endpoint-main">
                          <strong className="topbar-endpoint-tag topbar-endpoint-name" title={record.name}>{record.name}</strong>
                          <span className={`status-pill ${probeMeta.tone}`} title={probeMeta.title}>
                            <span className={`topbar-endpoint-latency-dot ${probeMeta.latencyTone}`} aria-hidden="true" />
                            {probeMeta.label}
                          </span>
                          <span className="topbar-endpoint-copy" aria-hidden="true">
                            {copyState === "copied" ? <CheckCheck size={14} /> : <Copy size={14} />}
                          </span>
                        </span>
                        <span className="topbar-endpoint-tag topbar-endpoint-value" title={record.endpoint}>{record.endpoint}</span>
                      </button>
                    );
                  })}
                </div>
                {sitePublicEndpointsLastError ? (
                  <div className="workspace-refresh-status has-error" role="alert" aria-live="assertive" aria-atomic="true">
                    <CircleAlert size={14} aria-hidden="true" />
                    <span>{`入口刷新失败, 当前入口仍可使用: ${sitePublicEndpointsLastError}`}</span>
                    {onRetrySitePublicEndpoints ? (
                      <button
                        type="button"
                        className="ghost-button workspace-refresh-retry"
                        onClick={onRetrySitePublicEndpoints}
                      >
                        重新同步
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <p className="topbar-alert-empty" role={selectedSite && sitePublicEndpointsLastError ? "alert" : undefined}>
                  {!selectedSite
                    ? "先选择一个站点, 这里会显示 API 入口"
                    : sitePublicEndpointsLoading || sitePublicEndpointsSyncing
                      ? "正在同步站点公共入口..."
                      : sitePublicEndpointsLastError ?? "当前站点还没有缓存到可展示的 API 入口"}
                </p>
                {selectedSite
                  && !sitePublicEndpointsLoading
                  && !sitePublicEndpointsSyncing
                  && onRetrySitePublicEndpoints ? (
                  <button
                    type="button"
                    className="topbar-peek-action"
                    onClick={onRetrySitePublicEndpoints}
                  >
                    重新同步站点入口
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
      <div className="floating-rail-drawer-tabs" aria-label="快捷详情入口">
        {drawerTabs.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`floating-rail-drawer-tab ${selectedPanel === item.key ? "active" : ""}`}
            title={item.label}
            aria-label={item.label}
            aria-controls="floating-rail-drawer-panel"
            aria-expanded={open && selectedPanel === item.key}
            onFocus={() => openDrawer(item.key)}
            onMouseEnter={() => openDrawer(item.key)}
            onClick={() => handleDrawerTabClick(item.key)}
          >
            {item.icon}
            {item.indicator}
          </button>
        ))}
      </div>
    </aside>
  );
}

function resolveSubscriptionSummaryMeta(input: {
  usageStatusLabel: string;
  subscriptionCount: number;
}) {
  const countLabel = input.subscriptionCount > 0
    ? /^\d+\s*个/.test(input.usageStatusLabel.trim())
      ? input.usageStatusLabel.trim()
      : `${input.subscriptionCount} 个订阅`
    : "暂无订阅";

  return countLabel;
}

function resolveSubscriptionDailyQuotaSummary(records: TopbarSubscriptionPreviewRecord[]) {
  let totalUsed = 0;
  let totalLimit = 0;

  for (const record of records) {
    const quota = record.quota;
    if (
      quota?.label !== "每日"
      || !Number.isFinite(quota.used)
      || !Number.isFinite(quota.limit)
      || quota.limit <= 0
    ) {
      continue;
    }

    totalUsed += Math.max(quota.used, 0);
    totalLimit += quota.limit;
  }

  if (totalLimit <= 0) {
    return null;
  }

  return {
    remaining: Math.max(totalLimit - totalUsed, 0),
    usedPercent: (totalUsed / totalLimit) * 100
  };
}

function buildPublicEndpointCopyKey(record: Pick<PublicEndpointRecord, "name" | "endpoint">) {
  return `${record.name}::${record.endpoint}`;
}

function resolvePublicEndpointProbeMeta(record: PublicEndpointRecord, pinging: boolean) {
  if (record.pingLatencyMs !== null && record.pingLatencyMs !== undefined) {
    const statusCode = record.pingStatusCode ? ` · HTTP ${record.pingStatusCode}` : "";
    const checkedAt = record.pingCheckedAt ? ` · ${formatTime(record.pingCheckedAt)}` : "";
    const latencyTone = record.pingLatencyMs <= 1000 ? "fast" as const : record.pingLatencyMs <= 3000 ? "steady" as const : "slow" as const;
    return {
      label: record.pingLatencyMs <= 0 ? "0 ms" : formatMilliseconds(record.pingLatencyMs),
      tone: latencyTone === "fast" ? "ready" as const : latencyTone === "steady" ? "warning" as const : "critical" as const,
      latencyTone,
      title: `自动探测延迟${statusCode}${checkedAt}`
    };
  }

  if (record.pingError) {
    const checkedAt = record.pingCheckedAt ? ` · ${formatTime(record.pingCheckedAt)}` : "";
    return {
      label: "连接失败",
      tone: "critical" as const,
      latencyTone: "failed" as const,
      title: `${record.pingError}${checkedAt}`
    };
  }

  if (pinging) {
    return {
      label: "探测中",
      tone: "neutral" as const,
      latencyTone: "pending" as const,
      title: "正在自动探测当前入口延迟"
    };
  }

  return {
    label: "待探测",
    tone: "neutral" as const,
    latencyTone: "pending" as const,
    title: "应用启动后会自动探测并定时刷新当前入口延迟"
  };
}
