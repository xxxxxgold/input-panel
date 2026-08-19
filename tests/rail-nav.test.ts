import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RailNav } from "../src/app/RailNav";

describe("RailNav motion markup", () => {
  it("renders an active pill for the selected nav item", () => {
    const html = renderToStaticMarkup(
      createElement(RailNav, {
        nav: "usage",
        isRailExpanded: true,
        railToggleTitle: "切换导航",
        onOpenOverview: () => {},
        onToggleRail: () => {},
        onNavChange: () => {},
        projectLogo: "/logo.png",
        selectedAccount: null,
        accounts: [],
        onAccountSelect: () => {}
      })
    );

    expect(html).toContain("rail-item active");
    expect(html).toContain("rail-item-active-pill");
  });
});
