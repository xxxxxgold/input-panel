import type { CSSProperties, ReactNode } from "react";

import { UsageDetailPopover } from "./UsageDetailPopover";
import { useAnimatedDisplayValue } from "../lib/motion";

export function MetricCard({
  label,
  value,
  hint,
  accent,
  icon,
  detailTitle,
  detail,
  detailPanelAlign = "start",
  className,
  style,
  animationKey
}: {
  label: string;
  value: string;
  hint: ReactNode;
  accent: "emerald" | "sky" | "violet" | "amber" | "indigo" | "rose";
  icon: ReactNode;
  detailTitle?: string;
  detail?: ReactNode;
  detailPanelAlign?: "start" | "end";
  className?: string;
  style?: CSSProperties;
  animationKey?: string;
}) {
  const animatedValue = useAnimatedDisplayValue(value, animationKey ?? `${label}:${value}`);
  const body = (
    <article className={`metric-card ${className ?? ""}`.trim()} style={style}>
      <div className={`metric-icon ${accent}`}>{icon}</div>
      <div>
        <p className="metric-label">{label}</p>
        <h3 className="metric-value">{animatedValue}</h3>
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
