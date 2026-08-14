import { CircleAlert, CircleCheck, Coins, Gauge, Radar, RefreshCcw, Timer, Zap } from "lucide-react";
import { useMemo, useState } from "react";

import { EChartCard, readChartPalette } from "../charts";
import type {
  CodexRadarFastRadarPayload,
  CodexRadarInsightsPayload,
  CodexRadarIntelligencePayload,
  CodexRadarModelIqPayload
} from "../types";
import type { CodexRadarPresentationState } from "../features/overview/useCodexRadarWorkspace";
import type { CodexRadarFastPresentationState } from "../features/overview/useCodexRadarFastWorkspace";
import type { CodexRadarInsightsPresentationState } from "../features/overview/useCodexRadarInsightsWorkspace";
import type { CodexRadarIntelligencePresentationState } from "../features/overview/useCodexRadarIntelligenceWorkspace";
import { CodexRadarEffortPill } from "../features/overview/CodexRadarEffortPill";
import { CodexRadarInsightsSections } from "../features/overview/CodexRadarInsightsSections";
import {
  buildCodexRadarCostIqOption,
  buildCodexRadarIntelligenceRows,
  buildCodexRadarTrendOption,
  CODEX_RADAR_TREND_METRICS,
  compareCodexRadarModelFamilies,
  formatCodexRadarNumber,
  getCodexRadarCacheHitRate,
  getCodexRadarTrendMetricMeta,
  getCodexRadarTrendWindow,
  type CodexRadarTrendMetric
} from "../features/overview/codex-radar-intelligence";
import {
  getCodexRadarModelDisplayName,
  getCodexRadarStatusPresentation
} from "../features/overview/codex-radar-presentation";
import { compact, formatTime } from "../shared/lib/formatters";
import { EmptyState } from "../shared/ui/EmptyState";
import { MetricCard } from "../shared/ui/MetricCard";
import { SectionCard } from "../shared/ui/SectionCard";
import "./CodexRadarPage.css";

type CodexRadarPageBaseProps = {
  payload: CodexRadarModelIqPayload | null;
  presentation: CodexRadarPresentationState;
  onRefresh: () => Promise<void>;
};

type CodexRadarPageProps = CodexRadarPageBaseProps & {
  intelligencePayload: CodexRadarIntelligencePayload | null;
  intelligencePresentation: CodexRadarIntelligencePresentationState;
  onRefreshIntelligence: () => Promise<void>;
  insightsPayload: CodexRadarInsightsPayload | null;
  insightsPresentation: CodexRadarInsightsPresentationState;
  onRefreshInsights: () => Promise<void>;
  fastPayload: CodexRadarFastRadarPayload | null;
  fastPresentation: CodexRadarFastPresentationState;
  onRefreshFast: () => Promise<void>;
};

export function CodexRadarPage(props: CodexRadarPageProps) {
  return <CodexRadarPageContent {...props} />;
}

