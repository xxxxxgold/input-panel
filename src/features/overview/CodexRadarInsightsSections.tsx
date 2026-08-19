import {
  Bot,
  BrainCircuit,
  CircleAlert,
  Code2,
  Info,
  RefreshCcw,
  TriangleAlert,
  Workflow,
  type LucideIcon
} from "lucide-react";

import type {
  CodexRadarDegradationAlert,
  CodexRadarInsightsPayload,
  CodexRadarInsightsTrendPoint,
  CodexRadarRecommendationGroup
} from "../../types";
import { formatTime } from "../../shared/lib/formatters";
import { EmptyState } from "../../shared/ui/EmptyState";
import { SectionCard } from "../../shared/ui/SectionCard";
import { CodexRadarEffortPill } from "./CodexRadarEffortPill";
import { formatCodexRadarNumber } from "./codex-radar-intelligence";
import { getCodexRadarModelDisplayName } from "./codex-radar-presentation";
import type { CodexRadarInsightsPresentationState } from "./useCodexRadarInsightsWorkspace";

type CodexRadarInsightsSectionsProps = {
  payload: CodexRadarInsightsPayload | null;
  presentation: CodexRadarInsightsPresentationState;
  onRefresh: () => Promise<void>;
};

const RECOMMENDATION_ICONS: Record<string, LucideIcon> = {
  daily_development: Code2,
  hard_problems: BrainCircuit,
  background_automation: Bot,
  lobster_tasks: Workflow
};

export function CodexRadarInsightsSections({
  payload,
  presentation,
  onRefresh
}: CodexRadarInsightsSectionsProps) {
  const busy = presentation.initialLoading || presentation.refreshing;
  const action = (
    <button
      type="button"
      className={`ghost-button ${presentation.refreshing ? "is-refreshing" : ""}`.trim()}
      onClick={() => void onRefresh()}
      disabled={busy}
      aria-busy={busy || undefined}
    >
      <RefreshCcw size={16} aria-hidden="true" />
      {presentation.refreshing
        ? "刷新中"
        : payload || presentation.lastError
          ? "刷新推荐与预警"
          : "读取推荐与预警"}
    </button>
  );

  return (
    <>
      <SectionCard
        title="任务推荐"
        subtitle="根据最新分布式众测结果，按使用场景给出实用选择"
        actions={action}
      >
        <InsightsSnapshotStatus payload={payload} presentation={presentation} />
        {payload ? (
          payload.recommendations.length > 0 ? (
            <div className="codex-radar-recommendation-groups">
              {payload.recommendations.map((group) => (
                <RecommendationGroup key={group.key} group={group} />
              ))}
            </div>
          ) : (
            <EmptyState
              title="当前没有任务推荐"
              detail="数据源已返回快照，但其中没有可展示的推荐条目。"
              compact
              icon={<BrainCircuit size={18} />}
            />
          )
        ) : (
          <InsightsEmptyState presentation={presentation} />
        )}
      </SectionCard>

      {payload?.degradationAlerts.length ? (
        <SectionCard
          title="降智预警"
          subtitle={payload.degradationRule}
          actions={action}
        >
          <InsightsSnapshotStatus payload={payload} presentation={presentation} />
          <div className="codex-radar-degradation-alerts">
            {payload.degradationAlerts.map((alert) => (
              <DegradationAlert key={alert.id} alert={alert} />
            ))}
          </div>
        </SectionCard>
      ) : null}
    </>
  );
}

