import type { ReactNode } from "react";

export function AppShell({
  rail,
  railCollapsed,
  children
}: {
  rail: ReactNode;
  railCollapsed: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`app-shell ${railCollapsed ? "rail-collapsed" : ""}`}>
      {rail}
      {children}
    </div>
  );
}
