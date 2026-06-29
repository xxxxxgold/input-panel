import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

export function WorkspaceFrame({
  topbar,
  title,
  subtitle,
  summary,
  loading,
  ready,
  navKey,
  pageMotionPhase,
  children
}: {
  topbar: ReactNode;
  title: string;
  subtitle: string;
  summary: ReactNode;
  loading: boolean;
  ready: boolean;
  navKey: string;
  pageMotionPhase?: "idle" | "enter";
  children: ReactNode;
}) {
  return (
    <main className="workspace">
      {topbar}
      <header className="workspace-header">
        <div>
          <p className="eyebrow">总览面板</p>
          <h2>{title}</h2>
          <p className="workspace-subtitle">{subtitle}</p>
        </div>
        <div className="workspace-header-summary">{summary}</div>
      </header>

      {loading && !ready ? (
        <div className="loading-state">
          <LoaderCircle size={22} className="spin" />
          <span>正在加载工作台...</span>
        </div>
      ) : (
        <div
          key={navKey}
          className={`workspace-scroll workspace-page ${pageMotionPhase === "enter" ? "page-motion-enter" : ""}`.trim()}
        >
          {children}
        </div>
      )}
    </main>
  );
}
