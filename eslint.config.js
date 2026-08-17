import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

// 下划线前缀表示刻意保留但当前路径不消费的参数或变量。
const noUnusedVarsRule = [
  "error",
  {
    argsIgnorePattern: "^_",
    caughtErrors: "all",
    caughtErrorsIgnorePattern: "^_",
    destructuredArrayIgnorePattern: "^_",
    ignoreRestSiblings: true,
    varsIgnorePattern: "^_"
  }
];

// 这些模块同时导出组件和可独立测试的纯函数，按文件显式维护例外。
const fastRefreshNonComponentExportAllowlist = {
  "src/app/DesktopModeCloseDialog.tsx": [
    "resolveRememberedCloseBehavior"
  ],
  "src/app/FloatingNotificationWindowRoot.tsx": [
    "isFloatingNotificationAnimationPaused",
    "createFloatingNotificationAnimationFallback",
    "pauseFloatingNotificationAnimationFallback",
    "resumeFloatingNotificationAnimationFallback",
    "applyNativeNotificationLifecyclePauseReasons",
    "resolveFloatingNotificationAnimationLifecycle",
    "collectNewlyExitingNotificationIds",
    "isFloatingNotificationDismissalAcknowledged",
    "isFloatingNotificationMotionSettled",
    "beginFloatingNotificationDetailDismissal",
    "reconcileFloatingNotificationSnapshot",
    "settleFloatingNotificationExitAfterNativeDismissal"
  ],
  "src/app/FloatingPanelWindow.tsx": [
    "sortFloatingUsageRows",
    "resolveFloatingUsageIp",
    "buildFloatingQuickSwitchCandidates",
    "resolveFloatingQuickSwitchPanelKey"
  ],
  "src/app/FloatingPanelWindowRoot.tsx": [
    "resolveFloatingPanelCurrentAccount",
    "shouldActivateFloatingPanelData",
    "isFloatingPanelResourceDataCurrent"
  ],
  "src/app/RetryableLazyPage.tsx": [
    "createRetryableLazyPage"
  ],
  "src/charts.tsx": [
    "withChartDataTypography",
    "normalizeTrendChartData",
    "buildTrendAreaChartOption",
    "buildPlatformDonutChartOption",
    "buildPlatformBarChartOption",
    "buildOverviewModelDonutChartOption",
    "readChartPalette",
    "buildChartOptionSignature"
  ],
  "src/pages/KeysPage.tsx": [
    "buildKeyUsageSummaryScopeKey",
    "preloadKeyUsageSummaryRange",
    "buildCcsImportUrl",
    "buildSuggestedThresholdValueInput",
    "buildOrderedCandidateGroups"
  ],
  "src/pages/OverviewPage.tsx": [
    "buildOverviewConcurrencyKeyItems"
  ],
  "src/pages/SubscriptionsPage.tsx": [
    "buildSubscriptionKeyUsageScopeKey"
  ],
  "src/pages/SettingsPage.tsx": [
    "runSiteCardAction",
    "runSiteAccountRowAction"
  ],
  "src/pages/SystemSettingsPage.tsx": [
    "normalizeSystemSettingsStepperValue"
  ]
};

export default defineConfig([
  globalIgnores([
    "node_modules/**",
    "dist/**",
    "dist-server/**",
    "coverage/**",
    "config/**",
    "tmp/**",
    ".tmp/**",
    "test-results/**",
    "src-tauri/target/**",
    "src-tauri/gen/**",
    ".trellis/**",
    ".agents/**",
    ".codex/**",
    ".gitnexus/**"
  ]),
  {
    files: ["eslint.config.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.node,
      sourceType: "module"
    }
  },
  {
    files: ["vite.config.ts", "vitest.config.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.node,
      sourceType: "module"
    }
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended
    ],
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.browser,
      sourceType: "module"
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh
    },
    rules: {
      "@typescript-eslint/no-unused-vars": noUnusedVarsRule,
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/rules-of-hooks": "error",
      "react-refresh/only-export-components": [
        "error",
        { allowConstantExport: true }
      ]
    }
  },
  ...Object.entries(fastRefreshNonComponentExportAllowlist).map(
    ([file, allowExportNames]) => ({
      files: [file],
      rules: {
        "react-refresh/only-export-components": [
          "error",
          { allowConstantExport: true, allowExportNames }
        ]
      }
    })
  ),
  {
    files: ["tests/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.vitest
      },
      sourceType: "module"
    },
    plugins: {
      "react-hooks": reactHooks
    },
    rules: {
      "@typescript-eslint/no-unused-vars": noUnusedVarsRule,
      "react-hooks/rules-of-hooks": "error"
    }
  }
]);
