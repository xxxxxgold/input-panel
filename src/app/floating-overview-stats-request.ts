import { emitTo, listen } from "@tauri-apps/api/event";

import {
  FLOATING_PANEL_OVERVIEW_STATS_REQUEST_EVENT,
  FLOATING_PANEL_OVERVIEW_STATS_RESPONSE_TIMEOUT_MS,
  FLOATING_PANEL_OVERVIEW_STATS_SYNC_EVENT,
  isFloatingPanelOverviewStatsResponseForRequest,
  type FloatingPanelOverviewStatsRequest,
  type FloatingPanelOverviewStatsResponse
} from "./floating-overview-stats-sync";

export type FloatingPanelOverviewStatsBridgeTransport = {
  listen: (
    eventName: string,
    handler: (event: { payload: FloatingPanelOverviewStatsResponse }) => void
  ) => Promise<() => void>;
  emitTo: (
    target: string,
    eventName: string,
    payload: FloatingPanelOverviewStatsRequest
  ) => Promise<void>;
};

type RequestMainWindowOverviewStatsOptions = {
  transport?: FloatingPanelOverviewStatsBridgeTransport;
  timeoutMs?: number;
};

const defaultTransport: FloatingPanelOverviewStatsBridgeTransport = {
  listen(eventName, handler) {
    return listen<FloatingPanelOverviewStatsResponse>(eventName, handler);
  },
  emitTo(target, eventName, payload) {
    return emitTo(target, eventName, payload);
  }
};

/**
 * 向主窗口按需索取同账号的既有实时总览快照。
 * 监听器先完成注册，再发起请求；超时或任一桥接失败都交还调用方走原有接口兜底。
 */
export function requestMainWindowOverviewStats(
  request: FloatingPanelOverviewStatsRequest,
  options: RequestMainWindowOverviewStatsOptions = {}
): Promise<FloatingPanelOverviewStatsResponse | null> {
  const transport = options.transport ?? defaultTransport;
  const timeoutMs = options.timeoutMs ?? FLOATING_PANEL_OVERVIEW_STATS_RESPONSE_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    let unlisten: (() => void) | undefined;

    const settle = (response: FloatingPanelOverviewStatsResponse | null) => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(timeoutId);
      unlisten?.();
      resolve(response);
    };

    const timeoutId = globalThis.setTimeout(() => settle(null), timeoutMs);
    void transport.listen(FLOATING_PANEL_OVERVIEW_STATS_SYNC_EVENT, ({ payload }) => {
      if (isFloatingPanelOverviewStatsResponseForRequest(payload, request)) {
        settle(payload);
      }
    }).then((cleanup) => {
      unlisten = cleanup;
      if (settled) {
        cleanup();
        return;
      }
      void transport.emitTo("main", FLOATING_PANEL_OVERVIEW_STATS_REQUEST_EVENT, request).catch(() => settle(null));
    }).catch(() => settle(null));
  });
}
