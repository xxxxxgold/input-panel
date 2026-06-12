import {
  BadgeDollarSign,
  Bell,
  ChevronRight,
  Crown,
  LayoutDashboard,
  PanelRightOpen,
  RefreshCw
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { openMainWindow } from "../features/desktop-ui/client";
import {
  FLOATING_ORB_SIZE,
  computeFloatingWindowPlacement,
  resolveFloatingDock,
  type FloatingDock,
  type FloatingPanelKey,
  type FloatingWorkArea
} from "./floating-layout";
import type { OverviewPayload } from "../types";
import { compact, formatTime, formatUsd } from "../shared/lib/formatters";
import { EmptyState } from "../shared/ui/EmptyState";
import projectLogo from "../assets/project-logo.webp";
import { isTauriRuntime } from "../shared/transport/runtime";

type FloatingMenuItem = {
  key: FloatingPanelKey;
  label: string;
  hint: string;
  nav: "overview" | "alerts" | "subscriptions" | "usage";
  icon: typeof LayoutDashboard;
};

const MENU_ITEMS: FloatingMenuItem[] = [
  {
    key: "overview",
    label: "实时总览",
    hint: "余额、请求、Token",
    nav: "overview",
    icon: LayoutDashboard
  },
  {
    key: "alerts",
    label: "优先告警",
    hint: "风险与异常提醒",
    nav: "alerts",
    icon: Bell
  },
  {
    key: "subscriptions",
    label: "订阅与账号",
    hint: "订阅窗口与余额",
    nav: "subscriptions",
    icon: Crown
  },
  {
    key: "usage",
    label: "最近使用",
    hint: "最近调用与消耗",
    nav: "usage",
    icon: BadgeDollarSign
  }
];

function getDefaultWorkArea(): FloatingWorkArea {
  if (typeof window === "undefined") {
    return { x: 0, y: 0, width: 1280, height: 720 };
  }
  return {
    x: 0,
    y: 0,
    width: window.innerWidth,
    height: window.innerHeight
  };
}

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
        <strong>{title}</strong>
      </div>
      <button type="button" className="floating-preview-link" onClick={onOpenMain}>
        {ctaLabel}
      </button>
    </div>
  );
}

