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
  floatingPanelOpacity: 0.82,
  closeBehavior: "ask",
  autoRefreshEnabled: true,
  autoRefreshIntervalSeconds: 9,
  autoRefreshCoreEnabled: true,
  autoRefreshCoreIntervalSeconds: 15,
  autoRefreshKeysEnabled: true,
  autoRefreshKeysIntervalSeconds: 12,
  autoRefreshUsageEnabled: false,
  autoRefreshUsageIntervalSeconds: 30,
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
        onFloatingPanelOpacityChange: () => {},
        onCloseBehaviorChange: () => {},
        onAutoRefreshEnabledChange: () => {},
        onServiceStatusRefreshIntervalSecondsChange: () => {},
        onAutoRefreshCoreEnabledChange: () => {},
        onAutoRefreshCoreIntervalSecondsChange: () => {},
        onAutoRefreshKeysEnabledChange: () => {},
        onAutoRefreshKeysIntervalSecondsChange: () => {},
        onAutoRefreshUsageEnabledChange: () => {},
        onAutoRefreshUsageIntervalSecondsChange: () => {},
        schedulerConfig: {
          enabled: true,
          intervalSeconds: 5
        },
        schedulerConfigLoading: false,
        onSchedulerConfigChange: () => {}
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
    expect(html).toContain("冷杉机房");
    expect(html).toContain("极地实验台");
    expect(html).toContain("光谱实验台");
    expect(html).toContain("医护监测舱");
    expect(html).toContain("审计档案室");
    expect(html).toContain("有账号时自动刷新数据");
    expect(html).toContain("静默拉取当前页数据, 不会整页刷新");
    expect(html).toContain("服务状态刷新间隔(秒)");
    expect(html).toContain("核心数据 / 订阅 / 站点账号配置");
    expect(html).toContain("密钥");
    expect(html).toContain("用量 / 单 Key / 图表实验室");
    expect(html).toContain('type="number"');
    expect(html).toContain('min="1"');
    expect(html).toContain("number-stepper");
    expect(html).toContain('aria-label="间隔(秒)增加 1 秒"');
    expect(html).toContain('aria-label="间隔(秒)减少 1 秒"');
    expect(html).toContain('data-testid="core-refresh-interval"');
    expect(html).toContain("system-settings-layout");
    expect(html).toContain("system-settings-column");
  });
});
