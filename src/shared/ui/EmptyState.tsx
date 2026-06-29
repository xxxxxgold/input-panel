import { Bell } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
  title,
  detail,
  compact = false,
  icon
}: {
  title: string;
  detail: string;
  compact?: boolean;
  icon?: ReactNode;
}) {
  return (
    <div className={`empty-state ${compact ? "compact" : ""}`}>
      {icon ?? <Bell size={compact ? 18 : 22} />}
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}