function FloatingOverviewPanel({
  overview,
  onOpenMain
}: {
  overview: OverviewPayload | null;
  onOpenMain: () => void;
}) {
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
  overview,
  onOpenMain
}: {
  overview: OverviewPayload | null;
  onOpenMain: () => void;
}) {
  const alerts = overview?.alerts.slice(0, 4) ?? [];
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
          <button key={alert.id} type="button" className={`floating-preview-row ${alert.severity}`} onClick={onOpenMain}>
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
  overview,
  onOpenMain
}: {
  overview: OverviewPayload | null;
  onOpenMain: () => void;
}) {
  const topAccount = overview?.accounts.find((item) => item.snapshot) ?? overview?.accounts[0] ?? null;
  const subscriptions = topAccount?.snapshot?.subscriptions.slice(0, 3) ?? [];

  if (!topAccount?.snapshot) {
    return (
      <>
        <FloatingPreviewHeader icon={Crown} title="订阅与账号" ctaLabel="订阅详情" onOpenMain={onOpenMain} />
        <EmptyState title="暂无订阅信息" detail="当前账号还没有可展示的订阅快照。" compact />
      </>
    );
  }

  return (
    <>
      <FloatingPreviewHeader icon={Crown} title="订阅与账号" ctaLabel="订阅详情" onOpenMain={onOpenMain} />
      <div className="floating-preview-list">
        <button type="button" className="floating-preview-row neutral" onClick={onOpenMain}>
          <div>
            <strong>{topAccount.label}</strong>
            <p>{topAccount.site?.name ?? topAccount.snapshot.siteName}</p>
          </div>
          <span>{formatUsd(topAccount.snapshot.balance, 2)}</span>
        </button>
        {subscriptions.map((subscription) => (
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

function FloatingUsagePanel({
  overview,
  onOpenMain
}: {
  overview: OverviewPayload | null;
  onOpenMain: () => void;
}) {
  const topAccount = overview?.accounts.find((item) => item.snapshot) ?? overview?.accounts[0] ?? null;
  const recentUsage = topAccount?.snapshot?.recentUsage.slice(0, 5) ?? [];

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

export function FloatingPanelApp({
  overview,
  loading,
  onRefresh
}: {
  overview: OverviewPayload | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<FloatingPanelKey>("overview");
  const [dragging, setDragging] = useState(false);
  const [dock, setDock] = useState<FloatingDock>("right");
  const [ballTop, setBallTop] = useState(420);
  const [workArea, setWorkArea] = useState<FloatingWorkArea>(getDefaultWorkArea);
  const hideTimerRef = useRef<number | null>(null);
  const pointerDownRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const panelVisible = menuOpen;
  const metrics = useMemo(
    () =>
      computeFloatingWindowPlacement({
        dock,
        menuVisible: menuOpen,
        panelVisible,
        workArea,
        ballTop
      }),
    [dock, menuOpen, panelVisible, workArea, ballTop]
  );

  const activeMenu = MENU_ITEMS.find((item) => item.key === activePanel) ?? MENU_ITEMS[0];

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let cancelled = false;

    async function syncWindow() {
      const [{ currentMonitor, getCurrentWindow }, { PhysicalPosition, PhysicalSize }] = await Promise.all([
        import("@tauri-apps/api/window"),
        import("@tauri-apps/api/dpi")
      ]);
      const appWindow = getCurrentWindow();

      const monitor = await currentMonitor();
      if (!cancelled && monitor) {
        setWorkArea({
          x: monitor.workArea.position.x,
          y: monitor.workArea.position.y,
          width: monitor.workArea.size.width,
          height: monitor.workArea.size.height
        });
      }

      await appWindow.setSize(new PhysicalSize(metrics.width, metrics.height));
      await appWindow.setPosition(new PhysicalPosition(metrics.x, metrics.y));
    }

    void syncWindow();

    return () => {
      cancelled = true;
    };
  }, [metrics.width, metrics.height, metrics.x, metrics.y]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    async function bindMoveListener() {
      const [{ getCurrentWindow, currentMonitor }, { PhysicalPosition }] = await Promise.all([
        import("@tauri-apps/api/window"),
        import("@tauri-apps/api/dpi")
      ]);
      const appWindow = getCurrentWindow();

      unlisten = await appWindow.onMoved(async ({ payload }) => {
        if (cancelled || !dragging) {
          return;
        }

        const monitor = (await currentMonitor()) ?? null;
        const nextWorkArea = monitor
          ? {
              x: monitor.workArea.position.x,
              y: monitor.workArea.position.y,
              width: monitor.workArea.size.width,
              height: monitor.workArea.size.height
            }
          : workArea;

        setWorkArea(nextWorkArea);
        const nextBallCenterX = payload.x + metrics.ballX + FLOATING_ORB_SIZE / 2;
        const nextDock = resolveFloatingDock(nextBallCenterX, nextWorkArea);
        setDock(nextDock);
        setBallTop(payload.y + metrics.ballY);

        if (!menuOpen) {
          const collapsed = computeFloatingWindowPlacement({
            dock: nextDock,
            menuVisible: false,
            panelVisible: false,
            workArea: nextWorkArea,
            ballTop: payload.y + metrics.ballY
          });
          await appWindow.setPosition(new PhysicalPosition(collapsed.x, collapsed.y));
        }
      });
    }

    void bindMoveListener();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [dragging, menuOpen, metrics.ballX, metrics.ballY, workArea]);

  function clearHideTimer() {
    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }

  function scheduleHideMenu() {
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => {
      setMenuOpen(false);
    }, 180);
  }

  async function startDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    clearHideTimer();
    if (!isTauriRuntime()) {
      return;
    }
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    setDragging(true);
    try {
      await getCurrentWindow().startDragging();
    } finally {
      setDragging(false);
      scheduleHideMenu();
    }
  }

  async function handleOrbPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    pointerDownRef.current = {
      x: event.clientX,
      y: event.clientY,
      moved: false
    };
  }

  async function handleOrbPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!pointerDownRef.current || pointerDownRef.current.moved) {
      return;
    }
    const deltaX = Math.abs(event.clientX - pointerDownRef.current.x);
    const deltaY = Math.abs(event.clientY - pointerDownRef.current.y);
    if (deltaX < 4 && deltaY < 4) {
      return;
    }
    pointerDownRef.current.moved = true;
    await startDrag(event);
  }

  function handleOrbPointerUp() {
    const pointerState = pointerDownRef.current;
    pointerDownRef.current = null;
    if (!pointerState || pointerState.moved) {
      return;
    }
    clearHideTimer();
    setMenuOpen((current) => !current);
  }

  function openPanel(key: FloatingPanelKey) {
    setActivePanel(key);
    setMenuOpen(true);
  }

  function handleOpenMain(nav: FloatingMenuItem["nav"]) {
    void openMainWindow(nav);
  }

  function renderPanel() {
    switch (activePanel) {
      case "alerts":
        return <FloatingAlertsPanel overview={overview} onOpenMain={() => handleOpenMain("alerts")} />;
      case "subscriptions":
        return <FloatingSubscriptionsPanel overview={overview} onOpenMain={() => handleOpenMain("subscriptions")} />;
      case "usage":
        return <FloatingUsagePanel overview={overview} onOpenMain={() => handleOpenMain("usage")} />;
      case "overview":
      default:
        return <FloatingOverviewPanel overview={overview} onOpenMain={() => handleOpenMain("overview")} />;
    }
  }

  return (
    <main
      className={`floating-stage dock-${dock} ${menuOpen ? "menu-open" : "menu-collapsed"} ${dragging ? "dragging" : ""}`}
      onMouseEnter={() => {
        clearHideTimer();
        setMenuOpen(true);
      }}
      onMouseLeave={() => {
        if (!dragging) {
          scheduleHideMenu();
        }
      }}
    >
      <section className="floating-panel-shell" aria-hidden={!panelVisible} style={{ left: metrics.panelX, top: metrics.panelY }}>
        <div className={`floating-preview-card ${panelVisible ? "visible" : "hidden"}`}>{renderPanel()}</div>
      </section>

      <section className="floating-menu-shell" style={{ left: metrics.menuX, top: metrics.menuY }}>
        <div className={`floating-menu-card ${menuOpen ? "visible" : "hidden"}`}>
          <div className="floating-menu-header">
            <div>
              <span className="floating-menu-eyebrow">INPUT PANEL</span>
              <strong>悬浮面板</strong>
            </div>
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
                  onClick={() => openPanel(item.key)}
                >
                  <div className="floating-menu-item-icon">
                    <Icon size={16} />
                  </div>
                  <div className="floating-menu-item-copy">
                    <strong>{item.label}</strong>
                    <span>{item.hint}</span>
                  </div>
                  <ChevronRight size={14} />
                </button>
              );
            })}
          </div>

          <button
            type="button"
            className="floating-menu-main-button"
            onClick={() => handleOpenMain(activeMenu.nav)}
          >
            打开{activeMenu.label}
          </button>
        </div>
      </section>

      <section className="floating-orb-shell" style={{ left: metrics.ballX, top: metrics.ballY }}>
        <button
          type="button"
          className="floating-orb-button"
          onPointerDown={(event) => {
            void handleOrbPointerDown(event);
          }}
          onPointerMove={(event) => {
            void handleOrbPointerMove(event);
          }}
          onPointerUp={handleOrbPointerUp}
          onPointerCancel={() => {
            pointerDownRef.current = null;
          }}
          aria-label="打开悬浮快捷菜单"
          title="打开悬浮快捷菜单"
        >
          <span className="floating-orb-glow" />
          <span className="floating-orb-logo-shell">
            <img src={projectLogo} alt="" className="floating-orb-logo" />
          </span>
        </button>
        <div className={`floating-orb-pill ${menuOpen ? "visible" : ""}`}>
          <PanelRightOpen size={13} />
          <span>{activeMenu.label}</span>
        </div>
      </section>
    </main>
  );
}
