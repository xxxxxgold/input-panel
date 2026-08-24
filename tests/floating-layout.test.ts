import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  FLOATING_EDGE_HIDE,
  FLOATING_MENU_HEIGHT,
  FLOATING_ORB_SIZE,
  FLOATING_PANEL_GAP,
  FLOATING_PREVIEW_HEIGHT,
  FLOATING_PANEL_SHELL_WIDTH,
  computeOrbPosition,
  computePanelWindowPosition,
  resolveFloatingDock
} from "../src/app/floating-layout";

const workArea = {
  x: 0,
  y: 0,
  width: 1440,
  height: 900
};

describe("floating layout", () => {
  it("docks to the left when the orb center is on the left half", () => {
    expect(resolveFloatingDock(320, workArea)).toBe("left");
  });

  it("docks to the right when the orb center is on the right half", () => {
    expect(resolveFloatingDock(1120, workArea)).toBe("right");
  });

  it("keeps the complete orb inside the left edge", () => {
    const placement = computeOrbPosition({
      dock: "left",
      workArea,
      y: 620
    });

    expect(FLOATING_EDGE_HIDE).toBe(0);
    expect(placement.x).toBe(workArea.x);
    expect(placement.x + FLOATING_ORB_SIZE).toBe(workArea.x + FLOATING_ORB_SIZE);
  });

  it("keeps the complete orb inside the right edge", () => {
    const placement = computeOrbPosition({
      dock: "right",
      workArea,
      y: 620
    });

    expect(placement.x).toBe(workArea.x + workArea.width - FLOATING_ORB_SIZE);
    expect(placement.x + FLOATING_ORB_SIZE).toBe(workArea.x + workArea.width);
  });

  it("expands the panel window inward from the orb", () => {
    const leftPanel = computePanelWindowPosition({
      dock: "left",
      orbX: -FLOATING_EDGE_HIDE,
      orbY: 300,
      workArea
    });
    const rightOrbX = workArea.width - FLOATING_ORB_SIZE + FLOATING_EDGE_HIDE;
    const rightPanel = computePanelWindowPosition({
      dock: "right",
      orbX: rightOrbX,
      orbY: 300,
      workArea
    });

    expect(leftPanel.x).toBe(-FLOATING_EDGE_HIDE + FLOATING_ORB_SIZE + FLOATING_PANEL_GAP);
    expect(rightPanel.x + FLOATING_PANEL_SHELL_WIDTH + FLOATING_PANEL_GAP).toBe(rightOrbX);
    expect(leftPanel.y).toBe(300 - Math.max(FLOATING_MENU_HEIGHT, FLOATING_PREVIEW_HEIGHT));
    expect(rightPanel.y).toBe(300 - Math.max(FLOATING_MENU_HEIGHT, FLOATING_PREVIEW_HEIGHT));
  });

  it("clamps the panel to the visible work area when the orb is near the top edge", () => {
    const topLeftPanel = computePanelWindowPosition({
      dock: "left",
      orbX: -FLOATING_EDGE_HIDE,
      orbY: 220,
      workArea
    });
    const topRightPanel = computePanelWindowPosition({
      dock: "right",
      orbX: workArea.width - FLOATING_ORB_SIZE + FLOATING_EDGE_HIDE,
      orbY: 220,
      workArea
    });

    expect(topLeftPanel.y).toBe(12);
    expect(topRightPanel.y).toBe(12);
  });
});

describe("native floating window surface", () => {
  it("keeps the orb window and WebView layers fully transparent", () => {
    const rustSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
    const builderStart = rustSource.indexOf("fn ensure_floating_window");
    const builderEnd = rustSource.indexOf("fn ensure_floating_panel_window", builderStart);
    const builder = rustSource.slice(builderStart, builderEnd);

    expect(builder).toContain(".transparent(true)");
    expect(builder).toContain(".background_color(tauri::window::Color(0, 0, 0, 0))");
  });
});
