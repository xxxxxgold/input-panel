import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

export function Topbar({
  summary,
  onReload,
  reloadRefreshing = false
}: {
  summary?: ReactNode;
  onReload?: () => void;
  reloadRefreshing?: boolean;
  [key: string]: unknown;
}) {
  return (
    <header className="global-topbar workspace-header-summary workspace-header-summary-topbar">
      <div
        className="topbar-summary-scroll"
        role={summary ? "region" : undefined}
        aria-label={summary ? "工作区摘要" : undefined}
        tabIndex={summary ? 0 : undefined}
      >
        {summary}
      </div>
      {onReload ? (
        <button
          type="button"
          className="topbar-reload-button"
          onClick={onReload}
          aria-label={reloadRefreshing ? "正在刷新" : "重新加载"}
          aria-busy={reloadRefreshing}
          title={reloadRefreshing ? "正在刷新" : "重新加载"}
          disabled={reloadRefreshing}
        >
          <RefreshCw size={13} className={reloadRefreshing ? "spin" : undefined} />
        </button>
      ) : null}
    </header>
  );
}
