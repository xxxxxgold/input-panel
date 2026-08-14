import { EChartCard, readChartPalette, type ChartOption } from "../../charts";
import { formatDurationSeconds, formatPercent } from "../../shared/lib/formatters";
import { TitleHint } from "../../shared/ui/TitleHint";
import type { ServiceStatusProbeRecord, ServiceStatusServiceRecord } from "../../types";
import {
  SERVICE_STATUS_ANALYSIS_WINDOW_SIZE,
  buildServiceLatencyComparisonOption,
  buildServiceLatencyTrendOption,
  buildServiceStatusAnalysisRows,
  buildServiceUptimeRankingOption,
  type ServiceStatusAnalysisRow
} from "./analysis";

export function ServiceStatusAnalysis({ services }: { services: ServiceStatusServiceRecord[] }) {
  if (services.length === 0) {
    return null;
  }

  const palette = readChartPalette();
  const rows = buildServiceStatusAnalysisRows(services);
  const insights = buildAnalysisInsights(rows);

  return (
    <section className="service-status-analysis">
      <ServiceStatusProbeOverview services={services} rows={rows} />

      <section className="service-status-analysis-workbench" aria-labelledby="service-status-analysis-title">
        <header className="service-status-analysis-header">
          <div>
            <p className="service-status-analysis-eyebrow">SERVICE HEALTH</p>
            <div className="title-with-hint">
              <h3 id="service-status-analysis-title">服务图表分析</h3>
              <TitleHint content="最近 60 次探测窗口" label="查看服务图表分析说明" />
            </div>
          </div>
          <span className="service-status-analysis-window">
            {services.length} 个模型 · 最多 {SERVICE_STATUS_ANALYSIS_WINDOW_SIZE} 个采样点
          </span>
        </header>

        <div className="service-status-analysis-facts" role="list" aria-label="服务状态分析结论">
          {insights.map((insight) => (
            <div key={insight.label} className="service-status-analysis-fact" role="listitem">
              <span>{insight.label}</span>
              <strong>{insight.value}</strong>
              <small>{insight.detail}</small>
            </div>
          ))}
        </div>

        <div className="service-status-analysis-grid">
          <AnalysisChartPanel
            className="service-status-analysis-panel--wide"
            title="响应延迟趋势"
            subtitle="按各模型实际探测时间绘制，真实失败或无有效延迟显示为 0 ms"
            meta="毫秒"
            option={buildServiceLatencyTrendOption(services, palette)}
            chartLabel="各模型最近 60 次响应延迟趋势图"
          />
          <AnalysisChartPanel
            title="模型可用率排行"
            subtitle="服务端累计可用率口径"
            meta="百分比"
            option={buildServiceUptimeRankingOption(rows, palette)}
            chartLabel="模型可用率排行图"
          />
          <AnalysisChartPanel
            title="延迟分层对比"
            subtitle="窗口内成功采样的平均值与 P95"
            meta="毫秒"
            option={buildServiceLatencyComparisonOption(rows, palette)}
            chartLabel="模型平均延迟和 P95 延迟对比图"
          />
        </div>

        <section className="service-status-analysis-table-section" aria-labelledby="service-status-analysis-table-title">
          <div className="service-status-analysis-table-head">
            <div className="title-with-hint">
              <h4 id="service-status-analysis-table-title">模型分析表</h4>
              <TitleHint content="长期可用率与当前探测窗口分开统计" label="查看模型分析表说明" />
            </div>
            <span>{rows.reduce((sum, row) => sum + row.sampleCount, 0)} 个窗口采样</span>
          </div>
          <div className="service-status-analysis-table-scroll">
            <table className="service-status-analysis-table">
              <thead>
                <tr>
                  <th scope="col">模型</th>
                  <th scope="col">总可用率</th>
                  <th scope="col">窗口可用率</th>
                  <th scope="col">最新延迟</th>
                  <th scope="col">平均延迟</th>
                  <th scope="col">P95 延迟</th>
                  <th scope="col">失败采样</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.model}>
                    <td>
                      <div className="service-status-analysis-model">
                        <strong>{row.model}</strong>
                        <span className={`service-status-analysis-state ${getStateTone(row.currentOk)}`}>
                          {formatCurrentState(row.currentOk)}
                        </span>
                      </div>
                    </td>
                    <td>{formatPercent(row.uptimePct, 2)}</td>
                    <td>{formatPercent(row.windowUptimePct, 2)}</td>
                    <td>{formatAnalysisLatency(row.latestLatencyMs)}</td>
                    <td>{formatAnalysisLatency(row.averageLatencyMs)}</td>
                    <td>{formatAnalysisLatency(row.p95LatencyMs)}</td>
                    <td className={row.failedSamples > 0 ? "is-alert" : ""}>{row.failedSamples}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </section>
    </section>
  );
}

