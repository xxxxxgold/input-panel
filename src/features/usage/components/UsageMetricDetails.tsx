import { compact } from "../../../shared/lib/formatters";
import { DetailItem, UsageMetricDetailItem } from "../../../shared/ui/DetailItem";
import type { UsageModelSummary } from "../model-summary";

export function UsageModelRequestDetails({
  models,
  loading = false
}: {
  models: UsageModelSummary[];
  loading?: boolean;
}) {
  if (loading) {
    return <DetailItem label="模型明细" value="正在统计模型明细..." />;
  }
  if (models.length === 0) {
    return <DetailItem label="模型明细" value="当前没有可展示的模型请求数据" />;
  }
  return (
    <>
      {models.map((model) => (
        <DetailItem
          key={`requests-${model.model}`}
          label={model.model}
          value={`${model.requests.toLocaleString()} 次`}
        />
      ))}
    </>
  );
}

export function UsageTokenMetricDetails({
  models,
  field,
  loading = false
}: {
  models: UsageModelSummary[];
  field: "input" | "output";
  loading?: boolean;
}) {
  if (loading) {
    return <DetailItem label="模型明细" value="正在统计模型明细..." />;
  }
  if (models.length === 0) {
    return <DetailItem label="模型明细" value="当前没有可展示的 Token 数据" />;
  }
  return (
    <>
      {models.map((model) => {
        const tokenValue = field === "input" ? model.inputTokens : model.outputTokens;
        const valueLabel = field === "input" ? "输入" : "输出";
        const description = field === "input"
          ? `缓存命中: 读取 ${compact(model.cacheReadTokens)}, 写入 ${compact(model.cacheCreationTokens)}`
          : `请求数 ${model.requests.toLocaleString()} 次, 全部 Token ${compact(model.totalTokens)}`;
        return (
          <UsageMetricDetailItem
            key={`${field}-${model.model}`}
            label={model.model}
            description={description}
            value={`${valueLabel} ${compact(tokenValue)}`}
          />
        );
      })}
    </>
  );
}
