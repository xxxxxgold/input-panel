import { useId, type ReactNode } from "react";

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
  const panelId = useId();

  return (
    <div className="usage-detail-popover">
      <div
        className="usage-detail-trigger"
        title={title}
        role="button"
        tabIndex={0}
        aria-label={title}
        aria-describedby={panelId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.currentTarget.blur();
          }
        }}
      >
        {trigger}
      </div>
      <div id={panelId} className={`usage-detail-panel ${panelAlign === "end" ? "align-end" : ""}`.trim()}>
        <div className="usage-detail-panel-title">{title}</div>
        <div className="usage-detail-grid">{children}</div>
      </div>
    </div>
  );
}
