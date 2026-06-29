import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { KeyRateSummary } from "../src/features/keys/components/KeyRateSummary";
import type { ManagedKeyRecord } from "../src/types";

describe("KeyRateSummary", () => {
  it("renders a chinese rounded status pill for active keys", () => {
    const keyRecord = {
      id: "key-1",
      name: "掌",
      status: "active",
      platform: "openai",
      groupName: "默认分组",
      expiresAt: null,
      lastUsedAt: null,
      quota: 100,
      quotaUsed: 12,
      rateLimit5h: 10,
      rateLimit1d: 20,
      rateLimit7d: 30,
      usage5h: 1,
      usage1d: 2,
      usage7d: 3,
      groupId: null,
      apiKeyId: 1,
      rawKey: null,
      userId: null,
      ipWhitelist: null,
      ipBlacklist: null,
      window5hStart: null,
      window1dStart: null,
      window7dStart: null
    } satisfies ManagedKeyRecord;

    const html = renderToStaticMarkup(createElement(KeyRateSummary, { keyRecord }));

    expect(html).toContain('class="status-pill ready"');
    expect(html).toContain(">已启用<");
    expect(html).not.toContain(">active<");
  });
});
