import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  normalizeSystemSettingsStepperValue,
  SystemSettingsPage
} from "../src/pages/SystemSettingsPage";
import type { DatabaseStorageStatus, DesktopUiPrefs } from "../src/types";

const desktopUiPrefs: DesktopUiPrefs = {
  version: 1,
  launchMode: "main",
  openFloatingInMainMode: true,
  keepFloatingPanelVisible: true,
  floatingPanelOpacity: 0.82,
  floatingNotificationDurationMs: 7000,
  floatingNotificationDensity: "standard",
  floatingNotificationMaxVisible: 3,
  floatingNotificationSoundSource: "default",
  floatingNotificationSoundFileName: null,
  floatingNotificationSoundStorageKey: null,
  floatingNotificationSoundVolume: 100,
  closeBehavior: "ask",
  autoRefreshEnabled: true,
  autoRefreshIntervalSeconds: 9,
  autoRefreshServiceStatusEnabled: true,
  autoRefreshCoreEnabled: true,
  autoRefreshCoreIntervalSeconds: 15,
  autoRefreshKeysEnabled: true,
  autoRefreshKeysIntervalSeconds: 12,
  autoRefreshUsageEnabled: false,
  autoRefreshUsageIntervalSeconds: 30,
  overviewAccountRuntimeTimeoutMs: 4500,
  theme: "titan-noir"
};

const databaseStorageStatus: DatabaseStorageStatus = {
  runtimeScope: "web",
  currentDatabasePath: "C:\\Users\\demo\\input_panel\\web\\config.sqlite",
  currentDirectory: "C:\\Users\\demo\\input_panel\\web",
  userDirectory: "C:\\Users\\demo\\input_panel\\web",
  programDirectory: "D:\\xm\\inputPanel",
  targetDirectory: "D:\\InputPanelData",
  overrideActive: false,
  migrationSupported: true,
  migrationPhase: "idle",
  restartRequired: false,
  lastError: null
};

const systemSettingsProps: ComponentProps<typeof SystemSettingsPage> = {
  theme: "titan-noir",
  setTheme: () => {},
  desktopUiPrefs,
  desktopUiLoading: false,
  desktopUiLoadError: null,
  onLaunchModeChange: () => {},
  onFloatingVisibleChange: () => {},
  onFloatingPanelPinnedChange: () => {},
  onFloatingPanelOpacityChange: () => {},
  onFloatingNotificationDurationMsChange: () => {},
  onFloatingNotificationDensityChange: () => {},
  onFloatingNotificationMaxVisibleChange: () => {},
  onFloatingNotificationSoundVolumeChange: () => {},
  floatingNotificationSoundAction: null,
  onSelectFloatingNotificationSound: () => {},
  onPreviewFloatingNotificationSound: () => {},
  onRestoreDefaultFloatingNotificationSound: () => {},
  onCloseBehaviorChange: () => {},
  onAutoRefreshEnabledChange: () => {},
  onServiceStatusAutoRefreshEnabledChange: () => {},
  onServiceStatusRefreshIntervalSecondsChange: () => {},
  onCoreAutoRefreshEnabledChange: () => {},
  onCoreAutoRefreshIntervalSecondsChange: () => {},
  onKeysAutoRefreshEnabledChange: () => {},
  onKeysAutoRefreshIntervalSecondsChange: () => {},
  onUsageAutoRefreshEnabledChange: () => {},
  onUsageAutoRefreshIntervalSecondsChange: () => {},
  onOverviewAccountRuntimeTimeoutMsChange: () => {},
  schedulerConfig: {
    enabled: true,
    intervalSeconds: 5,
    subscriptionIntervalSeconds: 30
  },
  schedulerConfigLoading: false,
  schedulerLoadError: null,
  onRetrySchedulerConfigLoad: () => {},
  onSchedulerConfigChange: () => {},
  runtimeCoordinationConfig: {
    siteRequestsPerSecond: 3,
    siteMaxInFlight: 3,
    usagePageMaxInFlight: 4
  },
  runtimeCoordinationConfigLoading: false,
  runtimeCoordinationLoadError: null,
  onRetryRuntimeCoordinationConfigLoad: () => {},
  onRuntimeCoordinationConfigChange: () => {},
  upstreamNetworkConfig: {
    useSystemProxy: true
  },
  upstreamNetworkConfigLoading: false,
  upstreamNetworkLoadError: null,
  onRetryUpstreamNetworkConfigLoad: () => {},
  onUpstreamNetworkConfigChange: () => {},
  databaseStorageStatus,
  databaseStorageTargetDirectory: databaseStorageStatus.targetDirectory,
  databaseStorageLoading: false,
  databaseStorageMigrationLoading: false,
  databaseStorageLoadError: null,
  databaseStorageMigrationError: null,
  databaseStorageMigrationResult: null,
  onDatabaseStorageTargetDirectoryChange: () => {},
  onRetryDatabaseStorageStatus: () => {},
  onMigrateDatabaseStorage: () => {},
  onClearRuntimeData: () => {},
  clearRuntimeDataLoading: false
};

function renderSystemSettings(overrides: Partial<ComponentProps<typeof SystemSettingsPage>> = {}) {
  return renderToStaticMarkup(createElement(SystemSettingsPage, {
    ...systemSettingsProps,
    ...overrides
  }));
}

