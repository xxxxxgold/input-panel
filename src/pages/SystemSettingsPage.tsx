import {
  Database,
  FolderOpen,
  Home,
  Minus,
  Monitor,
  Plus,
  RefreshCw
} from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";

import { MIN_AUTO_REFRESH_INTERVAL_SECONDS } from "../app/refresh-policy";
import { DatabaseMigrationConfirmDialog } from "../features/database-storage/DatabaseMigrationConfirmDialog";
import type { DesktopUiPrefsSaveState } from "../features/desktop-ui/prefs-save-queue";
import { THEME_OPTIONS, type ThemeId, type ThemeOption } from "../shared/lib/theme";
import { Modal } from "../shared/ui/Modal";
import type {
  AppLaunchMode,
  CloseBehavior,
  DatabaseStorageMigrationResult,
  DatabaseStorageStatus,
  DesktopUiPrefs,
  FloatingNotificationDensity
} from "../types";

const MIN_OVERVIEW_ACCOUNT_RUNTIME_TIMEOUT_MS = 1000;
const OVERVIEW_ACCOUNT_RUNTIME_TIMEOUT_STEP_MS = 500;
const FLOATING_NOTIFICATION_DURATION_STEP_MS = 1000;
const MIN_FLOATING_NOTIFICATION_DURATION_MS = 3000;
const MAX_FLOATING_NOTIFICATION_DURATION_MS = 30000;
const MIN_FLOATING_NOTIFICATION_MAX_VISIBLE = 1;
const MAX_FLOATING_NOTIFICATION_MAX_VISIBLE = 5;
const MIN_SCHEDULER_INTERVAL_SECONDS = 15;

const DATABASE_MIGRATION_PHASE_LABELS: Record<string, string> = {
  idle: "就绪",
  validating_target: "正在验证目标目录",
  freezing_writes: "正在等待并冻结写入",
  backing_up: "正在创建一致快照",
  validating_snapshot: "正在校验迁移快照",
  switching_pointer: "正在切换存储配置",
  restart_required: "迁移完成，等待重启"
};

function databaseRuntimeScopeLabel(scope: string) {
  if (scope === "web") {
    return "网页后端";
  }
  if (scope === "desktop") {
    return "桌面应用";
  }
  return "隔离运行环境";
}

function databaseMigrationPhaseLabel(phase: string) {
  return DATABASE_MIGRATION_PHASE_LABELS[phase] ?? "未知状态";
}

const DESKTOP_UI_PREF_FIELD_LABELS: Record<string, string> = {
  theme: "主题",
  launchMode: "默认启动模式",
  openFloatingInMainMode: "主窗口悬浮窗",
  keepFloatingPanelVisible: "悬浮快捷菜单",
  floatingPanelOpacity: "悬浮窗透明度",
  floatingNotificationDurationMs: "消息显示时长",
  floatingNotificationDensity: "消息密度",
  floatingNotificationMaxVisible: "消息最大显示数",
  closeBehavior: "关闭行为",
  autoRefreshEnabled: "前端自动刷新总开关",
  autoRefreshServiceStatusEnabled: "服务状态与公开端点刷新",
  autoRefreshIntervalSeconds: "服务状态与公开端点间隔",
  autoRefreshCoreEnabled: "核心总览刷新",
  autoRefreshCoreIntervalSeconds: "核心总览间隔",
  autoRefreshKeysEnabled: "密钥刷新",
  autoRefreshKeysIntervalSeconds: "密钥间隔",
  autoRefreshUsageEnabled: "用量刷新",
  autoRefreshUsageIntervalSeconds: "用量间隔",
  overviewAccountRuntimeTimeoutMs: "总览单账号超时"
};

export function normalizeSystemSettingsStepperValue(
  value: string,
  options: { min: number; max?: number; step?: number }
): number | null {
  if (!value.trim()) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const step = options.step ?? 1;
  const normalized = Math.round(parsed / step) * step;
  return Math.min(Math.max(normalized, options.min), options.max ?? Number.MAX_SAFE_INTEGER);
}

function buildThemePreviewStyle(option: ThemeOption): CSSProperties {
  return {
    background: option.preview,
    ["--theme-preview-accent" as string]: option.accent,
    ["--theme-preview-ink" as string]:
      option.family === "dark" ? "rgba(244, 248, 255, 0.92)" : "rgba(31, 39, 54, 0.88)",
    ["--theme-preview-muted" as string]:
      option.family === "dark" ? "rgba(214, 226, 243, 0.34)" : "rgba(84, 96, 118, 0.34)",
    ["--theme-preview-panel" as string]:
      option.family === "dark" ? "rgba(10, 16, 24, 0.62)" : "rgba(255, 255, 255, 0.82)",
    ["--theme-preview-surface" as string]:
      option.family === "dark" ? "rgba(255, 255, 255, 0.09)" : "rgba(255, 255, 255, 0.72)"
  };
}

function renderWorkbenchPreview(option: ThemeOption) {
  return (
    <div className="theme-workbench theme-workbench--card" style={buildThemePreviewStyle(option)} aria-hidden="true">
      <span className="theme-workbench-rail">
        <span className="theme-workbench-rail-pill" />
        <span className="theme-workbench-rail-dot" />
        <span className="theme-workbench-rail-dot" />
        <span className="theme-workbench-rail-dot" />
      </span>
      <span className="theme-workbench-stage">
        <span className="theme-workbench-topbar">
          <span className="theme-workbench-topbar-time" />
          <span className="theme-workbench-topbar-status" />
        </span>
        <span className="theme-workbench-metrics">
          <span className="theme-workbench-metric" />
          <span className="theme-workbench-metric" />
          <span className="theme-workbench-metric" />
        </span>
        <span className="theme-workbench-chart">
          <span className="theme-workbench-chart-line" />
          <span className="theme-workbench-chart-bars">
            <span />
            <span />
            <span />
            <span />
          </span>
        </span>
        <span className="theme-workbench-floating" />
      </span>
    </div>
  );
}

