import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Topbar } from "../src/app/Topbar";

describe("Topbar", () => {
  it("renders a supplied workspace summary in an accessible scroll region", () => {
    const html = renderToStaticMarkup(
      createElement(Topbar, {
        summary: createElement("span", { className: "workspace-summary-chip" }, "今日 4.1K 请求")
      })
    );

    expect(html).toContain("global-topbar workspace-header-summary workspace-header-summary-topbar");
    expect(html).toContain("topbar-summary-scroll");
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="工作区摘要"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('class="workspace-summary-chip"');
    expect(html).toContain("今日 4.1K 请求");
    expect(html).not.toContain("topbar-reload-button");
  });

  it("renders the idle reload action when a reload callback is supplied", () => {
    const html = renderToStaticMarkup(
      createElement(Topbar, {
        onReload: () => {}
      })
    );

    expect(html).toContain("topbar-reload-button");
    expect(html).toContain('aria-label="重新加载"');
    expect(html).toContain('aria-busy="false"');
    expect(html).toContain('title="重新加载"');
    expect(html).toContain("lucide-refresh-cw");
    expect(html).not.toContain("disabled=");
    expect(html).not.toContain('role="region"');
  });

  it("marks the reload action busy and disabled while refreshing", () => {
    const html = renderToStaticMarkup(
      createElement(Topbar, {
        onReload: () => {},
        reloadRefreshing: true
      })
    );

    expect(html).toContain('aria-label="正在刷新"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('title="正在刷新"');
    expect(html).toContain('disabled=""');
    expect(html).toContain("lucide-refresh-cw spin");
  });
});
