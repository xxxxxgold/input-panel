import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AnalyticsLab } from "../src/features/analytics/AnalyticsLab";

describe("AnalyticsLab", () => {
  it("renders chart cards inside the shared tall chart container", () => {
    const html = renderToStaticMarkup(
      createElement(AnalyticsLab, {
        overview: {
          accounts: [
            {
              id: "account-1",
              siteId: "site-1",
              label: "主账号",
              email: "demo@example.com",
              sessionState: "ready",
              site: {
                id: "site-1",
                name: "AI INPUT",
                baseUrl: "https://example.com",
                createdAt: "2026-06-01T00:00:00.000Z",
                updatedAt: "2026-06-01T00:00:00.000Z"
              },
              cacheView: {
                fetchedAt: "2026-06-14T02:12:57.000Z",
                balance: 42.5,
                stats: {
                  totalRequests: 100_558,
                  todayRequests: 376,
                  todayActualCost: 103.6355,
                  todayInputTokens: 11_900_000,
                  todayCacheReadTokens: 6_800_000,
                  todayOutputTokens: 490_100,
                  todayTotalTokens: 111_200_000,
                  byPlatform: [
                    {
                      platform: "openai",
                      totalActualCost: 14980.4756,
                      totalRequests: 100_558,
                      totalTokens: 20_630_400_000
                    }
                  ]
                },
                subscriptions: []
              }
            }
          ],
          sites: [
            {
              id: "site-1",
              name: "AI INPUT",
              baseUrl: "https://example.com",
              createdAt: "2026-06-01T00:00:00.000Z",
              updatedAt: "2026-06-01T00:00:00.000Z"
            }
          ],
          totals: {
            todayRequests: 379,
            todayActualCost: 105.1355
          },
          platformSeries: [
            {
              platform: "openai",
              totalActualCost: 14980.4756,
              totalRequests: 100_567,
              totalTokens: 20_630_400_000
            }
          ],
          alerts: []
        } as any,
        selectedAccount: {
          id: "account-1",
          siteId: "site-1",
          label: "主账号",
          email: "demo@example.com",
          sessionState: "ready",
          site: {
            id: "site-1",
            name: "AI INPUT",
            baseUrl: "https://example.com",
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z"
          },
          cacheView: {
            fetchedAt: "2026-06-14T02:12:57.000Z",
            subscriptions: [],
            stats: {
              byPlatform: [
                {
                  platform: "openai",
                  totalActualCost: 14980.4756,
                  totalRequests: 100_558,
                  totalTokens: 20_630_400_000
                }
              ],
              totalRequests: 100_558
            }
          }
        } as any,
        managedKeys: {
          items: [
            {
              id: "key-1",
              name: "codex",
              status: "active",
              quota: 500,
              quotaUsed: 103.64,
              usage5h: 10,
              usage1d: 42,
              usage7d: 100,
              rateLimit5h: 100,
              rateLimit1d: 500,
              rateLimit7d: 3000
            }
          ],
          page: 1,
          pages: 1,
          total: 1
        } as any,
        usageStats: {
          totalRequests: 379,
          totalActualCost: 105.1355,
          totalTokens: 111_200_000,
          totalInputTokens: 11_900_000,
          totalOutputTokens: 490_100,
          totalCacheReadTokens: 6_800_000,
          totalCacheCreationTokens: 707_100_000,
          averageDurationMs: 38_100,
          rpm: 0,
          tpm: 0
        } as any,
        usageTrend: {
          startDate: "2026-06-07",
          endDate: "2026-06-14",
          trend: [
            {
              date: "2026-06-14",
              actualCost: 105.1355,
              totalCost: 105.1355,
              requests: 379,
              totalTokens: 111_200_000
            },
            {
              date: "2026-06-13",
              actualCost: 88.5,
              totalCost: 88.5,
              requests: 221,
              totalTokens: 91_200_000
            }
          ]
        } as any,
        usageModels: {
          models: [
            {
              model: "gpt-5.4",
              actualCost: 105.1355,
              cost: 105.1355,
              totalTokens: 111_200_000,
              inputTokens: 11_900_000,
              outputTokens: 490_100,
              cacheCreationTokens: 707_100_000,
              cacheReadTokens: 6_800_000
            },
            {
              model: "gpt-5.4-mini",
              actualCost: 26.12,
              cost: 26.12,
              totalTokens: 61_100_000,
              inputTokens: 8_000_000,
              outputTokens: 320_000,
              cacheCreationTokens: 120_000_000,
              cacheReadTokens: 4_200_000
            }
          ]
        } as any,
        usageRecords: {
          items: [
            {
              id: "usage-1",
              model: "gpt-5.4",
              apiKeyName: "codex",
              endpoint: "/responses",
              requestType: "stream",
              stream: true,
              reasoningEffort: "medium",
              userAgent: "Codex Desktop",
              createdAt: "2026-06-14T02:12:57.000Z",
              billingMode: "standard",
              billingType: 1,
              totalTokens: 688_100,
              actualCost: 0.47199,
              durationMs: 38_100,
              firstTokenMs: 1_200,
              inputCost: 0.08,
              outputCost: 0.2,
              cacheCreationCost: 0.01,
              cacheReadCost: 0.03,
              totalCost: 0.31,
              upstreamEndpoint: "/v1/responses",
              groupName: "CodeX Plus 月度",
              subscriptionName: "CodeX Plus 月度",
              platform: "openai",
              rateMultiplier: 1.5
            }
          ],
          page: 1,
          pages: 105,
          total: 2095
        } as any,
        usageScopeRows: [
          {
            id: "usage-1",
            model: "gpt-5.4",
            apiKeyName: "codex",
            endpoint: "/responses",
            requestType: "stream",
            stream: true,
            reasoningEffort: "medium",
            userAgent: "Codex Desktop",
            createdAt: "2026-06-14T02:12:57.000Z",
            billingMode: "standard",
            billingType: 1,
            totalTokens: 688_100,
            actualCost: 0.47199,
            durationMs: 38_100,
            firstTokenMs: 1_200,
            inputCost: 0.08,
            outputCost: 0.2,
            cacheCreationCost: 0.01,
            cacheReadCost: 0.03,
            totalCost: 0.31,
            upstreamEndpoint: "/v1/responses",
            groupName: "CodeX Plus 月度",
            subscriptionName: "CodeX Plus 月度",
            platform: "openai",
            rateMultiplier: 1.5
          },
          {
            id: "usage-2",
            model: "gpt-5.4-mini",
            apiKeyName: "codex",
            endpoint: "/chat/completions",
            requestType: "standard",
            stream: false,
            reasoningEffort: "low",
            userAgent: "Browser",
            createdAt: "2026-06-14T03:12:57.000Z",
            billingMode: "standard",
            billingType: 1,
            totalTokens: 128_000,
            actualCost: 0.081,
            durationMs: 8_100,
            firstTokenMs: 300,
            inputCost: 0.01,
            outputCost: 0.04,
            cacheCreationCost: 0.002,
            cacheReadCost: 0.001,
            totalCost: 0.053,
            upstreamEndpoint: "/v1/chat/completions",
            groupName: "CodeX Plus 年度",
            subscriptionName: "CodeX Plus 年度",
            platform: "openai",
            rateMultiplier: 1.52
          }
        ] as any,
        usageScopeMeta: {
          total: 2095,
          pages: 5,
          loadedPages: 5,
          pageSize: 500
        },
        subscriptionSummary: null,
        profileRecord: null,
        platformQuotas: null,
        keyUsageRows: [],
        keyUsageKeyId: "key-1",
        usageApiKeyFilter: "",
        usageStartDate: "2026-06-14",
        usageEndDate: "2026-06-14",
        onUsageApiKeyFilterChange: () => {},
        onUsageStartDateChange: () => {},
        onUsageEndDateChange: () => {},
        onUsageSearch: () => {},
        onKeyUsageSelect: () => {}
      })
    );

    expect(html).toContain("图表实验室");
    expect(html).toContain("chart-wrap tall analytics-chart-shell");
    expect(html.match(/class=\"analytics-meta-card\"/g)).toHaveLength(3);
    expect(html.match(/class=\"analytics-stat-card\"/g)).toHaveLength(8);
    expect(html).toContain("当前筛选范围已聚合 5 / 5 页，共 2095 条 usage 明细。");
    expect(html).toContain("当前样本为第 1 / 105 页，共 2095 条明细。");
    expect(html).toContain("延迟分位");
    expect(html).toContain("时段热力图");
    expect(html).toContain("Endpoint 上下游映射");
    expect(html).toContain("极值请求榜");
  });

  it("falls back to scoped rows when analytics summary requests are skipped", () => {
    const html = renderToStaticMarkup(
      createElement(AnalyticsLab, {
        overview: {
          accounts: [],
          sites: [],
          totals: {
            todayRequests: 2,
            todayActualCost: 0.6
          },
          platformSeries: [],
          alerts: []
        } as any,
        selectedAccount: {
          id: "account-1",
          siteId: "site-1",
          label: "主账号",
          email: "demo@example.com",
          sessionState: "ready",
          site: {
            id: "site-1",
            name: "AI INPUT",
            baseUrl: "https://example.com",
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z"
          },
          cacheView: {
            fetchedAt: "2026-06-14T02:12:57.000Z",
            subscriptions: [],
            stats: {
              byPlatform: [],
              totalRequests: 2
            }
          }
        } as any,
        managedKeys: {
          items: [],
          page: 1,
          pages: 1,
          total: 0
        } as any,
        usageStats: null,
        usageTrend: null,
        usageModels: null,
        usageRecords: null,
        usageScopeRows: [
          {
            id: "usage-1",
            model: "gpt-5.4",
            createdAt: "2026-06-14T02:12:57.000Z",
            totalTokens: 3000,
            inputTokens: 1000,
            outputTokens: 2000,
            cacheCreationTokens: 100,
            cacheReadTokens: 200,
            actualCost: 0.5,
            totalCost: 0.55,
            durationMs: 1000,
            endpoint: "/responses"
          },
          {
            id: "usage-2",
            model: "gpt-5.4-mini",
            createdAt: "2026-06-14T03:12:57.000Z",
            totalTokens: 1000,
            inputTokens: 400,
            outputTokens: 600,
            cacheCreationTokens: 0,
            cacheReadTokens: 50,
            actualCost: 0.1,
            totalCost: 0.12,
            durationMs: 2000,
            endpoint: "/chat/completions"
          }
        ] as any,
        usageScopeMeta: {
          total: 2,
          pages: 1,
          loadedPages: 1,
          pageSize: 500
        },
        subscriptionSummary: null,
        profileRecord: null,
        platformQuotas: null,
        keyUsageRows: [],
        keyUsageKeyId: "",
        usageApiKeyFilter: "",
        usageStartDate: "2026-06-14",
        usageEndDate: "2026-06-14",
        onUsageApiKeyFilterChange: () => {},
        onUsageStartDateChange: () => {},
        onUsageEndDateChange: () => {},
        onUsageSearch: () => {},
        onKeyUsageSelect: () => {}
      })
    );

    expect(html).toContain("当前总请求");
    expect(html).toContain("$0.6000");
    expect(html).toContain("4.0K");
    expect(html).toContain("当前样本使用筛选范围前 20 条，共 2 条明细。");
  });
});
