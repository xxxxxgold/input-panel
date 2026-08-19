import type { ReactNode } from "react";

import { TitleHint } from "./TitleHint";

export function SectionCard({
  title,
  subtitle,
  children,
  actions
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="section-card">
      <header className="section-card-header">
        <div>
          <div className="title-with-hint">
            <h3>{title}</h3>
            {subtitle ? <TitleHint content={subtitle} label={`查看${title}说明`} /> : null}
          </div>
        </div>
        {actions && <div className="section-card-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}
