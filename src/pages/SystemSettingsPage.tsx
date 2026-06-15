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
  onCloseBehaviorChange
}: {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
  desktopUiPrefs: DesktopUiPrefs;
  desktopUiLoading: boolean;
  onLaunchModeChange: (value: AppLaunchMode) => void;
  onFloatingVisibleChange: (value: boolean) => void;
  onFloatingPanelPinnedChange: (value: boolean) => void;
  onCloseBehaviorChange: (value: CloseBehavior) => void;
}) {
  return (
    <section className="content-grid">
      <section className="section-card">
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
              className={`theme-option theme-card ${theme === option.id ? "selected" : ""}`}
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
      <section className="section-card">
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
          <label className="toggle-field">
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
          <label className="toggle-field">
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
      <section className="section-card">
        <header className="section-card-header">
          <div>
            <h3>当前实现说明</h3>
            <p>单 Rust 后端负责登录、会话兼容与聚合</p>
          </div>
        </header>
        <ul className="plain-list">
          <li>前端只连接本地 `/api/*`，不直接跨域请求第三方站点。</li>
          <li>Rust 后端会把站点、账号、密码、session 与快照统一保存到 `config/config.db`。</li>
          <li>登录层会兼容多个候选 auth/profile 路径，降低 Sub2API 版本漂移风险。</li>
        </ul>
      </section>
    </section>
  );
}
