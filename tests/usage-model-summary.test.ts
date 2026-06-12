import { describe, expect, it } from "vitest";

import { summarizeDashboardModels } from "../src/features/usage/model-summary";

describe("summarizeDashboardModels", () => {
  it("reuses dashboard models without requiring raw usage pagination", () => {
    const summary = summarizeDashboardModels({
      startDate: "2026-06-12",
      endDate: "2026-06-12",
      models: [
        {
          model: "gpt-4.1",
          requests: 12,
          inputTokens: 3200,
          outputTokens: 1100,
          cacheCreationTokens: 22,
          cacheReadTokens: 18,
          totalTokens: 4340,
          cost: 1.28,
          actualCost: 1.12
        }
      ]
    });

    expect(summary).toEqual([
      {
        model: "gpt-4.1",
        requests: 12,
        inputTokens: 3200,
        outputTokens: 1100,
        cacheCreationTokens: 22,
        cacheReadTokens: 18,
        totalTokens: 4340,
        actualCost: 1.12
      }
    ]);
  });
});
