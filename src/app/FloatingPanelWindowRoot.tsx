import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

import { FloatingPanelWindow } from "./FloatingPanelWindow";
import { type NotificationInboxItem } from "../features/overview/components/AlertInboxModal";
import { ToastHost } from "./ToastHost";
import { useDesktopUiPrefs } from "../features/desktop-ui/useDesktopUiPrefs";
import { useMonitorStore } from "../store/monitor-store";
import { isTauriRuntime } from "../shared/transport/runtime";
import { THEME_IDS, normalizeThemeId } from "../shared/lib/theme";

const ALLOWED_THEMES = new Set<string>(THEME_IDS);

export function FloatingPanelWindowRoot() {
  const desktopUi = useDesktopUiPrefs("floating-panel");
  const theme = useMonitorStore((state) => state.theme);
  const setTheme = useMonitorStore((state) => state.setTheme);
  const overview = useMonitorStore((state) => state.overview);
  const appNotifications = useMonitorStore((state) => state.appNotifications);
  const dismissedOverviewAlertIds = useMonitorStore((state) => state.dismissedOverviewAlertIds);
  const loading = useMonitorStore((state) => state.loading);
  const toasts = useMonitorStore((state) => state.toasts);
  const pushToast = useMonitorStore((state) => state.pushToast);
  const dismissToast = useMonitorStore((state) => state.dismissToast);
  const loadOverview = useMonitorStore((state) => state.loadOverview);

  useEffect(() => {
    if (ALLOWED_THEMES.has(desktopUi.prefs.theme) && theme !== desktopUi.prefs.theme) {
      setTheme(normalizeThemeId(desktopUi.prefs.theme));
    }
  }, [desktopUi.prefs.theme, setTheme, theme]);

  useEffect(() => {
    document.documentElement.classList.remove(...THEME_IDS);
    document.documentElement.classList.add(theme);
  }, [theme]);

  useEffect(() => {
    document.title = "Input悬浮面板";
    document.documentElement.classList.add("floating-panel-root");
    document.body.classList.add("floating-window-body");
    document.body.classList.add("floating-panel-window-body");
    document.getElementById("root")?.classList.add("floating-panel-root");
    return () => {
      document.title = "Input悬浮面板";
      document.documentElement.classList.remove("floating-panel-root");
      document.body.classList.remove("floating-window-body");
      document.body.classList.remove("floating-panel-window-body");
      document.getElementById("root")?.classList.remove("floating-panel-root");
    };
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let unlistenToast: (() => void) | undefined;
    let disposed = false;

    void listen<{
      tone: "error" | "info";
      message: string;
      durationMs?: number;
    }>("floating-panel-toast", (event) => {
      if (disposed) {
        return;
      }
      pushToast({
        tone: event.payload.tone,
        message: event.payload.message,
        durationMs: event.payload.durationMs
      });
    }).then((cleanup) => {
      unlistenToast = cleanup;
    });

    return () => {
      disposed = true;
      unlistenToast?.();
    };
  }, [pushToast]);

  const notificationItems: NotificationInboxItem[] = [
    ...appNotifications.map((item) => ({
      notificationKey: `service-status:${item.id}`,
      source: "service-status" as const,
      id: item.id,
      severity: item.severity,
      title: item.title,
      detail: item.detail,
      createdAt: item.createdAt,
      models: item.models
    })),
    ...(overview?.alerts ?? [])
      .filter((alert) => !dismissedOverviewAlertIds.includes(alert.id))
      .map((alert) => ({
        notificationKey: `overview-alert:${alert.id}`,
        source: "overview-alert" as const,
        id: alert.id,
        severity: alert.severity,
        title: alert.title,
        detail: alert.detail,
        createdAt: alert.createdAt
      }))
  ].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

  return (
    <>
      <FloatingPanelWindow
        overview={overview}
        notificationItems={notificationItems}
        loading={loading}
        keepVisible={desktopUi.prefs.keepFloatingPanelVisible}
        onRefresh={() => void loadOverview()}
      />
      <ToastHost toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
