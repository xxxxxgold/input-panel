import {
  buildTrendAreaChartOption,
  EChartCard,
  normalizeTrendChartData
} from "../../../charts";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { SectionCard } from "../../../shared/ui/SectionCard";

type UsageTrendPoint = Parameters<typeof normalizeTrendChartData>[0][number];

export function UsageTrendSection({
  title = "趋势",
  subtitle,
  points,
  emptyTitle = "当前没有趋势数据",
  emptyDetail = "站点未返回 dashboard/trend 数据。"
}: {
  title?: string;
  subtitle: string;
  points: UsageTrendPoint[];
  emptyTitle?: string;
  emptyDetail?: string;
}) {
  return (
    <SectionCard title={title} subtitle={subtitle}>
      {points.length > 0 ? (
        <div className="chart-wrap tall">
          <EChartCard
            option={buildTrendAreaChartOption({
              data: normalizeTrendChartData(points),
              series: ["actualCost", "requests", "cacheCreationTokens", "cacheReadTokens", "cacheHitRate"]
            })}
          />
        </div>
      ) : (
        <EmptyState title={emptyTitle} detail={emptyDetail} compact />
      )}
    </SectionCard>
  );
}
