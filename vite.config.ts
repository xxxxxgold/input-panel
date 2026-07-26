import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
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
