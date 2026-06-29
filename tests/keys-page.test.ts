import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { KeysPage } from "../src/pages/KeysPage";
import type { GroupRecord } from "../src/types";

describe("KeysPage available group summary", () => {
  it("renders subscription groups before standard groups", () => {
    const subscriptionGroup: GroupRecord = {
      id: 2,
      name: "CodeX Plus 月度",
      platform: "openai",
      rateMultiplier: 1,
      subscriptionType: "subscription",
      dailyLimitUsd: 500,
      weeklyLimitUsd: 0,
      monthlyLimitUsd: 0,
      allowMessagesDispatch: true
    };
    const standardGroup: GroupRecord = {
      id: 1,
      name: "CodeX 余额",
      platform: "openai",
      rateMultiplier: 0.1,
      subscriptionType: "standard",
      dailyLimitUsd: 0,
      weeklyLimitUsd: 0,
      monthlyLimitUsd: 0,
      allowMessagesDispatch: true
    };

    const html = renderToStaticMarkup(
      createElement(KeysPage, {
        managedKeys: null,
        groups: [standardGroup, subscriptionGroup],
        profileRecord: null,
        selectedAccountId: "account-1",
        onRefresh: () => {},
        onError: () => {},
        onBusy: () => {}
      })
    );

    expect(html.indexOf("CodeX Plus 月度")).toBeLessThan(html.indexOf("CodeX 余额"));
  });

  it("renders balance type and only non-zero quota windows", () => {
    const group: GroupRecord = {
      id: 7,
      name: "Codex 余额",
      platform: "openai",
      rateMultiplier: 1,
      subscriptionType: "standard",
      dailyLimitUsd: 120,
      weeklyLimitUsd: 480,
      monthlyLimitUsd: 960,
      allowMessagesDispatch: true
    };

    const html = renderToStaticMarkup(
      createElement(KeysPage, {
        managedKeys: null,
        groups: [group],
        profileRecord: null,
        selectedAccountId: "account-1",
        onRefresh: () => {},
        onError: () => {},
        onBusy: () => {}
      })
    );

    expect(html).toContain('aria-label="分组额度"');
    expect(html).toContain(">余额</span>");
    expect(html).toContain('class="subscription-rate-pill"');
    expect(html).toContain("倍率: x1.00");
    expect(html).toContain("<small>日</small><strong>$120</strong>");
    expect(html).toContain("<small>周</small><strong>$480</strong>");
    expect(html).toContain("<small>月</small><strong>$960</strong>");
    expect(html).not.toContain(">standard</span>");
  });

  it("hides zero quota windows entirely when all windows are zero", () => {
    const group: GroupRecord = {
      id: 8,
      name: "Codex 备用",
      platform: "openai",
      rateMultiplier: 1,
      subscriptionType: "standard",
      dailyLimitUsd: null,
      weeklyLimitUsd: null,
      monthlyLimitUsd: null,
      allowMessagesDispatch: false
    };

    const html = renderToStaticMarkup(
      createElement(KeysPage, {
        managedKeys: null,
        groups: [group],
        profileRecord: null,
        selectedAccountId: "account-2",
        onRefresh: () => {},
        onError: () => {},
        onBusy: () => {}
      })
    );

    expect(html).not.toContain("暂无非 0 额度");
    expect(html).not.toContain("<small>日</small><strong>$0</strong>");
    expect(html).not.toContain("<small>周</small><strong>$0</strong>");
    expect(html).not.toContain("<small>月</small><strong>$0</strong>");
  });

  it("hides weekly and monthly quota pills when their values are zero", () => {
    const group: GroupRecord = {
      id: 9,
      name: "CodeX Plus 月度",
      platform: "openai",
      rateMultiplier: 1,
      subscriptionType: "subscription",
      dailyLimitUsd: 500,
      weeklyLimitUsd: 0,
      monthlyLimitUsd: 0,
      allowMessagesDispatch: true
    };

    const html = renderToStaticMarkup(
      createElement(KeysPage, {
        managedKeys: null,
        groups: [group],
        profileRecord: null,
        selectedAccountId: "account-3",
        onRefresh: () => {},
        onError: () => {},
        onBusy: () => {}
      })
    );

    expect(html).toContain("<small>日</small><strong>$500</strong>");
    expect(html).not.toContain("<small>周</small><strong>$0</strong>");
    expect(html).not.toContain("<small>月</small><strong>$0</strong>");
  });
});
