export type FloatingDock = "left" | "right";

export type FloatingPanelKey = "overview" | "alerts" | "subscriptions" | "usage";

export interface FloatingWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const FLOATING_ORB_SIZE = 60;
export const FLOATING_MENU_WIDTH = 360;
export const FLOATING_MENU_HEIGHT = 264;
export const FLOATING_PREVIEW_WIDTH = 360;
export const FLOATING_PREVIEW_HEIGHT = 264;
export const FLOATING_PANEL_GAP = 8;
export const FLOATING_PANEL_TAIL_SPACE = 0;
export const FLOATING_PANEL_SHELL_WIDTH = 360;
export const FLOATING_EDGE_HIDE = 0;
export const FLOATING_SAFE_MARGIN = 12;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function resolveFloatingDock(ballCenterX: number, workArea: FloatingWorkArea): FloatingDock {
  return ballCenterX <= workArea.x + workArea.width / 2 ? "left" : "right";
}

export function computeOrbPosition(options: {
  dock: FloatingDock;
  workArea: FloatingWorkArea;
  x?: number;
  y?: number;
}) {
  const minY = options.workArea.y + FLOATING_SAFE_MARGIN;
  const maxY = options.workArea.y + options.workArea.height - FLOATING_ORB_SIZE - FLOATING_SAFE_MARGIN;
  const y = clamp(options.y ?? options.workArea.y + 140, minY, Math.max(minY, maxY));
  const x =
    options.dock === "left"
      ? options.workArea.x - FLOATING_EDGE_HIDE
      : options.workArea.x + options.workArea.width - FLOATING_ORB_SIZE + FLOATING_EDGE_HIDE;

  return { x, y };
}

export function computePanelWindowPosition(options: {
  dock: FloatingDock;
  orbX: number;
  orbY: number;
  workArea?: FloatingWorkArea;
}) {
  const panelHeight = Math.max(FLOATING_MENU_HEIGHT, FLOATING_PREVIEW_HEIGHT);
  const rawY = options.orbY - panelHeight;
  const y = options.workArea
    ? clamp(
        rawY,
        options.workArea.y + FLOATING_SAFE_MARGIN,
        Math.max(options.workArea.y + FLOATING_SAFE_MARGIN, options.workArea.y + options.workArea.height - panelHeight - FLOATING_SAFE_MARGIN)
      )
    : rawY;
  const x =
    options.dock === "left"
      ? options.orbX + FLOATING_ORB_SIZE + FLOATING_PANEL_GAP
      : options.orbX - FLOATING_PANEL_SHELL_WIDTH - FLOATING_PANEL_GAP;

  return {
    x,
    y,
    width: FLOATING_PANEL_SHELL_WIDTH,
    height: panelHeight
  };
}
