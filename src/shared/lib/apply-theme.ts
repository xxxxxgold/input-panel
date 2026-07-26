import { THEME_IDS, type ThemeId } from "./theme";

/** 内联首帧脚本与运行时共用的主题缓存 key（见各 HTML 入口 <head>）。 */
export const LAST_THEME_STORAGE_KEY = "input-panel.last-theme";

/**
 * 把主题类应用到 <html>，并写入轻量缓存供下次启动的内联脚本在首帧前预置，
 * 消除"默认主题闪一下再切换"的 FOUC。
 */
export function applyThemeToDocument(theme: ThemeId) {
  document.documentElement.classList.remove(...THEME_IDS);
  document.documentElement.classList.add(theme);
  try {
    window.localStorage.setItem(LAST_THEME_STORAGE_KEY, theme);
  } catch {
    // 存储不可用时仅失去首帧预置能力，不影响主题本身。
  }
}
