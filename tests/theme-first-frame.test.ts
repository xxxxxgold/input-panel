import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const htmlEntries = [
  "index.html",
  "floating-orb.html",
  "floating-panel.html",
  "floating-notification.html"
];

function readProjectFile(path: string) {
  return readFileSync(resolve(root, path), "utf8");
}

describe("Tailwind-free 最小 reset 契约", () => {
  it("reset 先于字体加载，且构建链不再接入 Tailwind", () => {
    const baseStyles = readProjectFile("src/styles/00-base.css");
    const resetStyles = readProjectFile("src/styles/reset.css");
    const packageJson = JSON.parse(readProjectFile("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const viteConfig = readProjectFile("vite.config.ts");

    expect(baseStyles.indexOf('@import "./reset.css"')).toBeGreaterThanOrEqual(0);
    expect(baseStyles.indexOf('@import "./fonts.css"')).toBeGreaterThan(
      baseStyles.indexOf('@import "./reset.css"')
    );
    expect(baseStyles).not.toContain('@import "tailwindcss"');
    expect(resetStyles).toContain("box-sizing: border-box");
    expect(packageJson.dependencies).not.toHaveProperty("tailwindcss");
    expect(packageJson.devDependencies).not.toHaveProperty("tailwindcss");
    expect(packageJson.devDependencies).not.toHaveProperty("@tailwindcss/vite");
    expect(viteConfig).not.toContain("@tailwindcss/vite");
    expect(viteConfig).not.toContain("tailwindcss()");
  });
});

describe("四窗口主题首帧契约", () => {
  it.each(htmlEntries)("%s 在模块加载前恢复受限的主题缓存", (entry) => {
    const html = readProjectFile(entry);
    const inlineThemeScript = html.indexOf('localStorage.getItem("input-panel.last-theme")');
    const moduleEntry = html.indexOf('<script type="module"');

    expect(html).toContain('<html lang="zh-CN" class="titan-noir">');
    expect(html).toContain("/^[a-z][a-z-]*$/.test(lastTheme)");
    expect(inlineThemeScript).toBeGreaterThan(-1);
    expect(moduleEntry).toBeGreaterThan(inlineThemeScript);
  });

  it("运行时主题应用与 HTML 使用同一缓存键", () => {
    const applyThemeSource = readProjectFile("src/shared/lib/apply-theme.ts");

    expect(applyThemeSource).toContain(
      'export const LAST_THEME_STORAGE_KEY = "input-panel.last-theme"'
    );
    expect(applyThemeSource).toContain("classList.remove(...THEME_IDS)");
    expect(applyThemeSource).toContain("classList.add(theme)");
    expect(applyThemeSource).toContain("localStorage.setItem(LAST_THEME_STORAGE_KEY, theme)");
  });
});

describe("主窗口 frontend_ready 显示门禁", () => {
  it("前端发送就绪信号，Rust 注册 command 并保留三秒兜底", () => {
    const mainWindowSource = readProjectFile("src/app/MainWindowApp.tsx");
    const commandSource = readProjectFile("src-tauri/src/adapters/desktop/commands.rs");
    const rustSource = readProjectFile("src-tauri/src/lib.rs");

    expect(mainWindowSource).toContain("const [mainWindowChromeReady, setMainWindowChromeReady]");
    expect(mainWindowSource).toContain("if (desktopUi.loading) {");
    expect(mainWindowSource).toContain("|| !mainWindowChromeReady");
    expect(mainWindowSource).toContain(
      "|| theme !== normalizeThemeId(desktopUi.prefs.theme)"
    );
    expect(mainWindowSource).toContain('invoke("frontend_ready")');
    expect(commandSource).toContain("pub fn frontend_ready(app: AppHandle)");
    expect(commandSource).toContain("reveal_main_window_on_frontend_ready(&app)");
    expect(rustSource).toContain("MAIN_WINDOW_REVEAL_FALLBACK_MS: u64 = 3_000");
    expect(rustSource).toContain("MAIN_WINDOW_REVEALED.swap(true, Ordering::SeqCst)");
    expect(rustSource).toContain("schedule_main_window_reveal_fallback(app_handle.clone())");
    expect(rustSource).toContain("adapters::desktop::commands::frontend_ready");
  });
});