describe("SystemSettingsPage", () => {
  it("normalizes notification steppers to supported integer values before a desktop patch", () => {
    expect(
      normalizeSystemSettingsStepperValue("2.5", { min: 1, max: 5, step: 1 })
    ).toBe(3);
    expect(
      normalizeSystemSettingsStepperValue("2.5", { min: 3, max: 30, step: 1 })
    ).toBe(3);
    expect(
      normalizeSystemSettingsStepperValue("31", { min: 3, max: 30, step: 1 })
    ).toBe(30);
    expect(
      normalizeSystemSettingsStepperValue("", { min: 1, max: 5, step: 1 })
    ).toBeNull();
    expect(
      normalizeSystemSettingsStepperValue("not-a-number", { min: 1, max: 5, step: 1 })
    ).toBeNull();
  });

  it("renders window, sound, refresh, scheduler, and coordination settings", () => {
    const html = renderSystemSettings();

    expect(html).toContain("悬浮快捷菜单常驻显示");
    expect(html).toContain("开启后悬浮菜单会一直显示");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
    expect(html).toContain("Theme Lab");
    expect(html).toContain("钛夜主控");
    expect(html).toContain("极地中继");
    expect(html).toContain("余烬回路");
    expect(html).toContain("青核中枢");
    expect(html).toContain("樱雾信标");
    expect(html).not.toContain("中性运营灰");
    expect(html).not.toContain("石墨青夜班");
    expect(html).not.toContain("暖纸控制台");
    expect(html).toContain("前端自动刷新");
    expect(html).toContain("启用前端自动刷新");
    expect(html).toContain('aria-label="查看前端自动刷新说明"');
    expect(html).toContain("关闭后会暂停全部自动刷新。手动刷新始终可用。");
    expect(html).toContain("服务状态与公开端点");
    expect(html).toContain("核心总览");
    expect(html).toContain("密钥");
    expect(html).toContain("用量");
    expect(html).toContain("总览单账号超时(毫秒)");
    expect(html).toContain("悬浮窗透明度");
    expect(html).toContain("悬浮消息");
    expect(html).toContain("消息密度");
    expect(html).toContain("显示时长");
    expect(html).toContain("最大显示数量");
    expect(html).toContain("Windows Toast 提示音");
    expect(html).toContain("提示音音量");
    expect(html).toContain("紧凑");
    expect(html).toContain("宽松");
    expect(html).not.toContain("当前主题");
    expect(html).not.toContain("主题与展示");
    expect(html).toContain("每个分组只影响对应消费者");
    expect(html).toContain('type="number"');
    expect(html).toContain('min="5"');
    expect(html).toContain("number-stepper");
    expect(html).toContain('aria-label="服务状态与公开端点间隔增加 1 秒"');
    expect(html).toContain('aria-label="服务状态与公开端点间隔减少 1 秒"');
    expect(html).toContain('data-testid="service-status-refresh-interval"');
    expect(html).toContain('data-testid="core-refresh-interval"');
    expect(html).toContain('data-testid="keys-refresh-interval"');
    expect(html).toContain('data-testid="usage-refresh-interval"');
    expect(html).toContain('data-testid="overview-account-runtime-timeout-ms"');
    expect(html).toContain("后端用量自动同步");
    expect(html).toContain('min="15"');
    expect(html).toContain("15-300 秒, 默认 30 秒。订阅与额度规则按独立节奏检查。");
    expect(html).toContain("共享请求速率(每秒)");
    expect(html).toContain("上游网络");
    expect(html).toContain("使用系统代理");
    expect(html).toContain("system-settings-layout");
    expect(html).toContain("system-settings-column");
    expect(html.indexOf("Theme Lab")).toBeLessThan(html.indexOf("窗口与托盘"));
    expect(html.indexOf("Theme Lab")).toBeLessThan(html.indexOf("数据库存储"));
    expect(html).toContain("危险操作");
    expect(html).toContain("清空所有数据");
    expect(html).toContain("默认只清空使用过程中产生的数据. 勾选后会把站点和账号也一起删除。");
  });

  it("disables native window controls in browser debug mode while keeping browser-safe settings available", () => {
    const html = renderSystemSettings({ nativeWindowControlsAvailable: false });

    expect(html).toContain("浏览器调试模式不支持原生窗口控制。");
    expect(html).toContain("请在桌面应用中调整启动模式、悬浮窗口和关闭行为。");
    expect(html).toContain('id="native-window-controls-unavailable"');
    expect(html).toContain('aria-describedby="native-window-controls-unavailable"');
    expect(html).toContain('aria-label="原生窗口控制"');
    expect(html).toContain('style="border:0;margin:0;min-width:0;padding:0"');
    expect(html).toContain('class="stack-list system-settings-native-controls" disabled=""');

    const autoRefreshIntervalInput = html.match(
      /<input[^>]*data-testid="service-status-refresh-interval"[^>]*>/
    )?.[0];
    const overviewTimeoutInput = html.match(
      /<input[^>]*data-testid="overview-account-runtime-timeout-ms"[^>]*>/
    )?.[0];

    expect(autoRefreshIntervalInput).toBeDefined();
    expect(autoRefreshIntervalInput).not.toContain("disabled");
    expect(overviewTimeoutInput).toBeDefined();
    expect(overviewTimeoutInput).not.toContain("disabled");
    expect(html).toContain("共享请求速率(每秒)");
    expect(html).toContain("使用系统代理");
    expect(html).toContain("数据库存储");
    expect(html).toContain("迁移数据库");
  });
});
