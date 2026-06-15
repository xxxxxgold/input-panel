import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SystemSettingsPage } from "../src/pages/SystemSettingsPage";
import type { DesktopUiPrefs } from "../src/types";

const desktopUiPrefs: DesktopUiPrefs = {
  version: 1,
  launchMode: "main",
  openFloatingInMainMode: true,
  keepFloatingPanelVisible: true,
  closeBehavior: "ask",
  theme: "light"
};

describe("SystemSettingsPage", () => {
  it("renders the floating panel pin toggle", () => {
    const html = renderToStaticMarkup(
      createElement(SystemSettingsPage, {
        theme: "light",
        setTheme: () => {},
        desktopUiPrefs,
        desktopUiLoading: false,
        onLaunchModeChange: () => {},
        onFloatingVisibleChange: () => {},
        onFloatingPanelPinnedChange: () => {},
        onCloseBehaviorChange: () => {}
      })
    );

    expect(html).toContain("悬浮快捷菜单常驻显示");
    expect(html).toContain("开启后图片悬浮菜单会一直显示");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
    expect(html).toContain("中性运营灰");
    expect(html).toContain("石墨青夜班");
    expect(html).toContain("暖纸控制台");
    expect(html).toContain("琥珀交易台");
  });
});