export function SystemSettingsPage({
  theme,
  setTheme,
  desktopUiPrefs,
  desktopUiLoading,
  desktopUiSaveState,
  desktopUiLoadError,
  onRetryDesktopUiPrefs,
  nativeWindowControlsAvailable = true,
  onLaunchModeChange,
  onFloatingVisibleChange,
  onFloatingPanelPinnedChange,
  onFloatingPanelOpacityChange,
  onFloatingNotificationDurationMsChange,
  onFloatingNotificationDensityChange,
  onFloatingNotificationMaxVisibleChange,
  onCloseBehaviorChange,
  onAutoRefreshEnabledChange,
  onServiceStatusAutoRefreshEnabledChange,
  onServiceStatusRefreshIntervalSecondsChange,
  onCoreAutoRefreshEnabledChange,
  onCoreAutoRefreshIntervalSecondsChange,
  onKeysAutoRefreshEnabledChange,
  onKeysAutoRefreshIntervalSecondsChange,
  onUsageAutoRefreshEnabledChange,
  onUsageAutoRefreshIntervalSecondsChange,
  onOverviewAccountRuntimeTimeoutMsChange,
  schedulerConfig,
  schedulerConfirmedConfig,
  schedulerConfigLoading,
  schedulerConfigSaving,
  schedulerConfigAvailable = true,
  schedulerLoadError,
  schedulerSaveError,
  onRetrySchedulerConfigLoad,
  onRetrySchedulerConfig,
  onSchedulerConfigChange,
  databaseStorageStatus,
  databaseStorageTargetDirectory,
  databaseStorageLoading,
  databaseStorageMigrationLoading,
  databaseStorageLoadError,
  databaseStorageMigrationError,
  databaseStorageMigrationResult,
  onDatabaseStorageTargetDirectoryChange,
  onRetryDatabaseStorageStatus,
  onMigrateDatabaseStorage,
  onClearRuntimeData,
  clearRuntimeDataLoading
}: {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
  desktopUiPrefs: DesktopUiPrefs;
  desktopUiLoading: boolean;
  desktopUiSaveState: DesktopUiPrefsSaveState;
  desktopUiLoadError: string | null;
  onRetryDesktopUiPrefs: () => void;
  nativeWindowControlsAvailable?: boolean;
  onLaunchModeChange: (value: AppLaunchMode) => void;
  onFloatingVisibleChange: (value: boolean) => void;
  onFloatingPanelPinnedChange: (value: boolean) => void;
  onFloatingPanelOpacityChange: (value: number) => void;
  onFloatingNotificationDurationMsChange: (value: number) => void;
  onFloatingNotificationDensityChange: (value: FloatingNotificationDensity) => void;
  onFloatingNotificationMaxVisibleChange: (value: number) => void;
  onCloseBehaviorChange: (value: CloseBehavior) => void;
  onAutoRefreshEnabledChange: (value: boolean) => void;
  onServiceStatusAutoRefreshEnabledChange: (value: boolean) => void;
  onServiceStatusRefreshIntervalSecondsChange: (value: number) => void;
  onCoreAutoRefreshEnabledChange: (value: boolean) => void;
  onCoreAutoRefreshIntervalSecondsChange: (value: number) => void;
  onKeysAutoRefreshEnabledChange: (value: boolean) => void;
  onKeysAutoRefreshIntervalSecondsChange: (value: number) => void;
  onUsageAutoRefreshEnabledChange: (value: boolean) => void;
  onUsageAutoRefreshIntervalSecondsChange: (value: number) => void;
  onOverviewAccountRuntimeTimeoutMsChange: (value: number) => void;
  schedulerConfig: { enabled: boolean; intervalSeconds: number };
  schedulerConfirmedConfig: { enabled: boolean; intervalSeconds: number };
  schedulerConfigLoading: boolean;
  schedulerConfigSaving: boolean;
  schedulerConfigAvailable?: boolean;
  schedulerLoadError: string | null;
  schedulerSaveError: string | null;
  onRetrySchedulerConfigLoad: () => void;
  onRetrySchedulerConfig: () => void;
  onSchedulerConfigChange: (value: { enabled: boolean; intervalSeconds: number }, options?: { debounce?: boolean }) => void;
  databaseStorageStatus: DatabaseStorageStatus | null;
  databaseStorageTargetDirectory: string;
  databaseStorageLoading: boolean;
  databaseStorageMigrationLoading: boolean;
  databaseStorageLoadError: string | null;
  databaseStorageMigrationError: string | null;
  databaseStorageMigrationResult: DatabaseStorageMigrationResult | null;
  onDatabaseStorageTargetDirectoryChange: (value: string) => void;
  onRetryDatabaseStorageStatus: () => void;
  onMigrateDatabaseStorage: (targetDirectory: string) => void;
  onClearRuntimeData: (removeSitesAndAccounts: boolean) => void;
  clearRuntimeDataLoading: boolean;
}) {
  const [clearDataModalOpen, setClearDataModalOpen] = useState(false);
  const [removeSitesAndAccounts, setRemoveSitesAndAccounts] = useState(false);
  const [databaseMigrationConfirmTarget, setDatabaseMigrationConfirmTarget] = useState<string | null>(null);
  const nativeWindowControlsDisabled = desktopUiLoading || !nativeWindowControlsAvailable;
  const schedulerControlsDisabled = schedulerConfigLoading || !schedulerConfigAvailable || Boolean(schedulerLoadError);
  const databaseStorageActionsDisabled =
    databaseStorageLoading
    || databaseStorageMigrationLoading
    || !databaseStorageStatus
    || databaseStorageStatus.overrideActive
    || !databaseStorageStatus.migrationSupported
    || databaseStorageStatus.restartRequired;
  const normalizedDatabaseTarget = databaseStorageTargetDirectory.trim();
  const databaseMigrationDisabled =
    databaseStorageActionsDisabled
    || !normalizedDatabaseTarget
    || normalizedDatabaseTarget === databaseStorageStatus?.currentDirectory;

  useEffect(() => {
    if (databaseStorageMigrationResult) {
      setDatabaseMigrationConfirmTarget(null);
    }
  }, [databaseStorageMigrationResult]);
  function handleIntervalInputChange(
    value: string,
    onChange: (value: number) => void,
    options: { min: number; max?: number; step?: number } = { min: 1, step: 1 }
  ) {
    const normalized = normalizeSystemSettingsStepperValue(value, options);
    if (normalized === null) {
      return;
    }
    onChange(normalized);
  }

  function renderThemeLab(extraClassName = "") {
    return (
      <section className={`section-card system-settings-card system-settings-card--theme-lab ${extraClassName}`.trim()}>
        <div className="theme-lab-shell">
          <div className="theme-lab-kicker">Theme Lab</div>
          <div className="theme-picker-grid">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.id}
                className={`theme-option theme-card motion-surface-card ${theme === option.id ? "selected" : ""}`}
                onClick={() => setTheme(option.id)}
                title={option.summary}
                aria-pressed={theme === option.id}
              >
                <span className="theme-card-header">
                  <span className="theme-card-title-cluster">
                    <strong>{option.label}</strong>
                    <span className="theme-card-family">{option.family === "dark" ? "深色" : "浅色"}</span>
                  </span>
                  <span className="theme-card-state">{theme === option.id ? "当前" : "切换"}</span>
                </span>
                {renderWorkbenchPreview(option)}
                <span className="theme-card-copy">
                  <span>{option.summary}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </section>
    );
  }

  function renderWindowCard(extraClassName = "") {
    return (
      <section className={`section-card system-settings-card system-settings-card--window ${extraClassName}`.trim()}>
        <header className="section-card-header">
          <div>
            <h3>窗口与托盘</h3>
            <p>控制默认打开方式、悬浮窗和关闭时的处理方式</p>
          </div>
        </header>
        {nativeWindowControlsAvailable === false && (
          <p id="native-window-controls-unavailable" className="field-help" role="status">
            浏览器调试模式不支持原生窗口控制。请在桌面应用中调整启动模式、悬浮窗口和关闭行为。
          </p>
        )}
        <fieldset
          className="stack-list system-settings-native-controls"
          disabled={nativeWindowControlsDisabled}
          style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
          aria-label="原生窗口控制"
          aria-describedby={
            nativeWindowControlsAvailable === false ? "native-window-controls-unavailable" : undefined
          }
        >
          <label className="field">
            <span>默认启动模式</span>
            <select
              value={desktopUiPrefs.launchMode}
              onChange={(event) => onLaunchModeChange(event.target.value as AppLaunchMode)}
              disabled={desktopUiLoading}
            >
              <option value="main">主窗口模式</option>
              <option value="floating">悬浮窗模式</option>
            </select>
          </label>
          <label className="toggle-field motion-surface-card">
            <div>
              <strong>主窗口模式默认显示悬浮窗</strong>
              <p>关闭后只显示主窗口, 需要时再手动打开悬浮窗。</p>
            </div>
            <input
              type="checkbox"
              checked={desktopUiPrefs.openFloatingInMainMode}
              onChange={(event) => onFloatingVisibleChange(event.target.checked)}
              disabled={desktopUiLoading}
            />
          </label>
          <label className="field">
            <span>悬浮窗透明度</span>
            <div className="range-field settings-range-field">
              <input
                type="range"
                min={0.45}
                max={0.95}
                step={0.01}
                value={desktopUiPrefs.floatingPanelOpacity}
                onChange={(event) => onFloatingPanelOpacityChange(Number(event.target.value))}
                disabled={desktopUiLoading}
              />
              <strong>{Math.round(desktopUiPrefs.floatingPanelOpacity * 100)}%</strong>
            </div>
            <small>只影响悬浮快捷面板的通透度。默认 82%。</small>
          </label>
          <fieldset className="floating-notification-settings">
            <legend>悬浮消息</legend>
            <p>控制消息卡片的疏密、停留时间和同时显示数量。</p>
            <label className="field">
              <span>消息密度</span>
              <select
                value={desktopUiPrefs.floatingNotificationDensity}
                onChange={(event) =>
                  onFloatingNotificationDensityChange(
                    event.target.value as FloatingNotificationDensity
                  )
                }
              >
                <option value="compact">紧凑</option>
                <option value="standard">标准</option>
                <option value="relaxed">宽松</option>
              </select>
              <small>调整卡片内的留白和信息间距。默认标准。</small>
            </label>
            <div className="field">
              <span>显示时长</span>
            <div className="number-stepper">
              <button
                type="button"
                className="number-stepper-button"
                onClick={() =>
                  onFloatingNotificationDurationMsChange(
                    Math.max(
                      MIN_FLOATING_NOTIFICATION_DURATION_MS,
                      desktopUiPrefs.floatingNotificationDurationMs - FLOATING_NOTIFICATION_DURATION_STEP_MS
                    )
                  )
                }
                disabled={desktopUiPrefs.floatingNotificationDurationMs <= MIN_FLOATING_NOTIFICATION_DURATION_MS}
                aria-label="显示时长减少 1 秒"
              >
                <Minus size={14} />
              </button>
              <input
                type="number"
                min={MIN_FLOATING_NOTIFICATION_DURATION_MS / 1000}
                max={MAX_FLOATING_NOTIFICATION_DURATION_MS / 1000}
                step={1}
                value={desktopUiPrefs.floatingNotificationDurationMs / 1000}
                onChange={(event) =>
                  handleIntervalInputChange(event.target.value, (value) =>
                    onFloatingNotificationDurationMsChange(value * 1000),
                    {
                      min: MIN_FLOATING_NOTIFICATION_DURATION_MS / 1000,
                      max: MAX_FLOATING_NOTIFICATION_DURATION_MS / 1000,
                      step: 1
                    }
                  )
                }
                aria-label="显示时长(秒)"
              />
              <button
                type="button"
                className="number-stepper-button"
                onClick={() =>
                  onFloatingNotificationDurationMsChange(
                    Math.min(
                      MAX_FLOATING_NOTIFICATION_DURATION_MS,
                      desktopUiPrefs.floatingNotificationDurationMs + FLOATING_NOTIFICATION_DURATION_STEP_MS
                    )
                  )
                }
                disabled={desktopUiPrefs.floatingNotificationDurationMs >= MAX_FLOATING_NOTIFICATION_DURATION_MS}
                aria-label="显示时长增加 1 秒"
              >
                <Plus size={14} />
              </button>
            </div>
              <small>消息出现后自动关闭。默认 7 秒; 鼠标停留在卡片上时会暂停倒计时。</small>
            </div>
            <div className="field">
              <span>最大显示数量</span>
              <div className="number-stepper">
                <button
                  type="button"
                  className="number-stepper-button"
                  onClick={() =>
                    onFloatingNotificationMaxVisibleChange(
                      Math.max(
                        MIN_FLOATING_NOTIFICATION_MAX_VISIBLE,
                        desktopUiPrefs.floatingNotificationMaxVisible - 1
                      )
                    )
                  }
                  disabled={
                    desktopUiPrefs.floatingNotificationMaxVisible <=
                    MIN_FLOATING_NOTIFICATION_MAX_VISIBLE
                  }
                  aria-label="最大显示数量减少 1 条"
                >
                  <Minus size={14} />
                </button>
                <input
                  type="number"
                  min={MIN_FLOATING_NOTIFICATION_MAX_VISIBLE}
                  max={MAX_FLOATING_NOTIFICATION_MAX_VISIBLE}
                  step={1}
                  value={desktopUiPrefs.floatingNotificationMaxVisible}
                  onChange={(event) =>
                    handleIntervalInputChange(event.target.value, onFloatingNotificationMaxVisibleChange, {
                      min: MIN_FLOATING_NOTIFICATION_MAX_VISIBLE,
                      max: MAX_FLOATING_NOTIFICATION_MAX_VISIBLE,
                      step: 1
                    })
                  }
                  aria-label="最大显示数量"
                />
                <button
                  type="button"
                  className="number-stepper-button"
                  onClick={() =>
                    onFloatingNotificationMaxVisibleChange(
                      Math.min(
                        MAX_FLOATING_NOTIFICATION_MAX_VISIBLE,
                        desktopUiPrefs.floatingNotificationMaxVisible + 1
                      )
                    )
                  }
                  disabled={
                    desktopUiPrefs.floatingNotificationMaxVisible >=
                    MAX_FLOATING_NOTIFICATION_MAX_VISIBLE
                  }
                  aria-label="最大显示数量增加 1 条"
                >
                  <Plus size={14} />
                </button>
              </div>
              <small>可同时显示 1 到 5 条消息。超出的消息会按顺序等待显示。</small>
            </div>
          </fieldset>
          <label className="toggle-field motion-surface-card">
            <div>
              <strong>悬浮快捷菜单常驻显示</strong>
              <p>开启后悬浮菜单会一直显示; 关闭后只有鼠标靠近时才显示。</p>
            </div>
            <input
              type="checkbox"
              checked={desktopUiPrefs.keepFloatingPanelVisible}
              onChange={(event) => onFloatingPanelPinnedChange(event.target.checked)}
              disabled={desktopUiLoading}
            />
          </label>
          <label className="field">
            <span>主窗口关闭行为</span>
            <select
              value={desktopUiPrefs.closeBehavior}
              onChange={(event) => onCloseBehaviorChange(event.target.value as CloseBehavior)}
              disabled={desktopUiLoading}
            >
              <option value="ask">每次询问</option>
              <option value="switch_to_floating">切到悬浮窗模式</option>
              <option value="exit_app">直接退出程序</option>
            </select>
          </label>
        </fieldset>
      </section>
    );
  }

  function describeDesktopUiFields(fields: string[]) {
    return fields.map((field) => DESKTOP_UI_PREF_FIELD_LABELS[field] ?? field).join("、");
  }

  function renderDesktopUiSaveStatus() {
    if (desktopUiLoadError) {
      return (
        <div className="auto-refresh-group-note" role="alert">
          设置读取失败: {desktopUiLoadError}
        </div>
      );
    }
    if (desktopUiSaveState.phase === "failed") {
      return (
        <div className="auto-refresh-group-note" role="alert">
          <span>
            以下设置尚未保存: {describeDesktopUiFields(desktopUiSaveState.failedFields)}。当前界面保留新值,
            已持久化值仍是上次成功保存的版本。{desktopUiSaveState.error ? ` ${desktopUiSaveState.error}` : ""}
          </span>
          <button type="button" className="ghost-button" onClick={onRetryDesktopUiPrefs}>
            重试保存
          </button>
        </div>
      );
    }
    if (desktopUiSaveState.phase === "saving") {
      const fields = [...desktopUiSaveState.savingFields, ...desktopUiSaveState.pendingFields];
      return (
        <p className="auto-refresh-group-note" role="status">
          正在保存: {describeDesktopUiFields(fields)}。
        </p>
      );
    }
    if (desktopUiSaveState.lastSavedAt !== null) {
      return <p className="auto-refresh-group-note" role="status">所有设置已保存。</p>;
    }
    return null;
  }

  function renderAutoRefreshGroup(input: {
    key: "service-status" | "core" | "keys" | "usage";
    title: string;
    description: string;
    enabled: boolean;
    intervalSeconds: number;
    onEnabledChange: (value: boolean) => void;
    onIntervalChange: (value: number) => void;
  }) {
    return (
      <section key={input.key} className="auto-refresh-group-card motion-surface-card">
        <div className="auto-refresh-group-header">
          <div>
            <strong>{input.title}</strong>
            <p>{input.description}</p>
          </div>
          <input
            type="checkbox"
            checked={input.enabled}
            onChange={(event) => input.onEnabledChange(event.target.checked)}
            disabled={desktopUiLoading}
            aria-label={`${input.title}自动刷新开关`}
          />
        </div>
        <div className="field">
          <span>间隔(秒)</span>
          <div className="number-stepper">
            <button
              type="button"
              className="number-stepper-button"
              onClick={() =>
                input.onIntervalChange(
                  Math.max(MIN_AUTO_REFRESH_INTERVAL_SECONDS, input.intervalSeconds - 1)
                )
              }
              disabled={desktopUiLoading || input.intervalSeconds <= MIN_AUTO_REFRESH_INTERVAL_SECONDS}
              aria-label={`${input.title}间隔减少 1 秒`}
            >
              <Minus size={14} />
            </button>
            <input
              type="number"
              min={MIN_AUTO_REFRESH_INTERVAL_SECONDS}
              step={1}
              value={input.intervalSeconds}
              onChange={(event) =>
                handleIntervalInputChange(event.target.value, input.onIntervalChange)
              }
              disabled={desktopUiLoading}
              data-testid={`${input.key}-refresh-interval`}
            />
            <button
              type="button"
              className="number-stepper-button"
              onClick={() => input.onIntervalChange(input.intervalSeconds + 1)}
              disabled={desktopUiLoading}
              aria-label={`${input.title}间隔增加 1 秒`}
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
      </section>
    );
  }

  function renderRefreshCard(extraClassName = "") {
    const refreshGroups = [
      {
        key: "service-status" as const,
        title: "服务状态与公开端点",
        description: "控制服务状态页、顶部状态面板和公开端点自动 ping。",
        enabled: desktopUiPrefs.autoRefreshServiceStatusEnabled,
        intervalSeconds: desktopUiPrefs.autoRefreshIntervalSeconds,
        onEnabledChange: onServiceStatusAutoRefreshEnabledChange,
        onIntervalChange: onServiceStatusRefreshIntervalSecondsChange
      },
      {
        key: "core" as const,
        title: "核心总览",
        description: "控制总览和订阅页面的后台预热与自动刷新。",
        enabled: desktopUiPrefs.autoRefreshCoreEnabled,
        intervalSeconds: desktopUiPrefs.autoRefreshCoreIntervalSeconds,
        onEnabledChange: onCoreAutoRefreshEnabledChange,
        onIntervalChange: onCoreAutoRefreshIntervalSecondsChange
      },
      {
        key: "keys" as const,
        title: "密钥",
        description: "控制密钥列表和密钥关联数据的后台刷新。",
        enabled: desktopUiPrefs.autoRefreshKeysEnabled,
        intervalSeconds: desktopUiPrefs.autoRefreshKeysIntervalSeconds,
        onEnabledChange: onKeysAutoRefreshEnabledChange,
        onIntervalChange: onKeysAutoRefreshIntervalSecondsChange
      },
      {
        key: "usage" as const,
        title: "用量",
        description: "控制用量、模型统计、按密钥查看和趋势页面的后台刷新。",
        enabled: desktopUiPrefs.autoRefreshUsageEnabled,
        intervalSeconds: desktopUiPrefs.autoRefreshUsageIntervalSeconds,
        onEnabledChange: onUsageAutoRefreshEnabledChange,
        onIntervalChange: onUsageAutoRefreshIntervalSecondsChange
      }
    ];

    return (
      <section className={`section-card system-settings-card system-settings-card--refresh ${extraClassName}`.trim()}>
        <header className="section-card-header">
          <div>
            <h3>前端自动刷新</h3>
            <p>自动更新常用页面和服务状态, 不会打断你当前操作。</p>
          </div>
        </header>
        <div className="stack-list">
          {renderDesktopUiSaveStatus()}
          <label className="toggle-field motion-surface-card">
            <div>
              <strong>启用前端自动刷新</strong>
              <p>关闭后会暂停全部自动刷新。手动刷新始终可用。</p>
            </div>
            <input
              type="checkbox"
              checked={desktopUiPrefs.autoRefreshEnabled}
              onChange={(event) => onAutoRefreshEnabledChange(event.target.checked)}
              disabled={desktopUiLoading}
            />
          </label>
          <p className="auto-refresh-group-note">
            每个分组只影响对应消费者, 不会整页重载, 会保留当前筛选、分页和页面上下文。最低
            {MIN_AUTO_REFRESH_INTERVAL_SECONDS} 秒。
          </p>
          <div className="auto-refresh-group-grid">
            {refreshGroups.map((group) => renderAutoRefreshGroup(group))}
          </div>
          <div className="field">
            <span>总览单账号超时(毫秒)</span>
            <div className="number-stepper">
              <button
                type="button"
                className="number-stepper-button"
                onClick={() =>
                  onOverviewAccountRuntimeTimeoutMsChange(
                    Math.max(
                      MIN_OVERVIEW_ACCOUNT_RUNTIME_TIMEOUT_MS,
                      desktopUiPrefs.overviewAccountRuntimeTimeoutMs - OVERVIEW_ACCOUNT_RUNTIME_TIMEOUT_STEP_MS
                    )
                  )
                }
                disabled={
                  desktopUiLoading ||
                  desktopUiPrefs.overviewAccountRuntimeTimeoutMs <= MIN_OVERVIEW_ACCOUNT_RUNTIME_TIMEOUT_MS
                }
                aria-label="总览单账号超时(毫秒)减少 500 毫秒"
              >
                <Minus size={14} />
              </button>
              <input
                type="number"
                min={MIN_OVERVIEW_ACCOUNT_RUNTIME_TIMEOUT_MS}
                step={OVERVIEW_ACCOUNT_RUNTIME_TIMEOUT_STEP_MS}
                value={desktopUiPrefs.overviewAccountRuntimeTimeoutMs}
                onChange={(event) =>
                  handleIntervalInputChange(event.target.value, onOverviewAccountRuntimeTimeoutMsChange)
                }
                disabled={desktopUiLoading}
                data-testid="overview-account-runtime-timeout-ms"
              />
              <button
                type="button"
                className="number-stepper-button"
                onClick={() =>
                  onOverviewAccountRuntimeTimeoutMsChange(
                    desktopUiPrefs.overviewAccountRuntimeTimeoutMs + OVERVIEW_ACCOUNT_RUNTIME_TIMEOUT_STEP_MS
                  )
                }
                disabled={desktopUiLoading}
                aria-label="总览单账号超时(毫秒)增加 500 毫秒"
              >
                <Plus size={14} />
              </button>
            </div>
            <small>总览页读取单个账号实时数据时, 最多等待多久再判定超时。最低 1000 毫秒。</small>
          </div>
        </div>
      </section>
    );
  }

  function renderSchedulerCard(extraClassName = "") {
    return (
      <section className={`section-card system-settings-card system-settings-card--scheduler ${extraClassName}`.trim()}>
        <header className="section-card-header">
          <div>
            <h3>后端用量同步器</h3>
            <p>控制后台是否自动更新所有账号的用量缓存。</p>
          </div>
        </header>
        {schedulerConfigAvailable === false && (
          <p className="field-help" role="status">
            浏览器调试模式不会启动后端用量同步器。当前值可查看, 但只有桌面应用才能实际执行同步。
          </p>
        )}
        <div className="stack-list">
          {schedulerLoadError && (
            <div className="auto-refresh-group-note" role="alert">
              <span>后端用量同步器设置读取失败: {schedulerLoadError}。当前未读取到可确认的配置，未尝试保存。</span>
              <button
                type="button"
                className="ghost-button"
                onClick={onRetrySchedulerConfigLoad}
                disabled={schedulerConfigLoading}
              >
                重新读取
              </button>
            </div>
          )}
          {schedulerSaveError && !schedulerLoadError && (
            <div className="auto-refresh-group-note" role="alert">
              <span>
                后端用量同步器设置未保存: {schedulerSaveError}。已保存值:{" "}
                {schedulerConfirmedConfig.enabled ? "已启用" : "已关闭"}, 间隔{" "}
                {schedulerConfirmedConfig.intervalSeconds} 秒。
              </span>
              <button
                type="button"
                className="ghost-button"
                onClick={onRetrySchedulerConfig}
                disabled={schedulerControlsDisabled}
              >
                重试保存
              </button>
            </div>
          )}
          {!schedulerLoadError && !schedulerSaveError && schedulerConfigSaving && (
            <p className="auto-refresh-group-note" role="status">正在保存后端用量同步器设置。</p>
          )}
          <label className="toggle-field motion-surface-card">
            <div>
              <strong>启用自动同步</strong>
              <p>关闭后不会再自动更新用量缓存, 需要你手动刷新。</p>
            </div>
            <input
              type="checkbox"
              checked={schedulerConfig.enabled}
              onChange={(event) => onSchedulerConfigChange({ ...schedulerConfig, enabled: event.target.checked })}
              disabled={schedulerControlsDisabled}
            />
          </label>
          <div className="field">
            <span>调度间隔(秒)</span>
            <div className="number-stepper">
              <button
                type="button"
                className="number-stepper-button"
                onClick={() =>
                  onSchedulerConfigChange({
                    ...schedulerConfig,
                    intervalSeconds: Math.max(MIN_SCHEDULER_INTERVAL_SECONDS, schedulerConfig.intervalSeconds - 1)
                  }, { debounce: true })
                }
                disabled={schedulerControlsDisabled || schedulerConfig.intervalSeconds <= MIN_SCHEDULER_INTERVAL_SECONDS}
                aria-label="调度间隔减少 1 秒"
              >
                <Minus size={14} />
              </button>
              <input
                type="number"
                min={MIN_SCHEDULER_INTERVAL_SECONDS}
                step={1}
                value={schedulerConfig.intervalSeconds}
                onChange={(event) => {
                  const parsed = Number(event.target.value);
                  if (Number.isFinite(parsed)) {
                    onSchedulerConfigChange({
                      ...schedulerConfig,
                      intervalSeconds: Math.max(MIN_SCHEDULER_INTERVAL_SECONDS, parsed)
                    }, { debounce: true });
                  }
                }}
                disabled={schedulerControlsDisabled}
              />
              <button
                type="button"
                className="number-stepper-button"
                onClick={() =>
                  onSchedulerConfigChange({
                    ...schedulerConfig,
                    intervalSeconds: schedulerConfig.intervalSeconds + 1
                  }, { debounce: true })
                }
                disabled={schedulerControlsDisabled}
                aria-label="调度间隔增加 1 秒"
              >
                <Plus size={14} />
              </button>
            </div>
            <small>最低 {MIN_SCHEDULER_INTERVAL_SECONDS} 秒。后台会按这个间隔更新用量缓存; 有启用订阅切换规则时才会检查规则。</small>
          </div>
        </div>
      </section>
    );
  }

  function renderStorageCard(extraClassName = "") {
    return (
      <section className={`section-card system-settings-card system-settings-card--database-storage ${extraClassName}`.trim()}>
        <header className="section-card-header">
          <div className="database-storage-heading">
            <span className="database-storage-heading-icon" aria-hidden="true">
              <Database size={18} />
            </span>
            <div>
              <h3>数据库存储</h3>
              <p>查看当前 SQLite 文件，并将完整数据库迁移到新的本机目录。</p>
            </div>
          </div>
          <button
            type="button"
            className="ghost-button database-storage-refresh-button"
            onClick={onRetryDatabaseStorageStatus}
            disabled={databaseStorageLoading || databaseStorageMigrationLoading}
            title="刷新数据库存储状态"
          >
            <RefreshCw size={15} className={databaseStorageLoading ? "spin" : ""} />
            <span>刷新状态</span>
          </button>
        </header>
        {databaseStorageLoading && !databaseStorageStatus && (
          <p className="database-storage-state" role="status">正在读取数据库存储状态。</p>
        )}
        {databaseStorageLoadError && (
          <div className="database-storage-message database-storage-message--error" role="alert">
            <span>{databaseStorageLoadError}</span>
            <button
              type="button"
              className="ghost-button"
              onClick={onRetryDatabaseStorageStatus}
              disabled={databaseStorageLoading}
            >
              重试读取
            </button>
          </div>
        )}
        {databaseStorageStatus && (
          <div className="database-storage-content">
            <dl className="database-storage-facts">
              <div>
                <dt>运行范围</dt>
                <dd>{databaseRuntimeScopeLabel(databaseStorageStatus.runtimeScope)}</dd>
              </div>
              <div>
                <dt>迁移状态</dt>
                <dd>{databaseMigrationPhaseLabel(databaseStorageStatus.migrationPhase)}</dd>
              </div>
              <div className="database-storage-fact--path">
                <dt>当前数据库文件</dt>
                <dd>{databaseStorageStatus.currentDatabasePath}</dd>
              </div>
              <div className="database-storage-fact--path">
                <dt>当前目录</dt>
                <dd>{databaseStorageStatus.currentDirectory}</dd>
              </div>
            </dl>

            {databaseStorageStatus.overrideActive && (
              <div className="database-storage-message" role="status">
                <strong>环境目录覆盖已生效</strong>
                <span><code>SUB2API_APP_ROOT</code> 正在控制数据库位置，当前实例不能从设置页迁移。</span>
              </div>
            )}
            {databaseStorageStatus.lastError && (
              <div className="database-storage-message database-storage-message--error" role="alert">
                {databaseStorageStatus.lastError}
              </div>
            )}

            <label className="field database-storage-target-field">
              <span>目标目录</span>
              <input
                type="text"
                value={databaseStorageTargetDirectory}
                onChange={(event) => onDatabaseStorageTargetDirectoryChange(event.target.value)}
                disabled={databaseStorageActionsDisabled}
                aria-label="数据库目标存储目录"
                autoComplete="off"
                spellCheck={false}
              />
              <small>数据库文件名固定为 config.sqlite。</small>
            </label>

            <div className="database-storage-presets" aria-label="数据库目录快捷选择">
              <button
                type="button"
                className="ghost-button"
                onClick={() => onDatabaseStorageTargetDirectoryChange(databaseStorageStatus.userDirectory)}
                disabled={databaseStorageActionsDisabled}
              >
                <Home size={15} />
                <span>用户目录</span>
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => onDatabaseStorageTargetDirectoryChange(databaseStorageStatus.programDirectory)}
                disabled={databaseStorageActionsDisabled}
              >
                <Monitor size={15} />
                <span>程序目录</span>
              </button>
            </div>

            {databaseStorageMigrationError && (
              <div className="database-storage-message database-storage-message--error" role="alert">
                {databaseStorageMigrationError}
              </div>
            )}
            {databaseStorageMigrationLoading && (
              <div className="database-storage-message" role="status">
                <RefreshCw size={15} className="spin" aria-hidden="true" />
                <span>正在冻结写入、创建一致快照并校验目标数据库。</span>
              </div>
            )}
            {databaseStorageMigrationResult && (
              <div className="database-storage-result" role="status">
                <strong>数据库迁移完成</strong>
                <dl>
                  <div>
                    <dt>源数据库</dt>
                    <dd>{databaseStorageMigrationResult.sourcePath}</dd>
                  </div>
                  <div>
                    <dt>目标数据库</dt>
                    <dd>{databaseStorageMigrationResult.targetPath}</dd>
                  </div>
                  <div>
                    <dt>源库保留</dt>
                    <dd>{databaseStorageMigrationResult.sourceRetained ? "已保留" : "未确认"}</dd>
                  </div>
                  <div>
                    <dt>存储配置</dt>
                    <dd>{databaseStorageMigrationResult.bootstrapUpdated ? "已切换" : "未切换"}</dd>
                  </div>
                </dl>
                <p>
                  {databaseStorageStatus.runtimeScope === "desktop"
                    ? "请重启桌面应用后使用新数据库。"
                    : "请重启 Rust 后端后使用新数据库。"}
                </p>
              </div>
            )}
            {databaseStorageStatus.restartRequired && !databaseStorageMigrationResult && (
              <div className="database-storage-message database-storage-message--restart" role="status">
                <strong>数据库已迁移，当前进程正在等待重启。</strong>
                <span>
                  {databaseStorageStatus.runtimeScope === "desktop"
                    ? "请重启桌面应用。"
                    : "请重启 Rust 后端。"}
                </span>
              </div>
            )}

            <div className="database-storage-actions">
              <button
                type="button"
                className="inline-text-button"
                onClick={() => setDatabaseMigrationConfirmTarget(normalizedDatabaseTarget)}
                disabled={databaseMigrationDisabled}
              >
                <FolderOpen size={16} />
                <span>{databaseStorageMigrationLoading ? "正在迁移..." : "迁移数据库"}</span>
              </button>
            </div>
          </div>
        )}
      </section>
    );
  }

  function renderDangerCard(extraClassName = "") {
    return (
      <section className={`section-card system-settings-card system-settings-card--danger ${extraClassName}`.trim()}>
        <header className="section-card-header">
          <div>
            <h3>危险操作</h3>
            <p>清空当前设备上保存的数据, 让应用回到初始状态。</p>
          </div>
        </header>
        <div className="stack-list">
          <div className="system-settings-danger-copy">
            <strong>清空所有数据</strong>
            <p>默认只清空使用过程中产生的数据. 勾选后会把站点和账号也一起删除。</p>
          </div>
          <button
            type="button"
            className="inline-text-button danger system-settings-danger-button"
            onClick={() => setClearDataModalOpen(true)}
            disabled={clearRuntimeDataLoading}
          >
            {clearRuntimeDataLoading ? "正在清空..." : "清空所有数据"}
          </button>
        </div>
      </section>
    );
  }

  function closeClearDataModal() {
    if (clearRuntimeDataLoading) {
      return;
    }
    setClearDataModalOpen(false);
    setRemoveSitesAndAccounts(false);
  }

  function closeDatabaseMigrationModal() {
    if (databaseStorageMigrationLoading) {
      return;
    }
    setDatabaseMigrationConfirmTarget(null);
  }

  return (
    <>
      {renderThemeLab()}
      <section className="system-settings-layout system-settings-layout-desktop">
        <div className="system-settings-column">
          {renderRefreshCard()}
          {renderStorageCard()}
        </div>
        <div className="system-settings-column">
          {renderWindowCard()}
          {renderSchedulerCard()}
          {renderDangerCard()}
        </div>
      </section>
      <section className="system-settings-layout-mobile">
        {renderWindowCard("system-settings-card--mobile")}
        {renderRefreshCard("system-settings-card--mobile")}
        {renderSchedulerCard("system-settings-card--mobile")}
        {renderDangerCard("system-settings-card--mobile")}
        {renderStorageCard("system-settings-card--mobile")}
      </section>
      {databaseMigrationConfirmTarget && databaseStorageStatus && (
        <DatabaseMigrationConfirmDialog
          status={databaseStorageStatus}
          targetDirectory={databaseMigrationConfirmTarget}
          migrationLoading={databaseStorageMigrationLoading}
          migrationError={databaseStorageMigrationError}
          onCancel={closeDatabaseMigrationModal}
          onConfirm={() => onMigrateDatabaseStorage(databaseMigrationConfirmTarget)}
        />
      )}
      {clearDataModalOpen && (
        <Modal
          title="确认清空所有数据"
          onClose={closeClearDataModal}
          footer={
            <>
              <button className="ghost-button" onClick={closeClearDataModal} disabled={clearRuntimeDataLoading}>
                取消
              </button>
              <button
                className="inline-text-button danger"
                onClick={() => onClearRuntimeData(removeSitesAndAccounts)}
                disabled={clearRuntimeDataLoading}
              >
                {clearRuntimeDataLoading ? "正在清空..." : "确认清空"}
              </button>
            </>
          }
        >
          <div className="system-settings-danger-modal-copy">
            <p>这个操作会清空当前设备上保存的使用数据和登录状态。</p>
            <p>默认不会删除站点和账号. 只有勾选下面这项时, 才会把站点和账号一起删除。</p>
          </div>
          <label className="toggle-field motion-surface-card">
            <div>
              <strong>同时删除站点和账号</strong>
              <p>勾选后会把站点、账号以及相关登录信息一起删除。</p>
            </div>
            <input
              type="checkbox"
              checked={removeSitesAndAccounts}
              onChange={(event) => setRemoveSitesAndAccounts(event.target.checked)}
              disabled={clearRuntimeDataLoading}
            />
          </label>
        </Modal>
      )}
    </>
  );
}
