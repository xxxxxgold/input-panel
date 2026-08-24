// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, useState } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/lib/clipboard", () => ({
  copyTextToClipboard: vi.fn()
}));

import { FloatingRailDrawer, type FloatingRailDrawerPanelKey } from "../src/app/FloatingRailDrawer";
import { copyTextToClipboard } from "../src/shared/lib/clipboard";
import type {
  CodexRadarModelIqPayload,
  ServiceStatusPayload,
  SiteRecord,
  SitePublicEndpointsPayload
} from "../src/types";
import type { TopbarSubscriptionPreviewRecord } from "../src/subscription-view";

const selectedSite: SiteRecord = {
  id: "site-1",
  name: "AI INPUT",
  baseUrl: "https://ai.input.im",
  createdAt: "2026-07-03T08:00:00.000Z",
  updatedAt: "2026-07-03T08:00:00.000Z"
};

const serviceStatus: ServiceStatusPayload = {
  allOk: false,
  generatedAt: 1781449307,
  services: [
    {
      model: "gpt-5.5",
      uptimePct: 100,
      last: {
        ts: 1781449307,
        ok: true,
        latencyMs: 1379,
        error: null
      },
      history: []
    },
    {
      model: "gpt-5.4",
      uptimePct: 97.1,
      last: {
        ts: 1781449307,
        ok: false,
        latencyMs: null,
        error: "probe timeout"
      },
      history: []
    }
  ]
};

const sitePublicEndpoints: SitePublicEndpointsPayload = {
  siteId: "site-1",
  siteName: "AI INPUT",
  apiBaseUrl: "https://ai.input.im",
  endpoints: [
    {
      name: "默认API",
      endpoint: "https://ai.input.im",
      description: "当前站点默认入口",
      pingLatencyMs: 1000,
      pingStatusCode: 200,
      pingCheckedAt: "2026-07-03T08:12:05.000Z",
      pingError: null
    },
    {
      name: "Cloudflare ( 国际优化 )",
      endpoint: "https://input.codes",
      description: "国际优化",
      pingLatencyMs: null,
      pingStatusCode: null,
      pingCheckedAt: "2026-07-03T08:12:06.000Z",
      pingError: "请求超时"
    },
    {
      name: "黄色下界入口",
      endpoint: "https://steady-start.example.com",
      description: "黄色下界",
      pingLatencyMs: 1001,
      pingStatusCode: 200,
      pingCheckedAt: "2026-07-03T08:12:07.000Z",
      pingError: null
    },
    {
      name: "黄色上界入口",
      endpoint: "https://steady-end.example.com",
      description: "黄色上界",
      pingLatencyMs: 3000,
      pingStatusCode: 200,
      pingCheckedAt: "2026-07-03T08:12:08.000Z",
      pingError: null
    },
    {
      name: "红色入口",
      endpoint: "https://slow.example.com",
      description: "超过黄色上界",
      pingLatencyMs: 3001,
      pingStatusCode: 200,
      pingCheckedAt: "2026-07-03T08:12:09.000Z",
      pingError: null
    }
  ],
  fetchedAt: "2026-07-03T08:12:00.000Z",
  lastError: null
};

const codexRadarModelIq: CodexRadarModelIqPayload = {
  items: [
    { id: "sol-max", label: "GPT-5.6 Sol max", model: "gpt-5.6-sol", reasoningEffort: "max", score: 106.3, passed: 79, averageCostUsd: 9.44, status: "green", observedAt: "2026-07-21T18:07:02+08:00" },
    { id: "terra-max", label: "GPT-5.6 Terra max", model: "gpt-5.6-terra", reasoningEffort: "max", score: 99.5, passed: 74, averageCostUsd: 4.65, status: "green", observedAt: "2026-07-21T18:07:02+08:00" },
    { id: "sol-xhigh", label: "GPT-5.6 Sol xhigh", model: "gpt-5.6-sol", reasoningEffort: "xhigh", score: 97.7, passed: 72, averageCostUsd: 7.01, status: "green", observedAt: "2026-07-21T18:07:02+08:00" },
    { id: "sol-medium", label: "GPT-5.6 Sol medium", model: "gpt-5.6-sol", reasoningEffort: "medium", score: 94.2, passed: 70, averageCostUsd: 3.45, status: "yellow", observedAt: "2026-07-21T18:07:02+08:00" },
    { id: "sol-high", label: "GPT-5.6 Sol high", model: "gpt-5.6-sol", reasoningEffort: "high", score: 94.2, passed: 70, averageCostUsd: 5.09, status: "yellow", observedAt: "2026-07-21T18:07:02+08:00" },
    { id: "excluded", label: "GPT-5.5 xhigh", model: "gpt-5.5", reasoningEffort: "xhigh", score: 94.2, passed: 70, averageCostUsd: 5.87, status: "yellow", observedAt: "2026-07-21T18:07:02+08:00" }
  ],
  sourceUpdatedAt: "2026-07-21T18:07:02+08:00",
  fetchedAt: "2026-07-21T18:10:00+08:00",
  lastError: null,
  isStale: false
};