function ServiceStatusProbeOverview({
  services,
  rows
}: {
  services: ServiceStatusServiceRecord[];
  rows: ServiceStatusAnalysisRow[];
}) {
  const rowsByModel = new Map(rows.map((row) => [row.model, row]));

  return (
    <section className="service-status-analysis-probe-overview" aria-label="模型探测概览">
      <header className="service-status-analysis-probe-header">
        <div>
          <p className="service-status-analysis-probe-eyebrow">PROBE WINDOW</p>
          <div className="title-with-hint">
            <h3 className="service-status-analysis-probe-title">模型探测概览</h3>
            <TitleHint
              content={`每张卡片保留最近 ${SERVICE_STATUS_ANALYSIS_WINDOW_SIZE} 次探测，绿色成功，红色失败`}
              label="查看模型探测概览说明"
            />
          </div>
        </div>
      </header>

      <div className="service-status-analysis-probe-grid" role="list" aria-label="各模型最近探测状态">
        {services.map((service) => {
          const row = rowsByModel.get(service.model);

          return row ? <ServiceStatusProbeCard key={service.model} service={service} row={row} /> : null;
        })}
      </div>
    </section>
  );
}

function ServiceStatusProbeCard({
  service,
  row
}: {
  service: ServiceStatusServiceRecord;
  row: ServiceStatusAnalysisRow;
}) {
  const timeline = buildRecentProbeTimeline(service.history);

  return (
    <article className="service-status-analysis-probe-card" role="listitem">
      <header className="service-status-analysis-probe-card-head">
        <div>
          <strong title={service.model}>{service.model}</strong>
          <span className={`service-status-analysis-state ${getStateTone(row.currentOk)}`}>
            {formatCurrentState(row.currentOk)}
          </span>
        </div>
        <span className="service-status-analysis-probe-sample-count">
          {row.sampleCount} / {SERVICE_STATUS_ANALYSIS_WINDOW_SIZE}
        </span>
      </header>

      <div className="service-status-analysis-probe-stats">
        <div>
          <span>累计可用率</span>
          <strong>{formatPercent(row.uptimePct, 2)}</strong>
        </div>
        <div>
          <span>窗口可用率</span>
          <strong>{formatPercent(row.windowUptimePct, 2)}</strong>
        </div>
        <div>
          <span>失败采样</span>
          <strong className={row.failedSamples > 0 ? "is-alert" : ""}>{row.failedSamples}</strong>
        </div>
      </div>

      <div
        className="service-status-analysis-probe-samples"
        role="group"
        aria-label={`${service.model} 最近 ${SERVICE_STATUS_ANALYSIS_WINDOW_SIZE} 次探测状态`}
      >
        {timeline.map((probe, index) => (
          <span key={`${service.model}-${index}`} className="service-status-analysis-probe-sample-wrap">
            <span
              className={`service-status-analysis-probe-sample ${getProbeSampleTone(probe)}`}
              role="img"
              tabIndex={0}
              aria-label={describeProbeSample(probe)}
            />
            <ServiceStatusProbeTooltip probe={probe} />
          </span>
        ))}
      </div>

      <div className="service-status-analysis-probe-ticks" aria-hidden="true">
        <span>-60</span>
        <span>-45</span>
        <span>-30</span>
        <span>-15</span>
        <span>当前</span>
      </div>
    </article>
  );
}

function ServiceStatusProbeTooltip({ probe }: { probe: ServiceStatusProbeRecord | null }) {
  const tone = getProbeSampleTone(probe);
  const state = probe ? (probe.ok ? "成功" : "失败") : "缺失";
  const latency = formatProbeLatency(probe);
  const note = !probe
    ? "该位置尚未收到探测记录"
    : probe.ok
      ? "本次探测已成功完成"
      : `失败原因: ${probe.error || "未返回"}`;

  return (
    <span className="service-status-analysis-probe-tooltip" aria-hidden="true">
      <span className="service-status-analysis-probe-tooltip-kicker">探测详情</span>
      <strong className="service-status-analysis-probe-tooltip-time">
        {probe ? formatProbeTimestamp(probe.ts) : "暂无探测记录"}
      </strong>
      <span className="service-status-analysis-probe-tooltip-fields">
        <span>
          <small>状态</small>
          <strong className={`service-status-analysis-probe-tooltip-state ${tone}`}>{state}</strong>
        </span>
        <span>
          <small>延迟</small>
          <strong>{latency}</strong>
        </span>
      </span>
      <span className="service-status-analysis-probe-tooltip-note">{note}</span>
    </span>
  );
}

