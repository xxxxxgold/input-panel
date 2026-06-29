import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn()
}));

import { invoke } from "@tauri-apps/api/core";

import { refreshAccount, syncAccountData } from "../src/features/accounts/client";

describe("syncAccountData client", () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = originalFetch;
    if (originalWindow) {
      globalThis.window = originalWindow;
    } else {
      // @ts-expect-error test cleanup
      delete globalThis.window;
    }
  });

  it("passes scope and triggerSource through HTTP mode", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        accountId: "account-1",
        statuses: [
          {
            accountId: "account-1",
            scope: "full",
            state: "succeeded",
            lastAttemptAt: "2026-06-27T00:00:00Z",
            lastSuccessAt: "2026-06-27T00:00:00Z",
            lastError: null,
            itemCount: 10
          }
        ]
      })
    }) as typeof fetch;

    const result = await syncAccountData("account-1", {
      scope: "full",
      triggerSource: "stale_auto"
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/accounts/account-1/sync",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ scope: "full", triggerSource: "stale_auto" })
      })
    );
    expect(result.statuses[0].scope).toBe("full");
  });

  it("passes scope and triggerSource through Tauri mode", async () => {
    // @ts-expect-error test-only runtime flag
    globalThis.window = { __TAURI_INTERNALS__: {} };
    vi.mocked(invoke).mockResolvedValue({
      accountId: "account-1",
      statuses: [
        {
          accountId: "account-1",
          scope: "keys",
          state: "succeeded",
          lastAttemptAt: "2026-06-27T00:00:00Z",
          lastSuccessAt: "2026-06-27T00:00:00Z",
          lastError: null,
          itemCount: 10
        }
      ]
    });

    await syncAccountData("account-1", {
      scope: "keys",
      triggerSource: "manual"
    });

    expect(invoke).toHaveBeenCalledWith("sync_account_data", {
      accountId: "account-1",
      payload: {
        scope: "keys",
        triggerSource: "manual"
      }
    });
  });

  it("keeps refreshAccount compatibility by returning the wrapped account in HTTP mode", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        account: {
          id: "account-2",
          siteId: "site-2",
          label: "兼容账号",
          email: "demo@example.com",
          balanceWarning: -1,
          createdAt: "2026-06-28T00:00:00Z",
          updatedAt: "2026-06-28T00:00:00Z",
          sessionState: "ready",
          cacheView: null
        },
        run: {
          id: "run-1",
          accountId: "account-2",
          scope: "full",
          primaryTriggerSource: "manual",
          status: "succeeded",
          joinCount: 0,
          startedAt: "2026-06-28T00:00:00Z",
          finishedAt: "2026-06-28T00:00:01Z",
          errorMessage: null
        }
      })
    }) as typeof fetch;

    const result = await refreshAccount("account-2");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/accounts/account-2/refresh",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ triggerSource: "manual" })
      })
    );
    expect(result.id).toBe("account-2");
    expect(result.sessionState).toBe("ready");
  });

  it("keeps refreshAccount compatibility by returning the wrapped account in Tauri mode", async () => {
    // @ts-expect-error test-only runtime flag
    globalThis.window = { __TAURI_INTERNALS__: {} };
    vi.mocked(invoke).mockResolvedValue({
      account: {
        id: "account-3",
        siteId: "site-3",
        label: "Tauri 兼容账号",
        email: "demo@example.com",
        balanceWarning: -1,
        createdAt: "2026-06-28T00:00:00Z",
        updatedAt: "2026-06-28T00:00:00Z",
        sessionState: "ready",
        cacheView: null
      },
      run: {
        id: "run-2",
        accountId: "account-3",
        scope: "full",
        primaryTriggerSource: "stale_auto",
        status: "succeeded",
        joinCount: 0,
        startedAt: "2026-06-28T00:00:00Z",
        finishedAt: "2026-06-28T00:00:01Z",
        errorMessage: null
      }
    });

    const result = await refreshAccount("account-3", "stale_auto");

    expect(invoke).toHaveBeenCalledWith("refresh_account", {
      accountId: "account-3",
      triggerSource: "stale_auto"
    });
    expect(result.id).toBe("account-3");
    expect(result.sessionState).toBe("ready");
  });
});
