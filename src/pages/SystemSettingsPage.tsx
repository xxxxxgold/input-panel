import { Minus, Plus } from "lucide-react";

import { MIN_AUTO_REFRESH_INTERVAL_SECONDS } from "../app/refresh-policy";
import { THEME_OPTIONS, type ThemeId } from "../shared/lib/theme";
import type { AppLaunchMode, CloseBehavior, DesktopUiPrefs } from "../types";

export function SystemSettingsPage({
  theme,
  setTheme,
  desktopUiPrefs,
  desktopUiLoading,
  onLaunchModeChange,
  onFloatingVisibleChange,
  onFloatingPanelPinnedChange,
  onFloatingPanelOpacityChange,
  onCloseBehaviorChange,
  onAutoRefreshEnabledChange,
  onServiceStatusRefreshIntervalSecondsChange,
  onAutoRefreshCoreEnabledChange,
  onAutoRefreshCoreIntervalSecondsChange,
  onAutoRefreshKeysEnabledChange,
  onAutoRefreshKeysIntervalSecondsChange,
  onAutoRefreshUsageEnabledChange,
  onAutoRefreshUsageIntervalSecondsChange,
  schedulerConfig,
  schedulerConfigLoading,
  onSchedulerConfigChange
}: {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
  desktopUiPrefs: DesktopUiPrefs;
  desktopUiLoading: boolean;
  onLaunchModeChange: (value: AppLaunchMode) => void;
  onFloatingVisibleChange: (value: boolean) => void;
  onFloatingPanelPinnedChange: (value: boolean) => void;
  onFloatingPanelOpacityChange: (value: number) => void;
  onCloseBehaviorChange: (value: CloseBehavior) => void;
  onAutoRefreshEnabledChange: (value: boolean) => void;
  onServiceStatusRefreshIntervalSecondsChange: (value: number) => void;
  onAutoRefreshCoreEnabledChange: (value: boolean) => void;
  onAutoRefreshCoreIntervalSecondsChange: (value: number) => void;
  onAutoRefreshKeysEnabledChange: (value: boolean) => void;
  onAutoRefreshKeysIntervalSecondsChange: (value: number) => void;
  onAutoRefreshUsageEnabledChange: (value: boolean) => void;
  onAutoRefreshUsageIntervalSecondsChange: (value: number) => void;
  schedulerConfig: { enabled: boolean; intervalSeconds: number };
  schedulerConfigLoading: boolean;
  onSchedulerConfigChange: (value: { enabled: boolean; intervalSeconds: number }) => void;
}) {
  const autoRefreshGroups = [
    {
      key: "core",
      title: "核心数据 / 订阅 / 站点账号配置",
      description: "刷新当前账号核心资料、订阅摘要和站点账号配置里的账号数据。",
      enabled: desktopUiPrefs.autoRefreshCoreEnabled,
      intervalSeconds: desktopUiPrefs.autoRefreshCoreIntervalSeconds,
      onEnabledChange: onAutoRefreshCoreEnabledChange,
      onIntervalChange: onAutoRefreshCoreIntervalSecondsChange
    },
    {
      key: "keys",
      title: "密钥",
      description: "刷新密钥列表、分组、资料、额度和订阅摘要。",
      enabled: desktopUiPrefs.autoRefreshKeysEnabled,
      intervalSeconds: desktopUiPrefs.autoRefreshKeysIntervalSeconds,
      onEnabledChange: onAutoRefreshKeysEnabledChange,
      onIntervalChange: onAutoRefreshKeysIntervalSecondsChange
    },
    {
      key: "usage",
      title: "用量 / 单 Key / 图表实验室",
      description: "刷新用量统计、记录列表、单 Key 曲线和图表数据。",
      enabled: desktopUiPrefs.autoRefreshUsageEnabled,
      intervalSeconds: desktopUiPrefs.autoRefreshUsageIntervalSeconds,
      onEnabledChange: onAutoRefreshUsageEnabledChange,
      onIntervalChange: onAutoRefreshUsageIntervalSecondsChange
    }
  ] as const;

  function handleIntervalInputChange(value: string, onChange: (value: number) => void) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return;
    }
    onChange(parsed);
  }

  function renderIntervalStepper(input: {
    label: string;
    value: number;
    disabled: boolean;
    onChange: (value: number) => void;
    testId?: string;
  }) {
    const decrementDisabled = input.disabled || input.value <= MIN_AUTO_REFRESH_INTERVAL_SECONDS;

    return (
      <label className="field">
        <span>{input.label}</span>
        <div className="number-stepper">
          <button
            type="button"
            className="number-stepper-button"
            onClick={() => input.onChange(Math.max(MIN_AUTO_REFRESH_INTERVAL_SECONDS, input.value - 1))}
            disabled={decrementDisabled}
            aria-label={`${input.label}减少 1 秒`}
          >
            <Minus size={14} />
          </button>
          <input
            type="number"
            min={MIN_AUTO_REFRESH_INTERVAL_SECONDS}
            step={1}
            value={input.value}
            onChange={(event) => handleIntervalInputChange(event.target.value, input.onChange)}
            disabled={input.disabled}
            data-testid={input.testId}
          />
          <button
            type="button"
            className="number-stepper-button"
            onClick={() => input.onChange(input.value + 1)}
            disabled={input.disabled}
            aria-label={`${input.label}增加 1 秒`}
          >
            <Plus size={14} />
          </button>
        </div>
        <small>最低 {MIN_AUTO_REFRESH_INTERVAL_SECONDS} 秒。</small>
      </label>
    );
  }

  function renderThemeCard(extraClassName = "") {
    return (
      <section className={`section-card system-settings-card system-settings-card--theme ${extraClassName}`.trim()}>
        <header className="section-card-header">
          <div>
            <h3>主题与展示</h3>
            <p>首批扩展为 7 套主题, 覆盖通用工作、夜班值守、暖纸核对与高密度数据场景。</p>
          </div>
        </header>
        <div className="theme-grid">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.id}
              className={`theme-option theme-card motion-surface-card ${theme === option.id ? "selected" : ""}`}
              onClick={() => setTheme(option.id)}
              title={option.summary}
            >
              <span className="theme-card-preview" style={{ background: option.preview }}>
                <span className="theme-card-chip" style={{ background: option.accent }} />
                <span className="theme-card-bars" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              </span>
              <span className="theme-card-copy">
                <strong>{option.label}</strong>
                <span>{option.summary}</span>
              </span>
            </button>
          ))}
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
            <p>控制启动模式、悬浮窗和主窗口关闭行为</p>
          </div>
        </header>
        <div className="stack-list">
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
              <p>关闭后只保留主窗口, 再次打开需要手动切换。</p>
            </div>
            <input
              type="checkbox"
              checked={desktopUiPrefs.openFloatingInMainMode}
              onChange={(event) => onFloatingVisibleChange(event.target.checked)}
              disabled={desktopUiLoading}
            />
          </label>
          <label className="toggle-field motion-surface-card">
            <div>
              <strong>悬浮快捷菜单常驻显示</strong>
              <p>开启后图片悬浮菜单会一直显示; 关闭后仅在点击或悬浮到悬浮窗时显示。</p>
            </div>
            <input
              type="checkbox"
              checked={desktopUiPrefs.keepFloatingPanelVisible}
              onChange={(event) => onFloatingPanelPinnedChange(event.target.checked)}
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
            <small>默认 82%。数值越低越通透, 常驻模式下也会即时生效。</small>
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
        </div>
      </section>
    );
  }

  function renderRefreshCard(extraClassName = "") {
    return (
      <section className={`section-card system-settings-card system-settings-card--refresh ${extraClassName}`.trim()}>
        <header className="section-card-header">
          <div>
            <h3>数据自动刷新</h3>
            <p>静默拉取当前页数据, 不会整页刷新, 保留当前筛选和页面上下文。</p>
          </div>
        </header>
        <div className="stack-list">
          <label className="toggle-field motion-surface-card">
            <div>
              <strong>有账号时自动刷新数据</strong>
              <p>关闭后下方所有分组都会暂停, 开启后再按各组自己的设置静默刷新。</p>
            </div>
            <input
              type="checkbox"
              checked={desktopUiPrefs.autoRefreshEnabled}
              onChange={(event) => onAutoRefreshEnabledChange(event.target.checked)}
              disabled={desktopUiLoading}
            />
          </label>
          <div className="field">
            <span>服务状态刷新间隔(秒)</span>
            <div className="number-stepper">
              <button
                type="button"
                className="number-stepper-button"
                onClick={() =>
                  onServiceStatusRefreshIntervalSecondsChange(
                    Math.max(MIN_AUTO_REFRESH_INTERVAL_SECONDS, desktopUiPrefs.autoRefreshIntervalSeconds - 1)
                  )
                }
                disabled={desktopUiLoading || desktopUiPrefs.autoRefreshIntervalSeconds <= MIN_AUTO_REFRESH_INTERVAL_SECONDS}
                aria-label="服务状态刷新间隔(秒)减少 1 秒"
              >
                <Minus size={14} />
              </button>
              <input
                type="number"
                min={MIN_AUTO_REFRESH_INTERVAL_SECONDS}
                step={1}
                value={desktopUiPrefs.autoRefreshIntervalSeconds}
                onChange={(event) =>
                  handleIntervalInputChange(event.target.value, onServiceStatusRefreshIntervalSecondsChange)
                }
                disabled={desktopUiLoading}
                data-testid="service-status-refresh-interval"
              />
              <button
                type="button"
                className="number-stepper-button"
                onClick={() => onServiceStatusRefreshIntervalSecondsChange(desktopUiPrefs.autoRefreshIntervalSeconds + 1)}
                disabled={desktopUiLoading}
                aria-label="服务状态刷新间隔(秒)增加 1 秒"
              >
                <Plus size={14} />
              </button>
            </div>
            <small>服务状态页单独轮询。最低 {MIN_AUTO_REFRESH_INTERVAL_SECONDS} 秒。</small>
          </div>
          <p className="auto-refresh-group-note">
            下面三组只会在对应页面生效, 不会整页重载, 会保留当前筛选、分页和页面上下文。
          </p>
          <div className="auto-refresh-group-grid">
            {autoRefreshGroups.map((group) => (
              <section key={group.key} className="auto-refresh-group-card motion-surface-card">
                <div className="auto-refresh-group-header">
                  <div>
                    <strong>{group.title}</strong>
                    <p>{group.description}</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={group.enabled}
                    onChange={(event) => group.onEnabledChange(event.target.checked)}
                    disabled={desktopUiLoading}
                    aria-label={`${group.title}自动刷新开关`}
                  />
                </div>
                {renderIntervalStepper({
                  label: "间隔(秒)",
                  value: group.intervalSeconds,
                  disabled: desktopUiLoading,
                  onChange: group.onIntervalChange,
                  testId: `${group.key}-refresh-interval`
                })}
              </section>
            ))}
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
            <h3>后端数据调度器</h3>
            <p>控制后台自动从上游拉取数据到本地数据库的行为。</p>
          </div>
        </header>
        <div className="stack-list">
          <label className="toggle-field motion-surface-card">
            <div>
              <strong>启用自动调度</strong>
              <p>关闭后后台不再自动从上游拉取数据，需要手动刷新。</p>
            </div>
            <input
              type="checkbox"
              checked={schedulerConfig.enabled}
              onChange={(event) => onSchedulerConfigChange({ ...schedulerConfig, enabled: event.target.checked })}
              disabled={schedulerConfigLoading}
            />
          </label>
          <div className="field">
            <span>调度间隔(秒)</span>
            <div className="number-stepper">
              <button
                type="button"
                className="number-stepper-button"
                onClick={() => onSchedulerConfigChange({ ...schedulerConfig, intervalSeconds: Math.max(1, schedulerConfig.intervalSeconds - 1) })}
                disabled={schedulerConfigLoading || schedulerConfig.intervalSeconds <= 1}
                aria-label="调度间隔减少 1 秒"
              >
                <Minus size={14} />
              </button>
              <input
                type="number"
                min={1}
                step={1}
                value={schedulerConfig.intervalSeconds}
                onChange={(event) => {
                  const parsed = Number(event.target.value);
                  if (Number.isFinite(parsed) && parsed >= 1) {
                    onSchedulerConfigChange({ ...schedulerConfig, intervalSeconds: parsed });
                  }
                }}
                disabled={schedulerConfigLoading}
              />
              <button
                type="button"
                className="number-stepper-button"
                onClick={() => onSchedulerConfigChange({ ...schedulerConfig, intervalSeconds: schedulerConfig.intervalSeconds + 1 })}
                disabled={schedulerConfigLoading}
                aria-label="调度间隔增加 1 秒"
              >
                <Plus size={14} />
              </button>
            </div>
            <small>最低 1 秒。后台会自动按此间隔轮询所有账号并同步数据。</small>
          </div>
        </div>
      </section>
    );
  }

  function renderImplementationCard(extraClassName = "") {
    return (
      <section className={`section-card system-settings-card system-settings-card--implementation ${extraClassName}`.trim()}>
        <header className="section-card-header">
          <div>
            <h3>当前实现说明</h3>
            <p>单 Rust 后端负责登录、会话兼容与聚合</p>
          </div>
        </header>
        <ul className="plain-list">
          <li>前端只连接本地 `/api/*`，不直接跨域请求第三方站点。</li>
          <li>Rust 后端会把站点、账号、密码、session 与本地缓存统一保存到 `config/config.db`。</li>
          <li>登录层会兼容多个候选 auth/profile 路径，降低 Sub2API 版本漂移风险。</li>
        </ul>
      </section>
    );
  }

  return (
    <>
      <section className="system-settings-layout system-settings-layout-desktop">
        <div className="system-settings-column">
          {renderThemeCard()}
          {renderRefreshCard()}
          {renderImplementationCard()}
        </div>
        <div className="system-settings-column">
          {renderWindowCard()}
          {renderSchedulerCard()}
        </div>
      </section>
      <section className="system-settings-layout-mobile">
        {renderThemeCard()}
        {renderWindowCard()}
        {renderRefreshCard()}
        {renderSchedulerCard()}
        {renderImplementationCard()}
      </section>
    </>
  );
}
