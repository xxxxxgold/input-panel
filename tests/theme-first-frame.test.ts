import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_THEME_ID } from "../src/theme-registry";

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

    expect(html).toContain(`<html lang="zh-CN" class="${DEFAULT_THEME_ID}">`);
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
  it("前端发送就绪信号，Rust 等待真实 reveal 完成并只记录超时诊断", () => {
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
    expect(commandSource).toContain("pub async fn frontend_ready(app: AppHandle) -> Result<(), String>");
    expect(commandSource).toContain("crate::reveal_main_window_on_frontend_ready(&app).await");
    expect(rustSource).toContain("const FRONTEND_READY_TIMEOUT_MS: u64 = 3_000");
    expect(rustSource).toContain("fn schedule_frontend_ready_timeout_diagnostic()");
    expect(rustSource).toContain("frontend_ready 超时，保留原生启动窗并等待后续恢复");
    expect(rustSource).toContain("pub(crate) async fn reveal_main_window_on_frontend_ready");
    expect(rustSource).toContain("完成后才回复 IPC");
    expect(rustSource).toContain("adapters::desktop::commands::frontend_ready");
  });
});
