import type { DashboardModelsPayload, UsageRow } from "../../types";

export interface UsageModelSummary {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  actualCost: number;
}

export function summarizeUsageRowsByModel(rows: UsageRow[]): UsageModelSummary[] {
  const bucket = new Map<string, UsageModelSummary>();

  for (const row of rows) {
    const key = row.model || "unknown";
    const current = bucket.get(key) ?? {
      model: key,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      actualCost: 0
    };

    current.requests += 1;
    current.inputTokens += row.inputTokens ?? 0;
    current.outputTokens += row.outputTokens ?? 0;
    current.cacheCreationTokens += row.cacheCreationTokens ?? 0;
    current.cacheReadTokens += row.cacheReadTokens ?? 0;
    current.totalTokens += row.totalTokens ?? 0;
    current.actualCost += row.actualCost ?? 0;
    bucket.set(key, current);
  }

  return Array.from(bucket.values()).sort((left, right) => {
    if (right.requests !== left.requests) {
      return right.requests - left.requests;
    }
    return right.totalTokens - left.totalTokens;
  });
}

export function summarizeDashboardModels(modelsPayload: DashboardModelsPayload | null): UsageModelSummary[] {
  if (!modelsPayload?.models.length) {
    return [];
  }

  return [...modelsPayload.models]
    .map((model) => ({
      model: model.model || "unknown",
      requests: model.requests ?? 0,
      inputTokens: model.inputTokens ?? 0,
      outputTokens: model.outputTokens ?? 0,
      cacheCreationTokens: model.cacheCreationTokens ?? 0,
      cacheReadTokens: model.cacheReadTokens ?? 0,
      totalTokens: model.totalTokens ?? 0,
      actualCost: model.actualCost ?? 0
    }))
    .sort((left, right) => {
      if (right.requests !== left.requests) {
        return right.requests - left.requests;
      }
      return right.totalTokens - left.totalTokens;
    });
}
