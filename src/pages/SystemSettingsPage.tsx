export function SystemSettingsPage({
  theme,
  setTheme
}: {
  theme: "light" | "dark" | "deep-blue";
  setTheme: (theme: "light" | "dark" | "deep-blue") => void;
}) {
  return (
    <section className="content-grid">
      <section className="section-card">
        <header className="section-card-header">
          <div>
            <h3>主题与展示</h3>
            <p>浅色、深色、深蓝护眼三套主题可切换</p>
          </div>
        </header>
        <div className="stack-list">
          <button className={`theme-option ${theme === "light" ? "selected" : ""}`} onClick={() => setTheme("light")}>
            浅色
          </button>
          <button className={`theme-option ${theme === "dark" ? "selected" : ""}`} onClick={() => setTheme("dark")}>
            深色
          </button>
          <button
            className={`theme-option ${theme === "deep-blue" ? "selected" : ""}`}
            onClick={() => setTheme("deep-blue")}
          >
            深蓝护眼
          </button>
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
