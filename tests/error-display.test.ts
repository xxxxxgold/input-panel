import { describe, expect, it } from "vitest";

import { formatAppErrorMessage } from "../src/shared/lib/error-display";

describe("formatAppErrorMessage", () => {
  it("maps raw usage url failures to a user-friendly message", () => {
    expect(
      formatAppErrorMessage(
        "error sending request for url (https://ai.input.im/api/v1/usage?page=84&page_size=20&start_date=2026-06-12&end_date=2026-06-12)"
      )
    ).toBe("用量数据请求失败, 上游接口暂时不可用, 请稍后重试。");
  });

  it("keeps generic errors readable without leaking raw urls", () => {
    expect(formatAppErrorMessage("Request failed: 429 https://example.com/test")).toBe(
      "请求过于频繁, 请稍后再试。"
    );
  });

  it("maps service status upstream failures to a user-friendly message", () => {
    expect(
      formatAppErrorMessage("error sending request for url (https://status.input.im/api/status)")
    ).toBe("服务状态请求失败, 远端监控接口暂时不可用。");
  });
});
