import { useEffect, useRef } from "react";

import { listSiteFailoverTransitions } from "../features/accounts/client";
import {
  requestSiteFailoverTransitionRefresh,
  SITE_FAILOVER_TRANSITION_REFRESH_EVENT
} from "../shared/site-failover-transition";
import type { SiteFailoverTransitionEvent } from "../types";

const CURSOR_STORAGE_KEY = "input-panel:site-failover-transition-revision:v1";
const POLL_INTERVAL_MS = 8_000;

type FailoverToast = {
  tone: "info" | "success";
  title: string;
  message: string;
};

export { requestSiteFailoverTransitionRefresh };

/** 主窗口按持久 revision 消费故障转移事件，避免刷新或多次轮询重复提示。 */
export function useSiteFailoverTransitionObserver({
  pageVisible,
  windowFocused,
  pushToast
}: {
  pageVisible: boolean;
  windowFocused: boolean;
  pushToast: (toast: FailoverToast) => unknown;
}) {
  const inFlightRef = useRef(false);
  const pollPendingRef = useRef(false);
  const activePollRef = useRef<(() => void) | null>(null);
  const cursorRef = useRef<number | null>(readCursor());
  const pushToastRef = useRef(pushToast);
  pushToastRef.current = pushToast;

  useEffect(() => {
    if (!pageVisible || typeof window === "undefined") {
      return;
    }

    let disposed = false;
    const poll = async () => {
      if (disposed) {
        return;
      }
      if (inFlightRef.current) {
        pollPendingRef.current = true;
        return;
      }
      inFlightRef.current = true;
      try {
        const cursor = cursorRef.current;
        const batch = await listSiteFailoverTransitions(cursor ?? 0);
        if (disposed) {
          return;
        }
        if (cursor === null || batch.resetRequired) {
          replaceCursor(batch.latestRevision, cursorRef);
          return;
        }

        const events = [...batch.events]
          .filter((event) => Number.isSafeInteger(event.revision) && event.revision > cursor)
          .sort((left, right) => left.revision - right.revision);
        for (const event of events) {
          if (disposed || event.revision <= (cursorRef.current ?? 0)) {
            continue;
          }
          pushToastRef.current(buildTransitionToast(event));
          advanceCursor(event.revision, cursorRef);
        }
        if (events.length === 0 && batch.latestRevision > (cursorRef.current ?? 0)) {
          advanceCursor(batch.latestRevision, cursorRef);
        }
      } catch (error) {
        console.warn("读取站点故障转移事件失败", error);
      } finally {
        inFlightRef.current = false;
        if (pollPendingRef.current) {
          pollPendingRef.current = false;
          activePollRef.current?.();
        }
      }
    };
    const requestPoll = () => void poll();
    activePollRef.current = requestPoll;

    requestPoll();
    const intervalId = window.setInterval(requestPoll, POLL_INTERVAL_MS);
    const handleRefresh = () => requestPoll();
    window.addEventListener(SITE_FAILOVER_TRANSITION_REFRESH_EVENT, handleRefresh);
    return () => {
      disposed = true;
      if (activePollRef.current === requestPoll) {
        activePollRef.current = null;
      }
      window.clearInterval(intervalId);
      window.removeEventListener(SITE_FAILOVER_TRANSITION_REFRESH_EVENT, handleRefresh);
    };
  }, [pageVisible, windowFocused]);
}

function buildTransitionToast(event: SiteFailoverTransitionEvent): FailoverToast {
  const host = resolveHost(event.toBaseUrl);
  if (event.kind === "primaryRestored") {
    return {
      tone: "success",
      title: "主站已恢复",
      message: `${event.siteName} 已恢复使用 ${host}`
    };
  }
  return {
    tone: "info",
    title: "已切换至备用地址",
    message: `${event.siteName} 当前使用 ${host}`
  };
}

function resolveHost(baseUrl: string) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function readCursor() {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const value = window.localStorage.getItem(CURSOR_STORAGE_KEY);
    if (value === null) {
      return null;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

function advanceCursor(revision: number, cursorRef: { current: number | null }) {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    return;
  }
  const nextRevision = Math.max(cursorRef.current ?? 0, revision);
  replaceCursor(nextRevision, cursorRef);
}

function replaceCursor(revision: number, cursorRef: { current: number | null }) {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    return;
  }
  const nextRevision = revision;
  cursorRef.current = nextRevision;
  try {
    window.localStorage.setItem(CURSOR_STORAGE_KEY, String(nextRevision));
  } catch {
    // localStorage 不可用时仍保持当前页面内的单调 cursor。
  }
}
