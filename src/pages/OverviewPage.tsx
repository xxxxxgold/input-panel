import {
  BadgeDollarSign,
  ChartColumn,
  KeyRound,
  LayoutDashboard,
  MonitorDot,
  ShieldAlert
} from "lucide-react";

import type { AccountRuntime, OverviewPayload, SnapshotAlert } from "../types";
import { compact, formatTime } from "../shared/lib/formatters";
import { EmptyState } from "../shared/ui/EmptyState";
import { DetailItem, UsageMetricDetailItem } from "../shared/ui/DetailItem";
import { MetricCard } from "../shared/ui/MetricCard";
import { SectionCard } from "../shared/ui/SectionCard";
import { ApiKeyList } from "../features/keys/components/ApiKeyList";
import { SubscriptionList } from "../features/subscriptions/components/SubscriptionList";
import {
  buildPlatformDonutChartOption,
  buildTrendAreaChartOption,
  EChartCard,
  normalizeTrendChartData
} from "../charts";

type OverviewMetricDetailKind =
  | "balance"
  | "todayRequests"
  | "todayActualCost"
  | "activeApiKeys"
  | "todayTokens"
  | "alerts";

export function OverviewPage({
  overview,
  visibleSnapshot,
  alertCount
}: {
  overview: OverviewPayload;
  visibleSnapshot: AccountRuntime["snapshot"] | null;
  alertCount: number;
}) {
  return (
    <>
      <section className="metric-grid">
        <MetricCard
          label="总余额"
          value={`$${overview.totals.balance.toFixed(2)}`}
          accent="emerald"
          icon={<BadgeDollarSign size={18} />}
          hint="聚合所有已登录账号 · 悬浮查看账号"
          detailTitle="各账号余额"
          detail={renderOverviewMetricDetails(overview, "balance")}
        />
        <MetricCard
          label="今日请求"
          value={overview.totals.todayRequests.toLocaleString()}
          accent="sky"
          icon={<LayoutDashboard size={18} />}
          hint={`累计 ${overview.totals.totalRequests.toLocaleString()} · 悬浮查看账号`}
          detailTitle="各账号今日请求"
          detail={renderOverviewMetricDetails(overview, "todayRequests")}
        />
        <MetricCard
          label="今日实际成本"
          value={`$${overview.totals.todayActualCost.toFixed(4)}`}
          accent="violet"
          icon={<ChartColumn size={18} />}
          hint={`累计 $${overview.totals.totalActualCost.toFixed(4)} · 悬浮查看账号`}
          detailTitle="各账号今日实际成本"
          detail={renderOverviewMetricDetails(overview, "todayActualCost")}
          detailPanelAlign="end"
        />
        <MetricCard
          label="活跃 Keys"
          value={`${overview.totals.activeApiKeys}`}
          accent="amber"
          icon={<KeyRound size={18} />}
          hint={`总数 ${overview.totals.totalApiKeys} · 悬浮查看账号`}
          detailTitle="各账号 Key 状态"
          detail={renderOverviewMetricDetails(overview, "activeApiKeys")}
        />
        <MetricCard
          label="今日 Tokens"
          value={compact(overview.totals.todayTokens)}
          accent="indigo"
          icon={<MonitorDot size={18} />}
          hint={`累计 ${compact(overview.totals.totalTokens)} · 悬浮查看账号`}
          detailTitle="各账号今日 Tokens"
          detail={renderOverviewMetricDetails(overview, "todayTokens")}
        />
        <MetricCard
          label="异常数"
          value={String(alertCount)}
          accent="rose"
          icon={<ShieldAlert size={18} />}
          hint="低余额、会话失效、拉取失败 · 悬浮查看账号"
          detailTitle="各账号异常数"
          detail={renderOverviewMetricDetails(overview, "alerts")}
          detailPanelAlign="end"
        />
      </section>

      <section className="content-grid">
        <SectionCard title="近 7 天趋势" subtitle="按全部账号聚合 actual cost / requests / cache">
          <div className="chart-wrap tall">
            <EChartCard
              option={buildTrendAreaChartOption({
                data: normalizeTrendChartData(overview.trend),
                series: ["actualCost", "requests", "cacheCreationTokens", "cacheReadTokens", "cacheHitRate"]
              })}
            />
          </div>
        </SectionCard>

        <SectionCard title="平台分布" subtitle="按平台汇总实际成本与 tokens">
          <div className="chart-wrap">
            <EChartCard option={buildPlatformDonutChartOption(overview.platformSeries)} />
          </div>
          <div className="legend-list">
            {overview.platformSeries.map((item) => (
              <div key={item.platform} className="legend-row">
                <span>{item.platform}</span>
                <strong>${item.totalActualCost.toFixed(4)}</strong>
              </div>
            ))}
          </div>
        </SectionCard>
      </section>

      <section className="content-grid">
        <SectionCard title="异常优先" subtitle="当前需要关注的问题">
          <div className="stack-list">
            {overview.alerts.slice(0, 8).map((alert) => (
              <div key={alert.id} className={`alert-item ${alert.severity}`}>
                <div>
                  <strong>{alert.title}</strong>
                  <p>{alert.detail}</p>
                </div>
                <span>{formatTime(alert.createdAt)}</span>
              </div>
            ))}
            {overview.alerts.length === 0 && (
              <EmptyState title="当前没有异常" detail="最近一次聚合已经成功完成。" compact />
            )}
          </div>
        </SectionCard>

        <SectionCard title="最近使用" subtitle="当前选中账号的近期调用">
          <div className="table-list">
            {visibleSnapshot?.recentUsage.slice(0, 8).map((row) => (
              <div key={row.id} className="table-row">
                <div>
                  <strong>{row.model}</strong>
                  <p>{row.apiKeyName ?? "未知 Key"} / {row.endpoint ?? "-"}</p>
                </div>
                <div className="table-numbers">
                  <strong>${row.actualCost.toFixed(5)}</strong>
                  <span>{compact(row.totalTokens)} tokens</span>
                </div>
              </div>
            ))}
            {!visibleSnapshot && (
              <EmptyState title="还没有账号快照" detail="先登录账号并刷新数据。" compact />
            )}
          </div>
        </SectionCard>
      </section>

      <section className="content-grid">
        <SectionCard title="全部订阅" subtitle="当前账号返回的全部套餐与额度窗口">
          {visibleSnapshot ? (
            <SubscriptionList subscriptions={visibleSnapshot.subscriptions} />
          ) : (
            <EmptyState title="当前没有订阅数据" detail="该账号未返回有效订阅或套餐信息。" compact />
          )}
        </SectionCard>

        <SectionCard title="全部 API Keys" subtitle="状态、最近使用、额度与限流摘要">
          {visibleSnapshot ? (
            <ApiKeyList keys={visibleSnapshot.keys} />
          ) : (
            <EmptyState title="还没有 Key 快照" detail="登录并刷新后这里会展示 key 列表。" compact />
          )}
        </SectionCard>
      </section>
    </>
  );
}

