import type {
  CodexRadarIntelligencePayload,
  CodexRadarModelIqPayload
} from "../../types";

export type CodexRadarStatusPresentation = {
  tone: "ready" | "warning" | "critical";
  label: "良好" | "关注" | "异常" | "未提供";
};

export type CodexRadarEffortPresentation = {
  tone: "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "unknown";
  label: string;
};

const CODEX_RADAR_EFFORT_PRESENTATIONS: Record<string, CodexRadarEffortPresentation> = {
  low: { tone: "low", label: "low" },
  medium: { tone: "medium", label: "medium" },
  high: { tone: "high", label: "high" },
  xhigh: { tone: "xhigh", label: "xhigh" },
  max: { tone: "max", label: "max" },
  ultra: { tone: "ultra", label: "ultra" }
};

export function getCodexRadarStatusPresentation(status?: string | null): CodexRadarStatusPresentation {
  if (status === "green") {
    return { tone: "ready", label: "良好" };
  }
  if (status === "yellow") {
    return { tone: "warning", label: "关注" };
  }
  if (!status) {
    return { tone: "warning", label: "未提供" };
  }
  return { tone: "critical", label: "异常" };
}

export function getCodexRadarEffortPresentation(value: string): CodexRadarEffortPresentation {
  const normalizedValue = value.trim().toLowerCase();
  return CODEX_RADAR_EFFORT_PRESENTATIONS[normalizedValue] ?? {
    tone: "unknown",
    label: value.trim() || "未知"
  };
}

export function getCodexRadarModelDisplayName(label: string, effort: string) {
  const normalizedLabel = label.trim();
  const normalizedEffort = effort.trim();
  if (!normalizedLabel || !normalizedEffort) {
    return normalizedLabel;
  }

  const suffix = ` ${normalizedEffort}`;
  return normalizedLabel.toLowerCase().endsWith(suffix.toLowerCase())
    ? normalizedLabel.slice(0, -suffix.length).trimEnd()
    : normalizedLabel;
}

// Radar 页面打开时，侧栏从同一智力效率快照投影 Top 5，避免独立刷新出现短暂分叉。
export function buildCodexRadarTopFiveFromIntelligence(
  payload: CodexRadarIntelligencePayload
): CodexRadarModelIqPayload {
  const items = payload.efficiencyPoints.flatMap((point) => {
    const averageCostUsd = point.averageCostUsd;
    if (
      typeof averageCostUsd !== "number" ||
      !Number.isFinite(averageCostUsd) ||
      !Number.isFinite(point.score) ||
      !Number.isFinite(point.passed)
    ) {
      return [];
    }

    return [{
      id: point.id,
      label: point.label,
      model: point.model,
      reasoningEffort: point.reasoningEffort,
      score: point.score,
      passed: point.passed,
      averageCostUsd,
      status: null,
      observedAt: point.observedAt
    }];
  });

  items.sort((left, right) =>
    right.score - left.score ||
    right.passed - left.passed ||
    left.averageCostUsd - right.averageCostUsd ||
    left.id.localeCompare(right.id)
  );

  return {
    items: items.slice(0, 5),
    sourceUpdatedAt: payload.sourceUpdatedAt,
    fetchedAt: payload.fetchedAt,
    lastError: payload.lastError ?? null,
    isStale: payload.isStale
  };
}
