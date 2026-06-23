import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const mainWindowApp = readFileSync(new URL("../src/app/MainWindowApp.tsx", import.meta.url), "utf8");

describe("main window toast placement", () => {
  it("pins the main window toast host below the topbar without changing shared defaults", () => {
    expect(mainWindowApp).toContain("className=\"main-window-toast-layer\"");
    expect(styles).toContain(".main-window-toast-layer {");
    expect(styles).toContain("--toast-host-top: 88px;");
    expect(styles).toContain("top: var(--toast-host-top, 22px);");
    expect(styles).toContain("top: var(--toast-host-top, 14px);");
  });
});
