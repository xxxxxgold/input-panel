import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 当前自动化合同统一存放在 tests/，避免把历史参考目录纳入执行范围。
    include: ["tests/**/*.test.ts"],
    exclude: ["__qmai_ref/**", "node_modules/**"]
  }
});
