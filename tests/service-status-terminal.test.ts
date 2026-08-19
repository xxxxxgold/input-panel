import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ServiceStatusTerminal } from "../src/features/service-status/ServiceStatusTerminal";
import {
  describeServiceStatusFailure
} from "../src/features/service-status/useServiceStatusWorkspace";
import { buildServiceStatusTransitionEvent } from "../src/features/service-status/notifications";
import { formatDateTimeFull } from "../src/shared/lib/formatters";
import type { ServiceStatusPayload } from "../src/types";

describe("ServiceStatusTerminal", () => {
  it("renders current service metrics and analysis for local service records", () => {
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
    expect(html).toContain("在线1/2");
    expect(html).toContain("最低延迟");
    expect(html).toContain("总可用率");
    expect(html).toContain("最近同步时间");
    expect(html).toContain(formatDateTimeFull(new Date(lastSyncedAt).toISOString()));
    expect(html).toContain("模型探测概览");
    expect(html).toContain("服务图表分析");
    expect(html).toContain("响应延迟趋势");
    expect(html).toContain("模型可用率排行");
    expect(html).toContain("模型分析表");
    expect(html).toContain("失败采样");
    expect(html).toContain("gpt-5.5");
    expect(html).toContain("gpt-5.4-mini");
    expect(html).toContain("probe timeout");
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
  });
});
