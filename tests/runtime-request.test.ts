import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import { AppRequestError, desktopOrHttp, request } from "../src/shared/transport/runtime";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn()
}));

const invokeMock = vi.mocked(invoke);

describe("runtime request dedupe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    invokeMock.mockReset();
  });

  it("deduplicates concurrent readonly GET requests without custom signal", async () => {
    let resolveResponse: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = request<{ ok: boolean }>("/api/runtime-dedupe");
    const second = request<{ ok: boolean }>("/api/runtime-dedupe");

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveResponse?.(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      })
    );

    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
  });

  it("does not deduplicate requests that provide explicit abort signals", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const firstController = new AbortController();
    const secondController = new AbortController();

    await Promise.all([
      request("/api/runtime-signal", { signal: firstController.signal }),
      request("/api/runtime-signal", { signal: secondController.signal })
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("starts a new network request after the previous readonly GET has settled", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await request("/api/runtime-repeat");
    await request("/api/runtime-repeat");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("parses structured HTTP failures without trusting unknown fields", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({
          error: "上游持续限流。",
          failure: {
            category: "rate_limited",
            message: "上游持续限流。",
            code: "all_site_addresses_rate_limited",
            httpStatus: 429,
            retryAt: "2026-08-11T03:00:00Z",
            retryAfterMs: 1200,
            retryExhausted: true
          }
        }), {
          status: 429,
          headers: { "Content-Type": "application/json" }
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await request("/api/structured-failure").catch((cause) => cause);

    expect(error).toBeInstanceOf(AppRequestError);
    expect(error).toMatchObject({
      message: "上游持续限流。",
      status: 429,
      code: "all_site_addresses_rate_limited",
      httpStatus: 429,
      retryAt: "2026-08-11T03:00:00Z",
      retryAfterMs: 1200,
      failure: {
        category: "rate_limited",
        message: "上游持续限流。",
        code: "all_site_addresses_rate_limited",
        httpStatus: 429,
        retryAt: "2026-08-11T03:00:00Z",
        retryAfterMs: 1200,
        retryExhausted: true
      }
    });
  });

  it("parses top-level failover payloads returned by HTTP", async () => {
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({
          error: "所有站点地址都在冷却中。",
          code: "all_site_addresses_cooling",
          httpStatus: 503,
          retryAt: "2026-08-11T03:00:00Z",
          retryAfterMs: 12_500
        }), {
          status: 503,
          headers: { "Content-Type": "application/json" }
        })
      )
    ));

    const error = await request("/api/failover-status").catch((cause) => cause);

    expect(error).toBeInstanceOf(AppRequestError);
    expect(error).toMatchObject({
      message: "所有站点地址都在冷却中。",
      code: "all_site_addresses_cooling",
      status: 503,
      httpStatus: 503,
      retryAt: "2026-08-11T03:00:00Z",
      retryAfterMs: 12_500,
      failure: null
    });
  });

  it("parses object rejections returned by Tauri commands", async () => {
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: {}
    });
    invokeMock.mockRejectedValueOnce({
      error: "所有站点地址都被限流。",
      code: "all_site_addresses_rate_limited",
      httpStatus: 429,
      retryAt: "2026-08-11T03:00:00Z",
      retryAfterMs: 2_000
    });

    const error = await desktopOrHttp({
      command: "get_site_failover_status",
      url: "/api/sites/site-1/failover-status"
    }).catch((cause) => cause);

    expect(error).toBeInstanceOf(AppRequestError);
    expect(error).toMatchObject({
      message: "所有站点地址都被限流。",
      code: "all_site_addresses_rate_limited",
      status: 429,
      httpStatus: 429,
      retryAt: "2026-08-11T03:00:00Z",
      retryAfterMs: 2_000,
      failure: null
    });
  });

  it("rejects malformed structured metadata while preserving the safe top-level error", async () => {
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({
          error: "同步请求失败。",
          failure: {
            category: "rate_limited",
            message: "不应信任此结构。",
            retryAfterMs: "1200",
            retryExhausted: true
          }
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        })
      )
    ));

    const error = await request("/api/malformed-failure").catch((cause) => cause);

    expect(error).toBeInstanceOf(AppRequestError);
    expect(error).toMatchObject({
      message: "同步请求失败。",
      status: 500,
      failure: null
    });
  });

  it.each([
    ["code", "INVALID CODE"],
    ["httpStatus", 99],
    ["retryAt", "not-a-date"],
    ["retryAfterMs", -1]
  ])("rejects malformed top-level %s metadata", async (field, value) => {
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({
          error: "站点请求失败。",
          code: "all_site_addresses_cooling",
          httpStatus: 503,
          retryAt: "2026-08-11T03:00:00Z",
          retryAfterMs: 2_000,
          [field]: value
        }), {
          status: 503,
          headers: { "Content-Type": "application/json" }
        })
      )
    ));

    const error = await request("/api/malformed-failover").catch((cause) => cause);

    expect(error).toBeInstanceOf(AppRequestError);
    expect(error).toMatchObject({
      message: "站点请求失败。",
      status: 503,
      code: null,
      retryAt: null,
      retryAfterMs: null,
      failure: null
    });
  });
});
