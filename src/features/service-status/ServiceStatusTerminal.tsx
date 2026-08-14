import { Activity, AlertTriangle, CheckCircle2, TimerReset } from "lucide-react";

import type {
  ServiceStatusPayload,
  ServiceStatusProbeRecord,
  ServiceStatusServiceRecord
} from "../../types";
import {
  formatDateTimeFull,
  formatDurationSeconds,
  formatPercent
} from "../../shared/lib/formatters";
import { DetailItem } from "../../shared/ui/DetailItem";
import { MetricCard } from "../../shared/ui/MetricCard";
import { ServiceStatusAnalysis } from "./ServiceStatusAnalysis";

export function ServiceStatusTerminal({
  status,
  lastSyncedAt
}: {
  status: ServiceStatusPayload | null;
  lastSyncedAt?: number | null;
}) {
  const services = status?.services ?? [];
  const allOk = status?.allOk ?? false;
  const generatedAtText = status ? formatUnixDateTime(status.generatedAt) : "-";
  const lastSyncedText = lastSyncedAt ? formatDateTimeFull(new Date(lastSyncedAt).toISOString()) : generatedAtText;
  const onlineCount = services.filter((service) => service.last?.ok).length;
  const totalSamples = services.reduce((sum, service) => sum + service.history.length, 0);
  const lowestLatestLatency = findLowestLatestLatency(services);
  const averageUptime = computeAverageUptime(services);
  const hourlyUptimeBuckets = buildHourlyUptimeBuckets(services);
  const onlineSummaryText = services.length > 0 ? `在线${onlineCount}/${services.length}` : "-";

  return (
    <section className="content-grid status-page-grid">
      <div className="metric-grid status-page-metric-grid">
        <MetricCard
          label="服务数"
          value={onlineSummaryText}
          hint={services.length > 0 ? "这里显示当前服务在线情况" : "等待拉取"}
          accent="sky"
          icon={<Activity size={18} />}
          className="overview-metric-card status-page-metric-card"
          detailTitle="当前服务状态"
          detail={
            <>
              <DetailItem label="状态总览" value={allOk ? "全部正常" : "存在异常"} />
              <DetailItem label="在线服务" value={onlineSummaryText} />
              <DetailItem label="最近同步时间" value={lastSyncedText} />
              <DetailItem label="最近探测结果" value={generatedAtText} />
              <DetailItem label="已采样点数" value={String(totalSamples)} />
            </>
          }
        />
        <MetricCard
          label="最低延迟"
          value={formatServiceStatusLatency(lowestLatestLatency?.latencyMs)}
          hint={lowestLatestLatency ? `${lowestLatestLatency.model} · 最近一次探测` : "等待有效探测数据"}
          accent="emerald"
          icon={<TimerReset size={18} />}
          className="overview-metric-card status-page-metric-card"
          detailTitle="最新探测延迟"
          detail={
            <>
              {services.map((service) => (
                <DetailItem
                  key={`${service.model}-latency`}
                  label={service.model}
                  value={formatServiceStatusLatency(service.last?.latencyMs)}
                />
              ))}
            </>
          }
        />
        <MetricCard
          label="总可用率"
          value={services.length > 0 ? formatPercent(averageUptime, 2) : "-"}
          hint="这里会汇总显示整体可用情况, 方便快速判断"
          accent="indigo"
          icon={allOk ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
          className="overview-metric-card status-page-metric-card"
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
      <ServiceStatusAnalysis services={services} />
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

function formatServiceStatusLatency(value?: number | null) {
  return formatDurationSeconds(value, 2, "秒");
}

function findLowestLatestLatency(services: ServiceStatusServiceRecord[]) {
  return services.reduce<{ model: string; latencyMs: number } | null>((lowest, service) => {
    const latencyMs = service.last?.latencyMs;
    if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs) || latencyMs <= 0) {
      return lowest;
    }
    if (lowest && lowest.latencyMs <= latencyMs) {
      return lowest;
    }
    return {
      model: service.model,
      latencyMs
    };
  }, null);
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