function formatOverviewAccountSource(account: AccountRuntime) {
  return `${account.site?.name ?? account.snapshot?.siteName ?? "未命名站点"} / ${account.label}`;
}

function buildOverviewMetricDetails(overview: OverviewPayload, kind: OverviewMetricDetailKind) {
  const alertsByAccount = overview.alerts.reduce<Map<string, SnapshotAlert[]>>((memo, alert) => {
    const current = memo.get(alert.accountId) ?? [];
    current.push(alert);
    memo.set(alert.accountId, current);
    return memo;
  }, new Map());

  return overview.accounts
    .map((account) => {
      const source = formatOverviewAccountSource(account);
      const snapshot = account.snapshot;
      const unavailableLabel = account.lastError ? "同步失败" : account.sessionState === "expired" ? "会话失效" : "未登录";

      if (kind === "alerts") {
        const accountAlerts = alertsByAccount.get(account.id) ?? [];
        const latestAlert = accountAlerts[0] ?? null;
        return {
          accountId: account.id,
          label: account.label,
          value: accountAlerts.length.toLocaleString(),
          description: latestAlert
            ? `${source} · ${latestAlert.title} · ${formatTime(latestAlert.createdAt)}`
            : `${source} · ${account.sessionState === "ready" ? "当前无异常" : unavailableLabel}`
        };
      }

      if (!snapshot) {
        return {
          accountId: account.id,
          label: account.label,
          value: unavailableLabel,
          description: `${source} · 当前没有可展示的聚合数据`
        };
      }

      switch (kind) {
        case "balance":
          return {
            accountId: account.id,
            label: account.label,
            value: `$${snapshot.balance.toFixed(2)}`,
            description: `${source} · 更新时间 ${formatTime(snapshot.fetchedAt)}`
          };
        case "todayRequests":
          return {
            accountId: account.id,
            label: account.label,
            value: snapshot.stats.todayRequests.toLocaleString(),
            description: `${source} · 累计 ${snapshot.stats.totalRequests.toLocaleString()} 请求`
          };
        case "todayActualCost":
          return {
            accountId: account.id,
            label: account.label,
            value: `$${snapshot.stats.todayActualCost.toFixed(4)}`,
            description: `${source} · 累计 $${snapshot.stats.totalActualCost.toFixed(4)}`
          };
        case "activeApiKeys":
          return {
            accountId: account.id,
            label: account.label,
            value: String(snapshot.stats.activeApiKeys),
            description: `${source} · 总数 ${snapshot.stats.totalApiKeys}`
          };
        case "todayTokens":
          return {
            accountId: account.id,
            label: account.label,
            value: compact(snapshot.stats.todayTokens),
            description: `${source} · 累计 ${compact(snapshot.stats.totalTokens)} tokens`
          };
      }
    })
    .sort((left, right) => {
      const leftNumeric = Number(left.value.replace(/[^\d.-]/g, ""));
      const rightNumeric = Number(right.value.replace(/[^\d.-]/g, ""));
      if (Number.isFinite(leftNumeric) && Number.isFinite(rightNumeric) && rightNumeric !== leftNumeric) {
        return rightNumeric - leftNumeric;
      }
      return left.label.localeCompare(right.label, "zh-CN");
    });
}

function renderOverviewMetricDetails(overview: OverviewPayload, kind: OverviewMetricDetailKind) {
  const rows = buildOverviewMetricDetails(overview, kind);
  return (
    <>
      {rows.map((row) => (
        <UsageMetricDetailItem
          key={`${kind}-${row.accountId}`}
          label={row.label}
          value={row.value}
          description={row.description}
        />
      ))}
    </>
  );
}
