import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { mergeRequestHistory, Sub2ApiClient } from "../server/sub2api-client";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

describe("Sub2ApiClient", () => {
  it("merges request history and marks latest rows", () => {
    const merged = mergeRequestHistory(
      [
        {
          id: "usage-1",
          createdAt: "2026-06-05T08:00:00.000Z",
          model: "gpt-4.1",
          endpoint: "/responses",
          actualCost: 0.12,
          totalCost: 0.12,
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          apiKeyName: "Main",
          platform: "openai",
          subscriptionName: "Pro",
          firstSeenAt: "2026-06-05T09:00:00.000Z",
          lastSeenAt: "2026-06-05T09:00:00.000Z",
          isLatest: true
        }
      ],
      [
        {
          id: "usage-2",
          createdAt: "2026-06-05T10:00:00.000Z",
          model: "gpt-4.1-mini",
          endpoint: "/chat/completions",
          actualCost: 0.2,
          totalCost: 0.2,
          inputTokens: 30,
          outputTokens: 40,
          totalTokens: 70,
          apiKeyName: "Main",
          platform: "openai",
          subscriptionName: "Pro"
        }
      ],
      "2026-06-05T11:00:00.000Z"
    );

    expect(merged).toHaveLength(2);
    expect(merged[0]?.id).toBe("usage-2");
    expect(merged[0]?.isLatest).toBe(true);
    expect(merged[1]?.id).toBe("usage-1");
    expect(merged[1]?.isLatest).toBe(false);
  });

  it("falls back to legacy signin and builds a snapshot", async () => {
    const server = await createFixtureServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/v1/auth/login") {
        json(res, 404, { message: "not found" });
        return;
      }

      if (req.method === "POST" && req.url === "/api/v1/auths/signin") {
        res.setHeader("Set-Cookie", "sid=test; Path=/");
        json(res, 200, { ok: true });
        return;
      }

      if (!requireCookie(req, res)) {
        return;
      }

      if (req.url === "/api/v1/user/profile") {
        json(res, 200, { balance: 18.25, email: "mask@example.com" });
        return;
      }
      if (req.url === "/api/v1/usage/dashboard/stats") {
        json(res, 200, {
          total_api_keys: 1,
          active_api_keys: 1,
          today_requests: 12,
          total_requests: 120,
          today_actual_cost: 1.25,
          total_actual_cost: 9.5,
          today_cost: 1.5,
          total_cost: 10.5,
          today_tokens: 1400,
          total_tokens: 9200,
          today_input_tokens: 700,
          today_output_tokens: 700,
          average_duration_ms: 532,
          by_platform: [{ platform: "openai", total_actual_cost: 9.5, today_actual_cost: 1.25, total_requests: 120, total_tokens: 9200 }]
        });
        return;
      }
      if (req.url === "/api/v1/keys?page=1&page_size=100") {
        json(res, 200, {
          items: [{ id: "key-1", name: "Main Key", status: "active", last_used_at: "2026-06-05T10:00:00.000Z" }]
        });
        return;
      }
      if (req.url === "/api/v1/subscriptions") {
        json(res, 200, {
          items: [{ id: "sub-1", name: "CodeX Plus", status: "active", daily_limit_usd: 50, daily_usage_usd: 10 }]
        });
        return;
      }
      if (req.url === "/api/v1/usage?page=1&page_size=20") {
        json(res, 200, {
          items: [
            {
              id: "usage-1",
              created_at: "2026-06-05T09:30:00.000Z",
              model: "gpt-4.1-mini",
              actual_cost: 0.1234,
              total_cost: 0.2,
              input_tokens: 200,
              output_tokens: 300,
              total_tokens: 500,
              api_key: { name: "Main Key" }
            }
          ]
        });
        return;
      }
      if (req.url === "/api/v1/user/api-keys/key-1/usage/daily?days=7") {
        json(res, 200, {
          items: [{ date: "2026-06-05", actual_cost: 0.3, total_cost: 0.4, requests: 3, total_tokens: 900 }]
        });
        return;
      }

      json(res, 500, { message: `unexpected ${req.method} ${req.url}` });
    });

    const client = new Sub2ApiClient(server.url);
    await client.login("demo@example.com", "secret");
    const snapshot = await client.buildSnapshot(
      {
        id: "account-1",
        siteId: "site-1",
        label: "主账号",
        email: "demo@example.com",
        balanceWarning: 10,
        createdAt: "2026-06-05T00:00:00.000Z",
        updatedAt: "2026-06-05T00:00:00.000Z",
        lastLoginAt: "2026-06-05T00:00:00.000Z"
      },
      {
        id: "site-1",
        name: "AI INPUT",
        baseUrl: server.url,
        createdAt: "2026-06-05T00:00:00.000Z",
        updatedAt: "2026-06-05T00:00:00.000Z"
      }
    );

    expect(snapshot.balance).toBe(18.25);
    expect(snapshot.stats.totalApiKeys).toBe(1);
    expect(snapshot.recentUsage[0]?.apiKeyName).toBe("Main Key");
    expect(snapshot.trend[0]?.bucket).toBe("2026-06-05");
  });

  it("falls back from user/profile to auth/me", async () => {
    const server = await createFixtureServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/v1/auth/login") {
        res.setHeader("Set-Cookie", "sid=test; Path=/");
        json(res, 200, { ok: true });
        return;
      }

      if (!requireCookie(req, res)) {
        return;
      }

      if (req.url === "/api/v1/user/profile") {
        json(res, 404, { message: "missing" });
        return;
      }
      if (req.url === "/api/v1/auth/me") {
        json(res, 200, { balance: 6.5, email_masked: "fallback@example.com" });
        return;
      }
      if (req.url === "/api/v1/usage/dashboard/stats") {
        json(res, 200, { total_api_keys: 0, active_api_keys: 0, today_requests: 0, total_requests: 0, today_actual_cost: 0, total_actual_cost: 0, today_cost: 0, total_cost: 0, today_tokens: 0, total_tokens: 0, today_input_tokens: 0, today_output_tokens: 0, average_duration_ms: 0, by_platform: [] });
        return;
      }
      if (req.url === "/api/v1/keys?page=1&page_size=100") {
        json(res, 200, { items: [] });
        return;
      }
      if (req.url === "/api/v1/subscriptions") {
        json(res, 200, { items: [] });
        return;
      }
      if (req.url === "/api/v1/usage?page=1&page_size=20") {
        json(res, 200, { items: [] });
        return;
      }

      json(res, 500, { message: `unexpected ${req.method} ${req.url}` });
    });

    const client = new Sub2ApiClient(server.url);
    await client.login("demo@example.com", "secret");
    const snapshot = await client.buildSnapshot(
      {
        id: "account-2",
        siteId: "site-2",
        label: "Fallback",
        email: "demo@example.com",
        balanceWarning: 3,
        createdAt: "2026-06-05T00:00:00.000Z",
        updatedAt: "2026-06-05T00:00:00.000Z",
        lastLoginAt: "2026-06-05T00:00:00.000Z"
      },
      {
        id: "site-2",
        name: "Fallback Site",
        baseUrl: server.url,
        createdAt: "2026-06-05T00:00:00.000Z",
        updatedAt: "2026-06-05T00:00:00.000Z"
      }
    );

    expect(snapshot.balance).toBe(6.5);
    expect(snapshot.emailMasked).toBe("fallback@example.com");
  });

  it("supports a temp token 2fa completion flow", async () => {
    const server = await createFixtureServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/v1/auth/login") {
        json(res, 200, { code: 0, data: { temp_token: "temp-123", user_email_masked: "demo***@example.com" } });
        return;
      }
      if (req.method === "POST" && req.url === "/api/v1/auth/login/2fa") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          const parsed = JSON.parse(body);
          if (parsed.temp_token !== "temp-123" || parsed.code !== "654321") {
            json(res, 400, { message: "bad code" });
            return;
          }
          res.setHeader("Set-Cookie", "sid=test; Path=/");
          json(res, 200, { code: 0, data: { access_token: "access-2fa", refresh_token: "refresh-2fa" } });
        });
        return;
      }
      if (!requireCookie(req, res)) {
        return;
      }
      if (req.url === "/api/v1/user/profile") {
        json(res, 200, { balance: 3.2, email: "demo@example.com" });
        return;
      }
      if (req.url === "/api/v1/usage/dashboard/stats") {
        json(res, 200, { total_api_keys: 0, active_api_keys: 0, today_requests: 1, total_requests: 1, today_actual_cost: 0.1, total_actual_cost: 0.1, today_cost: 0.1, total_cost: 0.1, today_tokens: 10, total_tokens: 10, today_input_tokens: 5, today_output_tokens: 5, average_duration_ms: 100, by_platform: [] });
        return;
      }
      if (req.url === "/api/v1/keys?page=1&page_size=100") {
        json(res, 200, { items: [] });
        return;
      }
      if (req.url === "/api/v1/subscriptions") {
        json(res, 200, { items: [] });
        return;
      }
      if (req.url === "/api/v1/usage?page=1&page_size=20") {
        json(res, 200, { items: [] });
        return;
      }
      json(res, 500, { message: `unexpected ${req.method} ${req.url}` });
    });

    const client = new Sub2ApiClient(server.url);
    const login = await client.login("demo@example.com", "secret");
    expect(login.requires2fa).toBe(true);
    expect(login.tempToken).toBe("temp-123");
    await client.complete2fa("temp-123", "654321");
    const snapshot = await client.buildSnapshot(
      {
        id: "account-3",
        siteId: "site-3",
        label: "2FA",
        email: "demo@example.com",
        balanceWarning: 1,
        createdAt: "2026-06-05T00:00:00.000Z",
        updatedAt: "2026-06-05T00:00:00.000Z",
        lastLoginAt: "2026-06-05T00:00:00.000Z"
      },
      {
        id: "site-3",
        name: "2FA Site",
        baseUrl: server.url,
        createdAt: "2026-06-05T00:00:00.000Z",
        updatedAt: "2026-06-05T00:00:00.000Z"
      }
    );
    expect(snapshot.balance).toBe(3.2);
  });

  it("skips low-balance alerts when warning is disabled with -1", async () => {
    const server = await createFixtureServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/v1/auth/login") {
        res.setHeader("Set-Cookie", "sid=test; Path=/");
        json(res, 200, { ok: true });
        return;
      }
      if (!requireCookie(req, res)) {
        return;
      }
      if (req.url === "/api/v1/user/profile") {
        json(res, 200, { balance: 0.5, email: "demo@example.com" });
        return;
      }
      if (req.url === "/api/v1/usage/dashboard/stats") {
        json(res, 200, { total_api_keys: 0, active_api_keys: 0, today_requests: 0, total_requests: 0, today_actual_cost: 0, total_actual_cost: 0, today_cost: 0, total_cost: 0, today_tokens: 0, total_tokens: 0, today_input_tokens: 0, today_output_tokens: 0, average_duration_ms: 0, by_platform: [] });
        return;
      }
      if (req.url === "/api/v1/keys?page=1&page_size=100") {
        json(res, 200, { items: [] });
        return;
      }
      if (req.url === "/api/v1/subscriptions") {
        json(res, 200, { items: [] });
        return;
      }
      if (req.url === "/api/v1/usage?page=1&page_size=20") {
        json(res, 200, { items: [] });
        return;
      }
      json(res, 500, { message: `unexpected ${req.method} ${req.url}` });
    });

    const client = new Sub2ApiClient(server.url);
    await client.login("demo@example.com", "secret");
    const snapshot = await client.buildSnapshot(
      {
        id: "account-disabled",
        siteId: "site-1",
        label: "主账号",
        email: "demo@example.com",
        balanceWarning: -1,
        createdAt: "2026-06-05T00:00:00.000Z",
        updatedAt: "2026-06-05T00:00:00.000Z",
        lastLoginAt: "2026-06-05T00:00:00.000Z"
      },
      {
        id: "site-1",
        name: "AI INPUT",
        baseUrl: server.url,
        createdAt: "2026-06-05T00:00:00.000Z",
        updatedAt: "2026-06-05T00:00:00.000Z"
      }
    );

    expect(snapshot.alerts).toHaveLength(0);
  });
});

async function createFixtureServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
  });
  servers.push(server);
  return {
    server,
    get url() {
      const address = server.address() as AddressInfo | null;
      return `http://127.0.0.1:${address?.port ?? 0}`;
    }
  };
}

function json(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function requireCookie(req: IncomingMessage, res: ServerResponse) {
  if (!req.headers.cookie?.includes("sid=test")) {
    json(res, 401, { message: "missing cookie" });
    return false;
  }
  return true;
}
