import { useEffect } from "react";

import { FloatingPanelApp } from "./FloatingPanelApp";
import { ToastHost } from "./ToastHost";
import { useDesktopUiPrefs } from "../features/desktop-ui/useDesktopUiPrefs";
import { useMonitorStore } from "../store/monitor-store";

const ALLOWED_THEMES = new Set(["light", "dark", "deep-blue"]);

export function FloatingWindowRoot() {
  const desktopUi = useDesktopUiPrefs("floating");
  const theme = useMonitorStore((state) => state.theme);
  const setTheme = useMonitorStore((state) => state.setTheme);
  const overview = useMonitorStore((state) => state.overview);
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
    document.body.classList.add("floating-window-body");
    return () => {
      document.body.classList.remove("floating-window-body");
    };
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  return (
    <>
      <FloatingPanelApp overview={overview} loading={loading} onRefresh={() => void loadOverview()} />
      <ToastHost toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
