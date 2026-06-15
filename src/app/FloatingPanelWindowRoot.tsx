import { useEffect } from "react";

import { FloatingPanelWindow } from "./FloatingPanelWindow";
import { type NotificationInboxItem } from "../features/overview/components/AlertInboxModal";
import { ToastHost } from "./ToastHost";
import { useDesktopUiPrefs } from "../features/desktop-ui/useDesktopUiPrefs";
import { useMonitorStore } from "../store/monitor-store";

const ALLOWED_THEMES = new Set(["light", "dark", "deep-blue"]);

export function FloatingPanelWindowRoot() {
  const desktopUi = useDesktopUiPrefs("floating-panel");
  const theme = useMonitorStore((state) => state.theme);
  const setTheme = useMonitorStore((state) => state.setTheme);
  const overview = useMonitorStore((state) => state.overview);
  const appNotifications = useMonitorStore((state) => state.appNotifications);
  const loading = useMonitorStore((state) => state.loading);
  const toasts = useMonitorStore((state) => state.toasts);
  const dismissToast = useMonitorStore((state) => state.dismissToast);
  const loadOverview = useMonitorStore((state) => state.loadOverview);

  useEffect(() => {
    if (ALLOWED_THEMES.has(desktopUi.prefs.theme) && theme !== desktopUi.prefs.theme) {
      setTheme(desktopUi.prefs.theme as "light" | "dark" | "deep-blue");
    }
  }, [desktopUi.prefs.theme, setTheme, theme]);

  useEffect(() => {
    document.documentElement.classList.remove("light", "dark", "deep-blue");
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

  const notificationItems: NotificationInboxItem[] = [
    ...appNotifications.map((item) => ({
      source: "service-status" as const,
      id: item.id,
      severity: item.severity,
      title: item.title,
      detail: item.detail,
      createdAt: item.createdAt,
      models: item.models
    })),
    ...(overview?.alerts ?? []).map((alert) => ({
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
