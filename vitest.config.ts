import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["__qmai_ref/**", "node_modules/**"]
  }
});