const subscriptions: TopbarSubscriptionPreviewRecord[] = [
  {
    id: "sub-1",
    name: "CodeX Plus 年度",
    status: "active",
    statusLabel: "正常",
    expiresAt: "2027-05-18T22:42:23+08:00",
    remainingDaysLabel: "剩余 340 天",
    accountLabel: "主账号",
    siteName: "AI INPUT",
    quota: {
      label: "每日",
      used: 437.11,
      limit: 500
    },
    quotaProgress: {
      percent: 87.422,
      rawPercent: 87.422,
      tone: "quota-tier-90"
    },
    indicatorTone: "quota-tier-90"
  }
];

function renderDrawer(activePanel: FloatingRailDrawerPanelKey | null, overrides: Partial<Parameters<typeof FloatingRailDrawer>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(FloatingRailDrawer, {
      activePanel,
      onActivePanelChange: () => {},
      selectedSite,
      sitePublicEndpoints,
      sitePublicEndpointsLoading: false,
      sitePublicEndpointsSyncing: false,
      sitePublicEndpointsPinging: false,
      sitePublicEndpointsLastError: null,
      serviceStatus,
      serviceStatusLoading: false,
      serviceStatusRequestInFlight: false,
      serviceStatusLastError: null,
      serviceStatusRefreshIntervalSeconds: 9,
      codexRadarModelIq,
      codexRadarModelIqLoading: false,
      codexRadarModelIqRefreshing: false,
      codexRadarModelIqIsStale: false,
      codexRadarModelIqLastError: null,
      usageStatusLabel: "1 个有效订阅",
      subscriptionCount: 1,
      subscriptionPreviewRecords: subscriptions,
      onRefreshServiceStatus: () => {},
      onRefreshCodexRadarModelIq: () => {},
      onOpenServiceStatus: () => {},
      onOpenSubscriptions: () => {},
      ...overrides
    })
  );
}

function renderInteractiveDrawer(overrides: Partial<Parameters<typeof FloatingRailDrawer>[0]> = {}) {
  return render(
    createElement(FloatingRailDrawer, {
      activePanel: "serviceStatus",
      onActivePanelChange: () => {},
      selectedSite,
      sitePublicEndpoints,
      sitePublicEndpointsLoading: false,
      sitePublicEndpointsSyncing: false,
      sitePublicEndpointsPinging: false,
      sitePublicEndpointsLastError: null,
      serviceStatus,
      serviceStatusLoading: false,
      serviceStatusRequestInFlight: false,
      serviceStatusLastError: null,
      serviceStatusRefreshIntervalSeconds: 9,
      codexRadarModelIq,
      codexRadarModelIqLoading: false,
      codexRadarModelIqRefreshing: false,
      codexRadarModelIqIsStale: false,
      codexRadarModelIqLastError: null,
      usageStatusLabel: "1 个有效订阅",
      subscriptionCount: 1,
      subscriptionPreviewRecords: subscriptions,
      onRefreshServiceStatus: () => {},
      onRefreshCodexRadarModelIq: () => {},
      onOpenServiceStatus: () => {},
      onOpenSubscriptions: () => {},
      ...overrides
    })
  );
}

