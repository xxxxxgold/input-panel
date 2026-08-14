import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";

import { TitleHint } from "../shared/ui/TitleHint";
import { WorkspaceLoadingState } from "./WorkspaceLoadingState";

export function WorkspaceFrame({
  topbar,
  title,
  subtitle,
  headerActions,
  loading,
  ready,
  refreshError = null,
  onRetry,
  navKey,
  pageMotionPhase,
  children
}: {
  topbar: ReactNode;
  title: string;
  subtitle: string;
  headerActions?: ReactNode;
  loading: boolean;
  ready: boolean;
  scopeLoading?: boolean;
  refreshError?: string | null;
  onRetry?: () => void;
  navKey: string;
  pageMotionPhase?: "idle" | "enter";
  children: ReactNode;
}) {
  const hasSubtitle = subtitle.trim().length > 0;
  const workspaceLoading = loading && !ready;
  const headerCopyClassName = `workspace-header-copy ${headerActions ? "has-header-actions" : ""}`.trim();

  return (
    <div className="workspace-window-shell">
      <main className="workspace" aria-busy={workspaceLoading}>
        {topbar}
        <header className="workspace-header">
          <div className={headerCopyClassName}>
            <div className="workspace-header-main">
              <div className="title-with-hint">
                <h2>{title}</h2>
                {hasSubtitle ? <TitleHint content={subtitle} label={`查看${title}说明`} /> : null}
              </div>
            </div>
            {headerActions ? <div className="workspace-header-actions">{headerActions}</div> : null}
            {refreshError ? (
              <div
                className="workspace-refresh-status has-error"
                role="alert"
                aria-live="assertive"
                aria-atomic="true"
              >
                <CircleAlert size={14} aria-hidden="true" />
                <span>{`刷新失败, 当前仍显示上次成功数据: ${refreshError}`}</span>
                {onRetry ? (
                  <button type="button" className="ghost-button workspace-refresh-retry" onClick={onRetry}>
                    重新刷新
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </header>

        <div className={`workspace-page-shell ${workspaceLoading ? "is-loading" : ""}`.trim()}>
          <div
            key={navKey}
            className={`workspace-scroll workspace-page ${pageMotionPhase === "enter" ? "page-motion-enter" : ""}`.trim()}
            inert={workspaceLoading || undefined}
          >
            {children}
          </div>
          {workspaceLoading ? <WorkspaceLoadingState /> : null}
        </div>
      </main>
    </div>
  );
}