export function CodexRadarPageContent({
  payload,
  presentation,
  onRefresh,
  intelligencePayload,
  intelligencePresentation,
  onRefreshIntelligence,
  insightsPayload,
  insightsPresentation,
  onRefreshInsights,
  fastPayload,
  fastPresentation,
  onRefreshFast
}: CodexRadarPageProps) {
  const [trendMetric, setTrendMetric] = useState<CodexRadarTrendMetric>("iq");
  const topItems = (payload?.items ?? []).slice(0, 5);
  const intelligenceRows = useMemo(
    () => buildCodexRadarIntelligenceRows(intelligencePayload),
    [intelligencePayload]
  );
  const points = intelligencePayload?.efficiencyPoints ?? [];
  const detailItems = intelligencePayload?.detailItems ?? [];
  const fastItems = useMemo(
    () => [...(fastPayload?.items ?? [])].sort((left, right) => compareCodexRadarModelFamilies(left.model, right.model)),
    [fastPayload]
  );
  const pointGroups = useMemo(() => groupPointsByModel(intelligenceRows), [intelligenceRows]);
  const chartPalette = readChartPalette();
  const costIqOption = useMemo(
    () => buildCodexRadarCostIqOption(points, chartPalette),
    [points, chartPalette]
  );
  const trendOption = useMemo(
    () => buildCodexRadarTrendOption(detailItems, trendMetric, chartPalette),
    [detailItems, trendMetric, chartPalette]
  );
  const trendWindow = useMemo(() => getCodexRadarTrendWindow(detailItems), [detailItems]);
  const top5Busy = presentation.initialLoading || presentation.refreshing;
  const intelligenceBusy = intelligencePresentation.initialLoading || intelligencePresentation.refreshing;
  const fastBusy = fastPresentation.initialLoading || fastPresentation.refreshing;
  const leadingPoint = findPoint(points, (point) => point.score);
  const lowestCostPoint = findPoint(points, (point) => point.averageCostUsd ?? Number.POSITIVE_INFINITY, "min");
  const fastestPoint = findPoint(points, (point) => point.averageMinutes ?? Number.POSITIVE_INFINITY, "min");
  const bestValuePoint = findPoint(
    points.filter((point) => (point.averageCostUsd ?? 0) > 0),
    (point) => point.score / (point.averageCostUsd ?? 1)
  );
  const measuredModelCount = new Set(points.map((point) => point.model)).size;
  const highestPassedPoint = findPoint(points, (point) => point.passed);
  const secondLowestCostPoint = findRankedPoint(
    points,
    (point) => point.averageCostUsd ?? Number.POSITIVE_INFINITY,
    1,
    "min"
  );
  const secondFastestPoint = findRankedPoint(
    points,
    (point) => point.averageMinutes ?? Number.POSITIVE_INFINITY,
    1,
    "min"
  );

  return (
    <section className="codex-radar-view motion-shell-section" aria-label="降智雷达模型测评">
      <div className="metric-grid compact-metrics motion-stagger-grid codex-radar-metric-grid">
        <MetricCard
          label="榜首 IQ"
          value={leadingPoint ? formatCodexRadarNumber(leadingPoint.score) : "-"}
          hint={leadingPoint ? leadingPoint.label : "等待智力检测快照"}
          accent="sky"
          icon={<Gauge size={18} />}
          animationKey={`codex-radar-leader:${leadingPoint?.id ?? "empty"}:${leadingPoint?.score ?? "-"}`}
        />
        <MetricCard
          label="最低任务费"
          value={formatRadarUsd(lowestCostPoint?.averageCostUsd)}
          hint={lowestCostPoint ? lowestCostPoint.label : "等待费用数据"}
          accent="emerald"
          icon={<Coins size={18} />}
          animationKey={`codex-radar-cost:${lowestCostPoint?.id ?? "empty"}`}
        />
        <MetricCard
          label="最快完成"
          value={formatMinutes(fastestPoint?.averageMinutes)}
          hint={fastestPoint ? fastestPoint.label : "等待耗时数据"}
          accent="amber"
          icon={<Timer size={18} />}
          animationKey={`codex-radar-duration:${fastestPoint?.id ?? "empty"}`}
        />
        <MetricCard
          label="最佳 IQ / 美元"
          value={bestValuePoint ? formatCodexRadarNumber(bestValuePoint.score / (bestValuePoint.averageCostUsd ?? 1)) : "-"}
          hint={bestValuePoint ? bestValuePoint.label : "等待效率数据"}
          accent="violet"
          icon={<Zap size={18} />}
          animationKey={`codex-radar-value:${bestValuePoint?.id ?? "empty"}`}
        />
        <MetricCard
          label="已测模型"
          value={measuredModelCount > 0 ? measuredModelCount.toLocaleString() : "-"}
          hint={points.length > 0 ? `${points.length} 个模型 / 强度档位` : "等待智力检测快照"}
          accent="sky"
          icon={<Radar size={18} />}
          animationKey={`codex-radar-model-count:${measuredModelCount}:${points.length}`}
        />
        <MetricCard
          label="最高通过数"
          value={highestPassedPoint ? `${formatCodexRadarNumber(highestPassedPoint.passed)} 项` : "-"}
          hint={highestPassedPoint ? highestPassedPoint.label : "等待通过任务数据"}
          accent="violet"
          icon={<CircleCheck size={18} />}
          animationKey={`codex-radar-highest-passed:${highestPassedPoint?.id ?? "empty"}:${highestPassedPoint?.passed ?? "-"}`}
        />
        <MetricCard
          label="任务费次低"
          value={formatRadarUsd(secondLowestCostPoint?.averageCostUsd)}
          hint={secondLowestCostPoint ? secondLowestCostPoint.label : "等待第二个费用条目"}
          accent="emerald"
          icon={<Coins size={18} />}
          animationKey={`codex-radar-second-lowest-cost:${secondLowestCostPoint?.id ?? "empty"}`}
        />
        <MetricCard
          label="完成次快"
          value={formatMinutes(secondFastestPoint?.averageMinutes)}
          hint={secondFastestPoint ? secondFastestPoint.label : "等待第二个耗时条目"}
          accent="amber"
          icon={<Timer size={18} />}
          animationKey={`codex-radar-second-fastest:${secondFastestPoint?.id ?? "empty"}`}
        />
      </div>

      <CodexRadarInsightsSections
        payload={insightsPayload}
        presentation={insightsPresentation}
        onRefresh={onRefreshInsights}
      />

      <SectionCard
        title="Fast 雷达"
        subtitle="Standard 与 Fast 的端到端耗时、首字延迟和 Token 生成速度对比"
        actions={
          <div className="codex-radar-header-actions">
            {fastPayload ? (
              <CodexRadarSnapshotMeta
                ariaLabel="Fast 雷达数据时间"
                sourceText={`源数据 ${fastPayload.sourceUpdatedAt}`}
                fetchedAt={fastPayload.fetchedAt}
                isStale={fastPresentation.isStale}
              />
            ) : null}
            <button
              type="button"
              className={`ghost-button ${fastPresentation.refreshing ? "is-refreshing" : ""}`.trim()}
              onClick={() => void onRefreshFast()}
              disabled={fastBusy}
              aria-busy={fastBusy || undefined}
            >
              <RefreshCcw size={16} aria-hidden="true" />
              {fastPresentation.refreshing ? "刷新中" : fastPayload || fastPresentation.lastError ? "刷新 Fast 雷达" : "读取 Fast 雷达"}
            </button>
          </div>
        }
      >
        {fastPayload && fastPresentation.lastError ? (
          <div className="workspace-refresh-status has-error codex-radar-sync-status" role="alert" aria-live="assertive">
            <CircleAlert size={14} aria-hidden="true" />
            <span>{`刷新失败, 当前展示上次同步数据: ${fastPresentation.lastError}`}</span>
          </div>
        ) : null}
        {fastPayload ? (
          <>
            <div className="codex-radar-fast-summary" aria-label="Fast 模式速览">
              <article>
                <span>成本</span>
                <strong>{`${formatCodexRadarNumber(fastPayload.summary.costMultiplier, 2)} 倍`}</strong>
              </article>
              <article>
                <span>体感加速</span>
                <strong>{`${formatCodexRadarNumber(fastPayload.summary.e2eMultiplier, 3)} 倍`}</strong>
              </article>
              <article>
                <span>首字延迟减少</span>
                <strong>{`${formatCodexRadarNumber(fastPayload.summary.ttftDeltaSeconds, 2)} 秒`}</strong>
              </article>
              <article>
                <span>Token 生成速度</span>
                <strong>{`${formatCodexRadarNumber(fastPayload.summary.tpsMultiplier, 3)} 倍`}</strong>
              </article>
            </div>
            <div className="usage-table-wrap">
              <table className="usage-table codex-radar-fast-table">
                <thead>
                  <tr>
                    <th>模型</th>
                    <th>Standard → Fast E2E</th>
                    <th>体感加速</th>
                    <th>Standard → Fast TTFT</th>
                    <th>首字变化</th>
                    <th>Standard → Fast TPS</th>
                    <th>Token 加速</th>
                  </tr>
                </thead>
                <tbody>
                  {fastItems.map((item, index) => (
                    <tr key={item.model} className="usage-row-motion" style={{ ["--motion-order" as string]: index }}>
                      <td><strong>{item.model}</strong></td>
                      <td>{formatFastPair(item.standardE2eSeconds, item.fastE2eSeconds, "s")}</td>
                      <td><strong className="codex-radar-score">{`${formatCodexRadarNumber(item.e2eMultiplier, 3)}×`}</strong></td>
                      <td>{formatFastPair(item.standardTtftSeconds, item.fastTtftSeconds, "s")}</td>
                      <td>{item.ttftChangeLabel}</td>
                      <td>{formatFastPair(item.standardTps, item.fastTps)}</td>
                      <td><strong className="codex-radar-score">{`${formatCodexRadarNumber(item.tpsMultiplier, 3)}×`}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <EmptyState
            title={resolveFastEmptyState(fastPresentation).title}
            detail={resolveFastEmptyState(fastPresentation).detail}
            compact
            icon={<Zap size={18} />}
          />
        )}
      </SectionCard>

      <SectionCard
        title="智力检测"
        subtitle="全部模型与推理强度的 IQ、费用和耗时快照"
        actions={
          <div className="codex-radar-header-actions">
            {intelligencePayload ? (
              <CodexRadarSnapshotMeta
                ariaLabel="智力检测数据时间"
                sourceText={`源数据更新 ${formatTime(intelligencePayload.sourceUpdatedAt)}`}
                fetchedAt={intelligencePayload.fetchedAt}
                isStale={intelligencePresentation.isStale}
              />
            ) : null}
            <button
              type="button"
              className={`ghost-button ${intelligencePresentation.refreshing ? "is-refreshing" : ""}`.trim()}
              onClick={() => void onRefreshIntelligence()}
              disabled={intelligenceBusy}
              aria-busy={intelligenceBusy || undefined}
            >
              <RefreshCcw size={16} aria-hidden="true" />
              {intelligencePresentation.refreshing ? "刷新中" : intelligencePayload || intelligencePresentation.lastError ? "刷新智力检测" : "读取智力检测"}
            </button>
          </div>
        }
      >
        {intelligencePayload && intelligencePresentation.lastError ? (
          <div className="workspace-refresh-status has-error codex-radar-sync-status" role="alert" aria-live="assertive">
            <CircleAlert size={14} aria-hidden="true" />
            <span>{`刷新失败, 当前展示上次同步数据: ${intelligencePresentation.lastError}`}</span>
          </div>
        ) : null}
        {intelligencePayload ? (
          <>
            <div className="codex-radar-efficiency-groups" aria-label="模型智力检测矩阵">
              {pointGroups.map(([model, rows]) => (
                <section key={model} className="codex-radar-efficiency-group" aria-label={`${formatModelFamily(model)} 智力检测`}>
                  <header>
                    <strong>{formatModelFamily(model)}</strong>
                    <span>{`${rows.length} 个强度`}</span>
                  </header>
                  <div className="codex-radar-efficiency-grid">
                    {rows.map(({ point }) => (
                      <article key={point.id} className="codex-radar-efficiency-cell">
                        <div className="codex-radar-efficiency-cell-head">
                          <CodexRadarEffortPill effort={point.reasoningEffort} />
                          <strong>{`IQ ${formatCodexRadarNumber(point.score)}`}</strong>
                        </div>
                        <div className="codex-radar-efficiency-cell-metrics">
                          <span>{formatRadarUsd(point.averageCostUsd)}</span>
                          <span>{formatMinutes(point.averageMinutes)}</span>
                        </div>
                        <small>{`通过 ${point.passed} / ${point.validTasks}`}</small>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        ) : (
          <EmptyState
            title={resolveIntelligenceEmptyState(intelligencePresentation).title}
            detail={resolveIntelligenceEmptyState(intelligencePresentation).detail}
            compact
            icon={<Radar size={18} />}
          />
        )}
      </SectionCard>

      {intelligencePayload ? (
        <div className="codex-radar-chart-grid">
          <SectionCard
            title="综合成本 × IQ"
            subtitle="横轴为来源综合成本指数，对数刻度保留不同强度的可比性"
          >
            <div className="chart-wrap tall codex-radar-chart-shell">
              <EChartCard option={costIqOption} />
            </div>
          </SectionCard>
          <SectionCard
            title="详细快照趋势"
            subtitle={trendWindow
              ? `${formatTime(trendWindow.start)} 至 ${formatTime(trendWindow.end)} · ${trendWindow.count} 个源时间点`
              : "当前没有可用的详细历史快照"}
          >
            <div className="codex-radar-segmented" role="tablist" aria-label="详细快照趋势指标">
              {CODEX_RADAR_TREND_METRICS.map((metric) => {
                const meta = getCodexRadarTrendMetricMeta(metric);
                return (
                  <button
                    key={metric}
                    type="button"
                    role="tab"
                    aria-selected={trendMetric === metric}
                    className={trendMetric === metric ? "is-active" : undefined}
                    onClick={() => setTrendMetric(metric)}
                  >
                    {meta.label}
                  </button>
                );
              })}
            </div>
            <div className="chart-wrap tall codex-radar-chart-shell">
              <EChartCard option={trendOption} />
            </div>
          </SectionCard>
        </div>
      ) : null}

      <SectionCard
        title="IQ Top 5"
        subtitle={payload ? "稳定排序的模型测评快照" : "模型 IQ、通过数与单任务平均费用"}
        actions={
          <div className="codex-radar-header-actions">
            {payload ? (
              <CodexRadarSnapshotMeta
                ariaLabel="降智雷达数据时间"
                sourceText={`源数据更新 ${formatTime(payload.sourceUpdatedAt)}`}
                fetchedAt={payload.fetchedAt}
                isStale={presentation.isStale}
              />
            ) : null}
            <button
              type="button"
              className={`ghost-button ${presentation.refreshing ? "is-refreshing" : ""}`.trim()}
              onClick={() => void onRefresh()}
              disabled={top5Busy}
              aria-busy={top5Busy || undefined}
            >
              <RefreshCcw size={16} aria-hidden="true" />
              {presentation.refreshing ? "刷新中" : payload || presentation.lastError ? "重新读取" : "读取数据"}
            </button>
          </div>
        }
      >
        {payload && presentation.lastError ? (
          <div className="workspace-refresh-status has-error codex-radar-sync-status" role="alert" aria-live="assertive">
            <CircleAlert size={14} aria-hidden="true" />
            <span>{`刷新失败, 当前展示上次同步数据: ${presentation.lastError}`}</span>
          </div>
        ) : null}
        {topItems.length > 0 ? (
          <div className="usage-table-wrap">
            <table className="usage-table codex-radar-table">
              <thead>
                <tr>
                  <th>排名</th>
                  <th>模型档位</th>
                  <th>IQ</th>
                  <th>通过数</th>
                  <th>单任务费用</th>
                  <th>状态</th>
                  <th>观测时间</th>
                </tr>
              </thead>
              <tbody>
                {topItems.map((item, index) => {
                  const status = getCodexRadarStatusPresentation(item.status);
                  return (
                    <tr key={item.id} className="usage-row-motion" style={{ ["--motion-order" as string]: index }}>
                      <td><strong className="codex-radar-rank">#{index + 1}</strong></td>
                      <td>
                        <div className="usage-cell usage-cell-primary">
                          <div className="codex-radar-model-title">
                            <strong>{getCodexRadarModelDisplayName(item.label, item.reasoningEffort)}</strong>
                            <CodexRadarEffortPill effort={item.reasoningEffort} />
                          </div>
                        </div>
                      </td>
                      <td><strong className="codex-radar-score">{formatCodexRadarNumber(item.score)}</strong></td>
                      <td>{item.passed.toLocaleString()}</td>
                      <td><strong className="codex-radar-cost">{formatRadarUsd(item.averageCostUsd)}</strong></td>
                      <td><span className={`status-pill ${status.tone}`}>{status.label}</span></td>
                      <td>{formatTime(item.observedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title={resolveTop5EmptyState(presentation).title}
            detail={resolveTop5EmptyState(presentation).detail}
            compact
            icon={<Radar size={18} />}
          />
        )}
      </SectionCard>

      {intelligencePayload ? (
        <SectionCard
          title="模型 / 强度详细指标"
          actions={<p className="codex-radar-detail-header-note">全部智力效率档位；资源字段仅显示来源实际返回的数据</p>}
        >
          <div className="usage-table-wrap">
            <table className="usage-table codex-radar-detail-table">
              <thead>
                <tr>
                  <th>模型档位</th>
                  <th>IQ</th>
                  <th>通过 / 有效</th>
                  <th>平均费用</th>
                  <th>平均耗时</th>
                  <th>综合成本</th>
                  <th>输入 Token</th>
                  <th>缓存输入</th>
                  <th>输出 Token</th>
                  <th>总 Token</th>
                  <th>总耗时</th>
                  <th>缓存命中率</th>
                </tr>
              </thead>
              <tbody>
                {intelligenceRows.map(({ point, detail }, index) => {
                  const cacheHitRate = getCodexRadarCacheHitRate(detail?.inputTokens, detail?.cachedInputTokens);
                  return (
                    <tr key={point.id} className="usage-row-motion" style={{ ["--motion-order" as string]: index }}>
                      <td>
                        <div className="usage-cell usage-cell-primary">
                          <div className="codex-radar-model-title">
                            <strong>{getCodexRadarModelDisplayName(point.label, point.reasoningEffort)}</strong>
                            <CodexRadarEffortPill effort={point.reasoningEffort} />
                          </div>
                        </div>
                      </td>
                      <td><strong className="codex-radar-score">{formatCodexRadarNumber(point.score)}</strong></td>
                      <td>{`${point.passed} / ${point.validTasks}`}</td>
                      <td>{formatRadarUsd(point.averageCostUsd)}</td>
                      <td>{formatMinutes(point.averageMinutes)}</td>
                      <td>{formatCostIndex(point.combinedCostIndex)}</td>
                      <td>{formatDetailNumber(detail?.inputTokens)}</td>
                      <td>{formatDetailNumber(detail?.cachedInputTokens)}</td>
                      <td>{formatDetailNumber(detail?.outputTokens)}</td>
                      <td>{formatDetailNumber(detail?.totalTokens)}</td>
                      <td>{formatSeconds(detail?.wallSeconds)}</td>
                      <td>{cacheHitRate === null ? "-" : formatRadarPercent(cacheHitRate)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="codex-radar-source codex-radar-detail-source">数据来自 Codex 雷达</p>
        </SectionCard>
      ) : null}
    </section>
  );
}

function groupPointsByModel(rows: ReturnType<typeof buildCodexRadarIntelligenceRows>) {
  const groups = new Map<string, ReturnType<typeof buildCodexRadarIntelligenceRows>>();
  for (const row of rows) {
    const entries = groups.get(row.point.model) ?? [];
    entries.push(row);
    groups.set(row.point.model, entries);
  }
  return [...groups.entries()];
}

function CodexRadarSnapshotMeta({
  ariaLabel,
  sourceText,
  fetchedAt,
  isStale
}: {
  ariaLabel: string;
  sourceText: string;
  fetchedAt: string;
  isStale: boolean;
}) {
  return (
    <div className="codex-radar-meta codex-radar-header-meta" aria-label={ariaLabel}>
      <span>{sourceText}</span>
      <span>{`本地获取 ${formatTime(fetchedAt)}`}</span>
      <span className={`status-pill ${isStale ? "warning" : "ready"}`}>
        {isStale ? "上次同步数据" : "最新快照"}
      </span>
    </div>
  );
}

function findPoint<T extends { id: string }>(
  points: T[],
  value: (point: T) => number,
  direction: "max" | "min" = "max"
) {
  return points.reduce<T | null>((best, point) => {
    const candidateValue = value(point);
    if (!Number.isFinite(candidateValue)) {
      return best;
    }
    if (!best) {
      return point;
    }
    const bestValue = value(best);
    return direction === "max" ? candidateValue > bestValue ? point : best : candidateValue < bestValue ? point : best;
  }, null);
}

function findRankedPoint<T extends { id: string }>(
  points: T[],
  value: (point: T) => number,
  rank: number,
  direction: "max" | "min" = "max"
) {
  return points
    .filter((point) => Number.isFinite(value(point)))
    .sort((left, right) => {
      const difference = value(left) - value(right);
      return direction === "max" ? -difference : difference;
    })[rank] ?? null;
}

function formatModelFamily(model: string) {
  return model.replace(/^gpt-/i, "GPT-").replace(/-/g, " ");
}

function formatMinutes(value: number | null | undefined) {
  return value === null || value === undefined ? "-" : `${formatCodexRadarNumber(value)} 分钟`;
}

function formatCostIndex(value: number | null | undefined) {
  return value === null || value === undefined ? "-" : formatCodexRadarNumber(value, 4);
}

function formatRadarUsd(value: number | null | undefined) {
  return value === null || value === undefined ? "-" : `$${formatCodexRadarNumber(value, 2)}`;
}

function formatDetailNumber(value: number | null | undefined) {
  return value === null || value === undefined
    ? "-"
    : compact(value).replace(/\.0([KM])$/, "$1");
}

function formatRadarPercent(value: number) {
  return `${formatCodexRadarNumber(value)}%`;
}

function formatFastPair(standard: number, fast: number, suffix = "") {
  return `${formatCodexRadarNumber(standard, 2)}${suffix} → ${formatCodexRadarNumber(fast, 2)}${suffix}`;
}

function formatSeconds(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return "-";
  }
  const hours = Math.floor(value / 3600);
  const minutes = Math.round((value % 3600) / 60);
  return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
}

function resolveTop5EmptyState(presentation: CodexRadarPresentationState) {
  if (presentation.initialLoading) {
    return {
      title: "正在读取模型测评",
      detail: "正在通过本地服务读取已授权的 Codex Radar 数据。"
    };
  }
  if (presentation.lastError) {
    return {
      title: "模型测评读取失败",
      detail: presentation.lastError
    };
  }
  return {
    title: "当前没有可展示的模型测评数据",
    detail: "数据源已返回快照, 但其中没有可用于排名的 IQ 测评条目。"
  };
}

function resolveIntelligenceEmptyState(presentation: CodexRadarIntelligencePresentationState) {
  if (presentation.initialLoading) {
    return {
      title: "正在读取智力检测",
      detail: "正在通过本地服务汇总已授权的 Codex Radar 测评数据。"
    };
  }
  if (presentation.lastError) {
    return {
      title: "智力检测读取失败",
      detail: presentation.lastError
    };
  }
  return {
    title: "当前没有可展示的智力检测数据",
    detail: "数据源已返回快照, 但没有可用于模型/强度矩阵的有效条目。"
  };
}

function resolveFastEmptyState(presentation: CodexRadarFastPresentationState) {
  if (presentation.initialLoading) {
    return {
      title: "正在读取 Fast 雷达",
      detail: "正在通过本地服务读取已授权的 Codex Radar Fast 测评。"
    };
  }
  if (presentation.lastError) {
    return {
      title: "Fast 雷达读取失败",
      detail: presentation.lastError
    };
  }
  return {
    title: "当前没有可展示的 Fast 雷达数据",
    detail: "数据源已返回页面, 但未找到可用的 Standard 与 Fast 对比条目。"
  };
}
