import type { ReactNode } from "react";

export function AppShell({
  windowChrome,
  rail,
  railCollapsed,
  children
}: {
  windowChrome?: ReactNode;
  rail: ReactNode;
  railCollapsed: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`app-shell ${railCollapsed ? "rail-collapsed" : ""}`}>
      {windowChrome}
      <div className="app-shell-body">
        {rail}
        {children}
      </div>
    </div>
  );
}
