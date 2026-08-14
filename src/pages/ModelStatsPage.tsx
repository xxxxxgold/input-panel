import {
  BadgeDollarSign,
  Boxes,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Coins,
  Cpu,
  RefreshCcw
} from "lucide-react";
import type { MutableRefObject } from "react";

import type { DashboardModelsPayload, ManagedKeyRecord, ModelUsagePoint, PaginatedResult } from "../types";
import { compact, formatUsd } from "../shared/lib/formatters";
import { EmptyState } from "../shared/ui/EmptyState";
import { MetricCard } from "../shared/ui/MetricCard";
import { SectionCard } from "../shared/ui/SectionCard";

const USAGE_RANGE_PRESETS = [
  { key: "today", label: "今天" },
  { key: "yesterday", label: "昨天" },
  { key: "last24Hours", label: "近24小时" },
  { key: "last7Days", label: "近 7 天" },
  { key: "last14Days", label: "近 14 天" },
  { key: "last30Days", label: "近 30 天" },
  { key: "thisMonth", label: "本月" },
  { key: "lastMonth", label: "上月" }
] as const;

export function ModelStatsPage({
  managedKeys,
  usageApiKeyFilter,
  setUsageApiKeyFilter,
  usageRangePickerRef,
  usageRangePickerOpen,
  toggleUsageRangePicker,
  usageRangeLabel,
  usageRangePreset,
  applyUsagePreset,
  usageDraftRange,
  setUsageDraftRange,
  applyUsageRange,
  usageModels,
  loading,
  onRefresh
}: {
  managedKeys: PaginatedResult<ManagedKeyRecord> | null;
  usageApiKeyFilter: string;
  setUsageApiKeyFilter: (value: string) => void;
  usageRangePickerRef: MutableRefObject<HTMLDivElement | null>;
  usageRangePickerOpen: boolean;
  toggleUsageRangePicker: () => void;
  usageRangeLabel: string;
  usageRangePreset: (typeof USAGE_RANGE_PRESETS)[number]["key"];
  applyUsagePreset: (preset: (typeof USAGE_RANGE_PRESETS)[number]["key"]) => void;
  usageDraftRange: { startDate: string; endDate: string };
  setUsageDraftRange: (updater: (prev: { startDate: string; endDate: string }) => { startDate: string; endDate: string }) => void;
  applyUsageRange: () => Promise<void>;
  usageModels: DashboardModelsPayload | null;
  loading: boolean;
  onRefresh: () => Promise<void>;
}) {
  const models = [...(usageModels?.models ?? [])].sort(compareModelUsageRows);
  const totals = buildModelTotals(models);
  const topCostModel = models[0] ?? null;
  const topTokenModel = [...models].sort((left, right) => (right.totalTokens ?? 0) - (left.totalTokens ?? 0))[0] ?? null;
  const topCacheModel = [...models].sort((left, right) => getCacheTokens(right) - getCacheTokens(left))[0] ?? null;
  const windowLabel = buildModelStatsWindowLabel(usageModels, usageRangeLabel);

  return (
    <section className="usage-view model-stats-view motion-shell-section">
      <SectionCard
        title="模型聚合统计"
        subtitle={`${windowLabel} · 按模型汇总请求、Token、缓存和成本`}
        actions={
          <button className="ghost-button" onClick={() => void onRefresh()}>
            <RefreshCcw size={16} />
            重新查询
          </button>
        }
      >
        <div className="filter-grid">
          <label className="field">
            <span>API Key</span>
            <select value={usageApiKeyFilter} onChange={(event) => setUsageApiKeyFilter(event.target.value)}>
              <option value="">全部</option>
              {(managedKeys?.items ?? []).map((key) => (
                <option
                  key={key.id || String(key.apiKeyId ?? key.name)}
                  value={key.apiKeyId !== null && key.apiKeyId !== undefined ? String(key.apiKeyId) : ""}
                  disabled={key.apiKeyId === null || key.apiKeyId === undefined}
                >
                  {key.apiKeyId === null || key.apiKeyId === undefined ? `${key.name} (无可筛选 ID)` : key.name}
                </option>
              ))}
            </select>
          </label>
          <div className="field range-field animated-range-field" ref={usageRangePickerRef}>
            <span>时间范围</span>
            <div className="range-picker-shell">
              <button
                type="button"
                className={`range-trigger ${usageRangePickerOpen ? "open" : ""}`}
                onClick={toggleUsageRangePicker}
              >
                <CalendarDays size={16} />
                <span>{usageRangeLabel}</span>
                <ChevronDown size={16} className={`range-trigger-chevron ${usageRangePickerOpen ? "open" : ""}`} />
              </button>
              {usageRangePickerOpen && (
                <div className="range-popover range-popover-visible">
                  <div className="range-presets">
                    {USAGE_RANGE_PRESETS.map((preset) => (
                      <button
                        key={preset.key}
                        type="button"
                        className={`range-preset ${usageRangePreset === preset.key ? "active" : ""}`}
                        onClick={() => applyUsagePreset(preset.key)}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  <div className="range-custom">
                    <label className="field">
                      <span>开始日期</span>
                      <input
                        type="date"
                        value={usageDraftRange.startDate}
                        onChange={(event) =>
                          setUsageDraftRange((prev) => ({ ...prev, startDate: event.target.value }))
                        }
                      />
                    </label>
                    <div className="range-arrow">
                      <ChevronRight size={16} />
                    </div>
                    <label className="field">
                      <span>结束日期</span>
                      <input
                        type="date"
                        value={usageDraftRange.endDate}
                        onChange={(event) =>
                          setUsageDraftRange((prev) => ({ ...prev, endDate: event.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <div className="range-popover-footer">
                    <button type="button" className="primary-button" onClick={() => void applyUsageRange()}>
                      应用
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="metric-grid compact-metrics motion-stagger-grid">
          <MetricCard
            label="模型数"
            value={models.length.toLocaleString()}
            hint={topCostModel ? `最高成本 ${topCostModel.model}` : "当前没有模型数据"}
            accent="sky"
            icon={<Boxes size={18} />}
            className="motion-stagger-item"
            animationKey={`model-stats-count:${models.length}`}
            style={{ ["--motion-order" as string]: 0 }}
          />
          <MetricCard
            label="请求数"
            value={totals.requests.toLocaleString()}
            hint={topCostModel ? `${topCostModel.requests.toLocaleString()} 次来自 ${topCostModel.model}` : "等待模型统计"}
            accent="emerald"
            icon={<Cpu size={18} />}
            className="motion-stagger-item"
            animationKey={`model-stats-requests:${totals.requests}`}
            style={{ ["--motion-order" as string]: 1 }}
          />
          <MetricCard
            label="总 Tokens"
            value={compact(totals.totalTokens)}
            hint={topTokenModel ? `Token 最高 ${topTokenModel.model}` : "当前没有 Token 数据"}
            accent="indigo"
            icon={<Coins size={18} />}
            className="motion-stagger-item"
            animationKey={`model-stats-tokens:${totals.totalTokens}`}
            style={{ ["--motion-order" as string]: 2 }}
          />
          <MetricCard
            label="实际成本"
            value={formatUsd(totals.actualCost, 4)}
            hint={topCacheModel ? `缓存最多 ${topCacheModel.model}` : "当前没有成本数据"}
            accent="violet"
            icon={<BadgeDollarSign size={18} />}
            className="motion-stagger-item"
            animationKey={`model-stats-cost:${totals.actualCost}`}
            style={{ ["--motion-order" as string]: 3 }}
          />
        </div>
      </SectionCard>

      <SectionCard title="模型排行榜" subtitle="按实际成本倒序, 同时保留标准成本和缓存输入口径">
        {models.length > 0 ? (
          <div className="usage-table-wrap">
            <table className="usage-table">
              <colgroup>
                <col style={{ width: "19%" }} />
                <col style={{ width: "9%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "12%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>模型</th>
                  <th>请求数</th>
                  <th>输入 Token</th>
                  <th>输出 Token</th>
                  <th>缓存 Token</th>
                  <th>总 Token</th>
                  <th>标准成本</th>
                  <th>实际成本</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model, index) => (
                  <tr key={model.model} className="usage-row-motion" style={{ ["--motion-order" as string]: index }}>
                    <td>
                      <div className="usage-cell usage-cell-primary">
                        <strong>{model.model}</strong>
                        <span>{formatShare(model.actualCost ?? model.cost ?? 0, totals.actualCost)} 成本占比</span>
                      </div>
                    </td>
                    <td>{model.requests.toLocaleString()}</td>
                    <td>{compact(model.inputTokens ?? 0)}</td>
                    <td>{compact(model.outputTokens ?? 0)}</td>
                    <td>{compact(getCacheTokens(model))}</td>
                    <td>{compact(model.totalTokens ?? 0)}</td>
                    <td>{formatUsd(model.cost ?? 0, 4)}</td>
                    <td>{formatUsd(model.actualCost ?? model.cost ?? 0, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title={loading ? "模型统计正在加载" : "当前没有模型统计数据"}
            detail={loading ? "正在读取当前账号的模型聚合结果。" : "调整时间范围或刷新账号用量后, 这里会显示按模型聚合的结果。"}
            compact
          />
        )}
      </SectionCard>
    </section>
  );
}

function compareModelUsageRows(left: ModelUsagePoint, right: ModelUsagePoint) {
  const costDiff = Number(right.actualCost ?? right.cost ?? 0) - Number(left.actualCost ?? left.cost ?? 0);
  if (costDiff !== 0) {
    return costDiff;
  }
  if (right.requests !== left.requests) {
    return right.requests - left.requests;
  }
  return left.model.localeCompare(right.model);
}

function buildModelTotals(models: ModelUsagePoint[]) {
  return models.reduce(
    (totals, model) => ({
      requests: totals.requests + model.requests,
      inputTokens: totals.inputTokens + (model.inputTokens ?? 0),
      outputTokens: totals.outputTokens + (model.outputTokens ?? 0),
      cacheTokens: totals.cacheTokens + getCacheTokens(model),
      totalTokens: totals.totalTokens + (model.totalTokens ?? 0),
      cost: totals.cost + Number(model.cost ?? 0),
      actualCost: totals.actualCost + Number(model.actualCost ?? model.cost ?? 0)
    }),
    {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      cost: 0,
      actualCost: 0
    }
  );
}

function getCacheTokens(model: ModelUsagePoint) {
  return (model.cacheCreationTokens ?? 0) + (model.cacheReadTokens ?? 0);
}

function buildModelStatsWindowLabel(usageModels: DashboardModelsPayload | null, fallback: string) {
  if (usageModels?.startDate && usageModels.endDate) {
    return usageModels.startDate === usageModels.endDate
      ? usageModels.startDate
      : `${usageModels.startDate} - ${usageModels.endDate}`;
  }
  return fallback;
}

function formatShare(value: number, total: number) {
  if (total <= 0) {
    return "0.0%";
  }
  return `${((value / total) * 100).toFixed(1)}%`;
}
