import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/echarts/charts")) {
            return "echarts-charts";
          }
          if (id.includes("/node_modules/echarts/components")) {
            return "echarts-components";
          }
          if (id.includes("/node_modules/echarts/renderers")) {
            return "echarts-renderers";
          }
          if (id.includes("/node_modules/zrender/")) {
            return "zrender";
          }
          if (
            id.includes("/src/features/analytics/AnalyticsLab.tsx") ||
            id.includes("/src/charts.tsx")
          ) {
            return "analytics-lab";
          }
        }
      },
      input: {
        main: resolve(__dirname, "index.html"),
        floatingOrb: resolve(__dirname, "floating-orb.html"),
        floatingPanel: resolve(__dirname, "floating-panel.html")
      }
    }
  },
  server: {
    port: 5777,
    proxy: {
      "/api": "http://127.0.0.1:5559"
    }
  },
  preview: {
    port: 4173
  }
});
