import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const topbarSource = readFileSync(new URL("../src/app/Topbar.tsx", import.meta.url), "utf8");
const floatingRailDrawerSource = readFileSync(new URL("../src/app/FloatingRailDrawer.tsx", import.meta.url), "utf8");
// 抽屉样式已归位 03-topbar.css（原独立补丁文件已删除）。
const floatingRailDrawerStyles = readFileSync(new URL("../src/styles/03-topbar.css", import.meta.url), "utf8");

describe("Topbar interaction source", () => {
  it("keeps legacy peek interactions out of the simplified topbar", () => {
    expect(topbarSource).not.toContain("TOPBAR_PEEK_HOVER_ENABLED");
    expect(topbarSource).not.toContain("handlePeekMouseEnter");
    expect(topbarSource).not.toContain("handlePeekMouseLeave");
    expect(topbarSource).not.toContain('aria-label="站点 API 入口"');
    expect(topbarSource).not.toContain('aria-label="服务状态详情"');
    expect(topbarSource).not.toContain('aria-label="订阅使用情况详情"');
  });

  it("opens moved detail panels from the right drawer icons", () => {
    expect(floatingRailDrawerSource).toContain('label: "站点 API 入口"');
    expect(floatingRailDrawerSource).toContain('label: "服务状态详情"');
    expect(floatingRailDrawerSource).toContain('label: "订阅使用情况详情"');
    expect(floatingRailDrawerSource).toContain("onMouseEnter={() => openDrawer(item.key)}");
    expect(floatingRailDrawerSource).toContain("onFocus={() => openDrawer(item.key)}");
    expect(floatingRailDrawerSource).toContain("function handleDrawerTabClick(panel: FloatingRailDrawerPanelKey)");
    expect(floatingRailDrawerSource).toContain("onClick={() => handleDrawerTabClick(item.key)}");
    expect(floatingRailDrawerStyles).toContain(".floating-rail-drawer.open .floating-rail-drawer-panel");
    expect(floatingRailDrawerStyles).not.toContain(".floating-rail-drawer:hover .floating-rail-drawer-panel");
    expect(floatingRailDrawerStyles).not.toContain(".floating-rail-drawer:focus-within");
  });
});
