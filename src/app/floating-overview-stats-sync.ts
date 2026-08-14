import type { UsageStatsRecord } from "../types";

/** 主窗口与悬浮面板间复用当前账号实时总览快照的最小事件协议。 */
export const FLOATING_PANEL_OVERVIEW_STATS_REQUEST_EVENT = "floating-panel-overview-stats-request";
export const FLOATING_PANEL_OVERVIEW_STATS_SYNC_EVENT = "floating-panel-overview-stats-sync";
export const FLOATING_PANEL_OVERVIEW_STATS_RESPONSE_TIMEOUT_MS = 180;

export type FloatingPanelOverviewStatsRequest = {
  requestId: string;
  accountId: string;
};

export type FloatingPanelOverviewStatsResponse = FloatingPanelOverviewStatsRequest & {
  stats: UsageStatsRecord;
  updatedAt: string;
};

/** 仅在主页面具有当前账号的成功快照时构造响应，避免用空值覆盖悬浮面板。 */
export function createFloatingPanelOverviewStatsResponse(input: {
  request: FloatingPanelOverviewStatsRequest;
  stats: UsageStatsRecord | null;
  updatedAt: number | null;
}): FloatingPanelOverviewStatsResponse | null {
  const accountId = input.request.accountId.trim();
  const requestId = input.request.requestId.trim();
  if (!accountId || !requestId || !input.stats || input.updatedAt === null || !Number.isFinite(input.updatedAt)) {
    return null;
  }

  return {
    accountId,
    requestId,
    stats: input.stats,
    updatedAt: new Date(input.updatedAt).toISOString()
  };
}

/** 响应必须同时对应当前请求和当前账号，防止旧事件混入新选择。 */
export function isFloatingPanelOverviewStatsResponseForRequest(
  response: FloatingPanelOverviewStatsResponse,
  request: FloatingPanelOverviewStatsRequest
) {
  return response.requestId === request.requestId && response.accountId === request.accountId;
}
