import { describe, expect, it } from "vitest";

import {
  buildAutoRefreshWatcherKey,
  resolveAutoRefreshIntervalSecondsForScope,
  resolveAutoRefreshScope,
  shouldAutoRefreshSelectedAccountData
} from "../src/app/refresh-policy";
import type { AccountRuntime, DesktopUiPrefs } from "../src/types";

const prefs: DesktopUiPrefs = {
  version: 1,
  launchMode: "main",
  openFloatingInMainMode: true,
  keepFloatingPanelVisible: false,
  floatingPanelOpacity: 0.82,
  closeBehavior: "ask",
  autoRefreshEnabled: true,
  autoRefreshIntervalSeconds: 9,
  autoRefreshCoreEnabled: true,
  autoRefreshCoreIntervalSeconds: 11,
  autoRefreshKeysEnabled: false,
  autoRefreshKeysIntervalSeconds: 13,
  autoRefreshUsageEnabled: true,
  autoRefreshUsageIntervalSeconds: 15,
  theme: "light"
};

const selectedAccount: AccountRuntime = {
  id: "acc-1",
  siteId: "site-1",
  label: "主账号",
  email: "demo@example.com",
  balanceWarning: 10,
  createdAt: "2026-06-18T00:00:00Z",
  updatedAt: "2026-06-18T00:00:00Z",
  sessionState: "ready"
};

describe("refresh-policy grouped auto refresh", () => {
  it("maps page navs into grouped refresh scopes", () => {
    expect(resolveAutoRefreshScope("overview")).toBe("core");
    expect(resolveAutoRefreshScope("keys")).toBe("keys");
    expect(resolveAutoRefreshScope("usage")).toBe("usage");
    expect(resolveAutoRefreshScope("systemSettings")).toBe("none");
  });

  it("uses the interval configured for each refresh group", () => {
    expect(resolveAutoRefreshIntervalSecondsForScope(prefs, "core")).toBe(11);
    expect(resolveAutoRefreshIntervalSecondsForScope(prefs, "keys")).toBe(13);
    expect(resolveAutoRefreshIntervalSecondsForScope(prefs, "usage")).toBe(15);
  });

  it("blocks auto refresh when the current group is disabled", () => {
    expect(
      shouldAutoRefreshSelectedAccountData({
        nav: "keys",
        autoRefreshEnabled: true,
        pageVisible: true,
        selectedAccount,
        prefs
      })
    ).toBe(false);
  });

  it("allows auto refresh when the current group is enabled", () => {
    expect(
      shouldAutoRefreshSelectedAccountData({
        nav: "usage",
        autoRefreshEnabled: true,
        pageVisible: true,
        selectedAccount,
        prefs
      })
    ).toBe(true);
  });

  it("changes the watcher key when readiness or usage refresh config changes", () => {
    const readyKey = buildAutoRefreshWatcherKey({
      nav: "usage",
      pageVisible: true,
      selectedAccount,
      prefs
    });
    const relabeledKey = buildAutoRefreshWatcherKey({
      nav: "usage",
      pageVisible: true,
      selectedAccount: {
        ...selectedAccount,
        label: "副账号"
      },
      prefs
    });
    const expiredKey = buildAutoRefreshWatcherKey({
      nav: "usage",
      pageVisible: true,
      selectedAccount: {
        ...selectedAccount,
        sessionState: "expired"
      },
      prefs
    });
    const usageDisabledKey = buildAutoRefreshWatcherKey({
      nav: "usage",
      pageVisible: true,
      selectedAccount,
      prefs: {
        ...prefs,
        autoRefreshUsageEnabled: false
      }
    });

    expect(relabeledKey).toBe(readyKey);
    expect(expiredKey).not.toBe(readyKey);
    expect(usageDisabledKey).not.toBe(readyKey);
  });
});
