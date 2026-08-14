export const SITE_FAILOVER_TRANSITION_REFRESH_EVENT =
  "input-panel:site-failover-transition-refresh";

/** 通知主窗口立即读取最新的站点故障转移事件。 */
export function requestSiteFailoverTransitionRefresh() {
  if (
    typeof window !== "undefined"
    && typeof window.dispatchEvent === "function"
    && typeof Event !== "undefined"
  ) {
    window.dispatchEvent(new Event(SITE_FAILOVER_TRANSITION_REFRESH_EVENT));
  }
}

/** 无论业务请求成功或失败，都在请求终态后刷新一次 transition cursor。 */
export function refreshSiteFailoverTransitionsAfter<T>(operation: Promise<T>) {
  return operation.finally(requestSiteFailoverTransitionRefresh);
}
