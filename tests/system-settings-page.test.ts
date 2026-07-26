import { createElement } from "react";
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

  it("renders the floating panel pin toggle", () => {
    const html = renderToStaticMarkup(
      createElement(SystemSettingsPage, {
        theme: "titan-noir",
        setTheme: () => {},
        desktopUiPrefs,
        desktopUiLoading: false,
        desktopUiSaveState: {
          phase: "failed",
          pendingFields: [],
          savingFields: [],
          failedFields: ["floatingPanelOpacity"],
          error: "模拟保存失败",
          lastSavedAt: null
        },
        desktopUiLoadError: null,
        onRetryDesktopUiPrefs: () => {},
        onLaunchModeChange: () => {},
        onFloatingVisibleChange: () => {},
        onFloatingPanelPinnedChange: () => {},
        onFloatingPanelOpacityChange: () => {},
        onFloatingNotificationDurationMsChange: () => {},
        onFloatingNotificationDensityChange: () => {},
        onFloatingNotificationMaxVisibleChange: () => {},
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
          intervalSeconds: 5
        },
        schedulerConfirmedConfig: {
          enabled: true,
          intervalSeconds: 9
        },
        schedulerConfigLoading: false,
        schedulerConfigSaving: false,
        schedulerLoadError: null,
        schedulerSaveError: "模拟调度器失败",
        onRetrySchedulerConfigLoad: () => {},
        onRetrySchedulerConfig: () => {},
        onSchedulerConfigChange: () => {},
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
      })
    );

    expect(html).toContain("悬浮快捷菜单常驻显示");
    expect(html).toContain("开启后悬浮菜单会一直显示");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
    expect(html).toContain("Theme Lab");
    expect(html).not.toContain("Control Deck");
    expect(html).toContain("钛夜主控");
    expect(html).toContain("极地中继");
    expect(html).toContain("余烬回路");
    expect(html).toContain("青核中枢");
    expect(html).toContain("樱雾信标");
    expect(html).not.toContain("中性运营灰");
    expect(html).not.toContain("石墨青夜班");
    expect(html).not.toContain("暖纸控制台");
    expect(html).toContain("前端自动刷新");
    expect(html).toContain("以下设置尚未保存: 悬浮窗透明度");
    expect(html).toContain("当前界面保留新值");
    expect(html).toContain("重试保存");
    expect(html).toContain("后端用量同步器设置未保存: 模拟调度器失败");
    expect(html).toContain("已保存值: 已启用, 间隔 9 秒。");
    expect(html).toContain("重试保存");
    expect(html).toContain("启用前端自动刷新");
    expect(html).toContain("自动更新常用页面和服务状态, 不会打断你当前操作。");
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
    expect(html).toContain("紧凑");
    expect(html).toContain("宽松");
    expect(html).not.toContain("当前主题");
    expect(html).not.toContain("主题切换会同步到主窗口、悬浮球和悬浮面板。");
    expect(html).not.toContain("总览 / 订阅 / 账号与站点");
    expect(html).not.toContain("用量 / 按密钥查看 / 数据分析");
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
    expect(html).toContain("后端用量同步器");
    expect(html).toContain('min="15"');
    expect(html).toContain("最低 15 秒。后台会按这个间隔更新用量缓存");
    expect(html).toContain("system-settings-layout");
    expect(html).toContain("system-settings-column");
    expect(html.indexOf("Theme Lab")).toBeLessThan(html.indexOf("窗口与托盘"));
    expect(html.indexOf("Theme Lab")).toBeLessThan(html.indexOf("数据库存储"));
    expect(html).not.toContain("主题与展示");
    expect(html).toContain("危险操作");
    expect(html).toContain("清空所有数据");
    expect(html).toContain("默认只清空使用过程中产生的数据. 勾选后会把站点和账号也一起删除。");
  });

  it("disables native window controls in browser debug mode while keeping browser-safe settings available", () => {
    const html = renderToStaticMarkup(
      createElement(SystemSettingsPage, {
        theme: "titan-noir",
        setTheme: () => {},
        desktopUiPrefs,
        desktopUiLoading: false,
        desktopUiSaveState: {
          phase: "idle",
          pendingFields: [],
          savingFields: [],
          failedFields: [],
          error: null,
          lastSavedAt: null
        },
        desktopUiLoadError: null,
        onRetryDesktopUiPrefs: () => {},
        nativeWindowControlsAvailable: false,
        onLaunchModeChange: () => {},
        onFloatingVisibleChange: () => {},
        onFloatingPanelPinnedChange: () => {},
        onFloatingPanelOpacityChange: () => {},
        onFloatingNotificationDurationMsChange: () => {},
        onFloatingNotificationDensityChange: () => {},
        onFloatingNotificationMaxVisibleChange: () => {},
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
          intervalSeconds: 5
        },
        schedulerConfirmedConfig: {
          enabled: true,
          intervalSeconds: 9
        },
        schedulerConfigLoading: false,
        schedulerConfigAvailable: false,
        schedulerConfigSaving: false,
        schedulerLoadError: null,
        schedulerSaveError: null,
        onRetrySchedulerConfigLoad: () => {},
        onRetrySchedulerConfig: () => {},
        onSchedulerConfigChange: () => {},
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
      })
    );

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
    expect(html).toContain("浏览器调试模式不会启动后端用量同步器。");
    expect(html).toContain("数据库存储");
    expect(html).toContain("迁移数据库");
  });
});
