import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ServiceStatusTerminal } from "../src/features/service-status/ServiceStatusTerminal";
import {
  describeServiceStatusFailure
} from "../src/features/service-status/useServiceStatusWorkspace";
import {
  buildNativeServiceStatusNotificationRecord,
  buildServiceStatusModelTransitionEvents,
  buildServiceStatusTransitionEvent
} from "../src/features/service-status/notifications";
import type { ServiceStatusPayload } from "../src/types";

describe("ServiceStatusTerminal", () => {
  it("renders summary cards, chart analysis, and hourly hover details", () => {
    const lastSyncedAt = new Date("2026-06-14T23:05:09+08:00").getTime();
    const status: ServiceStatusPayload = {
      allOk: true,
      generatedAt: 1781447824,
      services: [
        {
          model: "gpt-5.5",
          uptimePct: 100,
          last: {
            ts: 1781447807,
            ok: true,
            latencyMs: 5505,
            error: null
          },
          history: Array.from({ length: 60 }, (_, index) => ({
            ts: 1781444267 + index * 60,
            ok: true,
            latencyMs: 1000 + index,
            error: null
          }))
        },
        {
          model: "gpt-5.4-mini",
          uptimePct: 98.33,
          last: {
            ts: 1781447807,
            ok: false,
            latencyMs: null,
            error: "probe timeout"
          },
          history: Array.from({ length: 60 }, (_, index) => ({
            ts: 1781444267 + index * 60,
            ok: index !== 59,
            latencyMs: index !== 59 ? 800 + index : null,
            error: index !== 59 ? null : "probe timeout"
          }))
        }
      ]
    };

    const html = renderToStaticMarkup(
      createElement(ServiceStatusTerminal, {
        status,
        lastSyncedAt
      })
    );

    expect(html).toContain("服务数");
    expect(html).toContain("最低延迟");
    expect(html).toContain("总可用率");
    expect(html).toContain("这里显示当前服务在线情况");
    expect(html).toContain("在线1/2");
    expect(html).toContain("这里会汇总显示整体可用情况, 方便快速判断");
    expect(html).toContain("所有模型分小时可用率");
    expect(html).toContain("模型平均可用率");
    expect(html).toContain("06/14 22:00 - 22:59");
    expect(html).toContain("06/14 21:00 - 21:59");
    expect(html).toContain("gpt-5.5 · 37 次");
    expect(html).toContain("gpt-5.4-mini · 37 次");
    expect(html).toContain("gpt-5.5");
    expect(html).toContain("gpt-5.4-mini");
    expect(html).toContain("服务图表分析");
    expect(html).toContain("响应延迟趋势");
    expect(html).toContain("模型可用率排行");
    expect(html).toContain("延迟分层对比");
    expect(html).toContain("模型分析表");
    expect((html.match(/echart-card-shell/g) ?? []).length).toBe(3);
    expect(html).not.toContain("status-history-bar");
    expect(html).not.toContain("AI.INPUT.IM 服务状态");
    expect(html).not.toContain("打开原页面");
    expect(html).not.toContain("status-service-grid");
    expect(html).not.toContain("延迟节奏");
    expect(html).not.toContain("响应分层");
    expect(html).not.toContain("窗口稳定性");
  });

  it("shows the lowest latest latency and its model", () => {
    const html = renderToStaticMarkup(
      createElement(ServiceStatusTerminal, {
        status: {
          allOk: true,
          generatedAt: 1781447824,
          services: [
            {
              model: "model-slow",
              uptimePct: 100,
              last: { ts: 1781447807, ok: true, latencyMs: 4200, error: null },
              history: []
            },
            {
              model: "model-fast",
              uptimePct: 100,
              last: { ts: 1781447807, ok: true, latencyMs: 1250, error: null },
              history: []
            },
            {
              model: "model-no-latency",
              uptimePct: 0,
              last: { ts: 1781447807, ok: false, latencyMs: null, error: "probe timeout" },
              history: []
            }
          ]
        },
        lastSyncedAt: null
      })
    );

    expect(html).toContain('<p class="metric-label">最低延迟</p>');
    expect(html).toContain('<p class="metric-hint">model-fast · 最近一次探测</p>');
    expect(html).toContain('<h3 class="metric-value">1.25 秒</h3>');
  });

  it("keeps the summary-only page stable for null and empty status inputs", () => {
    const nullHtml = renderToStaticMarkup(
      createElement(ServiceStatusTerminal, {
        status: null,
        lastSyncedAt: null
      })
    );
    const emptyHtml = renderToStaticMarkup(
      createElement(ServiceStatusTerminal, {
        status: {
          allOk: true,
          generatedAt: 1781447824,
          services: []
        },
        lastSyncedAt: null
      })
    );

    expect(nullHtml).toContain("服务数");
    expect(nullHtml).toContain("最低延迟");
    expect(nullHtml).toContain("等待有效探测数据");
    expect(nullHtml).not.toContain("AI.INPUT.IM 服务状态");
    expect(nullHtml).not.toContain("服务图表分析");
    expect(emptyHtml).toContain("总可用率");
    expect(emptyHtml).not.toContain("AI.INPUT.IM 服务状态");
    expect(emptyHtml).not.toContain("服务图表分析");
  });

  it("builds a single-service failure toast message for auto refresh", () => {
    const issue = describeServiceStatusFailure({
      allOk: false,
      generatedAt: 1781447824,
      services: [
        {
          model: "gpt-5.5",
          uptimePct: 97.5,
          last: {
            ts: 1781447807,
            ok: false,
            latencyMs: null,
            error: "probe timeout"
          },
          history: []
        }
      ]
    });

    expect(issue).toEqual({
      signature: "gpt-5.5:probe timeout",
      message: "gpt-5.5 当前无法使用, 请打开服务状态查看详情",
      failingModels: ["gpt-5.5"]
    });
  });

  it("builds an aggregated failure toast message when multiple services fail", () => {
    const issue = describeServiceStatusFailure({
      allOk: false,
      generatedAt: 1781447824,
      services: [
        {
          model: "gpt-5.5",
          uptimePct: 95,
          last: {
            ts: 1781447807,
            ok: false,
            latencyMs: null,
            error: "probe timeout"
          },
          history: []
        },
        {
          model: "gpt-5.4-mini",
          uptimePct: 96,
          last: {
            ts: 1781447807,
            ok: false,
            latencyMs: null,
            error: null
          },
          history: []
        },
        {
          model: "gpt-4.1",
          uptimePct: 100,
          last: {
            ts: 1781447807,
            ok: true,
            latencyMs: 803,
            error: null
          },
          history: []
        }
      ]
    });

    expect(issue).toEqual({
      signature: "gpt-5.4-mini:probe_failed|gpt-5.5:probe timeout",
      message: "gpt-5.5, gpt-5.4-mini 当前无法使用, 请打开服务状态查看详情",
      failingModels: ["gpt-5.5", "gpt-5.4-mini"]
    });
  });

  it("returns null when all services are healthy", () => {
    expect(
      describeServiceStatusFailure({
        allOk: true,
        generatedAt: 1781447824,
        services: [
          {
            model: "gpt-5.5",
            uptimePct: 100,
            last: {
              ts: 1781447807,
              ok: true,
              latencyMs: 1200,
              error: null
            },
            history: []
          }
        ]
      })
    ).toBeNull();
  });

  it("only emits a transition notification when the health state changes", () => {
    const down = buildServiceStatusTransitionEvent({
      previousHealth: "healthy",
      nextStatus: {
        allOk: false,
        generatedAt: 1781447824,
        services: [
          {
            model: "gpt-5.5",
            uptimePct: 97.5,
            last: {
              ts: 1781447807,
              ok: false,
              latencyMs: null,
              error: "probe timeout"
            },
            history: []
          }
        ]
      }
    });

    const repeatedDown = buildServiceStatusTransitionEvent({
      previousHealth: "degraded",
      nextStatus: {
        allOk: false,
        generatedAt: 1781447824,
        services: [
          {
            model: "gpt-5.5",
            uptimePct: 97.5,
            last: {
              ts: 1781447807,
              ok: false,
              latencyMs: null,
              error: "probe timeout"
            },
            history: []
          }
        ]
      }
    });

    const recovered = buildServiceStatusTransitionEvent({
      previousHealth: "degraded",
      nextStatus: {
        allOk: true,
        generatedAt: 1781447824,
        services: [
          {
            model: "gpt-5.5",
            uptimePct: 100,
            last: {
              ts: 1781447807,
              ok: true,
              latencyMs: 1200,
              error: null
            },
            history: []
          }
        ]
      }
    });

    expect(down?.title).toBe("检测到服务状态不可用");
    expect(repeatedDown).toBeNull();
    expect(recovered?.title).toBe("检测到服务状态恢复正常");
    expect(down?.dedupeKey).toBe("service-status:down:gpt-5.5:probe timeout");
    expect(recovered?.dedupeKey).toBe("service-status:recovered");
  });

  it("keeps the same incident identity stable when only its occurrence time changes", () => {
    const status = {
      allOk: false,
      generatedAt: 1781447824,
      services: [
        {
          model: "gpt-5.5",
          uptimePct: 97.5,
          last: {
            ts: 1781447807,
            ok: false,
            latencyMs: null,
            error: "probe timeout"
          },
          history: []
        }
      ]
    };

    const first = buildServiceStatusTransitionEvent({
      previousHealth: "healthy",
      nextStatus: status,
      createdAt: "2026-07-11T00:00:00.000Z"
    });
    const later = buildServiceStatusTransitionEvent({
      previousHealth: "healthy",
      nextStatus: status,
      createdAt: "2026-07-11T01:00:00.000Z"
    });

    expect(later?.dedupeKey).toBe(first?.dedupeKey);
  });

  it("tracks each model transition while the aggregate status remains degraded", () => {
    const first = buildServiceStatusModelTransitionEvents({
      previousModels: null,
      notifyInitialFailures: true,
      nextStatus: {
        allOk: false,
        generatedAt: 100,
        services: [
          { model: "model-a", uptimePct: 99, last: { ts: 100, ok: false, error: "timeout" }, history: [] },
          { model: "model-b", uptimePct: 100, last: { ts: 100, ok: true }, history: [] }
        ]
      }
    });
    const second = buildServiceStatusModelTransitionEvents({
      previousModels: first.nextModels,
      nextStatus: {
        allOk: false,
        generatedAt: 200,
        services: [
          { model: "model-a", uptimePct: 99, last: { ts: 100, ok: false, error: "timeout" }, history: [] },
          { model: "model-b", uptimePct: 99, last: { ts: 200, ok: false, error: "502" }, history: [] }
        ]
      }
    });
    const third = buildServiceStatusModelTransitionEvents({
      previousModels: second.nextModels,
      nextStatus: {
        allOk: false,
        generatedAt: 300,
        services: [
          { model: "model-a", uptimePct: 99, last: { ts: 300, ok: true }, history: [] },
          { model: "model-b", uptimePct: 99, last: { ts: 200, ok: false, error: "502" }, history: [] }
        ]
      }
    });

    expect(first.events.map((event) => [event.kind, event.models])).toEqual([["down", ["model-a"]]]);
    expect(second.events.map((event) => [event.kind, event.models])).toEqual([["down", ["model-b"]]]);
    expect(third.events.map((event) => [event.kind, event.models])).toEqual([["recovered", ["model-a"]]]);
  });

  it("preserves native monitor identity when mapping it into the shared inbox", () => {
    expect(buildNativeServiceStatusNotificationRecord({
      id: "native-event-1",
      kind: "monitorUnavailable",
      severity: "critical",
      title: "模型状态监控暂时不可用",
      detail: "读取失败",
      createdAt: "2026-08-01T00:00:00.000Z",
      dedupeKey: "service-status:monitor-unavailable:1",
      models: []
    })).toMatchObject({
      id: "native-event-1",
      kind: "service-status-monitor-unavailable",
      severity: "critical",
      dedupeKey: "service-status:monitor-unavailable:1"
    });
  });
});
