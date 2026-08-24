// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const usageClient = vi.hoisted(() => ({
  getApiKeyUsageSummary: vi.fn()
}));
const keyClient = vi.hoisted(() => ({
  createManagedKey: vi.fn(),
  updateManagedKey: vi.fn()
}));
const settingsClient = vi.hoisted(() => ({
  upsertSubscriptionSwitchRule: vi.fn(),
  deleteSubscriptionSwitchRule: vi.fn()
}));

vi.mock("../src/features/usage/client", () => usageClient);
vi.mock("../src/features/keys/client", async () => {
  const actual = await vi.importActual<typeof import("../src/features/keys/client")>("../src/features/keys/client");
  return {
    ...actual,
    createManagedKey: keyClient.createManagedKey,
    updateManagedKey: keyClient.updateManagedKey
  };
});
vi.mock("../src/api", async () => {
  const actual = await vi.importActual<typeof import("../src/api")>("../src/api");
  return {
    ...actual,
    upsertSubscriptionSwitchRule: settingsClient.upsertSubscriptionSwitchRule,
    deleteSubscriptionSwitchRule: settingsClient.deleteSubscriptionSwitchRule
  };
});

import {
  buildCcsImportUrl,
  buildKeyUsageSummaryScopeKey,
  buildOrderedCandidateGroups,
  buildSuggestedThresholdValueInput,
  KeyUsageDetailModal,
  KeysPage,
  preloadKeyUsageSummaryRange,
  UseApiKeyModal
} from "../src/pages/KeysPage";
import { ScopedResourceCache } from "../src/shared/state/scoped-resource-cache";
import type {
  GroupRecord,
  KeyUsageSummaryPayload,
  ManagedKeyRecord,
  PaginatedResult,
  SubscriptionRecord,
  UserProfileRecord
} from "../src/types";

const sampleManagedKey = {
  id: "key-1",
  name: "codex",
  status: "active",
  platform: "openai",
  groupName: "CodeX Plus 年度",
  expiresAt: null,
  lastUsedAt: "2026-07-02T10:41:00+08:00",
  quota: 500,
  quotaUsed: 104.22,
  rateLimit5h: 0,
  rateLimit1d: 500,
  rateLimit7d: 0,
  usage5h: 0,
  usage1d: 104.22,
  usage7d: 104.22,
  groupId: 2,
  apiKeyId: 3641,
  rawKey: "sk-test-placeholder-not-a-real-key-00000000000000000000000000000000",
  userId: 1,
  ipWhitelist: null,
  ipBlacklist: null,
  window5hStart: null,
  window1dStart: null,
  window7dStart: null
} satisfies ManagedKeyRecord;

const sampleManagedKeys = {
  items: [sampleManagedKey],
  page: 1,
  pageSize: 20,
  total: 1,
  pages: 1
} satisfies PaginatedResult<ManagedKeyRecord>;

const keysPageSource = readFileSync(resolve(process.cwd(), "src/pages/KeysPage.tsx"), "utf8");
const mainWindowAppSource = readFileSync(resolve(process.cwd(), "src/app/MainWindowApp.tsx"), "utf8");

function groupSubscriptionIdentity(
  groupId: number
): Pick<SubscriptionRecord, "subscriptionKey" | "identityKind" | "identityAmbiguous"> {
  return {
    subscriptionKey: `group:${groupId}`,
    identityKind: "group",
    identityAmbiguous: false
  };
}

function createSubscriptionChainFixture() {
  const groups: GroupRecord[] = [
    { id: 2, name: "CodeX Plus 年度", platform: "openai", rateMultiplier: 1, subscriptionType: "subscription" },
    { id: 3, name: "CodeX Lite 月度", platform: "openai", rateMultiplier: 1, subscriptionType: "subscription" }
  ];
  const subscriptions: SubscriptionRecord[] = [
    {
      id: "sub-plus",
      ...groupSubscriptionIdentity(2),
      groupId: 2,
      name: "CodeX Plus 年度",
      groupName: "CodeX Plus 年度",
      status: "active",
      platform: "openai",
      expiresAt: null,
      daily: { current: 0, limit: 500 },
      weekly: null,
      monthly: null
    },
    {
      id: "sub-lite",
      ...groupSubscriptionIdentity(3),
      groupId: 3,
      name: "CodeX Lite 月度",
      groupName: "CodeX Lite 月度",
      status: "active",
      platform: "openai",
      expiresAt: null,
      daily: { current: 0, limit: 100 },
      weekly: null,
      monthly: null
    }
  ];
  return { groups, subscriptions };
}

function createKeyUsageSummary(): KeyUsageSummaryPayload {
  return {
    dailyUsage: [],
    today: {
      requests: 1,
      inputTokens: 2,
      outputTokens: 3,
      cacheCreationTokens: 4,
      cacheReadTokens: 5,
      totalTokens: 14,
      cost: 0.01,
      actualCost: 0.01
    },
    total: {
      requests: 1,
      inputTokens: 2,
      outputTokens: 3,
      cacheCreationTokens: 4,
      cacheReadTokens: 5,
      totalTokens: 14,
      cost: 0.01,
      actualCost: 0.01
    },
    averageDurationMs: null,
    rpm: null,
    tpm: null,
    planName: null,
    remaining: null,
    subscription: null,
    modelStats: []
  };
}

