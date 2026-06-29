import { Activity, AlertTriangle, CheckCircle2, RefreshCcw, TimerReset } from "lucide-react";

import type {
  ServiceStatusPayload,
  ServiceStatusProbeRecord,
  ServiceStatusServiceRecord
} from "../../types";
import {
  formatDateTimeFull,
  formatLiveClockTime,
  formatMilliseconds,
  formatPercent
} from "../../shared/lib/formatters";
import { DetailItem } from "../../shared/ui/DetailItem";
import { EmptyState } from "../../shared/ui/EmptyState";
import { MetricCard } from "../../shared/ui/MetricCard";
import { SectionCard } from "../../shared/ui/SectionCard";

const HISTORY_LEN = 60;

export function ServiceStatusTerminal({
  status,
  loading,
  refreshing,
  lastError,
  lastSyncedAt,
  enabled = true,
  refreshIntervalSeconds = 5,
  onRefresh
}: {
  status: ServiceStatusPayload | null;
  loading: boolean;
  refreshing: boolean;
  lastError: string | null;
  lastSyncedAt?: number | null;
  enabled?: boolean;
  refreshIntervalSeconds?: number;
  onRefresh: () => void | Promise<void>;
}) {
  const services = status?.services ?? [];
  const allOk = status?.allOk ?? false;
  const generatedAtText = status ? formatUnixDateTime(status.generatedAt) : "-";
  const lastSyncedText = lastSyncedAt ? formatDateTimeFull(new Date(lastSyncedAt).toISOString()) : generatedAtText;
  const onlineCount = services.filter((service) => service.last?.ok).length;
  const totalSamples = services.reduce((sum, service) => sum + service.history.length, 0);
  const avgLatency = computeAverageLatency(services);
  const averageUptime = computeAverageUptime(services);
  const hourlyUptimeBuckets = buildHourlyUptimeBuckets(services);

  return (
    <section className="content-grid status-page-grid">
      <div className="metric-grid">
        <MetricCard
          label="服务数"
          value={String(services.length)}
          hint={services.length > 0 ? `在线 ${onlineCount} / ${services.length}` : "等待拉取"}
          accent="sky"
          icon={<Activity size={18} />}
          detailTitle="当前服务状态"
          detail={
            <>
              <DetailItem label="状态总览" value={allOk ? "全部正常" : "存在异常"} />
              <DetailItem label="最近同步时间" value={lastSyncedText} />
              <DetailItem label="最近探测结果" value={generatedAtText} />
              <DetailItem label="已采样点数" value={String(totalSamples)} />
            </>
          }
        />
        <MetricCard
          label="平均延迟"
          value={formatMilliseconds(avgLatency)}
          hint="取各服务最新一次探测"
          accent="emerald"
          icon={<TimerReset size={18} />}
          detailTitle="最新探测延迟"
          detail={
            <>
              {services.map((service) => (
                <DetailItem
                  key={`${service.model}-latency`}
                  label={service.model}
                  value={formatMilliseconds(service.last?.latencyMs)}
                />
              ))}
            </>
          }
        />
        <MetricCard
          label="总可用率"
          value={services.length > 0 ? formatPercent(averageUptime, 2) : "-"}
          hint="按全部模型平均值, 悬浮查看分小时明细"
          accent="indigo"
          icon={allOk ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
          detailTitle="所有模型分小时可用率"
          detailPanelAlign="end"
          detail={
            <ServiceStatusHourlyUptimeDetails
              services={services}
              averageUptime={averageUptime}
              hourlyUptimeBuckets={hourlyUptimeBuckets}
            />
          }
        />
      </div>

      <SectionCard
        title="AI.INPUT.IM 服务状态"
        subtitle="监控INPUT的可用状态"
        actions={
          <div className="status-page-actions">
            <button
              type="button"
              className="inline-text-button"
              onClick={() => void onRefresh()}
              disabled={refreshing || !enabled}
            >
              <RefreshCcw size={16} className={refreshing ? "spin" : ""} />
              {refreshing ? "刷新中" : "立即刷新"}
            </button>
            <a
              className="inline-text-button"
              href="https://status.input.im"
              target="_blank"
              rel="noreferrer"
            >
              打开原页面
            </a>
          </div>
        }
      >
        {!status && loading ? (
          <div className="status-terminal-shell loading">
            <div className="status-terminal-titlebar">
              <div className="status-terminal-lights" aria-hidden="true">
                <span className="light close" />
                <span className="light min" />
                <span className="light max" />
              </div>
              <div className="status-terminal-title">status.input.im</div>
            </div>
            <div className="status-terminal-body">
              <p className="status-terminal-comment"># 正在连接远端状态接口...</p>
              <p className="status-terminal-line">
                <span className="status-terminal-prompt">~ $</span>
                <span className="status-terminal-command"> monitor --watch</span>
              </p>
              <p className="status-terminal-loading">loading<span className="status-terminal-cursor" /></p>
            </div>
          </div>
        ) : !status ? (
          <EmptyState
            title="当前无法获取服务状态"
            detail={lastError ? `最近一次错误: ${lastError}` : "稍后重试或打开原页面查看。"}
          />
        ) : (
          <div className="status-terminal-shell">
            <div className="status-terminal-titlebar">
              <div className="status-terminal-lights" aria-hidden="true">
                <span className="light close" />
                <span className="light min" />
                <span className="light max" />
              </div>
              <div className="status-terminal-title">status.input.im</div>
            </div>

            <div className="status-terminal-toolbar">
              <div>
                <strong>{allOk ? "all systems operational" : "degraded status detected"}</strong>
                <p>
                  上次同步 {lastSyncedText} · 最近探测 {generatedAtText} · 本地时钟 {formatLiveClockTime(new Date())}
                  {lastError ? ` · 最近一次刷新失败` : ""}
                </p>
              </div>
              <span className={`status-pill ${allOk ? "ready" : "critical"}`}>
                {allOk ? "Live" : "Alert"}
              </span>
            </div>

            <div className="status-terminal-body">
              <div className="status-terminal-block">
                <p className="status-terminal-comment"># AI.INPUT.IM service monitor · polling every {refreshIntervalSeconds}s</p>
                <p className="status-terminal-comment"># Last synced: {lastSyncedText}</p>
                <p className="status-terminal-comment"># Latest probe result: {generatedAtText}</p>
              </div>

              <div className="status-terminal-block">
                <p className="status-terminal-line">
                  <span className="status-terminal-prompt">~ $</span>
                  <span className="status-terminal-command"> uptime</span>
                </p>
                <p className="status-terminal-banner">
                  <span className={allOk ? "ok" : "bad"}>{allOk ? "up" : "degraded"}</span>, {services.length} services,
                  avg load <span className={allOk ? "ok" : "warn"}>{formatPercent(computeAverageUptime(services), 2)}</span>
                </p>
              </div>

              <div className="status-terminal-block">
                <p className="status-terminal-line">
                  <span className="status-terminal-prompt">~ $</span>
                  <span className="status-terminal-command"> monitor</span>
                  <span className="status-terminal-flag"> --watch</span>
                  <span className="status-terminal-args"> {services.map((service) => service.model).join(" ")}</span>
                </p>

                <div className="status-terminal-services">
                  {services.map((service) => (
                    <ServiceRow key={service.model} service={service} />
                  ))}
                </div>
              </div>

              <div className="status-terminal-block">
                <p className="status-terminal-line">
                  <span className="status-terminal-prompt">~ $</span>
                  <span className="status-terminal-cursor" />
                </p>
              </div>
            </div>
          </div>
        )}
      </SectionCard>
    </section>
  );
}

function ServiceStatusHourlyUptimeDetails({
  services,
  averageUptime,
  hourlyUptimeBuckets
}: {
  services: ServiceStatusServiceRecord[];
  averageUptime: number | null;
  hourlyUptimeBuckets: ServiceStatusHourlyUptimeBucket[];
}) {
  if (hourlyUptimeBuckets.length === 0) {
    return (
      <>
        <DetailItem label="模型平均可用率" value={formatPercent(averageUptime, 2)} />
        {services.map((service) => (
          <DetailItem
            key={`${service.model}-uptime`}
            label={service.model}
            value={formatPercent(service.uptimePct, 2)}
          />
        ))}
      </>
    );
  }

  return (
    <>
      <DetailItem label="模型平均可用率" value={formatPercent(averageUptime, 2)} />
      <DetailItem label="小时窗口数" value={String(hourlyUptimeBuckets.length)} />
      {hourlyUptimeBuckets.map((bucket) => (
        <div key={bucket.hourStartTs} className="status-uptime-hour-group">
          <div className="status-uptime-hour-head">
            <div>
              <p>{bucket.label}</p>
              <small>
                模型均值 · {bucket.models.length} 个模型 / {bucket.totalSamples} 个采样
              </small>
            </div>
            <strong>{formatPercent(bucket.averageUptimePct, 2)}</strong>
          </div>
          <div className="status-uptime-hour-models">
            {bucket.models.map((model) => (
              <DetailItem
                key={`${bucket.hourStartTs}-${model.model}`}
                label={`${model.model} · ${model.sampleCount} 次`}
                value={formatPercent(model.uptimePct, 2)}
              />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function ServiceRow({ service }: { service: ServiceStatusServiceRecord }) {
  const last = service.last;
  const tone = last?.ok ? "ok" : last ? "bad" : "warn";
  const statusText = last?.ok ? "online" : last ? "failing" : "pending";
  const normalizedHistory = normalizeHistory(service.history);

  return (
    <div className="status-service-card">
      <div className="status-service-head">
        <div>
          <strong>{service.model}</strong>
          <p>
            <span className={tone}>● {statusText}</span>
            <span> uptime {formatPercent(service.uptimePct, 2)}</span>
            <span> samples {service.history.length}/{HISTORY_LEN}</span>
          </p>
        </div>
        <div className="status-service-last">
          <span>{last ? formatUnixDateTime(last.ts) : "暂无探测"}</span>
          <strong>{formatMilliseconds(last?.latencyMs)}</strong>
        </div>
      </div>

      <div className="status-history-bars" role="img" aria-label={`${service.model} 最近 60 次探测`}>
        {normalizedHistory.map((probe, index) => {
          if (!probe) {
            return <span key={`${service.model}-empty-${index}`} className="status-history-bar empty" aria-hidden="true" />;
          }
          const title = [
            `${service.model}`,
            probe.ok ? "OK" : "FAIL",
            formatUnixDateTime(probe.ts),
            `延迟 ${formatMilliseconds(probe.latencyMs)}`,
            probe.error ? `错误 ${probe.error}` : null
          ]
            .filter(Boolean)
            .join(" | ");
          return (
            <span
              key={`${service.model}-${probe.ts}-${index}`}
              className={`status-history-bar ${probe.ok ? "ok" : "bad"}`}
              title={title}
            />
          );
        })}
      </div>
      <div className="status-history-axis">
        <span>-60m</span>
        <span>-45m</span>
        <span>-30m</span>
        <span>-15m</span>
        <span>now</span>
      </div>
      {last?.error ? (
        <p className="status-service-error">最近错误: {last.error}</p>
      ) : (
        <p className="status-service-error neutral">
          最近探测 {last ? formatDateTimeFull(toIsoFromUnix(last.ts)) : "暂无数据"} · 延迟 {formatMilliseconds(last?.latencyMs)}
        </p>
      )}
    </div>
  );
}

function normalizeHistory(history: ServiceStatusProbeRecord[]) {
  const next: Array<ServiceStatusProbeRecord | null> = [...history];
  while (next.length < HISTORY_LEN) {
    next.unshift(null);
  }
  return next.slice(-HISTORY_LEN);
}

function computeAverageLatency(services: ServiceStatusServiceRecord[]) {
  const latencies = services
    .map((service) => service.last?.latencyMs ?? null)
    .filter((value): value is number => typeof value === "number" && value > 0);

  if (latencies.length === 0) {
    return null;
  }

  return Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length);
}

function computeAverageUptime(services: ServiceStatusServiceRecord[]) {
  if (services.length === 0) {
    return null;
  }
  return services.reduce((sum, service) => sum + service.uptimePct, 0) / services.length;
}

type ServiceStatusHourlyUptimeBucket = {
  hourStartTs: number;
  label: string;
  averageUptimePct: number | null;
  totalSamples: number;
  models: Array<{
    model: string;
    uptimePct: number;
    sampleCount: number;
  }>;
};

function buildHourlyUptimeBuckets(services: ServiceStatusServiceRecord[]): ServiceStatusHourlyUptimeBucket[] {
  const serviceOrder = new Map(services.map((service, index) => [service.model, index]));
  const buckets = new Map<number, Map<string, ServiceStatusProbeRecord[]>>();

  services.forEach((service) => {
    service.history.forEach((probe) => {
      const hourStartTs = toHourStartUnix(probe.ts);
      const hourBucket = buckets.get(hourStartTs) ?? new Map<string, ServiceStatusProbeRecord[]>();
      const probes = hourBucket.get(service.model) ?? [];
      probes.push(probe);
      hourBucket.set(service.model, probes);
      buckets.set(hourStartTs, hourBucket);
    });
  });

  return [...buckets.entries()]
    .sort(([leftTs], [rightTs]) => rightTs - leftTs)
    .map(([hourStartTs, models]) => {
      const modelRows = [...models.entries()]
        .map(([model, probes]) => {
          const uptimePct = computeProbeUptime(probes);
          if (uptimePct === null) {
            return null;
          }
          return {
            model,
            uptimePct,
            sampleCount: probes.length
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null)
        .sort((left, right) => (serviceOrder.get(left.model) ?? 0) - (serviceOrder.get(right.model) ?? 0));

      return {
        hourStartTs,
        label: formatHourBucketLabel(hourStartTs),
        averageUptimePct:
          modelRows.length > 0
            ? modelRows.reduce((sum, model) => sum + model.uptimePct, 0) / modelRows.length
            : null,
        totalSamples: modelRows.reduce((sum, model) => sum + model.sampleCount, 0),
        models: modelRows
      };
    });
}

function computeProbeUptime(probes: ServiceStatusProbeRecord[]) {
  if (probes.length === 0) {
    return null;
  }
  const okCount = probes.filter((probe) => probe.ok).length;
  return (okCount / probes.length) * 100;
}

function toHourStartUnix(value: number) {
  const date = new Date(value * 1000);
  date.setMinutes(0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

function formatHourBucketLabel(hourStartTs: number) {
  const start = new Date(hourStartTs * 1000);
  const end = new Date(start.getTime() + 59 * 60 * 1000);
  const dateText = start.toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit"
  });
  const startText = start.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const endText = end.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  return `${dateText} ${startText} - ${endText}`;
}

function formatUnixDateTime(value?: number | null) {
  if (value === null || value === undefined) {
    return "-";
  }
  return formatDateTimeFull(toIsoFromUnix(value));
}

function toIsoFromUnix(value: number) {
  return new Date(value * 1000).toISOString();
}
