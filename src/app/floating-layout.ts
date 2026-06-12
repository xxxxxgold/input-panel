export type FloatingDock = "left" | "right";

export type FloatingPanelKey = "overview" | "alerts" | "subscriptions" | "usage";

export interface FloatingWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FloatingWindowMetrics {
  width: number;
  height: number;
  ballX: number;
  ballY: number;
  menuX: number;
  menuY: number;
  panelX: number;
  panelY: number;
}

export interface FloatingWindowPlacement extends FloatingWindowMetrics {
  x: number;
  y: number;
  ballTop: number;
}

export const FLOATING_ORB_SIZE = 68;
export const FLOATING_WINDOW_PADDING = 10;
export const FLOATING_PANEL_GAP = 14;
export const FLOATING_MENU_WIDTH = 188;
export const FLOATING_MENU_HEIGHT = 248;
export const FLOATING_PREVIEW_WIDTH = 324;
export const FLOATING_PREVIEW_HEIGHT = 316;
export const FLOATING_EDGE_HIDE = 26;
export const FLOATING_SAFE_MARGIN = 14;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function resolveFloatingDock(ballCenterX: number, workArea: FloatingWorkArea): FloatingDock {
  return ballCenterX <= workArea.x + workArea.width / 2 ? "left" : "right";
}

export function getFloatingWindowMetrics(options: {
  dock: FloatingDock;
  menuVisible: boolean;
  panelVisible: boolean;
}): FloatingWindowMetrics {
  const previewWidth = options.panelVisible ? FLOATING_PREVIEW_WIDTH + FLOATING_PANEL_GAP : 0;
  const menuWidth = options.menuVisible ? FLOATING_MENU_WIDTH + FLOATING_PANEL_GAP : 0;
  const width =
    FLOATING_WINDOW_PADDING * 2 + FLOATING_ORB_SIZE + menuWidth + previewWidth;
  const height =
    FLOATING_WINDOW_PADDING * 2 +
    Math.max(
      FLOATING_ORB_SIZE,
      options.menuVisible ? FLOATING_MENU_HEIGHT : 0,
      options.panelVisible ? FLOATING_PREVIEW_HEIGHT : 0
    );
  const ballY = height - FLOATING_WINDOW_PADDING - FLOATING_ORB_SIZE;

  if (options.dock === "left") {
    const ballX = FLOATING_WINDOW_PADDING;
    const menuX = ballX + FLOATING_ORB_SIZE + FLOATING_PANEL_GAP;
    const panelX = menuX + (options.menuVisible ? FLOATING_MENU_WIDTH + FLOATING_PANEL_GAP : 0);
    return {
      width,
      height,
      ballX,
      ballY,
      menuX,
      menuY: height - FLOATING_WINDOW_PADDING - FLOATING_MENU_HEIGHT,
      panelX,
      panelY: height - FLOATING_WINDOW_PADDING - FLOATING_PREVIEW_HEIGHT
    };
  }

  const ballX = width - FLOATING_WINDOW_PADDING - FLOATING_ORB_SIZE;
  const menuX = ballX - FLOATING_PANEL_GAP - FLOATING_MENU_WIDTH;
  const panelX = menuX - (options.panelVisible ? FLOATING_PANEL_GAP + FLOATING_PREVIEW_WIDTH : 0);

  return {
    width,
    height,
    ballX,
    ballY,
    menuX,
    menuY: height - FLOATING_WINDOW_PADDING - FLOATING_MENU_HEIGHT,
    panelX,
    panelY: height - FLOATING_WINDOW_PADDING - FLOATING_PREVIEW_HEIGHT
  };
}

export function computeFloatingWindowPlacement(options: {
  dock: FloatingDock;
  menuVisible: boolean;
  panelVisible: boolean;
  workArea: FloatingWorkArea;
  ballTop: number;
}): FloatingWindowPlacement {
  const metrics = getFloatingWindowMetrics(options);
  const minY = options.workArea.y + FLOATING_SAFE_MARGIN;
  const maxY = options.workArea.y + options.workArea.height - FLOATING_SAFE_MARGIN - metrics.height;
  const y = clamp(options.ballTop - metrics.ballY, minY, Math.max(minY, maxY));
  const clampedBallTop = y + metrics.ballY;

  const x =
    options.dock === "left"
      ? options.workArea.x - FLOATING_EDGE_HIDE
      : options.workArea.x + options.workArea.width - metrics.width + FLOATING_EDGE_HIDE;

  return {
    ...metrics,
    x,
    y,
    ballTop: clampedBallTop
  };
}
