import { describe, expect, it } from "vitest";
import {
  appendToastDeduped,
  resolveOverviewSelection,
  type MonitorToast
} from "../src/shared/state/monitor-store";
import type { AccountRuntime, OverviewPayload, SiteRecord } from "../src/types";

function buildSite(overrides: Partial<SiteRecord> = {}): SiteRecord {
  return {
    id: overrides.id ?? "site-1",
    name: overrides.name ?? "站点",
    baseUrl: overrides.baseUrl ?? "https://example.com",
    createdAt: overrides.createdAt ?? "2026-06-11T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-06-11T00:00:00Z"
  };
}

function buildAccount(overrides: Partial<AccountRuntime> = {}): AccountRuntime {
  return {
    id: overrides.id ?? "account-1",
    siteId: overrides.siteId ?? "site-1",
    label: overrides.label ?? "账号",
    email: overrides.email ?? "demo@example.com",
    balanceWarning: overrides.balanceWarning ?? -1,
    lastLoginAt: overrides.lastLoginAt ?? null,
    createdAt: overrides.createdAt ?? "2026-06-11T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-06-11T00:00:00Z",
    site: overrides.site ?? buildSite({ id: overrides.siteId ?? "site-1" }),
    snapshot: overrides.snapshot ?? null,
    sessionState: overrides.sessionState ?? "missing",
    lastError: overrides.lastError ?? null
  };
}

describe("resolveOverviewSelection", () => {
  it("prefers a ready account on first load so detail panels do not default to an offline account", () => {
    const sites = [buildSite({ id: "site-1" }), buildSite({ id: "site-2" })];
    const accounts = [
      buildAccount({ id: "offline", siteId: "site-1", label: "主账号", sessionState: "missing" }),
      buildAccount({
        id: "ready",
        siteId: "site-2",
        label: "2FA账号",
        sessionState: "ready"
      })
    ];

    expect(
      resolveOverviewSelection({
        accounts,
        sites,
        selectedAccountId: null,
        selectedSiteId: null
      })
    ).toEqual({
      selectedAccountId: "ready",
      selectedSiteId: "site-2"
    });
  });

  it("keeps the current account when it is still valid inside the selected site", () => {
    const sites = [buildSite({ id: "site-1" }), buildSite({ id: "site-2" })];
    const accounts = [
      buildAccount({ id: "offline", siteId: "site-1", sessionState: "missing" }),
      buildAccount({ id: "ready", siteId: "site-2", sessionState: "ready" })
    ];

    expect(
      resolveOverviewSelection({
        accounts,
        sites,
        selectedAccountId: "offline",
        selectedSiteId: "site-1"
      })
    ).toEqual({
      selectedAccountId: "offline",
      selectedSiteId: "site-1"
    });
  });
});

describe("appendToastDeduped", () => {
  it("avoids pushing the same error toast twice", () => {
    const existing: MonitorToast[] = [
      {
        id: "toast-1",
        tone: "error",
        message: "账号 主账号 尚未保存可恢复凭据，请重新登录。",
        durationMs: 4200
      }
    ];

    const next = appendToastDeduped(
      existing,
      {
        tone: "error",
        message: "账号 主账号 尚未保存可恢复凭据，请重新登录。",
        durationMs: 4200
      },
      () => "toast-2"
    );

    expect(next.toastId).toBe("toast-1");
    expect(next.toasts).toEqual(existing);
  });

  it("still appends a distinct toast when the message changes", () => {
    const existing: MonitorToast[] = [
      {
        id: "toast-1",
        tone: "error",
        message: "旧错误",
        durationMs: 4200
      }
    ];

    const next = appendToastDeduped(
      existing,
      {
        tone: "error",
        message: "新错误",
        durationMs: 4200
      },
      () => "toast-2"
    );

    expect(next.toastId).toBe("toast-2");
    expect(next.toasts).toHaveLength(2);
  });
});
