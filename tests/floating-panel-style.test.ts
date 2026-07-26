import { describe, expect, it } from "vitest";

import { readBundledStyles } from "./helpers/styles";

const styles = readBundledStyles();

describe("floating panel shell styles", () => {
  it("keeps the floating panel on a narrower rail and a cleaner widget-like chrome split", () => {
    expect(styles).toContain(".floating-panel-window::before");
    expect(styles).toContain("backdrop-filter: blur(40px) saturate(170%);");
    expect(styles).toContain(".floating-panel-window::after");
    expect(styles).toContain("height: 92px;");
    expect(styles).toContain(".floating-panel-shell::before");
    expect(styles).toContain("backdrop-filter: blur(34px) saturate(150%);");
    expect(styles).toContain(".floating-panel-shell::after");
    expect(styles).toContain("filter: blur(22px);");
    expect(styles).toContain("opacity: 0.28;");
    expect(styles).toContain(".floating-menu-cap");
    expect(styles).toContain(".floating-preview-head-status");
    expect(styles).toContain(".floating-menu-card.dock-right");
    expect(styles).toContain("10px 16px 28px rgba(15, 23, 42, 0.06)");
    expect(styles).toContain("border-radius: 0 22px 22px 0;");
    expect(styles).toContain("width: 60px;");
    expect(styles).toContain(".floating-preview-card.dock-right");
    expect(styles).toContain("-12px 16px 28px rgba(15, 23, 42, 0.06)");
    expect(styles).toContain(".floating-menu-card.dock-left");
    expect(styles).toContain("border-radius: 22px 0 0 22px;");
    expect(styles).toContain("margin-right: -1px;");
    expect(styles).toContain(".floating-menu-card.dock-left::after");
    expect(styles).toContain("right: -1px;");
    expect(styles).toContain(".floating-panel-shell.dock-left::before");
    expect(styles).toContain(".floating-preview-card.dock-left");
    expect(styles).toContain("transform-origin: bottom left;");
    expect(styles).toContain("padding-right: 10px;");
    expect(styles).toContain(".floating-preview-card.dock-left .floating-preview-head");
    expect(styles).toContain("flex-direction: row-reverse;");
    expect(styles).toContain(".floating-preview-card.dock-left::after");
    expect(styles).toContain(".floating-preview-metric");
    expect(styles).toContain(".floating-menu-card::before,");
    expect(styles).toContain(".floating-preview-card::before");
    expect(styles).toContain("height: 48px;");
    expect(styles).toContain("rgba(251, 253, 255, 0.96)");
    expect(styles).toContain(".floating-preview-head {");
  });
});
