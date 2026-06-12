import { AlertTriangle, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

export function WorkspaceFrame({
  topbar,
  title,
  subtitle,
  summary,
  error,
  busyText,
  loading,
  ready,
  children
}: {
  topbar: ReactNode;
  title: string;
  subtitle: string;
  summary: ReactNode;
  error: string | null;
  busyText: string | null;
  loading: boolean;
  ready: boolean;
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

      {error && (
        <div className="inline-banner error">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      )}
      {busyText && (
        <div className="inline-banner info">
          <LoaderCircle size={16} className="spin" />
          <span>{busyText}</span>
        </div>
      )}

      {loading && !ready ? (
        <div className="loading-state">
          <LoaderCircle size={22} className="spin" />
          <span>正在加载工作台...</span>
        </div>
      ) : (
        <div className="workspace-scroll">{children}</div>
      )}
    </main>
  );
}
