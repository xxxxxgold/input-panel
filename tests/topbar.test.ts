import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Topbar } from "../src/app/Topbar";

function renderTopbar(props: Parameters<typeof Topbar>[0] = {}) {
  return renderToStaticMarkup(
    createElement(Topbar, {
      ...props
    })
  );
}

describe("Topbar", () => {
  it("renders the workspace summary", () => {
    const html = renderTopbar({
      summary: createElement("span", { className: "workspace-summary-pill" }, "今日 10 请求")
    });

    expect(html).toContain('class="global-topbar workspace-header-summary workspace-header-summary-topbar"');
    expect(html).toContain('class="topbar-summary-scroll"');
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="工作区摘要"');
    expect(html).toContain("今日 10 请求");
  });

  it("renders the reload action after the latest sync summary", () => {
    const html = renderTopbar({
      summary: createElement("span", { className: "workspace-summary-pill" }, "最近同步 19:57:01"),
      onReload: () => {},
      reloadRefreshing: false
    });

    expect(html).toContain('class="topbar-reload-button"');
    expect(html).toContain('aria-label="重新加载"');
    expect(html.indexOf("最近同步 19:57:01")).toBeLessThan(html.indexOf("topbar-reload-button"));
  });

  it("keeps the moved reload action disabled while refreshing", () => {
    const html = renderTopbar({
      summary: createElement("span", { className: "workspace-summary-pill" }, "最近同步 19:57:01"),
      onReload: () => {},
      reloadRefreshing: true
    });

    expect(html).toContain('aria-label="正在刷新"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("disabled");
    expect(html).toContain("spin");
  });

  it("does not render the moved message inbox entry in the topbar", () => {
    const html = renderTopbar({
      alertCount: 1,
      topbarAlertsExpanded: true,
      topbarAlertPreview: [
        {
          id: "alert-1",
          severity: "critical",
          title: "测试通知: 检测到服务状态不可用",
          detail: "这是一条手动触发的异常测试通知, 用于验证系统通知和消息盒子链路。",
          siteId: "service-status",
          accountId: "runtime",
          createdAt: "2026-06-17T09:48:00.000Z"
        }
      ],
      latestUnreadAlertSeverity: "critical",
      onOpenAlerts: () => {}
    });

    expect(html).not.toContain('aria-label="消息盒子"');
    expect(html).not.toContain("topbar-alert-badge");
    expect(html).not.toContain("topbar-alert-item-button");
    expect(html).not.toContain("打开消息盒子");
  });

  it("keeps legacy peek data out of the simplified topbar surface", () => {
    const html = renderTopbar({
      serviceStatus: {
        allOk: false,
        generatedAt: 1781449307,
        services: [{ model: "gpt-5.5", uptimePct: 100, last: null, history: [] }]
      },
      sitePublicEndpoints: {
        siteId: "site-1",
        siteName: "AI INPUT",
        apiBaseUrl: "https://ai.input.im",
        endpoints: [{ name: "默认API", endpoint: "https://ai.input.im" }]
      },
      subscriptionPreviewRecords: [
        {
          id: "sub-1",
          name: "CodeX Plus 年度",
          indicatorTone: "quota-tier-90"
        }
      ]
    });

    expect(html).not.toContain('aria-label="站点 API 入口"');
    expect(html).not.toContain("服务状态");
    expect(html).not.toContain("订阅使用情况");
    expect(html).not.toContain("topbar-subscription-dots");
  });
});