function renderStatefulDrawer(overrides: Partial<Parameters<typeof FloatingRailDrawer>[0]> = {}) {
  function DrawerHarness() {
    const [activePanel, setActivePanel] = useState<FloatingRailDrawerPanelKey | null>(null);

    return createElement(FloatingRailDrawer, {
      activePanel,
      onActivePanelChange: setActivePanel,
      selectedSite,
      sitePublicEndpoints,
      sitePublicEndpointsLoading: false,
      sitePublicEndpointsSyncing: false,
      sitePublicEndpointsPinging: false,
      sitePublicEndpointsLastError: null,
      serviceStatus,
      serviceStatusLoading: false,
      serviceStatusRequestInFlight: false,
      serviceStatusLastError: null,
      serviceStatusRefreshIntervalSeconds: 9,
      codexRadarModelIq,
      codexRadarModelIqLoading: false,
      codexRadarModelIqRefreshing: false,
      codexRadarModelIqIsStale: false,
      codexRadarModelIqLastError: null,
      usageStatusLabel: "1 个有效订阅",
      subscriptionCount: 1,
      subscriptionPreviewRecords: subscriptions,
      onRefreshServiceStatus: () => {},
      onRefreshCodexRadarModelIq: () => {},
      onOpenServiceStatus: () => {},
      onOpenSubscriptions: () => {},
      ...overrides
    });
  }

  return render(createElement(DrawerHarness));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FloatingRailDrawer", () => {
  it("renders four collapsed icon entries and hides the drawer panel", () => {
    const html = renderDrawer(null);

    expect(html).toContain("floating-rail-drawer");
    expect(html).toContain("floating-rail-drawer-tabs");
    expect(html).toContain("floating-rail-drawer-panel");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('aria-label="站点 API 入口"');
    expect(html).toContain('aria-label="服务状态详情"');
    expect(html).toContain('aria-label="降智雷达详情"');
    expect(html).toContain('aria-label="订阅使用情况详情"');
    expect(html).toContain("topbar-endpoint-latency-dots");
    expect(html).toContain("topbar-endpoint-latency-indicator fast");
    expect(html).toContain("topbar-endpoint-latency-indicator steady");
    expect(html).toContain("topbar-endpoint-latency-indicator slow");
    expect(html).toContain("topbar-subscription-dot quota-tier-90");
    expect(html.match(/topbar-codex-radar-indicator/g)).toHaveLength(5);
    expect(html.indexOf('aria-label="服务状态详情"')).toBeLessThan(html.indexOf('aria-label="订阅使用情况详情"'));
    expect(html.indexOf('aria-label="降智雷达详情"')).toBeLessThan(html.indexOf('aria-label="订阅使用情况详情"'));
    expect(html.indexOf('aria-label="订阅使用情况详情"')).toBeLessThan(html.indexOf('aria-label="站点 API 入口"'));
    expect(html).not.toContain("空白抽屉");
  });

  it("renders compact drawer metadata without redundant counts", () => {
    const html = renderDrawer("serviceStatus");

    expect(html).toContain('class="topbar-service-status-heading"');
    expect(html).toContain('class="topbar-service-status-title-row"');
    expect(html).toContain('class="topbar-service-status-summary"');
    expect(html).toContain('class="topbar-service-status-hint"');
    expect(html).toContain('class="topbar-service-status-row"');
    expect(html).toContain('class="topbar-service-status-detail"');
    expect(html).toContain('class="topbar-codex-radar-hint"');
    expect(html).toContain('class="topbar-subscription-summary-hint"');
    expect(html).toContain('class="topbar-subscription-summary-total-used"');
    expect(html).toMatch(/<div class="topbar-subscription-summary-line"><span class="topbar-card-label">订阅<\/span><span class="topbar-subscription-summary-meta">/);
    expect(html).toContain("今日余额 $62.89");
    expect(html).toContain("总已用 87.4%");
    expect(html).not.toContain("已用 $437.11");
    expect(html).not.toContain("topbar-metric");
    expect(html).not.toContain("5 个入口");
    expect(html).not.toContain("前五名");
  });

  it("renders five Codex Radar indicators for fresh, stale, and failed snapshots", () => {
    const staleHtml = renderDrawer(null, { codexRadarModelIqIsStale: true });
    const failedHtml = renderDrawer(null, {
      codexRadarModelIq: null,
      codexRadarModelIqLastError: "模型测评读取失败"
    });
    const emptyHtml = renderDrawer(null, { codexRadarModelIq: null });

    expect(staleHtml.match(/topbar-codex-radar-indicator warning/g)).toHaveLength(5);
    expect(failedHtml.match(/topbar-codex-radar-indicator critical/g)).toHaveLength(5);
    expect(emptyHtml.match(/topbar-codex-radar-indicator neutral/g)).toHaveLength(5);
  });

  it("renders cached public endpoints inside the drawer", () => {
    const html = renderDrawer("siteEndpoints");

    expect(html).toContain("topbar-site-endpoints-panel");
    expect(html).toContain("默认API");
    expect(html).toContain("https://ai.input.im");
    expect(html).toContain("Cloudflare ( 国际优化 )");
    expect(html).toContain("https://input.codes");
    expect(html).toContain("topbar-endpoint-chip");
    expect(html).toContain("topbar-endpoint-latency-dot fast");
    expect(html).toContain("topbar-endpoint-latency-dot steady");
    expect(html).toContain("topbar-endpoint-latency-dot slow");
    expect(html).toContain("status-pill ready");
    expect(html).toContain("status-pill warning");
    expect(html).toContain(">1000 ms<");
    expect(html).toContain(">1001 ms<");
    expect(html).toContain(">3000 ms<");
    expect(html).toContain(">3001 ms<");
    expect(html).toContain(">连接失败<");
    expect(html.indexOf("topbar-endpoint-main")).toBeLessThan(html.indexOf("topbar-endpoint-value"));
  });

  it("keeps cached public endpoints visible after a refresh error and renders retry", () => {
    const html = renderDrawer("siteEndpoints", {
      sitePublicEndpointsLastError: "上游入口暂时不可用",
      onRetrySitePublicEndpoints: () => {}
    });
    const source = readFileSync(resolve(process.cwd(), "src/app/FloatingRailDrawer.tsx"), "utf8");

    expect(html).toContain("https://ai.input.im");
    expect(html).toContain("入口刷新失败, 当前入口仍可使用: 上游入口暂时不可用");
    expect(html).toContain("重新同步");
    expect(html).toContain('role="alert"');
    expect(source).toContain("onClick={onRetrySitePublicEndpoints}");
  });

  it("renders the endpoint error and retry when no snapshot is available", () => {
    const html = renderDrawer("siteEndpoints", {
      sitePublicEndpoints: null,
      sitePublicEndpointsLastError: "站点入口读取失败",
      onRetrySitePublicEndpoints: () => {}
    });

    expect(html).toContain("站点入口读取失败");
    expect(html).toContain("重新同步站点入口");
    expect(html).not.toContain("当前入口仍可使用");
  });

  it("offers recovery for an empty endpoint snapshot when retry is available", () => {
    const html = renderDrawer("siteEndpoints", {
      sitePublicEndpoints: null,
      onRetrySitePublicEndpoints: () => {}
    });

    expect(html).toContain("当前站点还没有缓存到可展示的 API 入口");
    expect(html).toContain("重新同步站点入口");
  });

  it("does not render an API entry indicator before a site is selected", () => {
    const html = renderDrawer(null, {
      selectedSite: null,
      sitePublicEndpoints: null
    });

    expect(html).not.toContain("topbar-endpoint-latency-dots");
    expect(html).not.toContain("topbar-endpoint-latency-indicator pending");
  });

  it("renders the IQ card between service status and subscriptions", () => {
    const html = renderDrawer("serviceStatus");

    expect(html).toContain("topbar-site-endpoints-panel");
    expect(html).toContain("topbar-service-status-panel");
    expect(html).toContain("topbar-codex-radar-panel");
    expect(html).toContain("topbar-subscription-summary-line");
    expect(html).toContain("API端点地址");
    expect(html).toContain("服务状态");
    expect(html).toContain("降智雷达 · IQ Top 5");
    expect(html).toContain("订阅");
    expect(html.indexOf("topbar-service-status-panel")).toBeLessThan(html.indexOf("topbar-subscription-summary-head"));
    expect(html.indexOf("topbar-service-status-panel")).toBeLessThan(html.indexOf("topbar-codex-radar-panel"));
    expect(html.indexOf("topbar-codex-radar-panel")).toBeLessThan(html.indexOf("topbar-subscription-summary-head"));
    expect(html.indexOf("topbar-subscription-summary-head")).toBeLessThan(html.indexOf("topbar-site-endpoints-panel"));
  });

  it("shows the first five IQ rows in a compact layout", () => {
    const html = renderDrawer("serviceStatus");

    expect(html).toContain('title="推理强度 high">high</span>');
    expect(html).toContain("IQ 106.3");
    expect(html).toContain("$9.44 / 任务");
    expect(html).not.toContain("通过 79 项");
    expect(html).toContain("GPT-5.6 Sol");
    expect(html).not.toContain("GPT-5.5 xhigh");
    expect(html).toContain('class="codex-radar-effort-pill effort-max"');
    expect(html).toContain('class="codex-radar-effort-pill effort-high"');
    expect(html).toContain('class="topbar-codex-radar-heading"');
    expect(html).toContain("源数据更新");
    expect(html).not.toContain("前五名");
    expect(html).not.toContain("5 个档位");
    expect(html).not.toContain("5 项");
    expect(html).toMatch(/<div class="topbar-codex-radar-title-row"><div class="topbar-codex-radar-model"><strong><span class="topbar-codex-radar-rank">1<\/span>GPT-5\.6 Sol<\/strong><span class="codex-radar-effort-pill effort-max" title="推理强度 max">max<\/span><\/div><div class="topbar-codex-radar-summary"><span class="status-pill ready topbar-codex-radar-score">IQ 106\.3<\/span><strong class="topbar-codex-radar-cost">\$9\.44 \/ 任务<\/strong><\/div><\/div>/);
    expect(html).not.toContain("gpt-5.6-sol · max");
    expect(html).not.toContain("gpt-5.6-terra · max");
    expect(html).toContain("数据来自 Codex 雷达");
  });

  it("keeps a stale IQ snapshot visible after its refresh fails", () => {
    const html = renderDrawer("serviceStatus", {
      codexRadarModelIq: { ...codexRadarModelIq, isStale: false, lastError: null },
      codexRadarModelIqIsStale: true,
      codexRadarModelIqLastError: "上游暂时不可用"
    });

    expect(html).toContain("GPT-5.6 Sol");
    expect(html).toContain(">max</span>");
    expect(html).toContain("上次同步数据");
    expect(html).toContain("模型测评刷新失败, 当前展示上次同步的数据。");
  });

  it("renders an explicit IQ loading state instead of an empty snapshot", () => {
    const html = renderDrawer("serviceStatus", {
      codexRadarModelIq: null,
      codexRadarModelIqLoading: true
    });

    expect(html).toContain("正在读取模型测评...");
    expect(html).toContain('role="status"');
    expect(html).not.toContain("当前没有可展示的模型测评数据");
  });

  it("renders service status rows with a visible refresh loading state", () => {
    const html = renderDrawer("serviceStatus", {
      serviceStatusRequestInFlight: true
    });

    expect(html).toContain("服务状态");
    expect(html).toContain("topbar-service-status-dots");
    expect(html).toContain("topbar-subscription-dot subscription-dot-ready");
    expect(html).toContain("topbar-subscription-dot subscription-dot-critical");
    expect(html).toContain("gpt-5.5");
    expect(html).toContain("gpt-5.4");
    expect(html).toContain("刷新中");
    expect(html).toContain("topbar-refresh-loading-dots");
    expect(html).toContain("每 9 秒自动更新一次");
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("立即刷新服务状态");
  });

  it("restores the manual refresh action after the request completes", () => {
    const html = renderDrawer("serviceStatus");

    expect(html).toContain("立即刷新服务状态");
    expect(html).not.toContain("topbar-refresh-loading-dots");
  });

  it("shows an explicit loading state instead of treating a missing snapshot as empty data", () => {
    const html = renderDrawer("serviceStatus", {
      serviceStatus: null,
      serviceStatusLoading: true,
      serviceStatusRequestInFlight: true
    });

    expect(html).toContain("正在同步");
    expect(html).toContain("正在获取服务状态...");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("当前没有服务状态数据");
  });

  it("shows a retryable failure instead of presenting a failed request as empty data", () => {
    const html = renderDrawer("serviceStatus", {
      serviceStatus: null,
      serviceStatusLastError: "status endpoint offline"
    });

    expect(html).toContain("同步失败");
    expect(html).toContain("服务状态读取失败, 请重新尝试。");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("status endpoint offline");
    expect(html).not.toContain("当前没有服务状态数据");
  });

  it("only renders the empty-data copy for a successful empty snapshot", () => {
    const html = renderDrawer("serviceStatus", {
      serviceStatus: {
        allOk: true,
        generatedAt: serviceStatus.generatedAt,
        services: []
      }
    });

    expect(html).toContain("0 / 0 正常");
    expect(html).toContain("当前没有服务状态数据");
    expect(html).not.toContain("服务状态尚未同步");
    expect(html).not.toContain("未配置账号");
  });

  it("renders subscription usage rows inside the drawer", () => {
    const html = renderDrawer("subscriptions");

    expect(html).toContain("topbar-subscription-dots");
    expect(html).toContain("topbar-subscription-dot quota-tier-90");
    expect(html).toContain("topbar-subscription-summary-line");
    expect(html).toContain("topbar-subscription-summary-meta");
    expect(html).toContain("1 个有效订阅");
    expect(html).toContain("CodeX Plus 年度");
    expect(html).toContain("topbar-subscription-remaining-days");
    expect(html).toContain("topbar-subscription-name-line");
    expect(html).toMatch(/<div class="topbar-subscription-name-line"><strong>CodeX Plus 年度<\/strong><span class="status-pill ready">每日<\/span><span class="topbar-subscription-remaining-days">剩余 340 天<\/span><\/div>/);
    expect(html).not.toContain(">打开订阅页</button>");
    expect(html).toContain("每日 87.4%");
    expect(html).toContain("$437.11 / $500.00");
  });

  it("aggregates only daily quotas for the subscription summary", () => {
    const html = renderDrawer("subscriptions", {
      subscriptionPreviewRecords: [
        ...subscriptions,
        {
          ...subscriptions[0]!,
          id: "sub-2",
          name: "CodeX Plus 月度",
          quota: {
            label: "每日",
            used: 50,
            limit: 100
          },
          quotaProgress: {
            percent: 50,
            rawPercent: 50,
            tone: "quota-tier-60"
          },
          indicatorTone: "quota-tier-60"
        }
      ]
    });

    expect(html).toContain("今日余额 $112.89");
    expect(html).toContain("总已用 81.2%");
  });

  it("does not present weekly quotas as today's balance", () => {
    const html = renderDrawer("subscriptions", {
      subscriptionPreviewRecords: [
        {
          ...subscriptions[0]!,
          quota: {
            label: "每周",
            used: 20,
            limit: 200
          },
          quotaProgress: {
            percent: 10,
            rawPercent: 10,
            tone: "quota-tier-20"
          },
          indicatorTone: "quota-tier-20"
        }
      ]
    });

    expect(html).toContain("今日额度待同步");
    expect(html).toContain("总已用 待同步");
    expect(html).not.toContain("今日余额 $180.00");
  });

  it("opens the matching workspace page when a service or subscription card is clicked", () => {
    const onOpenServiceStatus = vi.fn();
    const onOpenSubscriptions = vi.fn();
    const { getByRole } = renderInteractiveDrawer({ onOpenServiceStatus, onOpenSubscriptions });

    fireEvent.click(getByRole("button", { name: "打开服务状态页: gpt-5.5" }));
    fireEvent.click(getByRole("button", { name: "打开订阅页: CodeX Plus 年度" }));

    expect(onOpenServiceStatus).toHaveBeenCalledTimes(1);
    expect(onOpenSubscriptions).toHaveBeenCalledTimes(1);
  });

  it("copies the endpoint when any part of its card is activated", async () => {
    const copy = vi.mocked(copyTextToClipboard);
    copy.mockResolvedValue(undefined);
    const { getByRole } = renderInteractiveDrawer();

    fireEvent.click(getByRole("button", { name: "复制 默认API 地址" }));

    await waitFor(() => {
      expect(copy).toHaveBeenCalledWith("https://ai.input.im");
      expect(getByRole("button", { name: "已复制 默认API 地址" })).toBeTruthy();
    });
  });

  it("ships the floating drawer styles inside the layered stylesheet bundle", () => {
    // 抽屉样式已从独立补丁文件归位到 03-topbar.css，随 styles.css 分层加载。
    const styles = readFileSync(resolve(process.cwd(), "src/styles/03-topbar.css"), "utf8").replace(/\r\n?/g, "\n");

    expect(styles).toContain(".workspace-floating-rail-host");
    expect(styles).toContain(".floating-rail-drawer-tabs");
    expect(styles).toMatch(/\.floating-rail-drawer-tab\s*\{[\s\S]*color: var\(--status-success-fg\);/);
    expect(styles).toMatch(/\.floating-rail-drawer-card \.topbar-card-icon\s*\{[\s\S]*color: var\(--status-success-fg\);[\s\S]*background: color-mix\(in srgb, var\(--status-success-fg\) 14%, transparent\);/);
    expect(styles).toContain("--floating-rail-panel-width");
    expect(styles).toContain("transform: translateX(100%);");
    expect(styles).toContain(".floating-rail-drawer.open .floating-rail-drawer-panel");
    expect(styles).toMatch(/\.floating-rail-drawer\s*\{[^}]*pointer-events:\s*none;/);
    expect(styles).toMatch(/\.floating-rail-drawer-tabs\s*\{[^}]*pointer-events:\s*auto;/);
    expect(styles).toMatch(/\.floating-rail-drawer-tab\s*\{[^}]*pointer-events:\s*auto;/);
    expect(styles).toMatch(/\.floating-rail-drawer-panel\s*\{[^}]*pointer-events:\s*none;/);
    expect(styles).toMatch(/\.floating-rail-drawer\.open \.floating-rail-drawer-panel\s*\{[^}]*pointer-events:\s*auto;/);
    expect(styles).toContain("justify-content: flex-start;");
    expect(styles).toMatch(/\.floating-rail-drawer-panel-scroll\s*\{[\s\S]*padding: 10px;[\s\S]*gap: 8px;/);
    expect(styles).toContain(".topbar-endpoint-latency-dot.fast");
    expect(styles).toContain("background: var(--status-success-fg);");
    expect(styles).toContain(".topbar-endpoint-latency-indicator.fast");
    expect(styles).toContain(".topbar-endpoint-latency-indicator.steady");
    expect(styles).toContain(".topbar-endpoint-latency-indicator.slow");
    expect(styles).toContain(".topbar-detail-card-action");
    expect(styles).toContain(".topbar-refresh-loading-dots");
    expect(styles).toContain("@keyframes floating-rail-refresh-dot");
    expect(styles).toContain(".topbar-codex-radar-title-row");
    expect(styles).toContain(".topbar-codex-radar-heading");
    expect(styles).toContain(".topbar-service-status-heading");
    expect(styles).toContain(".topbar-service-status-title-row");
    expect(styles).toContain(".topbar-service-status-hint");
    expect(styles).toContain(".topbar-service-status-row");
    expect(styles).toContain(".topbar-service-status-detail");
    expect(styles).toContain(".topbar-subscription-remaining-days");
    expect(styles).toContain(".topbar-subscription-name-line");
    expect(styles).toContain(".topbar-subscription-summary-meta");
    expect(styles).toContain(".topbar-subscription-summary-total-used");
    expect(styles).toMatch(/\.topbar-service-status-title-row \.topbar-card-label,[\s\S]*\.topbar-codex-radar-heading \.topbar-card-label,[\s\S]*\.topbar-subscription-summary-line \.topbar-card-label,[\s\S]*\.topbar-site-endpoints-panel \.topbar-card-copy > \.topbar-card-label\s*\{[^}]*font-size:\s*14px;[^}]*font-weight:\s*700;/);
    expect(styles).toMatch(/\.topbar-endpoint-card-action\s*\{[^}]*gap:\s*4px;/);
    expect(styles).toMatch(/\.topbar-endpoint-name\s*\{[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*font-size:\s*13px;[^}]*font-weight:\s*700;/);
    expect(styles).toMatch(/\.topbar-endpoint-value\s*\{[^}]*border-top:\s*1px solid[^}]*background:\s*transparent;[^}]*white-space:\s*nowrap;[^}]*text-overflow:\s*ellipsis;/);
    expect(styles).toMatch(/\.topbar-service-status-title-row \.topbar-service-status-hint,[\s\S]*\.topbar-codex-radar-hint\s*\{[\s\S]*margin-left: auto;/);
    expect(styles).toMatch(/\.topbar-subscription-summary-meta\s*\{[\s\S]*margin-left: auto;/);
    expect(styles).toMatch(/\.topbar-subscription-summary-meta\s*\{[\s\S]*flex:\s*1 1 auto;[\s\S]*flex-wrap:\s*nowrap;[\s\S]*justify-content:\s*flex-end;/);
    expect(styles).toMatch(/@media \(max-width: 760px\)\s*\{[\s\S]*\.topbar-subscription-summary-line\s*\{\s*flex-wrap:\s*wrap;/);
    expect(styles).toMatch(/\.topbar-subscription-remaining-days\s*\{[\s\S]*margin: 0 0 0 auto;/);
    expect(styles).toContain(".topbar-codex-radar-summary");
    expect(styles).toContain(".topbar-codex-radar-cost");
    expect(styles).toContain(".topbar-codex-radar-score");
    expect(styles).toContain(".topbar-codex-radar-indicator.ready");
    expect(styles).toContain(".topbar-codex-radar-indicator.warning");
    expect(styles).toContain(".topbar-codex-radar-indicator.critical");
    expect(styles).toContain(".topbar-codex-radar-indicator.neutral");
    expect(styles).toContain("font-size: 14px;");
    expect(styles).toMatch(/\.floating-rail-drawer-tab \.topbar-subscription-dots\s*\{\s*bottom: -7px;/);
    expect(styles).toMatch(
      /\.workspace-floating-rail-host > \.workspace-window-shell > \.workspace\s*\{[^}]*padding-right:\s*48px;/
    );
    expect(styles).toMatch(/\.floating-rail-drawer-panel-scroll\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.topbar-service-status-title-row\s*\{[^}]*flex-wrap:\s*wrap;/);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.topbar-service-status-heading strong\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.topbar-service-status-title-row \.topbar-service-status-hint\s*\{[^}]*flex:\s*1 1 100%;[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/);
    expect(styles).toMatch(
      /\.workspace-floating-rail-host \.workspace-subtitle\s*\{[\s\S]*white-space: normal;/
    );
    expect(styles).toContain(".status-pill.warning");
    expect(styles).not.toContain(".floating-rail-drawer:hover,");
    expect(styles).not.toContain(".floating-rail-drawer:hover .floating-rail-drawer-tabs");
    expect(styles).not.toContain(".floating-rail-drawer:hover .floating-rail-drawer-panel");
    expect(styles).not.toContain(".floating-rail-drawer:focus-within");
  });

  it("opens from each icon entry without pinning the drawer", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/FloatingRailDrawer.tsx"), "utf8");

    expect(source).not.toContain("onPointerEnter={() => openDrawer(selectedPanel)}");
    expect(source).not.toContain("onPointerMove={() => openDrawer(selectedPanel)}");
    expect(source).toContain("onPointerLeave={handlePointerLeave}");
    expect(source).toContain("onFocus={() => openDrawer(item.key)}");
    expect(source).toContain("onMouseEnter={() => openDrawer(item.key)}");
    expect(source).toContain('data-floating-rail-card="serviceStatus"');
    expect(source).toContain('data-floating-rail-card="codexRadar"');
    expect(source).toContain('data-floating-rail-card="subscriptions"');
    expect(source).toContain('data-floating-rail-card="siteEndpoints"');
    expect(source).toContain("function scrollDrawerCardIntoView");
    expect(source).toContain("scrollContainer.scrollTo(scrollOptions)");
    expect(source).toContain("DRAWER_SCROLL_REVEAL_DELAY_MS");
    expect(source).toContain("onClick={() => handleDrawerTabClick(item.key)}");
    expect(source).not.toContain("pinnedOpenRef");
  });

  it("keeps all four collapsed buttons operable while the transparent outer rail is inert", () => {
    const { getByLabelText, getAllByRole } = renderStatefulDrawer();
    const drawer = getByLabelText("悬浮导航抽屉");
    const panel = getByLabelText("快捷详情抽屉");
    const buttons = getAllByRole("button").filter((button) =>
      button.getAttribute("aria-controls") === "floating-rail-drawer-panel"
    );

    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(button.getAttribute("aria-controls")).toBe("floating-rail-drawer-panel");
    }

    fireEvent.mouseEnter(buttons[1]);

    expect(drawer.classList.contains("open")).toBe(true);
    expect(panel.getAttribute("aria-hidden")).toBe("false");
    expect(buttons[1].getAttribute("aria-expanded")).toBe("true");

    fireEvent.pointerLeave(drawer, { relatedTarget: document.body });
    expect(drawer.classList.contains("open")).toBe(false);

    fireEvent.click(buttons[2]);
    expect(drawer.classList.contains("open")).toBe(true);
    expect(buttons[2].getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the drawer open while moving from a button into the panel and closes after pointer leave", () => {
    const { getByLabelText, getByRole } = renderStatefulDrawer();
    const drawer = getByLabelText("悬浮导航抽屉");
    const panel = getByLabelText("快捷详情抽屉");
    const button = getByRole("button", { name: "服务状态详情" });

    fireEvent.mouseEnter(button);
    fireEvent.pointerEnter(panel, { relatedTarget: button });
    expect(drawer.classList.contains("open")).toBe(true);

    fireEvent.pointerLeave(drawer, { relatedTarget: document.body });
    expect(drawer.classList.contains("open")).toBe(false);
    expect(panel.getAttribute("aria-hidden")).toBe("true");
  });

  it("supports keyboard focus and closes when focus leaves the drawer", () => {
    const { getByLabelText, getByRole } = renderStatefulDrawer();
    const drawer = getByLabelText("悬浮导航抽屉");
    const button = getByRole("button", { name: "订阅使用情况详情" });

    fireEvent.focus(button);
    expect(drawer.classList.contains("open")).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    fireEvent.blur(button, { relatedTarget: document.body });
    expect(drawer.classList.contains("open")).toBe(false);
  });

  it("waits for the drawer reveal before smoothly scrolling the matching card into view", () => {
    const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
    const originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(window, "requestAnimationFrame");
    const originalCancelAnimationFrame = Object.getOwnPropertyDescriptor(window, "cancelAnimationFrame");
    const scrollTo = vi.fn();
    const frames: FrameRequestCallback[] = [];
    vi.useFakeTimers();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo
    });
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      })
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      value: vi.fn()
    });

    try {
      const { getByRole } = renderInteractiveDrawer();

      fireEvent.click(getByRole("button", { name: "降智雷达详情" }));

      expect(scrollTo).not.toHaveBeenCalled();
      vi.advanceTimersByTime(239);
      expect(scrollTo).not.toHaveBeenCalled();
      expect(frames).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(scrollTo).not.toHaveBeenCalled();
      expect(frames).toHaveLength(1);
      frames.shift()?.(0);
      expect(scrollTo).not.toHaveBeenCalled();
      expect(frames).toHaveLength(1);
      frames.shift()?.(16);
      expect(scrollTo).toHaveBeenCalledWith({
        behavior: "smooth",
        top: 0
      });
    } finally {
      vi.useRealTimers();
      if (originalScrollTo) {
        Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
      }
      if (originalRequestAnimationFrame) {
        Object.defineProperty(window, "requestAnimationFrame", originalRequestAnimationFrame);
      } else {
        Reflect.deleteProperty(window, "requestAnimationFrame");
      }
      if (originalCancelAnimationFrame) {
        Object.defineProperty(window, "cancelAnimationFrame", originalCancelAnimationFrame);
      } else {
        Reflect.deleteProperty(window, "cancelAnimationFrame");
      }
    }
  });
});
