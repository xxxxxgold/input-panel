import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  normalizeSystemSettingsStepperValue,
  SystemSettingsPage
} from "../src/pages/SystemSettingsPage";
import type { DatabaseStorageStatus, DesktopUiPrefs } from "../src/types";

const systemSettingsStyles = readFileSync(
  new URL("../src/styles/03-topbar.css", import.meta.url),
  "utf8"
).replace(/\r\n?/g, "\n");

const systemSettingsToggleStyles = readFileSync(
  new URL("../src/styles/04-components.css", import.meta.url),
  "utf8"
).replace(/\r\n?/g, "\n");

const desktopUiPrefs: DesktopUiPrefs = {
  version: 1,
  completedTaskRetentionMinutes: 1,
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

function renderSystemSettingsPageWithPrefs(preferences: DesktopUiPrefs) {
  return renderToStaticMarkup(
    createElement(SystemSettingsPage, {
      theme: "titan-noir",
      setTheme: () => {},
      desktopUiPrefs: preferences,
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
        intervalSeconds: 5
      },
      schedulerConfigLoading: false,
      schedulerLoadError: null,
      onRetrySchedulerConfigLoad: () => {},
      onSchedulerConfigChange: () => {},
      runtimeCoordinationConfig: {
        siteRequestsPerSecond: 3,
        siteMaxInFlight: 3,
        usagePageMaxInFlight: 6
      },
      runtimeCoordinationConfigLoading: false,
      runtimeCoordinationLoadError: null,
      onRetryRuntimeCoordinationConfigLoad: () => {},
      onRuntimeCoordinationConfigChange: () => {},
      upstreamNetworkConfig: { useSystemProxy: false },
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
    })
  );
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
      normalizeSystemSettingsStepperValue("0", { min: 1, max: 1440, step: 1 })
    ).toBe(1);
    expect(
      normalizeSystemSettingsStepperValue("1441", { min: 1, max: 1440, step: 1 })
    ).toBe(1440);
    expect(
      normalizeSystemSettingsStepperValue("", { min: 1, max: 5, step: 1 })
    ).toBeNull();
    expect(
      normalizeSystemSettingsStepperValue("not-a-number", { min: 1, max: 5, step: 1 })
    ).toBeNull();
  });

  it("renders the completed task retention setting with minute bounds", () => {
    const html = renderSystemSettingsPageWithPrefs(desktopUiPrefs);

    expect(html).toContain("任务中心");
    expect(html).toContain("已完成任务保留时间(分钟)");
    expect(html).toContain("默认 1 分钟。");
    expect(html).toContain('data-testid="completed-task-retention-minutes"');
    expect(html).toContain('min="1"');
    expect(html).toContain('max="1440"');
    expect(html).toContain('value="1"');
  });

  it("renders only the custom sound file name instead of an absolute local path", () => {
    const localPath = "C:\\Users\\Alice\\Music\\private-tone.mp3";
    const html = renderSystemSettingsPageWithPrefs({
      ...desktopUiPrefs,
      floatingNotificationSoundSource: "custom",
      floatingNotificationSoundFileName: localPath,
      floatingNotificationSoundStorageKey:
        "notification-sound-550e8400-e29b-41d4-a716-446655440000.mp3"
    });

    expect(html).toContain("当前文件: private-tone.mp3");
    expect(html).not.toContain(localPath);
  });

  it("explains system sound and disables preview while muted", () => {
    const systemHtml = renderSystemSettingsPageWithPrefs({
      ...desktopUiPrefs,
      floatingNotificationSoundSource: "system"
    });
    const mutedHtml = renderSystemSettingsPageWithPrefs({
      ...desktopUiPrefs,
      floatingNotificationSoundSource: "muted"
    });
    const mutedPreviewButton = mutedHtml.match(
      /<button(?=[^>]*title="当前处于静音状态")[^>]*>/
    )?.[0];

    expect(systemHtml).toContain("系统提示音");
    expect(systemHtml).toContain("当前使用系统提示音。");
    expect(systemHtml).toContain("其余音量按当前平台设置生效。");
    expect(mutedHtml).toContain("当前不会播放提示音。");
    expect(mutedPreviewButton).toContain("disabled");
  });

  it("starts the zero-volume visual track at the actual left edge", () => {
    const html = renderSystemSettingsPageWithPrefs({
      ...desktopUiPrefs,
      floatingNotificationSoundVolume: 0
    });
    const soundVolumeInput = html.match(/<input(?=[^>]*aria-label="提示音音量")[^>]*>/)?.[0];

    expect(soundVolumeInput).toContain('class="floating-notification-sound-volume-range"');
    expect(soundVolumeInput).toContain("--floating-notification-sound-volume-fill:0%");
    expect(systemSettingsStyles).toMatch(
      /\.floating-notification-sound-volume-range\s*\{[\s\S]*?appearance: none;/
    );
    expect(systemSettingsStyles).toMatch(
      /\.floating-notification-sound-volume-range::-webkit-slider-runnable-track\s*\{[\s\S]*?background: linear-gradient\(/
    );
  });

  it("offers the retained custom sound after switching to system sound or mute", () => {
    const savedCustomSound = {
      floatingNotificationSoundFileName: "private-tone.mp3",
      floatingNotificationSoundStorageKey:
        "notification-sound-550e8400-e29b-41d4-a716-446655440000.mp3"
    };
    const systemHtml = renderSystemSettingsPageWithPrefs({
      ...desktopUiPrefs,
      ...savedCustomSound,
      floatingNotificationSoundSource: "system"
    });
    const mutedHtml = renderSystemSettingsPageWithPrefs({
      ...desktopUiPrefs,
      ...savedCustomSound,
      floatingNotificationSoundSource: "muted"
    });
    const customHtml = renderSystemSettingsPageWithPrefs({
      ...desktopUiPrefs,
      ...savedCustomSound,
      floatingNotificationSoundSource: "custom"
    });
    const missingSavedSoundHtml = renderSystemSettingsPageWithPrefs({
      ...desktopUiPrefs,
      floatingNotificationSoundSource: "system"
    });

    expect(systemHtml).toContain("使用已保存的自定义提示音");
    expect(mutedHtml).toContain("使用已保存的自定义提示音");
    expect(customHtml).not.toContain("使用已保存的自定义提示音");
    expect(missingSavedSoundHtml).not.toContain("使用已保存的自定义提示音");
  });

  it("renders the floating panel pin toggle", () => {
    const html = renderToStaticMarkup(
      createElement(SystemSettingsPage, {
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
          intervalSeconds: 5
        },
        schedulerConfigLoading: false,
        schedulerLoadError: null,
        onRetrySchedulerConfigLoad: () => {},
        onSchedulerConfigChange: () => {},
        runtimeCoordinationConfig: {
          siteRequestsPerSecond: 3,
          siteMaxInFlight: 3,
          usagePageMaxInFlight: 6
        },
        runtimeCoordinationConfigLoading: false,
        runtimeCoordinationLoadError: null,
        onRetryRuntimeCoordinationConfigLoad: () => {},
        onRuntimeCoordinationConfigChange: () => {},
        upstreamNetworkConfig: { useSystemProxy: false },
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
    expect(html).not.toContain("以下设置尚未保存");
    expect(html).not.toContain("所有设置已保存");
    expect(html).not.toContain("正在保存");
    expect(html).not.toContain("后端用量同步器设置未保存");
    expect(html).toContain("启用前端自动刷新");
    expect(html).toContain('aria-label="查看前端自动刷新说明"');
    expect(html).not.toContain("自动更新常用页面和服务状态, 不会打断你当前操作。");
    expect(html).toContain("关闭后会暂停全部自动刷新。手动刷新始终可用。");
    expect(html).toContain("服务状态与公开端点");
    expect(html).toContain("核心总览");
    expect(html).toContain("密钥");
    expect(html).toContain("用量");
    expect(html).toContain("控制用量、模型统计和数据分析页面的后台刷新。");
    expect(html).toContain("总览单账号超时(毫秒)");
    expect(html).toContain("悬浮窗透明度");
    expect(html).toContain("悬浮消息");
    expect(html).toContain("消息密度");
    expect(html).toContain("显示时长");
    expect(html).toContain("最大显示数量");
    expect(html).toContain("桌面通知提示音");
    expect(html).toContain("内置默认提示音");
    expect(html).toContain("选择文件");
    expect(html).toContain("试听");
    expect(html).toContain("使用系统提示音");
    expect(html).toContain("静音");
    expect(html).toContain("恢复默认");
    expect(html).toContain("提示音音量");
    expect(html).toContain('aria-label="提示音音量"');
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
    expect(html).toContain("后端用量自动同步");
    expect(html).toContain('aria-label="查看后端用量自动同步说明"');
    expect(html).not.toContain("由桌面后端定期向上游读取所有账号的最新用量, 与前端页面刷新相互独立。");
    expect(html).toContain('min="4"');
    expect(html).toContain('max="10"');
    expect(html).toContain("4-10 秒, 默认 6 秒");
    expect(html).toContain("订阅同步间隔(秒)");
    expect(html).toContain('data-testid="subscription-refresh-interval"');
    expect(html).toContain('value="30"');
    expect(html).toContain("15-300 秒, 默认 30 秒");
    expect(html).toContain('data-testid="site-requests-per-second"');
    expect(html).toContain('data-testid="site-max-in-flight"');
    expect(html).toContain('data-testid="usage-page-max-in-flight"');
    expect(html).toContain("共享请求速率(每秒)");
    expect(html).toContain("站点并发请求数");
    expect(html).toContain("用量分页并发数");
    expect(html).toContain("上游网络");
    expect(html).toContain("使用系统代理");
    expect(html).toContain("关闭后，应用会绕过系统和环境代理，直接请求上游。切换只影响新发起的请求。");
    const upstreamNetworkToggle = html.match(
      /<input[^>]*data-testid="use-system-proxy"[^>]*>/
    )?.[0];
    expect(upstreamNetworkToggle).toBeDefined();
    expect(upstreamNetworkToggle).not.toContain("checked");
    expect(upstreamNetworkToggle).not.toContain("disabled");
    expect(html).toContain("前端自动刷新和手动刷新不受影响");
    expect(html).toContain("system-settings-layout");
    expect(html).toContain("system-settings-column");
    expect(html.indexOf("Theme Lab")).toBeLessThan(html.indexOf("窗口与托盘"));
    expect(html.indexOf("Theme Lab")).toBeLessThan(html.indexOf("数据库存储"));
    expect(html).not.toContain("主题与展示");
    expect(html).toContain("危险操作");
    expect(html).toContain('aria-label="查看窗口与托盘说明"');
    expect(html).toContain('aria-label="查看数据库存储说明"');
    expect(html).toContain('aria-label="查看危险操作说明"');
    expect(html).toContain("清空所有数据");
    expect(html).toContain("默认只清空使用过程中产生的数据. 勾选后会把站点和账号也一起删除。");
  });

  it("renders every persistent system setting checkbox as a rounded switch", () => {
    const html = renderSystemSettingsPageWithPrefs(desktopUiPrefs);

    expect(html.match(/class="system-settings-switch"/g) ?? []).toHaveLength(18);
    expect(html.match(/class="system-settings-switch-track"/g) ?? []).toHaveLength(18);
    expect(systemSettingsToggleStyles).toMatch(
      /\.system-settings-switch > input\[type="checkbox"\]\s*\{[\s\S]*?opacity: 0;[\s\S]*?cursor: pointer;/
    );
    expect(systemSettingsToggleStyles).toMatch(
      /\.system-settings-switch-track\s*\{[\s\S]*?border-radius: 999px;[\s\S]*?pointer-events: none;/
    );
    expect(systemSettingsToggleStyles).toMatch(
      /\.system-settings-switch > input\[type="checkbox"\]:focus-visible \+ \.system-settings-switch-track\s*\{[\s\S]*?outline:/
    );
    expect(systemSettingsToggleStyles).toMatch(
      /\.system-settings-switch > input\[type="checkbox"\]:checked:hover \+ \.system-settings-switch-track\s*\{[\s\S]*?border-color:[\s\S]*?box-shadow:/
    );
    expect(systemSettingsToggleStyles).toMatch(
      /\.system-settings-switch > input\[type="checkbox"\]:disabled \+ \.system-settings-switch-track\s*\{[\s\S]*?opacity: 0\.56;/
    );
  });

  it("disables native window controls in browser debug mode while keeping browser-safe settings available", () => {
    const html = renderToStaticMarkup(
      createElement(SystemSettingsPage, {
        theme: "titan-noir",
        setTheme: () => {},
        desktopUiPrefs,
        desktopUiLoading: false,
        desktopUiLoadError: null,
        nativeWindowControlsAvailable: false,
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
          intervalSeconds: 5
        },
        schedulerConfigLoading: false,
        schedulerLoadError: null,
        onRetrySchedulerConfigLoad: () => {},
        onSchedulerConfigChange: () => {},
        runtimeCoordinationConfig: {
          siteRequestsPerSecond: 3,
          siteMaxInFlight: 3,
          usagePageMaxInFlight: 6
        },
        runtimeCoordinationConfigLoading: false,
        runtimeCoordinationLoadError: null,
        onRetryRuntimeCoordinationConfigLoad: () => {},
        onRuntimeCoordinationConfigChange: () => {},
        upstreamNetworkConfig: { useSystemProxy: false },
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
    expect(html).not.toContain("浏览器调试模式不会启动桌面后端自动同步。");
    expect(html).toContain("启用后端自动同步");
    expect(html).toContain("前端自动刷新和手动刷新不受影响");
    expect(html).toContain("数据库存储");
    expect(html).toContain("迁移数据库");
    const upstreamNetworkToggle = html.match(
      /<input[^>]*data-testid="use-system-proxy"[^>]*>/
    )?.[0];
    expect(upstreamNetworkToggle).toBeDefined();
    expect(upstreamNetworkToggle).not.toContain("disabled");
  });
});
