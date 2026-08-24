import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RailNav } from "../src/app/RailNav";
import type { AccountRuntime, NavKey } from "../src/types";

const account = {
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
  }
} satisfies Partial<AccountRuntime> as AccountRuntime;

const latinAccount = {
  ...account,
  id: "account-2",
  label: "fxlshang",
  email: "fxlshang@example.com"
} satisfies Partial<AccountRuntime> as AccountRuntime;

type RailButtonProps = {
  children?: ReactNode;
  "aria-label"?: string;
  onClick?: () => void;
  onFocus?: () => void;
  onPointerEnter?: () => void;
};

function findRailButton(tree: ReactNode, ariaLabel: string) {
  let result: ReactElement<RailButtonProps> | null = null;

  function visit(node: ReactNode): void {
    if (result || !isValidElement<RailButtonProps>(node)) {
      return;
    }
    if (node.type === "button" && node.props["aria-label"] === ariaLabel) {
      result = node;
      return;
    }
    Children.forEach(node.props.children, visit);
  }

  visit(tree);
  if (!result) {
    throw new Error(`未找到导航项: ${ariaLabel}`);
  }
  return result;
}

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
        selectedAccount: account,
        accounts: [account],
        onAccountSelect: () => {}
      })
    );

    expect(html).toContain("rail-item active");
    expect(html).toContain("rail-item-active-pill");
  });

  it("renders Codex Radar as an independent selected navigation item", () => {
    const html = renderToStaticMarkup(
      createElement(RailNav, {
        nav: "codexRadar",
        isRailExpanded: true,
        railToggleTitle: "切换导航",
        onOpenOverview: () => {},
        onToggleRail: () => {},
        onNavChange: () => {},
        projectLogo: "/logo.png",
        selectedAccount: account,
        accounts: [account],
        onAccountSelect: () => {}
      })
    );

    expect(html).toContain('aria-label="降智雷达"');
    expect(html).toMatch(/class="rail-item active"[^>]*aria-label="降智雷达"/);
  });

  it("renders the rail toggle as a drawer handle outside the nav stack", () => {
    const html = renderToStaticMarkup(
      createElement(RailNav, {
        nav: "usage",
        isRailExpanded: true,
        railToggleTitle: "收起导航",
        onOpenOverview: () => {},
        onToggleRail: () => {},
        onNavChange: () => {},
        projectLogo: "/logo.png",
        selectedAccount: account,
        accounts: [account],
        onAccountSelect: () => {}
      })
    );

    expect(html).toContain("rail-toggle-handle open");
    expect(html).toContain('aria-label="收起导航"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("rail-toggle-handle-grip");
    expect(html).not.toContain("rail-item rail-toggle");
    expect(html.indexOf("rail-toggle-handle")).toBeGreaterThan(html.indexOf("rail-bottom"));
  });

  it("renders account switching below the navigation stack", () => {
    const html = renderToStaticMarkup(
      createElement(RailNav, {
        nav: "usage",
        isRailExpanded: true,
        railToggleTitle: "切换导航",
        onOpenOverview: () => {},
        onToggleRail: () => {},
        onNavChange: () => {},
        projectLogo: "/logo.png",
        selectedAccount: account,
        accounts: [account],
        onAccountSelect: () => {}
      })
    );

    expect(html.indexOf("rail-stack")).toBeLessThan(html.indexOf("rail-account-switcher"));
    expect(html.indexOf("rail-bottom")).toBeLessThan(html.indexOf("rail-account-switcher"));
    expect(html).toContain("rail-account-option selected");
    expect(html).toContain("AI INPUT · demo@example.com");
    expect(html).not.toContain("切换主题");
  });

  it("uses account options themselves as avatars when the rail is collapsed", () => {
    const html = renderToStaticMarkup(
      createElement(RailNav, {
        nav: "usage",
        isRailExpanded: false,
        railToggleTitle: "切换导航",
        onOpenOverview: () => {},
        onToggleRail: () => {},
        onNavChange: () => {},
        projectLogo: "/logo.png",
        selectedAccount: account,
        accounts: [account, latinAccount],
        onAccountSelect: () => {}
      })
    );

    expect(html).toContain('class="brand-glyph brand-logo"');
    expect(html).not.toContain("brand-logo-shell");
    expect(html).not.toContain('class="rail-account-avatar"');
    expect(html).toContain(">主</button>");
    expect(html).toContain(">F</button>");
  });

  it("emits navigation intent for non-active rail items on pointer entry and focus", () => {
    const intents: NavKey[] = [];
    const tree = RailNav({
      nav: "usage",
      isRailExpanded: true,
      railToggleTitle: "切换导航",
      onOpenOverview: () => {},
      onToggleRail: () => {},
      onNavChange: () => {},
      onNavIntent: (target) => intents.push(target),
      projectLogo: "/logo.png",
      selectedAccount: account,
      accounts: [account],
      onAccountSelect: () => {}
    });

    const keysButton = findRailButton(tree, "密钥");
    keysButton.props.onPointerEnter?.();
    keysButton.props.onFocus?.();

    expect(intents).toEqual(["keys", "keys"]);
  });

  it("ignores intent for the active rail item", () => {
    const intents: NavKey[] = [];
    const tree = RailNav({
      nav: "usage",
      isRailExpanded: true,
      railToggleTitle: "切换导航",
      onOpenOverview: () => {},
      onToggleRail: () => {},
      onNavChange: () => {},
      onNavIntent: (target) => intents.push(target),
      projectLogo: "/logo.png",
      selectedAccount: account,
      accounts: [account],
      onAccountSelect: () => {}
    });

    const usageButton = findRailButton(tree, "用量");
    usageButton.props.onPointerEnter?.();
    usageButton.props.onFocus?.();

    expect(intents).toEqual([]);
  });

  it("keeps click navigation unchanged and permits omitted intent callbacks", () => {
    const navigations: NavKey[] = [];
    const noIntentCallbackTree = RailNav({
      nav: "usage",
      isRailExpanded: true,
      railToggleTitle: "切换导航",
      onOpenOverview: () => {},
      onToggleRail: () => {},
      onNavChange: (target) => navigations.push(target),
      projectLogo: "/logo.png",
      selectedAccount: account,
      accounts: [account],
      onAccountSelect: () => {}
    });
    const noIntentCallbackKeysButton = findRailButton(noIntentCallbackTree, "密钥");

    expect(() => {
      noIntentCallbackKeysButton.props.onPointerEnter?.();
      noIntentCallbackKeysButton.props.onFocus?.();
    }).not.toThrow();

    const intents: NavKey[] = [];
    const tree = RailNav({
      nav: "usage",
      isRailExpanded: true,
      railToggleTitle: "切换导航",
      onOpenOverview: () => {},
      onToggleRail: () => {},
      onNavChange: (target) => navigations.push(target),
      onNavIntent: (target) => intents.push(target),
      projectLogo: "/logo.png",
      selectedAccount: account,
      accounts: [account],
      onAccountSelect: () => {}
    });

    const keysButton = findRailButton(tree, "密钥");
    keysButton.props.onClick?.();

    expect(navigations).toEqual(["keys"]);
    expect(intents).toEqual([]);
  });
});
