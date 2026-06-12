import type { ReactNode } from "react";

export function UsageDetailPopover({
  title,
  trigger,
  children,
  panelAlign = "start"
}: {
  title: string;
  trigger: ReactNode;
  children: ReactNode;
  panelAlign?: "start" | "end";
}) {
  return (
    <div className="usage-detail-popover">
      <div className="usage-detail-trigger" title={title}>
        {trigger}
      </div>
      <div className={`usage-detail-panel ${panelAlign === "end" ? "align-end" : ""}`.trim()}>
        <div className="usage-detail-panel-title">{title}</div>
        <div className="usage-detail-grid">{children}</div>
      </div>
    </div>
  );
}
