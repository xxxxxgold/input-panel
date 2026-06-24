import { afterEach, describe, expect, it, vi } from "vitest";

import { request } from "../src/shared/transport/runtime";

describe("runtime request dedupe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
});
