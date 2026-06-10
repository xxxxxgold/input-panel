import http from "node:http";

const port = Number(process.env.MOCK_2FA_PORT ?? 16661);
const validTempToken = "temp-2fa-token";
const validAccessToken = "access-2fa-token";

const json = (res, status, payload) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
};

const requireBearer = (req, res) => {
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${validAccessToken}`) {
    json(res, 401, { message: "Authorization header is required" });
    return false;
  }
  return true;
};

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) : {};

    if (req.method === "POST" && req.url === "/api/v1/auth/login") {
      json(res, 200, {
        code: 0,
        data: {
          temp_token: validTempToken,
          user_email_masked: "demo***@example.com"
        }
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/v1/auth/login/2fa") {
      if (body.temp_token !== validTempToken || body.code !== "123456") {
        json(res, 400, { message: "invalid 2fa code" });
        return;
      }
      json(res, 200, {
        code: 0,
        data: {
          access_token: validAccessToken,
          refresh_token: "refresh-2fa-token",
          user: {
            email: "demo@example.com"
          }
        }
      });
      return;
    }

    if (!requireBearer(req, res)) {
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/v1/user/profile")) {
      json(res, 200, { code: 0, data: { balance: 42.5, email: "demo@example.com", currency: "USD" } });
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/v1/usage/dashboard/stats")) {
      json(res, 200, {
        code: 0,
        data: {
          total_api_keys: 1,
          active_api_keys: 1,
          today_requests: 3,
          total_requests: 9,
          today_actual_cost: 1.5,
          total_actual_cost: 5.4,
          today_cost: 1.5,
          total_cost: 5.4,
          today_tokens: 1200,
          total_tokens: 3600,
          today_input_tokens: 700,
          today_output_tokens: 500,
          average_duration_ms: 1234,
          by_platform: [
            {
              platform: "openai",
              total_actual_cost: 5.4,
              today_actual_cost: 1.5,
              total_requests: 9,
              total_tokens: 3600
            }
          ]
        }
      });
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/v1/keys")) {
      json(res, 200, {
        code: 0,
        data: {
          items: [
            {
              id: "mock-key-1",
              name: "mock-key",
              status: "active",
              last_used_at: "2026-06-06T00:15:00+08:00",
              group: {
                name: "Mock Group",
                platform: "openai"
              }
            }
          ]
        }
      });
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/v1/subscriptions")) {
      json(res, 200, {
        code: 0,
        data: {
          items: [
            {
              id: "mock-sub-1",
              status: "active",
              expires_at: "2027-06-06T00:00:00+08:00",
              group: {
                name: "Mock Annual",
                platform: "openai",
                daily_limit_usd: 50
              },
              daily_usage_usd: 1.5,
              daily_window_start: "2026-06-06T00:00:00+08:00"
            }
          ]
        }
      });
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/v1/usage?page=1&page_size=20")) {
      json(res, 200, {
        code: 0,
        data: {
          items: [
            {
              id: "mock-usage-1",
              created_at: "2026-06-06T00:16:00+08:00",
              model: "gpt-4.1-mini",
              endpoint: "/responses",
              actual_cost: 0.5,
              total_cost: 0.5,
              input_tokens: 200,
              output_tokens: 300,
              total_tokens: 500,
              duration_ms: 2222,
              api_key: { name: "mock-key" },
              group: { platform: "openai" },
              subscription: { group: { name: "Mock Annual" } }
            }
          ]
        }
      });
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/v1/user/api-keys/mock-key-1/usage/daily")) {
      json(res, 200, {
        code: 0,
        data: {
          items: [
            {
              date: "2026-06-06",
              actual_cost: 1.5,
              total_cost: 1.5,
              requests: 3,
              total_tokens: 1200
            }
          ]
        }
      });
      return;
    }

    json(res, 404, { message: `unhandled ${req.method} ${req.url}` });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock-2fa-server listening on http://127.0.0.1:${port}`);
});
