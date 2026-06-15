import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ServiceStatusTerminal } from "../src/features/service-status/ServiceStatusTerminal";
import {
  describeServiceStatusFailure
} from "../src/features/service-status/useServiceStatusWorkspace";
import { buildServiceStatusTransitionEvent } from "../src/features/service-status/notifications";
import type { ServiceStatusPayload } from "../src/types";

describe("ServiceStatusTerminal", () => {
  it("renders local service cards and keeps the original page escape hatch", () => {
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
        loading: false,
        refreshing: false,
        lastError: null,
        enabled: true,
        refreshIntervalSeconds: 9,
        onRefresh: () => {}
      })
    );

    expect(html).toContain("AI.INPUT.IM 服务状态");
    expect(html).toContain("监控INPUT的可用状态");
    expect(html).toContain("打开原页面");
    expect(html).toContain("按全部模型平均值, 悬浮查看分小时明细");
    expect(html).toContain("所有模型分小时可用率");
    expect(html).toContain("模型平均可用率");
    expect(html).toContain("06/14 22:00 - 22:59");
    expect(html).toContain("06/14 21:00 - 21:59");
    expect(html).toContain("gpt-5.5 · 37 次");
    expect(html).toContain("gpt-5.4-mini · 37 次");
    expect(html).toContain("gpt-5.5");
    expect(html).toContain("gpt-5.4-mini");
    expect(html).toContain("probe timeout");
    expect(html).toContain("polling every 9s");
    expect(html).toContain("status-history-bar ok");
    expect(html).toContain("status-history-bar bad");
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
      message: "服务状态自动刷新发现异常: gpt-5.5 探测失败, probe timeout",
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
      message: "服务状态自动刷新发现异常: gpt-5.5, gpt-5.4-mini 探测失败",
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
  });
});
