import { getCodexRadarEffortPresentation } from "./codex-radar-presentation";

type CodexRadarEffortPillProps = {
  effort: string;
  className?: string;
};

export function CodexRadarEffortPill({ effort, className }: CodexRadarEffortPillProps) {
  const presentation = getCodexRadarEffortPresentation(effort);
  const classes = [
    "codex-radar-effort-pill",
    `effort-${presentation.tone}`,
    className
  ].filter(Boolean).join(" ");

  return (
    <span className={classes} title={`推理强度 ${presentation.label}`}>
      {presentation.label}
    </span>
  );
}
