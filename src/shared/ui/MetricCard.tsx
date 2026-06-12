import type { ReactNode } from "react";

import { UsageDetailPopover } from "./UsageDetailPopover";

export function MetricCard({
  label,
  value,
  hint,
  accent,
  icon,
  detailTitle,
  detail,
  detailPanelAlign = "start"
}: {
  label: string;
  value: string;
  hint: ReactNode;
  accent: "emerald" | "sky" | "violet" | "amber" | "indigo" | "rose";
  icon: ReactNode;
  detailTitle?: string;
  detail?: ReactNode;
  detailPanelAlign?: "start" | "end";
}) {
  const body = (
    <article className="metric-card">
      <div className={`metric-icon ${accent}`}>{icon}</div>
      <div>
        <p className="metric-label">{label}</p>
        <h3 className="metric-value">{value}</h3>
        <p className="metric-hint">{hint}</p>
      </div>
    </article>
  );

  if (!detail || !detailTitle) {
    return body;
  }

  return (
    <UsageDetailPopover title={detailTitle} trigger={body} panelAlign={detailPanelAlign}>
      {detail}
    </UsageDetailPopover>
  );
}
