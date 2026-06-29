import { BadgeDollarSign, Bell, Crown, ExternalLink, LayoutDashboard, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { openMainWindow } from "../features/desktop-ui/client";
import type { NotificationInboxItem } from "../features/overview/components/AlertInboxModal";
import type { OverviewPayload, SubscriptionRecord, UsageRow } from "../types";
import { compact, formatTime, formatUsd } from "../shared/lib/formatters";
import { EmptyState } from "../shared/ui/EmptyState";
import { isTauriRuntime } from "../shared/transport/runtime";
import {
  FLOATING_MENU_HEIGHT,
  FLOATING_PANEL_SHELL_WIDTH,
  FLOATING_PANEL_TAIL_SPACE,
  FLOATING_PREVIEW_HEIGHT,
  type FloatingPanelKey
} from "./floating-layout";

type FloatingMenuItem = {
  key: FloatingPanelKey;
  label: string;
  hint: string;
  nav: "overview" | "alerts" | "subscriptions" | "usage";
  icon: typeof LayoutDashboard;
};

type FloatingPanelSyncPayload = {
  dock: "left" | "right";
  x: number;
  y: number;
  menuVisible: boolean;
  activePanel: FloatingPanelKey;
};

async function ignoreWindowMutation(task: Promise<unknown>) {
  try {
    await task;
  } catch {
    // Windows 下浮窗属性调用偶发失败时, 不应阻断悬浮面板继续同步位置与显隐。
  }
}

const MENU_ITEMS: FloatingMenuItem[] = [
  { key: "overview", label: "实时总览", hint: "余额、请求、Token", nav: "overview", icon: LayoutDashboard },
  { key: "alerts", label: "优先告警", hint: "风险与异常提醒", nav: "alerts", icon: Bell },
  { key: "subscriptions", label: "订阅与账号", hint: "订阅窗口与余额", nav: "subscriptions", icon: Crown },
  { key: "usage", label: "最近使用", hint: "最近调用与消耗", nav: "usage", icon: BadgeDollarSign }
];

function FloatingPreviewHeader({
  icon: Icon,
  title,
  ctaLabel,
  onOpenMain
}: {
  icon: typeof LayoutDashboard;
  title: string;
  ctaLabel: string;
  onOpenMain: () => void;
}) {
  return (
    <div className="floating-preview-head">
      <div className="floating-preview-title">
        <Icon size={16} />
        <div className="floating-preview-title-copy">
          <span className="floating-preview-eyebrow">INPUT PANEL</span>
          <strong>{title}</strong>
        </div>
      </div>
      <button type="button" className="floating-preview-link" onClick={onOpenMain}>
        <span>{ctaLabel}</span>
        <ExternalLink size={14} />
      </button>
    </div>
  );
}

function FloatingOverviewPanel({ overview, onOpenMain }: { overview: OverviewPayload | null; onOpenMain: () => void }) {
  if (!overview) {
    return <EmptyState title="暂无聚合数据" detail="请先在主窗口完成登录并刷新。" compact />;
  }

  return (
    <>
      <FloatingPreviewHeader icon={LayoutDashboard} title="实时总览" ctaLabel="打开主窗口" onOpenMain={onOpenMain} />
      <div className="floating-preview-metrics">
        <button type="button" className="floating-preview-metric" onClick={onOpenMain}>
          <span>总余额</span>
          <strong>{formatUsd(overview.totals.balance, 2)}</strong>
        </button>
        <button type="button" className="floating-preview-metric" onClick={onOpenMain}>
          <span>今日请求</span>
          <strong>{overview.totals.todayRequests.toLocaleString()}</strong>
        </button>
        <button type="button" className="floating-preview-metric" onClick={onOpenMain}>
          <span>活跃 Keys</span>
          <strong>{overview.totals.activeApiKeys}</strong>
        </button>
        <button type="button" className="floating-preview-metric" onClick={onOpenMain}>
          <span>今日 Tokens</span>
          <strong>{compact(overview.totals.todayTokens)}</strong>
        </button>
      </div>
    </>
  );
}

function FloatingAlertsPanel({
  items,
  onOpenMain
}: {
  items: NotificationInboxItem[];
  onOpenMain: () => void;
}) {
  const alerts = items.slice(0, 4);
  if (alerts.length === 0) {
    return (
      <>
        <FloatingPreviewHeader icon={Bell} title="优先告警" ctaLabel="查看全部" onOpenMain={onOpenMain} />
        <EmptyState title="没有待处理告警" detail="当前所有账号状态正常。" compact />
      </>
    );
  }

  return (
    <>
      <FloatingPreviewHeader icon={Bell} title="优先告警" ctaLabel="查看全部" onOpenMain={onOpenMain} />
      <div className="floating-preview-list">
        {alerts.map((alert) => (
          <button
            key={alert.id}
            type="button"
            className={`floating-preview-row ${alert.severity === "critical" ? "critical" : "neutral"}`}
            onClick={onOpenMain}
          >
            <div>
              <strong>{alert.title}</strong>
              <p>{alert.detail}</p>
            </div>
            <span>{formatTime(alert.createdAt)}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function FloatingSubscriptionsPanel({
  accountLabel,
  siteName,
  balance,
  subscriptions,
  onOpenMain
}: {
  accountLabel: string | null;
  siteName: string | null;
  balance: number | null;
  subscriptions: SubscriptionRecord[];
  onOpenMain: () => void;
}) {
  if (balance === null) {
    return (
      <>
        <FloatingPreviewHeader icon={Crown} title="订阅与账号" ctaLabel="订阅详情" onOpenMain={onOpenMain} />
        <EmptyState title="暂无订阅信息" detail="当前账号还没有可展示的订阅数据。" compact />
      </>
    );
  }

  return (
    <>
      <FloatingPreviewHeader icon={Crown} title="订阅与账号" ctaLabel="订阅详情" onOpenMain={onOpenMain} />
      <div className="floating-preview-list">
        <button type="button" className="floating-preview-row neutral" onClick={onOpenMain}>
          <div>
            <strong>{accountLabel ?? "当前账号"}</strong>
            <p>{siteName ?? "未命名站点"}</p>
          </div>
          <span>{formatUsd(balance, 2)}</span>
        </button>
        {subscriptions.slice(0, 3).map((subscription) => (
          <button key={subscription.id} type="button" className="floating-preview-row neutral" onClick={onOpenMain}>
            <div>
              <strong>{subscription.name}</strong>
              <p>{subscription.status}</p>
            </div>
            <span>{subscription.daily ? formatUsd(subscription.daily.current, 2) : "--"}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function FloatingUsagePanel({ recentUsage, onOpenMain }: { recentUsage: UsageRow[]; onOpenMain: () => void }) {

  if (recentUsage.length === 0) {
    return (
      <>
        <FloatingPreviewHeader icon={BadgeDollarSign} title="最近使用" ctaLabel="打开用量" onOpenMain={onOpenMain} />
        <EmptyState title="暂无近期调用" detail="刷新后这里会显示最近使用记录。" compact />
      </>
    );
  }

  return (
    <>
      <FloatingPreviewHeader icon={BadgeDollarSign} title="最近使用" ctaLabel="打开用量" onOpenMain={onOpenMain} />
      <div className="floating-preview-list">
        {recentUsage.map((row) => (
          <button key={row.id} type="button" className="floating-preview-row neutral" onClick={onOpenMain}>
            <div>
              <strong>{row.model}</strong>
              <p>
                {row.apiKeyName ?? "未知 Key"} / {row.endpoint ?? "-"}
              </p>
            </div>
            <span>{formatUsd(row.actualCost, 4)}</span>
          </button>
        ))}
      </div>
    </>
  );
}

export function FloatingPanelWindow({
  overview,
  currentAccountLabel,
  currentSiteName,
  currentAccountBalance,
  currentAccountSubscriptions,
  currentAccountRecentUsage,
  notificationItems,
  loading,
  keepVisible,
  floatingPanelOpacity,
  onRefresh,
  initialPanel = "overview"
}: {
  overview: OverviewPayload | null;
  currentAccountLabel: string | null;
  currentSiteName: string | null;
  currentAccountBalance: number | null;
  currentAccountSubscriptions: SubscriptionRecord[];
  currentAccountRecentUsage: UsageRow[];
  notificationItems: NotificationInboxItem[];
  loading: boolean;
  keepVisible: boolean;
  floatingPanelOpacity: number;
  onRefresh: () => void;
  initialPanel?: FloatingPanelKey;
}) {
  const tauriRuntime = isTauriRuntime();
  const [dock, setDock] = useState<"left" | "right">("right");
  const [visible, setVisible] = useState(!tauriRuntime || keepVisible);
  const [activePanel, setActivePanel] = useState<FloatingPanelKey>(initialPanel);

  const activeMenu = useMemo(() => MENU_ITEMS.find((item) => item.key === activePanel) ?? MENU_ITEMS[0], [activePanel]);

  useEffect(() => {
    if (!tauriRuntime) {
      return;
    }

    let unlistenSync: (() => void) | undefined;
    let unlistenHide: (() => void) | undefined;
    let active = true;

    async function setup() {
      const appWindow = getCurrentWindow();
      await ignoreWindowMutation(appWindow.setDecorations(false));
      await ignoreWindowMutation(appWindow.setResizable(false));
      await ignoreWindowMutation(appWindow.setAlwaysOnTop(true));
      await ignoreWindowMutation(appWindow.setShadow(false));
      unlistenSync = await listen<FloatingPanelSyncPayload>(
        "floating-panel-sync",
        async ({ payload }) => {
          if (!active) {
            return;
          }
          setDock(payload.dock);
          setVisible(payload.menuVisible);
          setActivePanel(payload.activePanel);
          await appWindow.setSize(
            new LogicalSize(
              FLOATING_PANEL_SHELL_WIDTH,
              Math.max(FLOATING_MENU_HEIGHT, FLOATING_PREVIEW_HEIGHT) + FLOATING_PANEL_TAIL_SPACE
            )
          );
          await appWindow.setPosition(new LogicalPosition(payload.x, payload.y));
          if (payload.menuVisible) {
            await appWindow.show();
          } else {
            await appWindow.hide();
          }
        },
        { target: { kind: "WebviewWindow", label: "floating-panel" } }
      );

      unlistenHide = await listen(
        "floating-panel-hide",
        async () => {
          if (!active) {
            return;
          }
          setVisible(false);
          await appWindow.hide();
        },
        { target: { kind: "WebviewWindow", label: "floating-panel" } }
      );
    }

    void setup();

    return () => {
      active = false;
      unlistenSync?.();
      unlistenHide?.();
    };
  }, [tauriRuntime]);

  useEffect(() => {
    if (!tauriRuntime) {
      setVisible(keepVisible);
      return;
    }

    if (keepVisible) {
      setVisible(true);
      void getCurrentWindow().show().catch(() => {
        // 设置常驻时, 即便 show 调用偶发失败, 也不影响后续同步事件继续修正窗口状态。
      });
      return;
    }
  }, [keepVisible, tauriRuntime]);

  async function selectPanel(key: FloatingPanelKey) {
    setActivePanel(key);
    if (!tauriRuntime) {
      return;
    }
    await emitTo("floating", "floating-panel-select", { panel: key });
  }

  function handleOpenMain(nav: FloatingMenuItem["nav"]) {
    void openMainWindow(nav);
  }

  function renderPanel() {
    switch (activePanel) {
      case "alerts":
        return <FloatingAlertsPanel items={notificationItems} onOpenMain={() => handleOpenMain("alerts")} />;
      case "subscriptions":
        return (
          <FloatingSubscriptionsPanel
            accountLabel={currentAccountLabel}
            siteName={currentSiteName}
            balance={currentAccountBalance}
            subscriptions={currentAccountSubscriptions}
            onOpenMain={() => handleOpenMain("subscriptions")}
          />
        );
      case "usage":
        return (
          <FloatingUsagePanel
            recentUsage={currentAccountRecentUsage.slice(0, 5)}
            onOpenMain={() => handleOpenMain("usage")}
          />
        );
      case "overview":
      default:
        return <FloatingOverviewPanel overview={overview} onOpenMain={() => handleOpenMain("overview")} />;
    }
  }

  return (
    <main
      className={`floating-panel-window dock-${dock} ${visible ? "visible" : "hidden"} ${keepVisible ? "pinned-glass" : ""}`}
      style={{ ["--floating-panel-opacity" as string]: floatingPanelOpacity }}
      onMouseEnter={() => {
        if (!tauriRuntime) {
          return;
        }
        void emitTo("floating", "floating-panel-hover", { hovering: true });
      }}
      onMouseLeave={() => {
        if (!tauriRuntime) {
          return;
        }
        void emitTo("floating", "floating-panel-hover", { hovering: false });
      }}
    >
      <div className={`floating-panel-shell dock-${dock}`}>
        <section className="floating-panel-window-preview">
          <div className={`floating-preview-card visible dock-${dock} ${keepVisible ? "pinned" : "hover-preview"}`.trim()}>
            {renderPanel()}
          </div>
        </section>

        <section className="floating-panel-window-menu">
          <div className={`floating-menu-card visible dock-${dock}`}>
            <div className="floating-menu-header">
              <strong>导航</strong>
              <button
                type="button"
                className="floating-menu-refresh"
                onClick={onRefresh}
                aria-label="刷新悬浮面板"
                title="刷新悬浮面板"
              >
                <RefreshCw size={15} className={loading ? "spin" : undefined} />
              </button>
            </div>

            <div className="floating-menu-list">
              {MENU_ITEMS.map((item) => {
                const Icon = item.icon;
                const selected = item.key === activePanel;
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={`floating-menu-item ${selected ? "selected" : ""}`}
                    onClick={() => void selectPanel(item.key)}
                    aria-label={item.label}
                    title={`${item.label} · ${item.hint}`}
                  >
                    <div className="floating-menu-item-icon">
                      <Icon size={16} />
                    </div>
                    <div className={`floating-menu-tooltip dock-${dock}`} aria-hidden="true">
                      <strong>{item.label}</strong>
                      <span>{item.hint}</span>
                    </div>
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              className="floating-menu-main-button"
              onClick={() => handleOpenMain(activeMenu.nav)}
              aria-label={`打开${activeMenu.label}`}
              title={`打开${activeMenu.label}`}
            >
              <ExternalLink size={16} />
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
