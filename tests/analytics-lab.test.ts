// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/charts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/charts")>();
  return {
    ...original,
    EChartCard: () => createElement("div", { className: "analytics-test-chart-host" })
  };
});

import { AnalyticsLab } from "../src/features/analytics/AnalyticsLab";
import type {
  AccountCacheView,
  AccountRuntime,
  ManagedKeyRecord,
  OverviewPayload,
  PaginatedResult,
  PlatformQuotaPayload,
  SiteRecord,
  SubscriptionRecord,
  UsageAnalyticsAggregatePoint,
  UsageAnalyticsPayload,
  UsageRow,
  UsageStatsRecord
} from "../src/types";

type AnalyticsLabProps = Parameters<typeof AnalyticsLab>[0];
type OverviewOverrides = Omit<Partial<OverviewPayload>, "totals"> & {
  totals?: Partial<OverviewPayload["totals"]>;
};
type AccountCacheOverrides = Omit<Partial<AccountCacheView>, "stats"> & {
  stats?: Partial<AccountCacheView["stats"]>;
};
type AccountRuntimeOverrides = Omit<Partial<AccountRuntime>, "cacheView" | "site"> & {
  cacheView?: AccountCacheView | null;
  site?: SiteRecord;
};

const SITE: SiteRecord = {
  id: "site-1",
  name: "AI INPUT",
  baseUrl: "https://example.com",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z"
};

const TIMESTAMP = "2026-06-14T02:12:57.000Z";
const analyticsLabSource = readFileSync(
  resolve(process.cwd(), "src/features/analytics/AnalyticsLab.tsx"),
  "utf8"
);

function createOverview(overrides: OverviewOverrides = {}): OverviewPayload {
  const { totals, ...rest } = overrides;
  return {
    sites: [SITE],
    accounts: [],
    totals: {
      balance: 0,
      totalSites: 1,
      totalAccounts: 0,
      totalApiKeys: 0,
      activeApiKeys: 0,
      todayRequests: 0,
      totalRequests: 0,
      todayActualCost: 0,
      totalActualCost: 0,
      todayTokens: 0,
      totalTokens: 0,
      ...totals
    },
    alerts: [],
    platformSeries: [],
    modelSeries: [],
    trend: [],
    recentUsage: [],
    subscriptions: [],
    keys: [],
    generatedAt: TIMESTAMP,
    ...rest
  };
}

function createAccountCacheView(overrides: AccountCacheOverrides = {}): AccountCacheView {
  const { stats, ...rest } = overrides;
  return {
    fetchedAt: TIMESTAMP,
    online: true,
    siteName: SITE.name,
    balance: 0,
    stats: {
      totalApiKeys: 0,
      activeApiKeys: 0,
      todayRequests: 0,
      totalRequests: 0,
      todayActualCost: 0,
      totalActualCost: 0,
      todayCost: 0,
      totalCost: 0,
      todayTokens: 0,
      totalTokens: 0,
      todayInputTokens: 0,
      todayOutputTokens: 0,
      averageDurationMs: 0,
      byPlatform: [],
      byModel: [],
      ...stats
    },
    recentUsage: [],
    trend: [],
    keys: [],
    subscriptions: [],
    activeSubscription: null,
    alerts: [],
    ...rest
  };
}

function createAccountRuntime(overrides: AccountRuntimeOverrides = {}): AccountRuntime {
  return {
    id: "account-1",
    siteId: SITE.id,
    label: "主账号",
    email: "demo@example.com",
    balanceWarning: -1,
    lastLoginAt: TIMESTAMP,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    sessionState: "ready",
    lastError: null,
    site: SITE,
    cacheView: null,
    ...overrides
  };
}

function createPaginatedResult<T>(
  items: T[],
  overrides: Partial<Omit<PaginatedResult<T>, "items">> = {}
): PaginatedResult<T> {
  return {
    items,
    page: 1,
    pageSize: Math.max(items.length, 1),
    total: items.length,
    pages: items.length > 0 ? 1 : 0,
    ...overrides
  };
}

