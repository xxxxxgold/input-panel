export const FLOATING_PANEL_WIDTH = 392;
export const FLOATING_PANEL_HEIGHT = 456;
export const FLOATING_PANEL_PLACEHOLDER_HEIGHT = 196;

/** 根据已解析账号身份返回悬浮面板原生窗口高度。 */
export function resolveFloatingPanelWindowHeight(currentAccountId: string | null) {
  return currentAccountId == null
    ? FLOATING_PANEL_PLACEHOLDER_HEIGHT
    : FLOATING_PANEL_HEIGHT;
}
