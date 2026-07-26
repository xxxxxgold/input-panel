import { useEffect } from "react";

import { FloatingOrbWindow } from "./FloatingOrbWindow";
import { useDesktopUiPrefs } from "../features/desktop-ui/useDesktopUiPrefs";
import { useMonitorStore } from "../store/monitor-store";
import { THEME_IDS, normalizeThemeId } from "../shared/lib/theme";
import { applyThemeToDocument } from "../shared/lib/apply-theme";

const ALLOWED_THEMES = new Set<string>(THEME_IDS);

export function FloatingWindowRoot() {
  const desktopUi = useDesktopUiPrefs("floating");
  const theme = useMonitorStore((state) => state.theme);
  const setTheme = useMonitorStore((state) => state.setTheme);

  useEffect(() => {
    if (ALLOWED_THEMES.has(desktopUi.prefs.theme) && theme !== desktopUi.prefs.theme) {
      setTheme(normalizeThemeId(desktopUi.prefs.theme));
    }
  }, [desktopUi.prefs.theme, setTheme, theme]);

  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  return <FloatingOrbWindow keepPanelVisible={desktopUi.prefs.keepFloatingPanelVisible} />;
}