function AnalysisChartPanel({
  title,
  subtitle,
  meta,
  option,
  chartLabel,
  className
}: {
  title: string;
  subtitle: string;
  meta: string;
  option: ChartOption | null;
  chartLabel: string;
  className?: string;
}) {
  return (
    <article className={`service-status-analysis-panel ${className ?? ""}`.trim()}>
      <header>
        <div className="title-with-hint">
          <h4>{title}</h4>
          <TitleHint content={subtitle} label={`查看${title}说明`} />
        </div>
        <span>{meta}</span>
      </header>
      <div className="service-status-analysis-chart" role="img" aria-label={chartLabel}>
        <EChartCard option={option} />
      </div>
    </article>
  );
}

function buildAnalysisInsights(rows: ServiceStatusAnalysisRow[]) {
  const stable = maxBy(rows.filter((row) => row.windowUptimePct !== null), (row) => row.windowUptimePct ?? 0);
  const fastest = minBy(rows.filter((row) => row.averageLatencyMs !== null), (row) => row.averageLatencyMs ?? Infinity);
  const volatile = maxBy(
    rows.filter((row) => row.p95LatencyMs !== null && row.averageLatencyMs !== null),
    (row) => Math.max(0, (row.p95LatencyMs ?? 0) - (row.averageLatencyMs ?? 0))
  );
  const failedSamples = rows.reduce((sum, row) => sum + row.failedSamples, 0);
  const totalSamples = rows.reduce((sum, row) => sum + row.sampleCount, 0);

  return [
    {
      label: "窗口最稳",
      value: stable?.model ?? "-",
      detail: stable ? formatPercent(stable.windowUptimePct, 2) : "暂无窗口样本"
    },
    {
      label: "平均响应最快",
      value: fastest?.model ?? "-",
      detail: fastest ? formatAnalysisLatency(fastest.averageLatencyMs) : "暂无成功延迟"
    },
    {
      label: "尾部波动最高",
      value: volatile?.model ?? "-",
      detail: volatile
        ? `P95 与均值差 ${formatAnalysisLatency(Math.max(0, (volatile.p95LatencyMs ?? 0) - (volatile.averageLatencyMs ?? 0)))}`
        : "暂无可比较样本"
    },
    {
      label: "失败采样",
      value: `${failedSamples} / ${totalSamples}`,
      detail: totalSamples > 0 ? formatPercent((failedSamples / totalSamples) * 100, 2) : "暂无窗口样本"
    }
  ];
}

function maxBy<T>(rows: T[], readValue: (row: T) => number) {
  return rows.reduce<T | null>((best, row) => (!best || readValue(row) > readValue(best) ? row : best), null);
}

function minBy<T>(rows: T[], readValue: (row: T) => number) {
  return rows.reduce<T | null>((best, row) => (!best || readValue(row) < readValue(best) ? row : best), null);
}

function formatAnalysisLatency(value?: number | null) {
  return formatDurationSeconds(value, 2, "秒");
}

function formatCurrentState(value: boolean | null) {
  if (value === null) {
    return "等待探测";
  }
  return value ? "在线" : "异常";
}

function getStateTone(value: boolean | null) {
  if (value === null) {
    return "pending";
  }
  return value ? "ok" : "bad";
}

function buildRecentProbeTimeline(history: ServiceStatusProbeRecord[]) {
  const recentHistory = history.slice(-SERVICE_STATUS_ANALYSIS_WINDOW_SIZE);
  return [
    ...Array.from<unknown, ServiceStatusProbeRecord | null>(
      { length: SERVICE_STATUS_ANALYSIS_WINDOW_SIZE - recentHistory.length },
      () => null
    ),
    ...recentHistory
  ];
}

function getProbeSampleTone(probe: ServiceStatusProbeRecord | null) {
  if (!probe) {
    return "is-missing";
  }
  return probe.ok ? "is-ok" : "is-failed";
}

function describeProbeSample(probe: ServiceStatusProbeRecord | null) {
  if (!probe) {
    return "时间: 暂无探测记录";
  }

  const details = [`时间: ${formatProbeTimestamp(probe.ts)}`, `状态: ${probe.ok ? "成功" : "失败"}`];

  if (typeof probe.latencyMs === "number" && Number.isFinite(probe.latencyMs)) {
    details.push(`延迟: ${Math.round(probe.latencyMs)} ms`);
  }
  if (!probe.ok && probe.error) {
    details.push(`错误: ${probe.error}`);
  }

  return details.join(" · ");
}

function formatProbeLatency(probe: ServiceStatusProbeRecord | null) {
  if (!probe || typeof probe.latencyMs !== "number" || !Number.isFinite(probe.latencyMs)) {
    return "未返回";
  }

  return `${Math.round(probe.latencyMs)} ms`;
}

function formatProbeTimestamp(timestamp: number) {
  const date = new Date(timestamp * 1000);
  if (!Number.isFinite(date.getTime())) {
    return "未知";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  })
    .format(date)
    .replaceAll("/", "-");
}
