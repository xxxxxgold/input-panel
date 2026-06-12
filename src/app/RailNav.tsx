import { ChevronRight, MonitorDot } from "lucide-react";

import type { NavKey } from "../types";
import { NAV_ITEMS } from "./navigation";

export function RailNav({
  nav,
  isRailExpanded,
  railToggleTitle,
  onOpenOverview,
  onToggleRail,
  onNavChange,
  theme,
  setTheme,
  projectLogo
}: {
  nav: NavKey;
  isRailExpanded: boolean;
  railToggleTitle: string;
  onOpenOverview: () => void;
  onToggleRail: () => void;
  onNavChange: (key: NavKey) => void;
  theme: "light" | "dark" | "deep-blue";
  setTheme: (theme: "light" | "dark" | "deep-blue") => void;
  projectLogo: string;
}) {
  return (
    <aside className={`rail ${isRailExpanded ? "expanded" : ""}`}>
      <button className="brand-button" title="Input面板" aria-label="Input面板" onClick={onOpenOverview}>
        <span className="brand-glyph brand-logo-shell" aria-hidden="true">
          <img className="brand-logo" src={projectLogo} alt="" />
        </span>
        {isRailExpanded && (
          <span className="brand-copy">
            <span className="eyebrow">INPUT PANEL</span>
            <strong>Input面板</strong>
          </span>
        )}
      </button>
      <button
        className={`rail-item rail-toggle ${isRailExpanded ? "open" : ""}`}
        onClick={onToggleRail}
        title={railToggleTitle}
        aria-label={railToggleTitle}
        aria-expanded={isRailExpanded}
      >
        <ChevronRight size={18} />
        {isRailExpanded && <span className="rail-item-label">导航</span>}
      </button>
      <div className="rail-stack">
        {NAV_ITEMS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            className={`rail-item ${nav === key ? "active" : ""}`}
            onClick={() => onNavChange(key)}
            title={label}
            aria-label={label}
          >
            <Icon size={18} />
            {isRailExpanded && <span className="rail-item-label">{label}</span>}
          </button>
        ))}
      </div>
      <div className="rail-stack rail-bottom">
        <button
          className="rail-item"
          onClick={() => {
            setTheme(theme === "deep-blue" ? "light" : theme === "light" ? "dark" : "deep-blue");
          }}
          title="切换主题"
          aria-label="切换主题"
        >
          <MonitorDot size={18} />
          {isRailExpanded && <span className="rail-item-label">切换主题</span>}
        </button>
      </div>
    </aside>
  );
}