beforeEach(() => {
  usageClient.getApiKeyUsageSummary.mockResolvedValue(createKeyUsageSummary());
  keyClient.createManagedKey.mockResolvedValue(sampleManagedKey);
  keyClient.updateManagedKey.mockResolvedValue(sampleManagedKey);
  settingsClient.upsertSubscriptionSwitchRule.mockResolvedValue(null);
  settingsClient.deleteSubscriptionSwitchRule.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("KeysPage key form accessibility", () => {
  it("gives every icon-only key option switch a stable accessible name", () => {
    const view = render(
      createElement(KeysPage, {
        managedKeys: null,
        groups: [],
        profileRecord: null,
        selectedAccountId: "account-1",
        onRefresh: () => {},
        onError: () => {},
        onBusy: () => {},
        onSaveFeedback: () => {}
      })
    );

    fireEvent.click(view.getByRole("button", { name: "新增密钥" }));

    for (const name of ["自定义密钥", "IP 限制", "速率限制", "密钥有效期"]) {
      expect(view.getByRole("button", { name })).toBeTruthy();
    }
  });
});

describe("KeysPage save feedback", () => {
  const standardGroup: GroupRecord = {
    id: 2,
    name: "默认分组",
    platform: "openai",
    rateMultiplier: 1,
    subscriptionType: "standard"
  };

  it("reports API Key creation after the mutation succeeds", async () => {
    const onSaveFeedback = vi.fn();
    const onRefresh = vi.fn();
    const view = render(
      createElement(KeysPage, {
        managedKeys: null,
        groups: [standardGroup],
        profileRecord: null,
        selectedAccountId: "account-1",
        onRefresh,
        onError: vi.fn(),
        onBusy: vi.fn(),
        onSaveFeedback
      })
    );

    fireEvent.click(view.getByRole("button", { name: "新增密钥" }));
    fireEvent.change(view.getByLabelText("名称"), { target: { value: "new-key" } });
    fireEvent.click(view.getByRole("button", { name: "创建密钥" }));

    await waitFor(() => expect(keyClient.createManagedKey).toHaveBeenCalledWith(
      "account-1",
      expect.objectContaining({ name: "new-key", groupId: 2 })
    ));
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onSaveFeedback).toHaveBeenCalledWith({
      tone: "success",
      title: "保存成功",
      message: "API Key 已创建。"
    });
  });

  it("reports API Key updates and suppresses success when the mutation fails", async () => {
    const onSaveFeedback = vi.fn();
    const onError = vi.fn();
    const renderPage = () => createElement(KeysPage, {
      managedKeys: sampleManagedKeys,
      groups: [standardGroup],
      profileRecord: null,
      selectedAccountId: "account-1",
      onRefresh: vi.fn(),
      onError,
      onBusy: vi.fn(),
      onSaveFeedback
    });
    const view = render(renderPage());

    fireEvent.click(view.getByRole("button", { name: "编辑" }));
    fireEvent.click(view.getByRole("button", { name: "更新密钥" }));
    await waitFor(() => expect(onSaveFeedback).toHaveBeenCalledWith({
      tone: "success",
      title: "保存成功",
      message: "API Key 已更新。"
    }));

    cleanup();
    vi.clearAllMocks();
    usageClient.getApiKeyUsageSummary.mockResolvedValue(createKeyUsageSummary());
    keyClient.updateManagedKey.mockRejectedValueOnce(new Error("key update offline"));
    const failedFeedback = vi.fn();
    const failedError = vi.fn();
    const failedView = render(
      createElement(KeysPage, {
        managedKeys: sampleManagedKeys,
        groups: [standardGroup],
        profileRecord: null,
        selectedAccountId: "account-1",
        onRefresh: vi.fn(),
        onError: failedError,
        onBusy: vi.fn(),
        onSaveFeedback: failedFeedback
      })
    );
    fireEvent.click(failedView.getByRole("button", { name: "编辑" }));
    fireEvent.click(failedView.getByRole("button", { name: "更新密钥" }));

    await waitFor(() => expect(failedError).toHaveBeenCalledWith("key update offline"));
    expect(failedFeedback).not.toHaveBeenCalled();
  });
});

describe("KeysPage available group summary", () => {
  it("renders subscription groups before standard groups", () => {
    const subscriptionGroup: GroupRecord = {
      id: 2,
      name: "CodeX Plus 月度",
      platform: "openai",
      rateMultiplier: 1,
      subscriptionType: "subscription",
      dailyLimitUsd: 500,
      weeklyLimitUsd: 0,
      monthlyLimitUsd: 0,
      allowMessagesDispatch: true
    };
    const standardGroup: GroupRecord = {
      id: 1,
      name: "CodeX 余额",
      platform: "openai",
      rateMultiplier: 0.1,
      subscriptionType: "standard",
      dailyLimitUsd: 0,
      weeklyLimitUsd: 0,
      monthlyLimitUsd: 0,
      allowMessagesDispatch: true
    };

    const html = renderToStaticMarkup(
      createElement(KeysPage, {
        managedKeys: null,
        groups: [standardGroup, subscriptionGroup],
        profileRecord: null,
        selectedAccountId: "account-1",
        onRefresh: () => {},
        onError: () => {},
        onBusy: () => {}
      })
    );

    expect(html.indexOf("CodeX Plus 月度")).toBeLessThan(html.indexOf("CodeX 余额"));
    expect(html).toContain('class="available-group-grid"');
    expect(html).toContain('class="available-group-name-pill"');
  });

  it("keeps the platform with the left identity and moves the subscription type into right metadata", () => {
    const group: GroupRecord = {
      id: 5,
      name: "CodeX Plus 月度",
      platform: "openai",
      rateMultiplier: 1,
      subscriptionType: "subscription",
      dailyLimitUsd: 500,
      weeklyLimitUsd: 0,
      monthlyLimitUsd: 0,
      allowMessagesDispatch: true
    };

    const html = renderToStaticMarkup(
      createElement(KeysPage, {
        managedKeys: null,
        groups: [group],
        profileRecord: null,
        selectedAccountId: "account-1",
        onRefresh: () => {},
        onError: () => {},
        onBusy: () => {}
      })
    );
    const copyStart = html.indexOf('<div class="available-group-copy">');
    const inlineStart = html.indexOf('<div class="available-group-inline">');
    const platformStart = html.indexOf('class="key-platform-pill openai"');
    const subscriptionTypeStart = html.indexOf('class="subscription-type-pill"');

    expect(copyStart).toBeGreaterThan(-1);
    expect(inlineStart).toBeGreaterThan(copyStart);
    expect(platformStart).toBeGreaterThan(copyStart);
    expect(platformStart).toBeLessThan(inlineStart);
    expect(subscriptionTypeStart).toBeGreaterThan(inlineStart);
  });

  it("renders balance type and only non-zero quota windows", () => {
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

    const html = renderToStaticMarkup(
      createElement(KeysPage, {
        managedKeys: null,
        groups: [group],
        profileRecord: null,
        selectedAccountId: "account-1",
        onRefresh: () => {},
        onError: () => {},
        onBusy: () => {}
      })
    );

    expect(html).toContain('aria-label="分组额度"');
    expect(html).toContain(">余额</span>");
    expect(html).toContain('class="subscription-rate-pill"');
    expect(html).toContain("倍率: x1.00");
    expect(html).toContain("<small>日</small><strong>$120</strong>");
    expect(html).toContain("<small>周</small><strong>$480</strong>");
    expect(html).toContain("<small>月</small><strong>$960</strong>");
    expect(html).not.toContain(">standard</span>");
  });

  it("hides zero quota windows entirely when all windows are zero", () => {
    const group: GroupRecord = {
      id: 8,
      name: "Codex 备用",
      platform: "openai",
      rateMultiplier: 1,
      subscriptionType: "standard",
      dailyLimitUsd: null,
      weeklyLimitUsd: null,
      monthlyLimitUsd: null,
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

    expect(html).not.toContain("暂无非 0 额度");
    expect(html).not.toContain("<small>日</small><strong>$0</strong>");
    expect(html).not.toContain("<small>周</small><strong>$0</strong>");
    expect(html).not.toContain("<small>月</small><strong>$0</strong>");
  });

  it("hides weekly and monthly quota pills when their values are zero", () => {
    const group: GroupRecord = {
      id: 9,
      name: "CodeX Plus 月度",
      platform: "openai",
      rateMultiplier: 1,
      subscriptionType: "subscription",
      dailyLimitUsd: 500,
      weeklyLimitUsd: 0,
      monthlyLimitUsd: 0,
      allowMessagesDispatch: true
    };

    const html = renderToStaticMarkup(
      createElement(KeysPage, {
        managedKeys: null,
        groups: [group],
        profileRecord: null,
        selectedAccountId: "account-3",
        onRefresh: () => {},
        onError: () => {},
        onBusy: () => {}
      })
    );

    expect(html).toContain("<small>日</small><strong>$500</strong>");
    expect(html).not.toContain("<small>周</small><strong>$0</strong>");
    expect(html).not.toContain("<small>月</small><strong>$0</strong>");
  });

  it("renders a clickable key usage detail trigger on managed keys", () => {
    const html = renderToStaticMarkup(
      createElement(KeysPage, {
        managedKeys: sampleManagedKeys,
        groups: [],
        profileRecord: null,
        selectedAccountId: "account-1",
        onRefresh: () => {},
        onError: () => {},
        onBusy: () => {}
      })
    );

    expect(html).toContain('aria-label="查看 codex 的密钥用量详情"');
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("key-row-trigger");
    expect(html).not.toContain("点击查看用量");
    expect(html).not.toContain("key-row-usage-cue");
    expect(html).toContain(`${sampleManagedKey.rawKey.slice(0, 10)}...${sampleManagedKey.rawKey.slice(-8)}`);
    expect(html).toContain(">使用密钥</button>");
    expect(html).toContain(">配置订阅链</button>");
    expect(html).not.toContain(">导入到 CCS</button>");
  });

  it("opens a subscription picker, keeps unavailable records visible, and updates only the selected key", async () => {
    const subscriptions: SubscriptionRecord[] = [
      {
        id: "subscription-current",
        ...groupSubscriptionIdentity(2),
        groupId: 2,
        name: "CodeX Plus 年度",
        groupName: "CodeX Plus 年度",
        status: "active",
        platform: "openai",
        expiresAt: "2099-10-01T00:00:00+08:00",
        daily: { current: 125, limit: 500 },
        weekly: { current: 200, limit: 1000 },
        monthly: { current: 450, limit: 2000 }
      },
      {
        id: "subscription-ready",
        ...groupSubscriptionIdentity(3),
        groupId: 3,
        name: "CodeX Lite 月度",
        groupName: "CodeX Lite 月度",
        status: "active",
        platform: "openai",
        expiresAt: "2099-09-01T00:00:00+08:00",
        daily: { current: 20, limit: 100 },
        weekly: null,
        monthly: null
      },
      {
        id: "subscription-unavailable",
        ...groupSubscriptionIdentity(4),
        groupId: 4,
        name: "CodeX Air 订阅",
        groupName: "CodeX Air 订阅",
        status: "inactive",
        platform: "openai",
        expiresAt: "2099-08-01T00:00:00+08:00",
        daily: { current: 0, limit: 300 },
        weekly: { current: 0, limit: 600 },
        monthly: { current: 0, limit: 900 }
      }
    ];
    const onRefresh = vi.fn();
    const onError = vi.fn();
    const view = render(
      createElement(KeysPage, {
        managedKeys: sampleManagedKeys,
        groups: [],
        subscriptions,
        profileRecord: null,
        selectedAccountId: "account-1",
        onRefresh,
        onError,
        onBusy: () => {}
      })
    );
    const trigger = view.getByRole("button", { name: "切换 codex 的订阅" });

    expect(trigger.querySelectorAll(".key-subscription-tag")).toHaveLength(2);
    expect(trigger.querySelector("svg")).toBeNull();
    expect(trigger.textContent).toContain("CodeX Plus 年度");
    expect(trigger.textContent).toContain("openai");

    fireEvent.click(trigger);
    expect(view.queryByRole("heading", { name: "codex 用量详情" })).toBeNull();
    expect(view.getByRole("heading", { name: "codex · 选择订阅" })).toBeTruthy();
    const currentSubscriptionOption = view.getByRole("button", { name: "CodeX Plus 年度，当前订阅" }) as HTMLButtonElement;
    expect(currentSubscriptionOption.disabled).toBe(true);
    expect(currentSubscriptionOption.querySelectorAll("div")).toHaveLength(0);
    expect((view.getByRole("button", { name: "CodeX Air 订阅 暂不可切换" }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.container.querySelector(".key-subscription-option.current")).not.toBeNull();
    expect(view.container.querySelector(".key-subscription-picker-summary-name-row .key-subscription-picker-platform")?.textContent).toBe("openai");
    expect(currentSubscriptionOption.querySelector(".key-subscription-option-copy > strong + .key-subscription-option-meta")).not.toBeNull();
    expect(view.getAllByText("每日额度")).toHaveLength(3);
    expect(view.getAllByText("每周额度")).toHaveLength(2);
    expect(view.getAllByText("每月额度")).toHaveLength(2);
    expect(view.getAllByText(/剩余 \d+ 天/).length).toBeGreaterThan(0);

    fireEvent.click(view.getByRole("button", { name: "切换到 CodeX Lite 月度" }));

    await waitFor(() => expect(keyClient.updateManagedKey).toHaveBeenCalledWith("account-1", "key-1", { groupId: 3 }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(null);
    await waitFor(() => expect(view.queryByRole("heading", { name: "codex · 选择订阅" })).toBeNull());
  });

  it("renders two rounded subscription tags and copies from the full secret row", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    const view = render(
      createElement(KeysPage, {
        managedKeys: sampleManagedKeys,
        groups: [],
        profileRecord: null,
        selectedAccountId: "account-1",
        onRefresh: () => {},
        onError: () => {},
        onBusy: () => {}
      })
    );
    const trigger = view.getByRole("button", { name: "切换 codex 的订阅" });
    const subscriptionSwitch = trigger.closest(".key-subscription-switch");
    const secretRow = view.container.querySelector(".key-secret-row");

    expect(Array.from(subscriptionSwitch?.querySelectorAll(".key-subscription-tag") ?? []).map((tag) => tag.textContent)).toEqual([
      "CodeX Plus 年度",
      "openai"
    ]);
    expect(view.container.querySelector(".key-subscription-select")).toBeNull();
    expect(secretRow).not.toBeNull();

    fireEvent.click(secretRow!);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(sampleManagedKey.rawKey));
    expect(view.queryByRole("heading", { name: "codex 用量详情" })).toBeNull();
  });

  it("keeps the server binding selected when a quick subscription switch fails", async () => {
    keyClient.updateManagedKey.mockRejectedValueOnce(new Error("切换失败"));
    const onError = vi.fn();
    const view = render(
      createElement(KeysPage, {
        managedKeys: sampleManagedKeys,
        groups: [],
        subscriptions: [
          {
            id: "subscription-ready",
            ...groupSubscriptionIdentity(3),
            groupId: 3,
            name: "CodeX Lite 月度",
            groupName: "CodeX Lite 月度",
            status: "active",
            platform: "openai",
            expiresAt: null,
            daily: null,
            weekly: null,
            monthly: null
          }
        ],
        profileRecord: null,
        selectedAccountId: "account-1",
        onRefresh: () => {},
        onError: onError,
        onBusy: () => {}
      })
    );
    const trigger = view.getByRole("button", { name: "切换 codex 的订阅" });

    fireEvent.click(trigger);
    const currentSubscriptionOption = view.getByRole("button", { name: "CodeX Plus 年度，当前订阅" });
    expect(currentSubscriptionOption.querySelectorAll("div")).toHaveLength(0);
    expect(currentSubscriptionOption.querySelector(".key-subscription-quota-grid")).toBeNull();
    expect(view.queryByText("暂无额度")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "切换到 CodeX Lite 月度" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("切换失败"));
    expect(view.getByRole("heading", { name: "codex · 选择订阅" })).toBeTruthy();
    expect((view.getByRole("button", { name: "CodeX Plus 年度，当前订阅" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("preloads today's key usage summaries with bounded concurrency and reuses snapshots", async () => {
    const cache = new ScopedResourceCache<KeyUsageSummaryPayload>();
    const range = { mode: "today" as const, days: 1, startDate: "2026-07-23", endDate: "2026-07-23" };
    const calls: Array<{ accountId: string; keyId: string; days: number; startDate: string; endDate: string }> = [];
    let activeRequests = 0;
    let maxActiveRequests = 0;

    await preloadKeyUsageSummaryRange({
      cache,
      accountId: "account-1",
      keys: [
        { id: "key-1" },
        { id: "key-2" },
        { id: "key-3" },
        { id: "key-2" }
      ],
      range,
      concurrency: 2,
      fetchSummary: async (accountId, keyId, days, query) => {
        calls.push({ accountId, keyId, days, startDate: query.startDate, endDate: query.endDate });
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        await Promise.resolve();
        activeRequests -= 1;
        return createKeyUsageSummary();
      }
    });

    expect(calls).toEqual([
      expect.objectContaining({ accountId: "account-1", keyId: "key-1", days: 1, startDate: "2026-07-23", endDate: "2026-07-23" }),
      expect.objectContaining({ accountId: "account-1", keyId: "key-2", days: 1, startDate: "2026-07-23", endDate: "2026-07-23" }),
      expect.objectContaining({ accountId: "account-1", keyId: "key-3", days: 1, startDate: "2026-07-23", endDate: "2026-07-23" })
    ]);
    expect(maxActiveRequests).toBeLessThanOrEqual(2);
    expect(cache.peek(buildKeyUsageSummaryScopeKey({ accountId: "account-1", keyId: "key-1", range })).hasSnapshot).toBe(true);

    await preloadKeyUsageSummaryRange({
      cache,
      accountId: "account-1",
      keys: [{ id: "key-1" }, { id: "key-2" }, { id: "key-3" }],
      range,
      fetchSummary: async () => {
        throw new Error("已命中的预热快照不应重复请求");
      }
    });

    expect(calls).toHaveLength(3);
    expect(keysPageSource).toContain('const range = buildKeyUsagePresetRange("today");');
    expect(keysPageSource).toContain("void preloadKeyUsageSummaryRange({");
    expect(keysPageSource).toContain('useState<KeyUsageRangeQuery>(() => buildKeyUsagePresetRange("today"))');
  });

  it("stops scheduling warmup requests after the current scope is cancelled", async () => {
    const cache = new ScopedResourceCache<KeyUsageSummaryPayload>();
    const range = { mode: "today" as const, days: 1, startDate: "2026-07-23", endDate: "2026-07-23" };
    let cancelled = false;
    let resolveFirstRequest: ((summary: KeyUsageSummaryPayload) => void) | null = null;
    const calls: string[] = [];

    const preload = preloadKeyUsageSummaryRange({
      cache,
      accountId: "account-1",
      keys: [{ id: "key-1" }, { id: "key-2" }, { id: "key-3" }],
      range,
      concurrency: 1,
      shouldContinue: () => !cancelled,
      fetchSummary: (_accountId, keyId) => {
        calls.push(keyId);
        return new Promise<KeyUsageSummaryPayload>((resolve) => {
          resolveFirstRequest = resolve;
        });
      }
    });

    expect(calls).toEqual(["key-1"]);
    cancelled = true;
    resolveFirstRequest?.(createKeyUsageSummary());
    await preload;

    expect(calls).toEqual(["key-1"]);
  });

  it("returns a newly opened detail to today and hides the old account detail immediately", async () => {
    const managedKeys = {
      ...sampleManagedKeys,
      items: [
        sampleManagedKey,
        {
          ...sampleManagedKey,
          id: "key-2",
          name: "claude"
        }
      ]
    } satisfies PaginatedResult<ManagedKeyRecord>;
    const renderPage = (selectedAccountId: string) => createElement(KeysPage, {
      managedKeys,
      groups: [],
      profileRecord: null,
      selectedAccountId,
      onRefresh: () => {},
      onError: () => {},
      onBusy: () => {}
    });
    const view = render(renderPage("account-1"));

    await waitFor(() => expect(usageClient.getApiKeyUsageSummary).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    usageClient.getApiKeyUsageSummary.mockClear();

    fireEvent.click(view.getByRole("button", { name: "查看 codex 的密钥用量详情" }));
    await waitFor(() => expect(usageClient.getApiKeyUsageSummary).toHaveBeenLastCalledWith(
      "account-1",
      "key-1",
      1,
      expect.any(Object)
    ));
    fireEvent.click(view.getByRole("button", { name: "30天" }));
    await waitFor(() => expect(usageClient.getApiKeyUsageSummary).toHaveBeenLastCalledWith(
      "account-1",
      "key-1",
      30,
      expect.any(Object)
    ));
    fireEvent.click(view.getByRole("button", { name: "关闭" }));

    fireEvent.click(view.getByRole("button", { name: "查看 claude 的密钥用量详情" }));
    await waitFor(() => expect(usageClient.getApiKeyUsageSummary).toHaveBeenLastCalledWith(
      "account-1",
      "key-2",
      1,
      expect.any(Object)
    ));
    await waitFor(() => expect(view.queryByRole("heading", { name: "claude 用量详情" })).not.toBeNull());

    view.rerender(renderPage("account-2"));

    expect(view.queryByRole("heading", { name: "claude 用量详情" })).toBeNull();
    expect(keysPageSource).toContain('range = buildKeyUsagePresetRange("today")');
    expect(keysPageSource).toContain("usageDetailAccountId === selectedAccountId");
    expect(keysPageSource).toContain("shouldContinue: () => !cancelled");
  });

  it("remounts the full key workspace when the site changes for the same account id", () => {
    const accountId = "shared-account";
    const originalRawKey = "sk-site-a-legacy-secret";
    const siteAKeys = {
      ...sampleManagedKeys,
      items: [{ ...sampleManagedKey, rawKey: originalRawKey }]
    } satisfies PaginatedResult<ManagedKeyRecord>;
    const siteBKeys = {
      ...sampleManagedKeys,
      items: [{ ...sampleManagedKey, name: "site-b-key", rawKey: "sk-site-b-current-secret" }]
    } satisfies PaginatedResult<ManagedKeyRecord>;
    const renderPage = (siteId: string, managedKeys: PaginatedResult<ManagedKeyRecord>) => createElement(KeysPage, {
      key: `keys-page:${siteId}:${accountId}`,
      managedKeys,
      groups: [],
      profileRecord: null,
      selectedAccountId: accountId,
      onRefresh: () => {},
      onError: () => {},
      onBusy: () => {}
    });
    const view = render(renderPage("site-a", siteAKeys));

    fireEvent.click(view.getByRole("button", { name: "编辑" }));
    expect(view.getByRole("heading", { name: "编辑密钥" })).toBeTruthy();
    expect(view.getByDisplayValue(originalRawKey)).toBeTruthy();

    view.rerender(renderPage("site-b", siteBKeys));

    expect(view.queryByRole("heading", { name: "编辑密钥" })).toBeNull();
    expect(view.queryByDisplayValue(originalRawKey)).toBeNull();
    expect(view.queryByRole("button", { name: "更新密钥" })).toBeNull();
    expect(mainWindowAppSource).toContain('key={`keys-page:${selectedSite?.id ?? "none"}:${selectedAccountId ?? "none"}`}');
  });

  it("renders key current concurrency without substituting account concurrency", () => {
    const html = renderToStaticMarkup(
      createElement(KeysPage, {
        managedKeys: {
          ...sampleManagedKeys,
          items: [
            { ...sampleManagedKey, currentConcurrency: 7 },
            { ...sampleManagedKey, id: "key-2", name: "idle", currentConcurrency: 0 },
            { ...sampleManagedKey, id: "key-3", name: "unknown", currentConcurrency: null }
          ]
        },
        groups: [],
        profileRecord: {
          id: 1,
          email: "account@example.com",
          role: "user",
          balance: 0,
          concurrency: 99,
          status: "active",
          identities: {},
          authBindings: {},
          identityBindings: {}
        } satisfies UserProfileRecord,
        selectedAccountId: "account-1",
        onRefresh: () => {},
        onError: () => {},
        onBusy: () => {}
      })
    );

    expect(html).toContain("当前并发：7");
    expect(html).toContain("当前并发：0");
    expect(html).toContain("当前并发：-");
    expect(html).toContain('class="key-concurrency-pill active"');
    expect(html).toContain('class="key-concurrency-pill idle"');
    expect(html).toContain('class="key-concurrency-pill unknown"');
    expect(html).not.toContain("当前并发：99");
  });

  it("orders candidate groups by current subscriptions before fallback groups", () => {
    const subscriptions: SubscriptionRecord[] = [
      {
        id: "sub-2",
        ...groupSubscriptionIdentity(3),
        groupId: 3,
        name: "Backup B",
        status: "active",
        groupName: "Backup B",
        platform: "openai",
        expiresAt: null,
        daily: null,
        weekly: null,
        monthly: null
      },
      {
        id: "sub-1",
        ...groupSubscriptionIdentity(2),
        groupId: 2,
        name: "Backup A",
        status: "active",
        groupName: "Backup A",
        platform: "openai",
        expiresAt: null,
        daily: null,
        weekly: null,
        monthly: null
      }
    ];
    const groups: GroupRecord[] = [
      { id: 1, name: "Source", platform: "openai", rateMultiplier: 1, subscriptionType: "subscription" },
      { id: 2, name: "Backup A", platform: "openai", rateMultiplier: 1, subscriptionType: "subscription" },
      { id: 3, name: "Backup B", platform: "openai", rateMultiplier: 1, subscriptionType: "subscription" },
      { id: 4, name: "Backup C", platform: "openai", rateMultiplier: 1, subscriptionType: "subscription" }
    ];

    const ordered = buildOrderedCandidateGroups(subscriptions, groups, 1);

    expect(ordered.map((item) => item.id)).toEqual([1, 3, 2, 4]);
  });

  it("lets any added subscription become the chain head and saves the new order", async () => {
    const { groups, subscriptions } = createSubscriptionChainFixture();
    const onRefreshSubscriptionChain = vi.fn().mockResolvedValue(undefined);
    const onSaveFeedback = vi.fn();
    const view = render(
      createElement(KeysPage, {
        managedKeys: sampleManagedKeys,
        groups,
        subscriptions,
        profileRecord: null,
        selectedAccountId: "account-1",
        onRefresh: () => {},
        onError: () => {},
        onBusy: () => {},
        onSaveFeedback,
        onRefreshSubscriptionChain
      })
    );

    fireEvent.click(view.getByRole("button", { name: "配置订阅链" }));
    expect((view.getByRole("button", { name: "CodeX Plus 年度 已加入订阅链" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(view.getByRole("button", { name: "将 CodeX Lite 月度 加入订阅链" }));
    fireEvent.click(view.getByRole("button", { name: "上移 CodeX Lite 月度" }));

    expect(view.getByText("链首 · CodeX Lite 月度")).toBeTruthy();
    expect(view.getByText("候补 1 · CodeX Plus 年度")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "保存规则" }));

    await waitFor(() =>
      expect(settingsClient.upsertSubscriptionSwitchRule).toHaveBeenCalledWith("account-1", "key-1", {
        enabled: true,
        sourceGroupId: 3,
        chainNodes: [
          { groupId: 3, thresholdMode: "usage_percent", thresholdValue: 99 },
          { groupId: 2, thresholdMode: "usage_percent", thresholdValue: 99 }
        ],
        autoRestore: true,
        strictMode: false
      })
    );
    expect(onRefreshSubscriptionChain).toHaveBeenCalledTimes(1);
    expect(onSaveFeedback).toHaveBeenCalledWith({
      tone: "success",
      title: "保存成功",
      message: "订阅链规则已保存。"
    });
  });

  it("renders accessible switches, moves subtitles into hints and persists strict mode", async () => {
    const { groups, subscriptions } = createSubscriptionChainFixture();
    const view = render(
      createElement(KeysPage, {
        managedKeys: sampleManagedKeys,
        groups,
        subscriptions,
        profileRecord: null,
        selectedAccountId: "account-1",
        onRefresh: () => {},
        onError: () => {},
        onBusy: () => {},
        onSaveFeedback: () => {},
        onRefreshSubscriptionChain: vi.fn().mockResolvedValue(undefined)
      })
    );

    fireEvent.click(view.getByRole("button", { name: "配置订阅链" }));

    for (const name of ["启用自动切换", "恢复后自动切回链首", "严格模式"]) {
      expect(view.getByRole("checkbox", { name })).toBeTruthy();
    }
    expect((view.getByRole("checkbox", { name: "启用自动切换" }) as HTMLInputElement).checked).toBe(true);
    expect((view.getByRole("checkbox", { name: "恢复后自动切回链首" }) as HTMLInputElement).checked).toBe(true);
    expect((view.getByRole("checkbox", { name: "严格模式" }) as HTMLInputElement).checked).toBe(false);
    expect(view.queryByText(/当阈值命中或源订阅异常时/)).toBeNull();
    expect(view.queryByText(/当链首订阅重新低于阈值并恢复正常时/)).toBeNull();

    const automaticHint = view.getByRole("button", { name: "查看启用自动切换说明" });
    fireEvent.pointerEnter(automaticHint, { pointerType: "mouse" });
    expect(view.getByRole("tooltip").textContent).toContain("链尾没有可用项时会回到链首继续查找");
    fireEvent.pointerLeave(automaticHint, { pointerType: "mouse" });

    fireEvent.click(view.getByRole("checkbox", { name: "严格模式" }));
    fireEvent.click(view.getByRole("button", { name: "将 CodeX Lite 月度 加入订阅链" }));
    fireEvent.click(view.getByRole("button", { name: "保存规则" }));

    await waitFor(() =>
      expect(settingsClient.upsertSubscriptionSwitchRule).toHaveBeenCalledWith(
        "account-1",
        "key-1",
        expect.objectContaining({ strictMode: true })
      )
    );
  });

  it("keeps the rule editor error and reports a server save failure", async () => {
    const { groups, subscriptions } = createSubscriptionChainFixture();
    const onSaveFeedback = vi.fn();
    settingsClient.upsertSubscriptionSwitchRule.mockRejectedValueOnce(
      new Error("订阅链保存接口不可用")
    );
    const view = render(
      createElement(KeysPage, {
        managedKeys: sampleManagedKeys,
        groups,
        subscriptions,
        profileRecord: null,
        selectedAccountId: "account-1",
        onRefresh: () => {},
        onError: vi.fn(),
        onBusy: vi.fn(),
        onSaveFeedback,
        onRefreshSubscriptionChain: vi.fn().mockResolvedValue(undefined)
      })
    );

    fireEvent.click(view.getByRole("button", { name: "配置订阅链" }));
    fireEvent.click(view.getByRole("button", { name: "将 CodeX Lite 月度 加入订阅链" }));
    fireEvent.click(view.getByRole("button", { name: "保存规则" }));

    await waitFor(() => expect(view.getByText("订阅链保存接口不可用")).toBeTruthy());
    expect(onSaveFeedback).toHaveBeenCalledWith({
      tone: "error",
      title: "保存失败",
      message: "订阅链保存接口不可用"
    });
    expect(view.getByRole("heading", { name: "codex · 订阅链规则" })).toBeTruthy();
  });

  it("reports saved-but-refresh-failed without claiming full success", async () => {
    const { groups, subscriptions } = createSubscriptionChainFixture();
    const onSaveFeedback = vi.fn();
    const onRefreshSubscriptionChain = vi.fn().mockRejectedValue(new Error("刷新接口不可用"));
    const view = render(
      createElement(KeysPage, {
        managedKeys: sampleManagedKeys,
        groups,
        subscriptions,
        profileRecord: null,
        selectedAccountId: "account-1",
        onRefresh: () => {},
        onError: vi.fn(),
        onBusy: vi.fn(),
        onSaveFeedback,
        onRefreshSubscriptionChain
      })
    );

    fireEvent.click(view.getByRole("button", { name: "配置订阅链" }));
    fireEvent.click(view.getByRole("button", { name: "将 CodeX Lite 月度 加入订阅链" }));
    fireEvent.click(view.getByRole("button", { name: "保存规则" }));

    const message = "订阅链规则已保存，但刷新显示失败: 刷新接口不可用";
    await waitFor(() => expect(view.getByText(message)).toBeTruthy());
    expect(onSaveFeedback).toHaveBeenCalledWith({
      tone: "error",
      title: "刷新失败",
      message
    });
    expect(onSaveFeedback).not.toHaveBeenCalledWith(
      expect.objectContaining({ tone: "success" })
    );
  });

  it("stores thresholds per node without a fixed source-only control", () => {
    expect(keysPageSource).toContain("chainNodes: RuleDraftChainNode[]");
    expect(keysPageSource).toContain("activeTargetGroupId: number | null");
    expect(keysPageSource).toContain("strictMode: boolean");
    expect(keysPageSource).toContain("当前密钥所在订阅必须保留在订阅链中");
    expect(keysPageSource).toContain("disabled={isProtectedNode || ruleSaving}");
    expect(keysPageSource).toContain("ruleSavingRef.current");
    expect(keysPageSource).toContain("上次链路诊断:");
    expect(keysPageSource).not.toContain("源订阅必须固定在订阅链首");
    expect(keysPageSource).toContain("链尾没有可用项时会回到链首继续查找");
    expect(keysPageSource).toContain("updateRuleDraftChainNode");
    expect(keysPageSource).toContain("selected ? \"已添加\"");
  });

  it("suggests an amount threshold at 97 percent without exceeding the visible quota", () => {
    const baseSubscription = {
      id: "sub-1",
      ...groupSubscriptionIdentity(1),
      groupId: 1,
      name: "Source",
      status: "active",
      groupName: "Source",
      platform: "openai",
      expiresAt: null,
      weekly: null,
      monthly: null
    } satisfies Omit<SubscriptionRecord, "daily">;

    expect(
      buildSuggestedThresholdValueInput("amount_usd", {
        ...baseSubscription,
        daily: { current: 0, limit: 50.99 }
      }, null)
    ).toBe("49.46");
    expect(
      buildSuggestedThresholdValueInput("amount_usd", {
        ...baseSubscription,
        daily: { current: 0, limit: 0.8 }
      }, null)
    ).toBe("0.78");
  });

  it("opens edit from the current row data without reloading key details", () => {
    expect(keysPageSource).not.toContain('onBusy("正在加载密钥详情...")');
    expect(keysPageSource).not.toContain("await getManagedKey(");
    expect(keysPageSource).toContain("openEditKey(key);");
  });

  it("builds an openai CCS import url with codex target and usage script", () => {
    const importUrl = buildCcsImportUrl({
      baseUrl: "https://mirror.input.im/",
      platform: "openai",
      clientType: "claude",
      providerName: "AI INPUT",
      apiKey: sampleManagedKey.rawKey ?? ""
    });
    const parsed = new URL(importUrl);

    expect(parsed.protocol).toBe("ccswitch:");
    expect(parsed.host).toBe("v1");
    expect(parsed.pathname).toBe("/import");
    expect(parsed.searchParams.get("resource")).toBe("provider");
    expect(parsed.searchParams.get("app")).toBe("codex");
    expect(parsed.searchParams.get("model")).toBe("gpt-5.4");
    expect(parsed.searchParams.get("name")).toBe("AI INPUT");
    expect(parsed.searchParams.get("homepage")).toBe("https://mirror.input.im");
    expect(parsed.searchParams.get("endpoint")).toBe("https://mirror.input.im");
    expect(parsed.searchParams.get("apiKey")).toBe(sampleManagedKey.rawKey);
    expect(parsed.searchParams.get("configFormat")).toBe("json");
    expect(parsed.searchParams.get("usageEnabled")).toBe("true");
    expect(parsed.searchParams.get("usageAutoInterval")).toBe("30");
    expect(atob(parsed.searchParams.get("usageScript") ?? "")).toContain('{{baseUrl}}/v1/usage');
  });

  it("renders the use-api-key modal with codex cli snippets for the current site", () => {
    const html = renderToStaticMarkup(
      createElement(UseApiKeyModal, {
        keyRecord: sampleManagedKey,
        siteBaseUrl: "https://mirror.input.im/",
        onError: () => {},
        onImportToCcs: () => {},
        onClose: () => {}
      })
    );

    expect(html).toContain("使用 API 密钥");
    expect(html).toContain("Codex CLI (WebSocket)");
    expect(html).toContain("~/.codex/config.toml");
    expect(html).toContain("OPENAI_API_KEY");
    expect(html).toContain('base_url = &quot;https://mirror.input.im&quot;');
    expect(html).toContain("sk-test-placeholder-not-a-real-key-00000000000000000000000000000000");
    expect(html).toContain(">导入到 CCS</button>");
  });

  it("renders the key usage detail modal with daily rows and aggregate metrics", () => {
    const summary = {
      dailyUsage: [
        {
          date: "2026-07-06",
          requests: 1933,
          inputTokens: 16445350,
          outputTokens: 1346004,
          cacheReadTokens: 214308864,
          cacheWriteTokens: 0,
          totalTokens: 232100218,
          actualCost: 221.15564085,
          totalCost: 221.15564085
        }
      ],
      today: {
        requests: 1933,
        inputTokens: 16445350,
        outputTokens: 1346004,
        cacheCreationTokens: 0,
        cacheReadTokens: 214308864,
        totalTokens: 232100218,
        cost: 221.15564085,
        actualCost: 221.15564085
      },
      total: {
        requests: 147436,
        inputTokens: 2592494882,
        outputTokens: 129029619,
        cacheCreationTokens: 0,
        cacheReadTokens: 27732526860,
        totalTokens: 30454051361,
        cost: 24031.8134679,
        actualCost: 24031.8134679
      },
      averageDurationMs: 23949.84580428118,
      rpm: 6,
      tpm: 939063,
      planName: "CodeX Plus 年度",
      remaining: 278.84435915,
      subscription: {
        dailyLimitUsd: 500,
        dailyUsageUsd: 221.15564085,
        weeklyLimitUsd: 0,
        weeklyUsageUsd: 1989.21202395,
        monthlyLimitUsd: 0,
        monthlyUsageUsd: 8733.7644274,
        expiresAt: "2027-05-21T22:42:23.926654+08:00"
      },
      modelStats: [
        {
          model: "gpt-5.5",
          requests: 2141,
          inputTokens: 17064730,
          outputTokens: 1448715,
          cacheCreationTokens: 0,
          cacheReadTokens: 255274880,
          totalTokens: 273788325,
          cost: 256.42,
          actualCost: 256.42
        },
        {
          model: "gpt-5.4",
          requests: 120,
          inputTokens: 1958179,
          outputTokens: 70879,
          cacheCreationTokens: 0,
          cacheReadTokens: 6489088,
          totalTokens: 8518146,
          cost: 8.77,
          actualCost: 8.77
        },
        {
          model: "gpt-5.4-mini",
          requests: 32,
          inputTokens: 564238,
          outputTokens: 3117,
          cacheCreationTokens: 0,
          cacheReadTokens: 25088,
          totalTokens: 592443,
          cost: 0.44,
          actualCost: 0.44
        }
      ]
    } satisfies KeyUsageSummaryPayload;

    const html = renderToStaticMarkup(
      createElement(KeyUsageDetailModal, {
        keyRecord: sampleManagedKey,
        summary,
        range: { mode: "last30Days", days: 30, startDate: "2026-06-07", endDate: "2026-07-06" },
        rangeMode: "last30Days",
        customStartDate: "",
        customEndDate: "",
        loading: false,
        refreshing: true,
        error: null,
        onClose: () => {},
        onRangeModeChange: () => {},
        onCustomStartDateChange: () => {},
        onCustomEndDateChange: () => {},
        onApplyCustomRange: () => {}
      })
    );

    expect(html).toContain("codex 用量详情");
    expect(html).toContain("统计范围:");
    expect(html).toContain('aria-label="时间范围统计"');
    expect(html).toContain("今日");
    expect(html).toContain("7天");
    expect(html).toContain("30天");
    expect(html).toContain("自定义");
    expect(html).not.toContain("90 天");
    expect(html).toContain("模型用量统计");
    expect(html).toContain('aria-label="查看模型用量统计说明"');
    expect(html).not.toContain("30天范围内按模型聚合。");
    expect(html).toContain("今日与累计 Token 统计");
    expect(html).toContain('aria-label="查看今日与累计 Token 统计说明"');
    expect(html).toContain('aria-label="查看按日明细说明"');
    expect(html).not.toContain("30天范围内按日聚合");
    expect(html).toContain("正在后台更新");
    expect(html.indexOf("统计范围:")).toBeLessThan(html.indexOf("模型用量统计"));
    expect(html.indexOf("模型用量统计")).toBeLessThan(html.indexOf("今日与累计 Token 统计"));
    expect(html.indexOf("今日与累计 Token 统计")).toBeLessThan(html.indexOf("按日明细"));
    expect(html).toContain("gpt-5.5");
    expect(html).toContain("2,141");
    expect(html).toContain("17,064,730");
    expect(html).toContain("255,274,880");
    expect(html).toContain("273,788,325");
    expect(html).toContain("$256.42");
    expect(html).toContain("gpt-5.4-mini");
    expect(html).toContain("今日缓存创建");
    expect(html).toContain("RPM / TPM");
    expect(html).toContain("累计缓存创建");
    expect(html).toContain("平均耗时");
    expect(html).toContain("累计请求");
    expect(html).toContain("1,933");
    expect(html).toContain("6 / 939.1K");
    expect(html).toContain("23.95 秒");
    expect(html).toContain("2026-07-06");
    expect(html).toContain("16,445,350");
    expect(html).toContain("总 Tokens");
    expect(html).toContain("232,100,218");
    expect(html).toContain("标准费用");
    expect(html).toContain("$221.1556");
    expect(html).toContain("30天");
  });

  it("keeps a preheated detail snapshot visible after a background refresh failure", () => {
    const html = renderToStaticMarkup(
      createElement(KeyUsageDetailModal, {
        keyRecord: sampleManagedKey,
        summary: createKeyUsageSummary(),
        range: { mode: "today", days: 1, startDate: "2026-07-23", endDate: "2026-07-23" },
        rangeMode: "today",
        customStartDate: "",
        customEndDate: "",
        loading: false,
        refreshing: false,
        error: "key usage offline",
        onClose: () => {},
        onRangeModeChange: () => {},
        onCustomStartDateChange: () => {},
        onCustomEndDateChange: () => {},
        onApplyCustomRange: () => {}
      })
    );

    expect(html).toContain("刷新失败，正在显示预热数据");
    expect(html).toContain("今日与累计 Token 统计");
    expect(html).not.toContain("密钥用量加载失败");
  });

  it("renders custom date range controls in the key usage detail modal", () => {
    const summary: KeyUsageSummaryPayload = {
      dailyUsage: [],
      today: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        cost: 0,
        actualCost: 0
      },
      total: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        cost: 0,
        actualCost: 0
      },
      averageDurationMs: null,
      rpm: null,
      tpm: null,
      planName: null,
      remaining: null,
      subscription: null,
      modelStats: []
    };

    const html = renderToStaticMarkup(
      createElement(KeyUsageDetailModal, {
        keyRecord: sampleManagedKey,
        summary,
        range: { mode: "custom", days: 6, startDate: "2026-07-01", endDate: "2026-07-06" },
        rangeMode: "custom",
        customStartDate: "2026-07-01",
        customEndDate: "2026-07-06",
        loading: false,
        error: null,
        onClose: () => {},
        onRangeModeChange: () => {},
        onCustomStartDateChange: () => {},
        onCustomEndDateChange: () => {},
        onApplyCustomRange: () => {}
      })
    );

    expect(html).toContain('aria-label="自定义时间范围"');
    expect(html).toContain('type="date"');
    expect(html).toContain('value="2026-07-01"');
    expect(html).toContain('value="2026-07-06"');
    expect(html).toContain("应用");
    expect(html).toContain("2026-07-01 - 2026-07-06");
  });

  it("renders subscription quota details in the key usage detail modal", () => {
    const summary: KeyUsageSummaryPayload = {
      dailyUsage: [],
      today: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        cost: 0,
        actualCost: 0
      },
      total: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        cost: 0,
        actualCost: 0
      },
      averageDurationMs: null,
      rpm: null,
      tpm: null,
      planName: "CodeX Plus 年度",
      remaining: 341.09,
      subscription: {
        dailyUsageUsd: 158.91,
        dailyLimitUsd: 500,
        weeklyUsageUsd: 0,
        weeklyLimitUsd: 0,
        monthlyUsageUsd: 0,
        monthlyLimitUsd: 0,
        expiresAt: "2027-05-21T12:00:00+08:00"
      },
      modelStats: []
    };

    const html = renderToStaticMarkup(
      createElement(KeyUsageDetailModal, {
        keyRecord: {
          ...sampleManagedKey,
          quota: 0,
          quotaUsed: 0,
          expiresAt: null
        },
        summary,
        range: { mode: "last30Days", days: 30, startDate: "2026-06-07", endDate: "2026-07-06" },
        rangeMode: "last30Days",
        customStartDate: "",
        customEndDate: "",
        loading: false,
        error: null,
        onClose: () => {},
        onRangeModeChange: () => {},
        onCustomStartDateChange: () => {},
        onCustomEndDateChange: () => {},
        onApplyCustomRange: () => {}
      })
    );

    expect(html).toContain("订阅类型");
    expect(html).toContain("CodeX Plus 年度");
    expect(html).toContain("已用额度（日）");
    expect(html).toContain("$158.91 / $500.00");
    expect(html).toContain("订阅到期");
    expect(html).toContain("2027年5月21日");
    expect(html).toContain("剩余额度");
    expect(html).toContain("$341.09");
    expect(html).not.toContain("无限制");
    expect(html).not.toContain("无到期时间");
  });
});