function createManagedKey(overrides: Partial<ManagedKeyRecord> = {}): ManagedKeyRecord {
  return {
    id: "key-1",
    name: "codex",
    status: "active",
    groupId: null,
    platform: "openai",
    groupName: null,
    expiresAt: null,
    lastUsedAt: TIMESTAMP,
    quota: 0,
    quotaUsed: 0,
    rateLimit5h: 0,
    rateLimit1d: 0,
    rateLimit7d: 0,
    usage5h: 0,
    usage1d: 0,
    usage7d: 0,
    apiKeyId: 3641,
    rawKey: null,
    userId: null,
    ipWhitelist: null,
    ipBlacklist: null,
    window5hStart: null,
    window1dStart: null,
    window7dStart: null,
    ...overrides
  };
}

function createSubscription(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    id: "sub-1",
    subscriptionKey: "upstream:sub-1",
    identityKind: "upstream",
    identityAmbiguous: false,
    groupId: null,
    name: "CodeX Plus 月度",
    status: "active",
    groupName: null,
    platform: "openai",
    expiresAt: null,
    daily: null,
    weekly: null,
    monthly: null,
    ...overrides
  };
}

function createUsageRow(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    id: "usage-1",
    createdAt: TIMESTAMP,
    model: "gpt-5.4",
    actualCost: 0,
    totalCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    ...overrides
  };
}

function createUsageStats(overrides: Partial<UsageStatsRecord> = {}): UsageStatsRecord {
  return {
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    totalActualCost: 0,
    averageDurationMs: 0,
    rpm: null,
    tpm: null,
    ...overrides
  };
}

function createAnalyticsPoint(
  overrides: Partial<UsageAnalyticsAggregatePoint> = {}
): UsageAnalyticsAggregatePoint {
  return {
    key: "unknown",
    label: "unknown",
    isOther: false,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    actualCost: 0,
    averageFirstTokenMs: 0,
    averageDurationMs: 0,
    averageRateMultiplier: 0,
    ...overrides
  };
}

function createUsageAnalytics(
  overrides: Partial<UsageAnalyticsPayload> = {}
): UsageAnalyticsPayload {
  return {
    version: 1,
    startDate: "2026-06-07",
    endDate: "2026-06-14",
    generatedAt: TIMESTAMP,
    matchedRows: 0,
    topN: 12,
    totals: createUsageStats(),
    trend: [],
    models: [],
    platforms: [],
    endpoints: [],
    apiKeys: [],
    groups: [],
    subscriptions: [],
    reasoningEfforts: [],
    requestTypes: [],
    reasoningRequestCombinations: [],
    userAgents: [],
    hourlyHeatmap: [],
    endpointFlows: [],
    costBreakdown: [],
    latencyPercentiles: { firstToken: null, duration: null },
    extremes: [],
    sampleRows: [],
    ...overrides
  };
}

function createPlatformQuotas(
  overrides: Partial<PlatformQuotaPayload> = {}
): PlatformQuotaPayload {
  return {
    platformQuotas: [],
    ...overrides
  };
}

function createAnalyticsLabProps(
  overrides: Partial<AnalyticsLabProps> = {}
): AnalyticsLabProps {
  return {
    overview: createOverview(),
    selectedAccount: null,
    loading: false,
    managedKeys: null,
    usageAnalytics: null,
    subscriptionSummary: null,
    profileRecord: null,
    platformQuotas: null,
    keyUsageRows: [],
    keyUsageKeyId: "",
    usageApiKeyFilter: "",
    usageStartDate: "",
    usageEndDate: "",
    onUsageApiKeyFilterChange: () => {},
    onUsageStartDateChange: () => {},
    onUsageEndDateChange: () => {},
    onUsageSearch: () => {},
    onKeyUsageSelect: () => {},
    ...overrides
  };
}

function renderAnalyticsLab(props: AnalyticsLabProps) {
  return renderToStaticMarkup(createElement(AnalyticsLab, props));
}

function renderAnalyticsLabClient(props: AnalyticsLabProps) {
  return render(createElement(AnalyticsLab, props));
}

afterEach(() => {
  cleanup();
});

