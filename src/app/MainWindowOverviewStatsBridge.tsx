import { emitTo, listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

import {
  FLOATING_PANEL_OVERVIEW_STATS_REQUEST_EVENT,
  FLOATING_PANEL_OVERVIEW_STATS_SYNC_EVENT,
  createFloatingPanelOverviewStatsResponse,
  type FloatingPanelOverviewStatsRequest
} from "./floating-overview-stats-sync";
import { isTauriRuntime } from "../shared/transport/runtime";
import type { UsageStatsRecord } from "../types";

type MainWindowOverviewStatsBridgeProps = {
  accountId: string | null;
  stats: UsageStatsRecord | null;
  updatedAt: number | null;
};

/**
 * 将主窗口已经完成的当前账号总览快照按需交给悬浮面板。
 * 不发起任何请求，避免改变主页面原有刷新和缓存生命周期。
 */
export function MainWindowOverviewStatsBridge({
  accountId,
  stats,
  updatedAt
}: MainWindowOverviewStatsBridgeProps) {
  const currentSnapshotRef = useRef({ accountId, stats, updatedAt });
  currentSnapshotRef.current = { accountId, stats, updatedAt };

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<FloatingPanelOverviewStatsRequest>(
      FLOATING_PANEL_OVERVIEW_STATS_REQUEST_EVENT,
      ({ payload }) => {
        if (disposed) {
          return;
        }

        const currentSnapshot = currentSnapshotRef.current;
        if (payload.accountId !== currentSnapshot.accountId) {
          return;
        }

        const response = createFloatingPanelOverviewStatsResponse({
          request: payload,
          stats: currentSnapshot.stats,
          updatedAt: currentSnapshot.updatedAt
        });
        if (!response) {
          return;
        }

        void emitTo("floating-panel", FLOATING_PANEL_OVERVIEW_STATS_SYNC_EVENT, response).catch(() => undefined);
      }
    ).then((cleanup) => {
      if (disposed) {
        cleanup();
        return;
      }
      unlisten = cleanup;
    }).catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return null;
}
