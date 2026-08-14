import { getCurrentWindow } from "@tauri-apps/api/window";
import { Bell, UserRound } from "lucide-react";
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";

import { formatLiveClockDate, formatLiveClockTime } from "../shared/lib/formatters";
import { isTauriRuntime } from "../shared/transport/runtime";

type AlertSeverity = "critical" | "high" | "medium" | "low" | "success" | "info";

export function WindowChrome({
  title,
  logoSrc,
  alertCount = 0,
  latestUnreadAlertSeverity = null,
  onTriggerTestNotification,
  onOpenProfile,
  onOpenAlerts
}: {
  title: string;
  logoSrc: string;
  alertCount?: number;
  latestUnreadAlertSeverity?: AlertSeverity | null;
  onTriggerTestNotification?: (kind: "down" | "recovered") => void;
  onOpenProfile?: () => void;
  onOpenAlerts?: () => void;
}) {
  const desktopWindowControlsAvailable = isTauriRuntime();
  const [clockNow, setClockNow] = useState(() => new Date());

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setClockNow(new Date());
    }, 1000);

    return () => {
      window.clearInterval(timerId);
    };
  }, []);

  async function handleWindowAction(action: "minimize" | "toggle-maximize" | "close") {
    if (!desktopWindowControlsAvailable) {
      return;
    }

    const appWindow = getCurrentWindow();
    if (action === "minimize") {
      await appWindow.minimize();
      return;
    }
    if (action === "toggle-maximize") {
      await appWindow.toggleMaximize();
      return;
    }
    await appWindow.close();
  }

  async function handleTitlebarDoubleClick(event: ReactMouseEvent<HTMLElement>) {
    if (!desktopWindowControlsAvailable) {
      return;
    }
    if ((event.target as HTMLElement).closest(".window-chrome-dot, .window-chrome-alert-button, .window-chrome-profile-button")) {
      return;
    }
    await getCurrentWindow().toggleMaximize();
  }

  const desktopOnlyHint = desktopWindowControlsAvailable ? "" : "，浏览器预览不可用";
  const alertBadgeToneClass = resolveAlertBadgeToneClass(latestUnreadAlertSeverity);

  return (
    <div className="window-chrome-shell">
      <header
        className="window-chrome"
        data-browser-preview={!desktopWindowControlsAvailable}
        data-tauri-drag-region
        onDoubleClick={(event) => {
          void handleTitlebarDoubleClick(event);
        }}
      >
        <div className="window-chrome-leading">
          <div className="window-chrome-clock" aria-live="polite">
            <span className="window-chrome-clock-date">{formatLiveClockDate(clockNow)}</span>
            <strong className="window-chrome-clock-time">{formatLiveClockTime(clockNow)}</strong>
          </div>
        </div>
        <div className="window-chrome-title">
          <span className="window-chrome-title-logo-shell" aria-hidden="true">
            <img className="window-chrome-title-logo" src={logoSrc} alt="" />
          </span>
          <span className="window-chrome-title-text">{title}</span>
        </div>
        <div className="window-chrome-trailing">
          <div className="window-chrome-controls" role="toolbar" aria-label="窗口控制">
            {onOpenProfile ? (
              <button
                type="button"
                className="window-chrome-alert-button window-chrome-profile-button"
                onClick={onOpenProfile}
                aria-label="打开个人中心"
                title="个人中心"
              >
                <UserRound size={14} />
              </button>
            ) : null}
            {onTriggerTestNotification ? (
              <>
                <button
                  type="button"
                  className="window-chrome-alert-button window-chrome-test-button critical"
                  onClick={() => onTriggerTestNotification("down")}
                  aria-label="测试红色通知"
                  title="测试红色通知"
                >
                  <Bell size={14} />
                </button>
                <button
                  type="button"
                  className="window-chrome-alert-button window-chrome-test-button success"
                  onClick={() => onTriggerTestNotification("recovered")}
                  aria-label="测试绿色通知"
                  title="测试绿色通知"
                >
                  <Bell size={14} />
                </button>
              </>
            ) : null}
            {onOpenAlerts ? (
              <button
                type="button"
                className="window-chrome-alert-button"
                onClick={onOpenAlerts}
                aria-label="消息盒子"
                title={alertCount > 0 ? `消息盒子，${alertCount} 条待处理` : "消息盒子"}
              >
                <Bell size={14} />
                {alertBadgeToneClass ? (
                  <span
                    className={`topbar-alert-badge ${alertBadgeToneClass}`}
                    aria-hidden="true"
                  />
                ) : null}
              </button>
            ) : null}
            <button
              type="button"
              className="window-chrome-dot minimize"
              aria-label="最小化窗口"
              title={`最小化窗口${desktopOnlyHint}`}
              disabled={!desktopWindowControlsAvailable}
              onClick={() => {
                void handleWindowAction("minimize");
              }}
            />
            <button
              type="button"
              className="window-chrome-dot maximize"
              aria-label="最大化或还原窗口"
              title={`最大化或还原窗口${desktopOnlyHint}`}
              disabled={!desktopWindowControlsAvailable}
              onClick={() => {
                void handleWindowAction("toggle-maximize");
              }}
            />
            <button
              type="button"
              className="window-chrome-dot close"
              aria-label="关闭窗口"
              title={`关闭窗口${desktopOnlyHint}`}
              disabled={!desktopWindowControlsAvailable}
              onClick={() => {
                void handleWindowAction("close");
              }}
            />
          </div>
        </div>
      </header>
    </div>
  );
}

function resolveAlertBadgeToneClass(severity: AlertSeverity | null) {
  if (severity == null) {
    return "";
  }
  if (severity === "critical" || severity === "high") {
    return "topbar-alert-badge-critical";
  }
  if (severity === "low" || severity === "success") {
    return "topbar-alert-badge-success";
  }
  return "topbar-alert-badge-neutral";
}
