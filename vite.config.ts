import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    // 四个入口分别对应主窗口、悬浮球、悬浮面板和悬浮通知 WebView。
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        floatingOrb: resolve(__dirname, "floating-orb.html"),
        floatingPanel: resolve(__dirname, "floating-panel.html"),
        floatingNotification: resolve(__dirname, "floating-notification.html")
      }
    }
  },
  server: {
    // 开发态固定端口，并将业务请求代理到同仓库的 Rust HTTP adapter。
    port: 5777,
    strictPort: true,
    watch: {
      ignored: [
        "**/.trellis/**",
        "**/.agents/**",
        "**/.claude/**",
        "**/.codex/**",
        "**/.gitnexus/**",
        "**/tmp/**",
        "**/.tmp/**",
        "**/src-tauri/target/**"
      ]
    },
    proxy: {
      "/api": "http://127.0.0.1:5559"
    }
  },
  preview: {
    port: 4173
  }
});
