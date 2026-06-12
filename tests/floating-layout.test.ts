import { describe, expect, it } from "vitest";

import {
  FLOATING_EDGE_HIDE,
  FLOATING_ORB_SIZE,
  computeFloatingWindowPlacement,
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

  it("keeps the collapsed left orb partially hidden beyond the screen edge", () => {
    const placement = computeFloatingWindowPlacement({
      dock: "left",
      menuVisible: false,
      panelVisible: false,
      workArea,
      ballTop: 620
    });

    expect(placement.x).toBe(-FLOATING_EDGE_HIDE);
    expect(placement.ballX).toBeGreaterThanOrEqual(0);
    expect(placement.x + placement.ballX + FLOATING_ORB_SIZE / 2).toBeGreaterThan(0);
  });

  it("keeps the collapsed right orb partially hidden beyond the screen edge", () => {
    const placement = computeFloatingWindowPlacement({
      dock: "right",
      menuVisible: false,
      panelVisible: false,
      workArea,
      ballTop: 620
    });

    expect(placement.x + placement.width).toBe(workArea.width + FLOATING_EDGE_HIDE);
    expect(placement.x + placement.ballX + FLOATING_ORB_SIZE).toBeGreaterThan(workArea.width - FLOATING_ORB_SIZE);
  });

  it("keeps expanded content fully inside the work area", () => {
    const leftPlacement = computeFloatingWindowPlacement({
      dock: "left",
      menuVisible: true,
      panelVisible: true,
      workArea,
      ballTop: 160
    });
    const rightPlacement = computeFloatingWindowPlacement({
      dock: "right",
      menuVisible: true,
      panelVisible: true,
      workArea,
      ballTop: 840
    });

    expect(leftPlacement.y).toBeGreaterThanOrEqual(0);
    expect(leftPlacement.x + leftPlacement.menuX).toBeGreaterThanOrEqual(0);
    expect(leftPlacement.x + leftPlacement.panelX).toBeGreaterThanOrEqual(0);
    expect(leftPlacement.x + leftPlacement.width).toBeLessThanOrEqual(workArea.width + FLOATING_EDGE_HIDE);
    expect(rightPlacement.x + rightPlacement.panelX).toBeGreaterThanOrEqual(0);
    expect(rightPlacement.y + rightPlacement.height).toBeLessThanOrEqual(workArea.height);
  });
});