describe("AnalyticsLab", () => {
  it("uses adaptive label space for subscription quota bars without changing the model chart", () => {
    const modelStart = analyticsLabSource.indexOf("function buildModelTokenOption");
    const subscriptionStart = analyticsLabSource.indexOf("function buildSubscriptionUsageOption");
    const subscriptionEnd = analyticsLabSource.indexOf("function buildPlatformQuotaOption", subscriptionStart);
    const modelSource = analyticsLabSource.slice(modelStart, subscriptionStart);
    const subscriptionSource = analyticsLabSource.slice(subscriptionStart, subscriptionEnd);

    expect(modelSource).toContain("left: 120");
    expect(modelSource).not.toContain("containLabel: true");
    expect(subscriptionSource).toContain("left: 12");
    expect(subscriptionSource).toContain("containLabel: true");
    expect(subscriptionSource).toContain("data: sorted.map((item) => item.dailyUsed)");
  });

  it("renders chart cards inside the shared tall chart container", () => {
    const html = renderAnalyticsLab(
      createAnalyticsLabProps({
        overview: createOverview({
          accounts: [
            createAccountRuntime({
              cacheView: createAccountCacheView({
                balance: 42.5,
                stats: {
                  totalRequests: 100_558,
                  todayRequests: 376,
                  todayActualCost: 103.6355,
                  totalActualCost: 14_980.4756,
                  totalTokens: 20_630_400_000,
                  todayTokens: 111_200_000,
                  todayInputTokens: 11_900_000,
                  todayOutputTokens: 490_100,
                  byPlatform: [
                    {
                      platform: "openai",
                      todayActualCost: 103.6355,
                      totalActualCost: 14_980.4756,
                      totalRequests: 100_558,
                      totalTokens: 20_630_400_000
                    }
                  ]
                },
                subscriptions: []
              })
            })
          ],
          totals: {
            todayRequests: 379,
            todayActualCost: 105.1355
          },
          platformSeries: [
            {
              platform: "openai",
              todayActualCost: 105.1355,
              totalActualCost: 14_980.4756,
              totalRequests: 100_567,
              totalTokens: 20_630_400_000
            }
          ]
        }),
        selectedAccount: createAccountRuntime({
          cacheView: createAccountCacheView({
            subscriptions: [],
            stats: {
              totalRequests: 100_558,
              byPlatform: [
                {
                  platform: "openai",
                  todayActualCost: 103.6355,
                  totalActualCost: 14_980.4756,
                  totalRequests: 100_558,
                  totalTokens: 20_630_400_000
                }
              ]
            }
          })
        }),
        managedKeys: createPaginatedResult([
          createManagedKey({
            quota: 500,
            quotaUsed: 103.64,
            usage5h: 10,
            usage1d: 42,
            usage7d: 100,
            rateLimit5h: 100,
            rateLimit1d: 500,
            rateLimit7d: 3000
          })
        ]),
        usageAnalytics: createUsageAnalytics({
          startDate: "2026-06-14",
          endDate: "2026-06-14",
          matchedRows: 2095,
          totals: createUsageStats({
            totalRequests: 379,
            totalActualCost: 105.1355,
            totalCost: 105.1355,
            totalTokens: 111_200_000,
            totalInputTokens: 11_900_000,
            totalOutputTokens: 490_100,
            totalCacheReadTokens: 6_800_000,
            totalCacheCreationTokens: 707_100_000,
            averageDurationMs: 38_100,
            rpm: 0,
            tpm: 0
          }),
          trend: [
            {
              date: "2026-06-14",
              actualCost: 105.1355,
              totalCost: 105.1355,
              requests: 379,
              totalTokens: 111_200_000,
              inputTokens: 11_900_000,
              outputTokens: 490_100,
              cacheReadTokens: 6_800_000,
              cacheWriteTokens: 707_100_000
            }
          ],
          models: [
            createAnalyticsPoint({
              key: "gpt-5.4",
              label: "gpt-5.4",
              requests: 379,
              actualCost: 105.1355,
              totalCost: 105.1355,
              totalTokens: 111_200_000,
              inputTokens: 11_900_000,
              outputTokens: 490_100,
              cacheCreationTokens: 707_100_000,
              cacheReadTokens: 6_800_000,
              averageDurationMs: 38_100
            })
          ],
          platforms: [
            createAnalyticsPoint({
              key: "openai",
              label: "openai",
              requests: 379,
              actualCost: 105.1355,
              totalTokens: 111_200_000
            })
          ],
          sampleRows: [
            createUsageRow({
              id: "usage-1",
              model: "gpt-5.4",
              apiKeyName: "codex",
              endpoint: "/responses",
              totalTokens: 688_100,
              actualCost: 0.47199,
              durationMs: 38_100,
              firstTokenMs: 1_200
            })
          ]
        }),
        keyUsageRows: [],
        keyUsageKeyId: "key-1",
        usageApiKeyFilter: "",
        usageStartDate: "2026-06-14",
        usageEndDate: "2026-06-14"
      })
    );

    expect(html).toContain("核心概览");
    expect(html).toContain("chart-wrap tall analytics-chart-shell");
    expect(html.match(/class="analytics-scope-item"/g)).toHaveLength(3);
    expect(html.match(/class="analytics-stat-card"/g)).toHaveLength(8);
    expect(html).toContain("当前筛选范围共 2,095 条本地明细。");
    expect(html).toContain("成本 / 请求 / Token 趋势");
    expect(html).toContain("模型成本排行");
    expect(html).toContain("平台全景");
    expect(html).toContain("缓存效率");
    expect(html).not.toContain("时段热力图");
    expect(html).not.toContain("密钥限额窗口");
  });

  it("renders aggregate truth from the bounded analytics payload", () => {
    const html = renderAnalyticsLab(
      createAnalyticsLabProps({
        overview: createOverview({
          sites: [],
          totals: {
            totalSites: 0,
            todayRequests: 2,
            todayActualCost: 0.6
          }
        }),
        selectedAccount: createAccountRuntime({
          cacheView: createAccountCacheView({
            subscriptions: [],
            stats: {
              totalRequests: 2,
              byPlatform: []
            }
          })
        }),
        managedKeys: createPaginatedResult([]),
        usageAnalytics: createUsageAnalytics({
          startDate: "2026-06-14",
          endDate: "2026-06-14",
          matchedRows: 2,
          totals: createUsageStats({
            totalRequests: 2,
            totalInputTokens: 1400,
            totalOutputTokens: 2600,
            totalCacheCreationTokens: 100,
            totalCacheReadTokens: 250,
            totalCacheTokens: 350,
            totalTokens: 4000,
            totalCost: 0.67,
            totalActualCost: 0.6,
            averageDurationMs: 1500
          }),
          models: [
            createAnalyticsPoint({
              key: "gpt-5.4",
              label: "gpt-5.4",
              requests: 1,
              inputTokens: 1000,
              outputTokens: 2000,
              cacheCreationTokens: 100,
              cacheReadTokens: 200,
              totalTokens: 3000,
              totalCost: 0.55,
              actualCost: 0.5,
              averageDurationMs: 1000
            })
          ],
          sampleRows: [
            createUsageRow({
              id: "usage-1",
              model: "gpt-5.4",
              totalTokens: 3000,
              actualCost: 0.5,
              durationMs: 1000,
              endpoint: "/responses"
            }),
            createUsageRow({
              id: "usage-2",
              model: "gpt-5.4-mini",
              totalTokens: 1000,
              actualCost: 0.1,
              durationMs: 2000,
              endpoint: "/chat/completions"
            })
          ]
        }),
        keyUsageRows: [],
        keyUsageKeyId: "",
        usageApiKeyFilter: "",
        usageStartDate: "2026-06-14",
        usageEndDate: "2026-06-14"
      })
    );

    expect(html).toContain("当前总请求");
    expect(html).toContain("$0.6000");
    expect(html).toContain("4.0K");
    expect(html).toContain("当前筛选范围共 2 条本地明细。");
  });

  it("renders an explicit empty usage source state without a synthetic scope", () => {
    const html = renderAnalyticsLab(createAnalyticsLabProps());

    expect(html).toContain("当前还没有筛选范围聚合数据。");
    expect(html).toContain("当前图表暂无数据");
  });

  it("distinguishes a completed empty range from an unloaded analytics scope", () => {
    const html = renderAnalyticsLab(
      createAnalyticsLabProps({
        usageAnalytics: createUsageAnalytics()
      })
    );

    expect(html).toContain("当前筛选范围没有用量明细。");
    expect(html).not.toContain("当前还没有筛选范围聚合数据。");
  });

  it("uses cached keys and cached subscriptions so analytics cards do not stay empty while extra requests are pending", () => {
    const { getByRole, queryByText } = renderAnalyticsLabClient(
      createAnalyticsLabProps({
        overview: createOverview({
          sites: [],
          totals: {
            totalSites: 0,
            todayRequests: 6,
            todayActualCost: 12.34
          }
        }),
        selectedAccount: createAccountRuntime({
          cacheView: createAccountCacheView({
            keys: [
              createManagedKey({
                id: "3641",
                quota: 0,
                quotaUsed: 0,
                usage5h: 0,
                usage1d: 0,
                usage7d: 0,
                rateLimit5h: 0,
                rateLimit1d: 0,
                rateLimit7d: 0
              })
            ],
            subscriptions: [
              createSubscription({
                name: "CodeX Plus 月度",
                groupName: "CodeX Plus 月度",
                expiresAt: "2027-06-13T13:54:40+08:00"
              })
            ],
            stats: {
              totalRequests: 6,
              byPlatform: []
            }
          })
        }),
        usageAnalytics: createUsageAnalytics({
          matchedRows: 1,
          apiKeys: [
            createAnalyticsPoint({
              key: "3641",
              label: "codex",
              requests: 1,
              totalTokens: 6000,
              totalCost: 1.25,
              actualCost: 1.25
            })
          ],
          subscriptions: [
            createAnalyticsPoint({
              key: "sub-1",
              label: "CodeX Plus 月度",
              requests: 1,
              totalTokens: 6000,
              totalCost: 1.25,
              actualCost: 1.25
            })
          ]
        }),
        keyUsageRows: [],
        keyUsageKeyId: "3641",
        usageApiKeyFilter: "",
        usageStartDate: "2026-06-14",
        usageEndDate: "2026-06-14"
      })
    );

    const assetsTab = getByRole("tab", { name: /账号与资产/ });
    fireEvent.click(assetsTab);

    expect(assetsTab.getAttribute("aria-selected")).toBe("true");
    expect(queryByText("密钥状态分布")).not.toBeNull();
    expect(queryByText("密钥额度与已用")).not.toBeNull();
    expect(queryByText("订阅额度使用")).not.toBeNull();
    expect(queryByText("当前密钥没有配置周期限额")).not.toBeNull();
    expect(queryByText("成本 / 请求 / Token 趋势")).toBeNull();
  });

  it("falls back to platform efficiency and account health when quota and alert charts have no direct source data", () => {
    const { getByRole, getByText } = renderAnalyticsLabClient(
      createAnalyticsLabProps({
        overview: createOverview({
          accounts: [
            createAccountRuntime({
              cacheView: createAccountCacheView({
                alerts: [],
                keys: [],
                subscriptions: [],
                stats: {
                  totalRequests: 2,
                  byPlatform: []
                }
              })
            })
          ],
          sites: [],
          totals: {
            totalSites: 0,
            totalAccounts: 1,
            todayRequests: 2,
            todayActualCost: 0.6
          }
        }),
        managedKeys: createPaginatedResult([]),
        usageAnalytics: createUsageAnalytics({
          matchedRows: 2,
          platforms: [
            createAnalyticsPoint({
              key: "openai",
              label: "openai",
              requests: 1,
              totalTokens: 3000,
              actualCost: 0.5
            }),
            createAnalyticsPoint({
              key: "anthropic",
              label: "anthropic",
              requests: 1,
              totalTokens: 1000,
              actualCost: 0.1
            })
          ]
        }),
        platformQuotas: createPlatformQuotas(),
        keyUsageRows: [],
        keyUsageKeyId: "",
        usageApiKeyFilter: "",
        usageStartDate: "2026-06-14",
        usageEndDate: "2026-06-14"
      })
    );

    fireEvent.click(getByRole("tab", { name: /账号与资产/ }));

    const platformCard = getByText("平台额度").closest(".analytics-chart-card");
    const alertCard = getByText("告警严重级别").closest(".analytics-chart-card");

    expect(platformCard?.textContent).not.toContain("当前图表暂无数据");
    expect(alertCard?.textContent).not.toContain("当前图表暂无数据");
  });

  it("switches analytics views with tab clicks and keyboard navigation", () => {
    const { getByRole, queryByText } = renderAnalyticsLabClient(createAnalyticsLabProps());
    const performanceTab = getByRole("tab", { name: /性能与请求/ });

    fireEvent.click(performanceTab);

    expect(performanceTab.getAttribute("aria-selected")).toBe("true");
    expect(queryByText("请求样本散点")).not.toBeNull();
    expect(queryByText("尚未加载 usage 样本。")).not.toBeNull();
    expect(queryByText("成本 / 请求 / Token 趋势")).toBeNull();

    fireEvent.keyDown(performanceTab, { key: "ArrowRight" });

    const assetsTab = getByRole("tab", { name: /账号与资产/ });
    expect(assetsTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(assetsTab);
    expect(queryByText("密钥限额窗口")).not.toBeNull();
    expect(queryByText("请求样本散点")).toBeNull();
  });
});