function RecommendationGroup({ group }: { group: CodexRadarRecommendationGroup }) {
  const Icon = RECOMMENDATION_ICONS[group.key] ?? BrainCircuit;

  return (
    <section className="codex-radar-recommendation-group" aria-labelledby={`recommendation-${group.key}`}>
      <header>
        <span className="codex-radar-recommendation-icon" aria-hidden="true">
          <Icon size={16} />
        </span>
        <h4 id={`recommendation-${group.key}`}>{group.title}</h4>
        <span
          className="codex-radar-insights-rule-help"
          aria-label={`${group.title}规则`}
          aria-describedby={`recommendation-rule-${group.key}`}
          tabIndex={0}
        >
          <Info size={14} aria-hidden="true" />
          <span
            id={`recommendation-rule-${group.key}`}
            className="codex-radar-insights-rule-tooltip"
            role="tooltip"
          >
            {group.rule}
          </span>
        </span>
      </header>
      <div className="codex-radar-recommendation-items">
        {group.items.map((item) => (
          <article key={item.id} className="codex-radar-recommendation-item">
            <div className="codex-radar-recommendation-model">
              <strong>{formatModelName(item.model, item.reasoningEffort)}</strong>
              <CodexRadarEffortPill effort={item.reasoningEffort} />
              {item.slot ? <span className="codex-radar-recommendation-slot">{formatSlot(item.slot)}</span> : null}
            </div>
            <dl className="codex-radar-recommendation-metrics">
              <div><dt>IQ</dt><dd>{formatCodexRadarNumber(item.score)}</dd></div>
              <div><dt>费用</dt><dd>{formatUsd(item.averageCostUsd)}</dd></div>
              <div><dt>耗时</dt><dd>{formatMinutes(item.averageMinutes)}</dd></div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}

function DegradationAlert({ alert }: { alert: CodexRadarDegradationAlert }) {
  return (
    <article className="codex-radar-degradation-alert">
      <header>
        <span className="codex-radar-degradation-icon" aria-hidden="true">
          <TriangleAlert size={16} />
        </span>
        <strong>{formatModelName(alert.model, alert.reasoningEffort)}</strong>
        <CodexRadarEffortPill effort={alert.reasoningEffort} />
      </header>
      <div className="codex-radar-degradation-body">
        <div className="codex-radar-degradation-score">
          <span>当前 IQ</span>
          <strong>{formatCodexRadarNumber(alert.score)}</strong>
        </div>
        <TrendSparkline points={alert.trend} />
      </div>
      <dl className="codex-radar-degradation-metrics">
        <div><dt>较 24h 均值</dt><dd>{formatDelta(alert.dropFrom24hAverage)}</dd></div>
        <div><dt>较 48h 均值</dt><dd>{formatDelta(alert.dropFrom48hAverage)}</dd></div>
        <div><dt>12h 下降</dt><dd>{formatDelta(alert.drop12h)}</dd></div>
      </dl>
    </article>
  );
}

function TrendSparkline({ points }: { points: CodexRadarInsightsTrendPoint[] }) {
  const width = 160;
  const height = 40;
  const padding = 2;
  const scores = points.map((point) => point.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  const plot = points.map((point, index) => ({
    x: points.length === 1 ? width / 2 : padding + (index / (points.length - 1)) * (width - padding * 2),
    y: padding + ((max - point.score) / range) * (height - padding * 2)
  }));
  const polyline = plot.map((point) => `${point.x},${point.y}`).join(" ");

  return (
    <svg
      className="codex-radar-insights-sparkline"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="48 小时 IQ 趋势"
    >
      <title>48 小时 IQ 趋势</title>
      {plot.length > 1 ? (
        <polyline points={polyline} fill="none" vectorEffect="non-scaling-stroke" />
      ) : plot.length === 1 ? (
        <circle cx={plot[0].x} cy={plot[0].y} r="2" />
      ) : (
        <line x1="2" y1="20" x2="158" y2="20" vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );
}

function InsightsSnapshotStatus({
  payload,
  presentation
}: {
  payload: CodexRadarInsightsPayload | null;
  presentation: CodexRadarInsightsPresentationState;
}) {
  return (
    <>
      {payload && presentation.lastError ? (
        <div className="workspace-refresh-status has-error codex-radar-sync-status" role="alert" aria-live="assertive">
          <CircleAlert size={14} aria-hidden="true" />
          <span>{`刷新失败, 当前展示上次同步数据: ${presentation.lastError}`}</span>
        </div>
      ) : null}
      {payload ? (
        <div className="codex-radar-meta" aria-label="推荐与预警数据时间">
          <span>{`源数据 ${formatTime(payload.sourceUpdatedAt)}`}</span>
          <span>{`本地获取 ${formatTime(payload.fetchedAt)}`}</span>
          <span className={`status-pill ${presentation.isStale ? "warning" : "ready"}`}>
            {presentation.isStale ? "上次同步数据" : "最新快照"}
          </span>
        </div>
      ) : null}
    </>
  );
}

function InsightsEmptyState({ presentation }: { presentation: CodexRadarInsightsPresentationState }) {
  if (presentation.initialLoading) {
    return (
      <EmptyState
        title="正在读取任务推荐"
        detail="正在通过本地服务读取 Codex 雷达推荐与预警数据。"
        compact
        icon={<BrainCircuit size={18} />}
      />
    );
  }
  if (presentation.lastError) {
    return (
      <EmptyState
        title="任务推荐读取失败"
        detail={presentation.lastError}
        compact
        icon={<CircleAlert size={18} />}
      />
    );
  }
  return (
    <EmptyState
      title="当前没有任务推荐"
      detail="本地服务尚未返回可展示的推荐与预警快照。"
      compact
      icon={<BrainCircuit size={18} />}
    />
  );
}

function formatSlot(slot: string) {
  const labels: Record<string, string> = {
    value: "性价比位",
    smart: "聪明位"
  };
  return labels[slot] ?? slot;
}

function formatModelName(model: string, effort: string) {
  return getCodexRadarModelDisplayName(model, effort)
    .replace(/^gpt-/i, "GPT-")
    .replace(/-/g, " ");
}

function formatUsd(value: number | null | undefined) {
  return value === null || value === undefined ? "-" : `$${formatCodexRadarNumber(value, 2)}`;
}

function formatMinutes(value: number | null | undefined) {
  return value === null || value === undefined ? "-" : `${formatCodexRadarNumber(value, 1)} 分钟`;
}

function formatDelta(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return "-";
  }
  const normalized = value > 0 ? -value : value;
  return formatCodexRadarNumber(normalized, 1);
}
