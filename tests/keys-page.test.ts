import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { KeysPage } from "../src/pages/KeysPage";
import type { GroupRecord, UserProfileRecord } from "../src/types";

describe("KeysPage available group summary", () => {
  it("renders balance inside the combined daily weekly balance stat", () => {
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
    const profileRecord: UserProfileRecord = {
      id: 1,
      email: "demo@example.com",
      role: "user",
      balance: 42.5,
      concurrency: 1,
      status: "active",
      identities: {},
      authBindings: {},
      identityBindings: {}
    };

    const html = renderToStaticMarkup(
      createElement(KeysPage, {
        managedKeys: null,
        groups: [group],
        profileRecord,
        selectedAccountId: "account-1",
        onRefresh: () => {},
        onError: () => {},
        onBusy: () => {}
      })
    );

    expect(html).toContain("日 / 周 / 余额");
    expect(html).toContain("$120 / $480 / $42.50");
    expect(html).not.toContain("日 / 周 / 月额度");
  });

  it("falls back to zero balance when profile data is unavailable", () => {
    const group: GroupRecord = {
      id: 8,
      name: "Codex 备用",
      platform: "openai",
      rateMultiplier: 1,
      subscriptionType: "standard",
      dailyLimitUsd: 50,
      weeklyLimitUsd: 200,
      monthlyLimitUsd: 800,
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

    expect(html).toContain("$50 / $200 / $0.00");
  });
});
