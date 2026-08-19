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

  it("keeps the orb partially hidden beyond the left edge", () => {
    const placement = computeOrbPosition({
      dock: "left",
      workArea,
      y: 620
    });

    expect(Math.abs(placement.x + FLOATING_EDGE_HIDE)).toBe(0);
    expect(placement.x + FLOATING_ORB_SIZE / 2).toBeGreaterThan(0);
  });

  it("keeps the orb partially hidden beyond the right edge", () => {
    const placement = computeOrbPosition({
      dock: "right",
      workArea,
      y: 620
    });

    expect(placement.x + FLOATING_ORB_SIZE).toBe(workArea.width + FLOATING_EDGE_HIDE);
  });

  it("expands the panel window inward from the orb", () => {
    const leftPanel = computePanelWindowPosition({
      dock: "left",
      orbX: -FLOATING_EDGE_HIDE,
      orbY: 300
    });
    const rightOrbX = workArea.width - FLOATING_ORB_SIZE + FLOATING_EDGE_HIDE;
    const rightPanel = computePanelWindowPosition({
      dock: "right",
      orbX: rightOrbX,
      orbY: 300
    });

    expect(leftPanel.x).toBe(-FLOATING_EDGE_HIDE + FLOATING_ORB_SIZE + FLOATING_PANEL_GAP);
    expect(rightPanel.x + FLOATING_PANEL_SHELL_WIDTH + FLOATING_PANEL_GAP).toBe(rightOrbX);
    expect(leftPanel.y).toBe(300 - Math.max(FLOATING_MENU_HEIGHT, FLOATING_PREVIEW_HEIGHT));
    expect(rightPanel.y).toBe(300 - Math.max(FLOATING_MENU_HEIGHT, FLOATING_PREVIEW_HEIGHT));
  });
});
