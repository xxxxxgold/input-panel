import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent, type MouseEvent, type SetStateAction } from "react";
import { ArrowDown, ArrowUp, CalendarDays, ChevronDown, Plus, Search, Trash2 } from "lucide-react";

import type {
  DailyUsagePoint,
  GroupRecord,
  KeyMutationInput,
  KeyUsageSummaryPayload,
  KeyUsageTokenStats,
  ManagedKeyRecord,
  PaginatedResult,
  SubscriptionRecord,
  SubscriptionSummaryPayload,
  SubscriptionSwitchChainNode,
  SubscriptionSwitchRuleRecord,
  SubscriptionSwitchThresholdMode,
  UserProfileRecord
} from "../types";
import {
  DEFAULT_SUBSCRIPTION_SWITCH_THRESHOLD_MODE,
  DEFAULT_SUBSCRIPTION_SWITCH_THRESHOLD_VALUE,
  deleteSubscriptionSwitchRule,
  upsertSubscriptionSwitchRule
} from "../api";
import {
  compact,
  formatDurationSeconds,
  formatPercent,
  formatRemainingDaysLabel,
  formatSubscriptionTypeLabel,
  formatTime,
  formatUsd,
  maskSecret,
  toDateValue
} from "../shared/lib/formatters";
import type { SaveFeedbackHandler } from "../shared/lib/save-feedback";
import {
  buildSubscriptionDetailRecords,
  getSubscriptionQuotaProgressMeta,
  getSubscriptionStatusPresentation,
  type SubscriptionDetailRecord
} from "../subscription-view";
import {
  buildKeyExpiryValue,
  inferKeyExpiryPreset,
  KEY_EXPIRY_PRESET_DAYS,
  parseOptionalNumberInput,
  type KeyExpiryPreset
} from "../shared/lib/key-utils";
import { EmptyState } from "../shared/ui/EmptyState";
import { DetailItem } from "../shared/ui/DetailItem";
import { Modal } from "../shared/ui/Modal";
import { SectionCard } from "../shared/ui/SectionCard";
import { StatusBadge } from "../shared/ui/StatusBadge";
import { TitleHint } from "../shared/ui/TitleHint";
import {
  createManagedKey,
  deleteManagedKey,
  updateManagedKey
} from "../features/keys/client";
import { getApiKeyUsageSummary } from "../features/usage/client";
import { buildScopedResourceKey, ScopedResourceCache } from "../shared/state/scoped-resource-cache";

type KeyFormState = Omit<KeyMutationInput, "ipWhitelist" | "ipBlacklist"> & {
  ipWhitelist: string;
  ipBlacklist: string;
};

type RuleDraftChainNode = Omit<SubscriptionSwitchChainNode, "thresholdValue"> & {
  thresholdValueInput: string;
};

type RuleDraft = {
  keyId: string;
  sourceGroupId: number;
  activeTargetGroupId: number | null;
  enabled: boolean;
  chainNodes: RuleDraftChainNode[];
  autoRestore: boolean;
  strictMode: boolean;
};

const KEY_USAGE_RANGE_PRESETS = [
  { key: "today", label: "今日", days: 1 },
  { key: "last7Days", label: "7天", days: 7 },
  { key: "last30Days", label: "30天", days: 30 }
] as const;

const KEY_USAGE_SUMMARY_CACHE_MAX_ENTRIES = 160;
const KEY_USAGE_SUMMARY_WARMUP_CONCURRENCY = 3;

type KeyUsageRangePreset = (typeof KEY_USAGE_RANGE_PRESETS)[number]["key"];
type KeyUsageRangeMode = KeyUsageRangePreset | "custom";

export type KeyUsageRangeQuery = {
  mode: KeyUsageRangeMode;
  days: number;
  startDate: string;
  endDate: string;
};

type KeyUsageSummaryFetch = (
  accountId: string,
  keyId: string,
  days: number,
  query: { startDate: string; endDate: string }
) => Promise<KeyUsageSummaryPayload>;

type UseKeyClientId = "codex-cli" | "codex-cli-websocket" | "claude-code" | "opencode";

type UseKeyVariantId = "macos-linux" | "windows" | "windows-cmd" | "powershell";

type CcsClientType = "claude" | "gemini";

type CcsImportPlatform = "openai" | "gemini" | "antigravity";

type UseKeySnippet = {
  id: string;
  label: string;
  path: string;
  code: string;
};

type UseKeyVariantConfig = {
  id: UseKeyVariantId;
  label: string;
  preface?: string;
  note?: string;
  snippets: UseKeySnippet[];
};

type UseKeyClientConfig = {
  id: UseKeyClientId;
  label: string;
  intro: string;
  variants: UseKeyVariantConfig[];
};

const DEFAULT_USE_KEY_BASE_URL = "https://ai.input.im";

function isSubscriptionGroup(group: Pick<GroupRecord, "subscriptionType">) {
  return group.subscriptionType?.trim().toLowerCase() === "subscription";
}

function sortAvailableGroups(groups: GroupRecord[]) {
  return [...groups].sort((left, right) => Number(isSubscriptionGroup(right)) - Number(isSubscriptionGroup(left)));
}

function formatAvailableGroupTypeLabel(value?: string | null) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "standard") return "余额";
  return formatSubscriptionTypeLabel(value);
}

function formatAvailableGroupQuota(value: number) {
  if (Number.isInteger(value)) return `$${value.toFixed(0)}`;
  return `$${value.toFixed(2).replace(/\.?0+$/, "")}`;
}

function buildAvailableGroupQuotaItems(group: Pick<GroupRecord, "dailyLimitUsd" | "weeklyLimitUsd" | "monthlyLimitUsd">) {
  return [
    { label: "日", value: Number(group.dailyLimitUsd ?? 0) },
    { label: "周", value: Number(group.weeklyLimitUsd ?? 0) },
    { label: "月", value: Number(group.monthlyLimitUsd ?? 0) }
  ].filter((item) => item.value > 0);
}

type KeySubscriptionSwitchCandidate = {
  groupId: number;
  name: string;
  platform: string | null;
};

type KeySubscriptionPickerItem = {
  itemKey: string;
  subscription: SubscriptionDetailRecord | null;
  groupId: number | null;
  name: string;
  platform: string | null;
  isCurrent: boolean;
};

/** 返回当前密钥可直接切换的、状态正常的订阅分组。 */
function buildKeySubscriptionSwitchCandidates(input: {
  currentGroupId: number | null | undefined;
  subscriptionDetails: SubscriptionDetailRecord[];
}): KeySubscriptionSwitchCandidate[] {
  const candidates = new Map<number, KeySubscriptionSwitchCandidate>();

  for (const subscription of input.subscriptionDetails) {
    const groupId = subscription.sourceGroupId;
    if (
      groupId == null ||
      groupId <= 0 ||
      groupId === input.currentGroupId ||
      getSubscriptionStatusPresentation(subscription.status).tone !== "ready"
    ) {
      continue;
    }
    candidates.set(groupId, {
      groupId,
      name: subscription.name,
      platform: subscription.platform
    });
  }

  return Array.from(candidates.values()).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

/** 为弹窗保留全部订阅视图，并在摘要数据暂缺时补出当前绑定。 */
function buildKeySubscriptionPickerItems(input: {
  key: Pick<ManagedKeyRecord, "groupId" | "groupName" | "platform">;
  subscriptionDetails: SubscriptionDetailRecord[];
}): KeySubscriptionPickerItem[] {
  const currentGroupId = input.key.groupId ?? null;
  const items: KeySubscriptionPickerItem[] = input.subscriptionDetails.map((subscription, index) => ({
    itemKey: `${subscription.subscriptionKey || subscription.id}:${index}`,
    subscription,
    groupId: subscription.sourceGroupId,
    name: subscription.name,
    platform: subscription.platform,
    isCurrent: currentGroupId !== null && subscription.sourceGroupId === currentGroupId
  }));

  if (currentGroupId !== null && !items.some((item) => item.isCurrent)) {
    items.unshift({
      itemKey: `current:${currentGroupId}`,
      subscription: null,
      groupId: currentGroupId,
      name: input.key.groupName?.trim() || "当前订阅",
      platform: input.key.platform ?? null,
      isCurrent: true
    });
  }

  return items.sort(
    (left, right) => Number(right.isCurrent) - Number(left.isCurrent) || left.name.localeCompare(right.name, "zh-CN")
  );
}

/** 使用订阅页同一套额度分级算法，避免密钥页出现不同的颜色口径。 */
function KeySubscriptionQuotaMetric({
  label,
  used,
  limit
}: {
  label: string;
  used: number | null | undefined;
  limit: number | null | undefined;
}) {
  const hasLimit = Number.isFinite(limit) && Number(limit) > 0;
  if (!hasLimit) {
    return null;
  }

  const safeUsed = Number.isFinite(used) ? Number(used) : 0;
  const safeLimit = Number(limit);
  const progress = getSubscriptionQuotaProgressMeta(safeUsed, safeLimit);
  return (
    <span className="key-subscription-quota">
      <span className="key-subscription-quota-head">
        <span>{label}</span>
        <small className={`key-subscription-quota-percent ${progress.tone}`}>{formatPercent(progress.rawPercent, 1)}</small>
      </span>
      <strong>{formatUsd(safeUsed, 2)} / {formatUsd(safeLimit, 2)}</strong>
      <span className={`key-subscription-quota-track ${progress.tone}`} aria-label={`${label}进度 ${formatPercent(progress.rawPercent, 1)}`}>
        <span className={`key-subscription-quota-fill ${progress.tone}`} style={{ width: `${progress.percent}%` }} />
      </span>
    </span>
  );
}

/** 密钥订阅选择只负责呈现和回调，写入仍由页面的既有切换处理函数统一完成。 */
function KeySubscriptionPickerModal({
  keyRecord,
  subscriptionDetails,
  candidates,
  saving,
  onSelect,
  onClose
}: {
  keyRecord: ManagedKeyRecord;
  subscriptionDetails: SubscriptionDetailRecord[];
  candidates: KeySubscriptionSwitchCandidate[];
  saving: boolean;
  onSelect: (groupId: number) => void;
  onClose: () => void;
}) {
  const items = buildKeySubscriptionPickerItems({ key: keyRecord, subscriptionDetails });
  const selectableGroupIds = new Set(candidates.map((candidate) => candidate.groupId));
  const currentItem = items.find((item) => item.isCurrent) ?? null;

  return (
    <Modal
      title={`${keyRecord.name} · 选择订阅`}
      onClose={onClose}
      size="wide"
      className="key-subscription-picker-modal"
    >
      <div className="key-subscription-picker">
        <div className="key-subscription-picker-summary">
          <div className="key-subscription-picker-summary-copy">
            <span>当前订阅</span>
            <span className="key-subscription-picker-summary-name-row">
              <strong>{keyRecord.groupName?.trim() || "未分组"}</strong>
              <span className="key-subscription-picker-platform">{keyRecord.platform ?? "unknown"}</span>
            </span>
          </div>
          <div className="key-subscription-picker-summary-meta">
            <span className="key-subscription-picker-expiry">
              <CalendarDays size={14} aria-hidden="true" />
              {formatRemainingDaysLabel(currentItem?.subscription?.expiresAt ?? null)}
            </span>
          </div>
        </div>
        {saving && <p className="key-subscription-picker-saving" role="status">正在切换订阅...</p>}
        <div className="key-subscription-picker-list" aria-label="全部订阅">
          {items.map((item) => {
            const statusPresentation = item.subscription
              ? getSubscriptionStatusPresentation(item.subscription.status)
              : { label: "数据暂未返回", tone: "neutral" as const };
            const canSwitch = item.groupId !== null && selectableGroupIds.has(item.groupId);
            const disabled = item.isCurrent || !canSwitch || saving;
            const actionLabel = item.isCurrent ? "当前订阅" : canSwitch ? "选择此订阅" : "暂不可切换";
            const quotaWindows = [
              { label: "每日额度", used: item.subscription?.dailyUsedUsd, limit: item.subscription?.dailyLimitUsd },
              { label: "每周额度", used: item.subscription?.weeklyUsedUsd, limit: item.subscription?.weeklyLimitUsd },
              { label: "每月额度", used: item.subscription?.monthlyUsedUsd, limit: item.subscription?.monthlyLimitUsd }
            ].filter((quota) => Number.isFinite(quota.limit) && Number(quota.limit) > 0);

            return (
              <button
                key={item.itemKey}
                type="button"
                className={`key-subscription-option ${item.isCurrent ? "current" : ""} ${canSwitch ? "selectable" : "unavailable"}`.trim()}
                aria-current={item.isCurrent ? "true" : undefined}
                aria-label={item.isCurrent ? `${item.name}，当前订阅` : canSwitch ? `切换到 ${item.name}` : `${item.name} 暂不可切换`}
                disabled={disabled}
                onClick={() => {
                  if (item.groupId !== null && canSwitch) {
                    onSelect(item.groupId);
                  }
                }}
              >
                <span className="key-subscription-option-head">
                  <span className="key-subscription-option-copy">
                    <strong>{item.name}</strong>
                    <span className="key-subscription-option-meta">
                      <span className="key-subscription-option-platform">{item.platform ?? "unknown"}</span>
                      <span className={`status-pill ${statusPresentation.tone}`}>{statusPresentation.label}</span>
                      <span className="key-subscription-option-expiry">
                        <CalendarDays size={14} aria-hidden="true" />
                        {formatRemainingDaysLabel(item.subscription?.expiresAt ?? null)}
                      </span>
                    </span>
                  </span>
                  <span className={`key-subscription-option-action ${item.isCurrent ? "current" : canSwitch ? "ready" : "neutral"}`}>
                    {actionLabel}
                  </span>
                </span>
                {quotaWindows.length > 0 && (
                  <span className="key-subscription-quota-grid">
                    {quotaWindows.map((quota) => (
                      <KeySubscriptionQuotaMetric key={quota.label} {...quota} />
                    ))}
                  </span>
                )}
              </button>
            );
          })}
          {items.length === 0 && <EmptyState title="当前没有订阅数据" detail="刷新账号后再试。" compact />}
        </div>
      </div>
    </Modal>
  );
}

function parseIpList(value: string) {
  const items = value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function handleActionKey(event: KeyboardEvent<HTMLElement>, action: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}

function buildKeyUsagePresetRange(mode: KeyUsageRangePreset): KeyUsageRangeQuery {
  const preset = KEY_USAGE_RANGE_PRESETS.find((item) => item.key === mode) ?? KEY_USAGE_RANGE_PRESETS[2];
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - preset.days + 1);
  return {
    mode,
    days: preset.days,
    startDate: toDateValue(start),
    endDate: toDateValue(end)
  };
}

function buildKeyUsageCustomRange(startDate: string, endDate: string): KeyUsageRangeQuery | null {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  if (
    !startDate ||
    !endDate ||
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    toDateValue(start) !== startDate ||
    toDateValue(end) !== endDate ||
    start > end
  ) {
    return null;
  }
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
  return {
    mode: "custom",
    days,
    startDate,
    endDate
  };
}

function refreshKeyUsagePresetRange(range: KeyUsageRangeQuery): KeyUsageRangeQuery {
  return range.mode === "custom" ? range : buildKeyUsagePresetRange(range.mode);
}

function formatKeyUsageRangeTag(range: KeyUsageRangeQuery) {
  if (range.mode === "custom") {
    return `${range.startDate} - ${range.endDate}`;
  }
  return KEY_USAGE_RANGE_PRESETS.find((item) => item.key === range.mode)?.label ?? `${range.days}天`;
}

export function buildKeyUsageSummaryScopeKey(input: {
  accountId: string;
  keyId: string;
  range: KeyUsageRangeQuery;
}) {
  return buildScopedResourceKey("key-usage-summary", {
    accountId: input.accountId,
    keyId: input.keyId,
    days: input.range.days,
    startDate: input.range.startDate,
    endDate: input.range.endDate
  });
}

function loadKeyUsageSummary(
  cache: ScopedResourceCache<KeyUsageSummaryPayload>,
  input: {
    accountId: string;
    keyId: string;
    range: KeyUsageRangeQuery;
  },
  fetchSummary: KeyUsageSummaryFetch = getApiKeyUsageSummary
) {
  const scopeKey = buildKeyUsageSummaryScopeKey(input);
  return cache.load(
    scopeKey,
    () => fetchSummary(input.accountId, input.keyId, input.range.days, {
      startDate: input.range.startDate,
      endDate: input.range.endDate
    })
  );
}

export async function preloadKeyUsageSummaryRange(input: {
  cache: ScopedResourceCache<KeyUsageSummaryPayload>;
  accountId: string;
  keys: ReadonlyArray<Pick<ManagedKeyRecord, "id">>;
  range: KeyUsageRangeQuery;
  concurrency?: number;
  fetchSummary?: KeyUsageSummaryFetch;
  shouldContinue?: () => boolean;
}) {
  const keyIds = [...new Set(input.keys.map((key) => key.id).filter(Boolean))];
  const shouldContinue = input.shouldContinue ?? (() => true);
  const workerCount = Math.min(
    keyIds.length,
    Math.max(1, Math.floor(input.concurrency ?? KEY_USAGE_SUMMARY_WARMUP_CONCURRENCY))
  );
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < keyIds.length) {
      if (!shouldContinue()) {
        return;
      }
      const keyId = keyIds[nextIndex];
      nextIndex += 1;
      if (!keyId) {
        continue;
      }
      const scopeKey = buildKeyUsageSummaryScopeKey({
        accountId: input.accountId,
        keyId,
        range: input.range
      });
      if (input.cache.peek(scopeKey).hasSnapshot) {
        continue;
      }
      await loadKeyUsageSummary(
        input.cache,
        {
          accountId: input.accountId,
          keyId,
          range: input.range
        },
        input.fetchSummary
      );
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}

function stopRowTriggerPropagation(event: KeyboardEvent<HTMLElement> | MouseEvent<HTMLElement>) {
  event.stopPropagation();
}

/** 密钥管理列表保留更长的前后缀，方便区分相近的密钥。 */
function maskKeyListSecret(value: string) {
  const prefixLength = 10;
  const suffixLength = 8;
  if (value.length <= prefixLength + suffixLength + 3) {
    return maskSecret(value);
  }
  return `${value.slice(0, prefixLength)}...${value.slice(-suffixLength)}`;
}

function getDailyRowActualCost(row: DailyUsagePoint) {
  return Number(row.actualCost ?? row.totalCost ?? 0);
}

function formatKeyUsageRate(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) {
    return "-";
  }
  if (value >= 1000) {
    return compact(value);
  }
  if (Number.isInteger(value)) {
    return value.toLocaleString();
  }
  if (value >= 10) {
    return value.toFixed(0);
  }
  return value.toFixed(2);
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);

  if (!copied) {
    throw new Error("当前环境不支持复制到剪贴板。");
  }
}

function normalizeUseKeyBaseUrl(baseUrl?: string | null) {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return DEFAULT_USE_KEY_BASE_URL;
  return trimmed.replace(/\/+$/, "");
}

function normalizeCcsImportPlatform(platform?: string | null): CcsImportPlatform {
  const normalized = platform?.trim().toLowerCase();
  if (normalized === "gemini") {
    return "gemini";
  }
  if (normalized === "antigravity") {
    return "antigravity";
  }
  return "openai";
}

function encodeBase64(value: string) {
  return globalThis.btoa(value);
}

export function buildCcsImportUrl(input: {
  baseUrl: string;
  platform?: string | null;
  clientType: CcsClientType;
  providerName?: string | null;
  apiKey: string;
}) {
  const normalizedBaseUrl = normalizeUseKeyBaseUrl(input.baseUrl);
  const normalizedPlatform = normalizeCcsImportPlatform(input.platform);
  const params = new URLSearchParams();
  const app =
    normalizedPlatform === "gemini"
      ? "gemini"
      : normalizedPlatform === "antigravity"
        ? input.clientType
        : "codex";
  const model =
    normalizedPlatform === "gemini"
      ? "gemini-2.5-pro"
      : normalizedPlatform === "antigravity"
        ? "claude-sonnet-4.0"
        : "gpt-5.4";
  const usageScript = "fetch('{{baseUrl}}/v1/usage', { headers: { Authorization: 'Bearer {{apiKey}}' } });";

  params.set("resource", "provider");
  params.set("app", app);
  params.set("model", model);
  params.set("name", (input.providerName?.trim() || "Input Panel").trim());
  params.set("homepage", normalizedBaseUrl);
  params.set("endpoint", normalizedBaseUrl);
  params.set("apiKey", input.apiKey);
  params.set("configFormat", "json");
  params.set("usageEnabled", "true");
  params.set("usageAutoInterval", "30");
  params.set("usageScript", encodeBase64(usageScript));

  return `ccswitch://v1/import?${params.toString()}`;
}

function buildOpenCodeBaseUrl(baseUrl: string) {
  return /\/v1$/i.test(baseUrl) ? baseUrl : `${baseUrl}/v1`;
}

function buildCodexCliConfig(baseUrl: string, supportsWebSocket: boolean) {
  return [
    'model_provider = "OpenAI"',
    'model = "gpt-5.5"',
    'review_model = "gpt-5.5"',
    'model_reasoning_effort = "xhigh"',
    "disable_response_storage = true",
    'network_access = "enabled"',
    "windows_wsl_setup_acknowledged = true",
    "",
    "[model_providers.OpenAI]",
    'name = "OpenAI"',
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
    ...(supportsWebSocket ? ['supports_websockets = true'] : []),
    "requires_openai_auth = true",
    "",
    "[features]",
    ...(supportsWebSocket ? ["responses_websockets_v2 = true"] : []),
    "goals = true"
  ].join("\n");
}

function buildClaudeTerminalSnippet(baseUrl: string, rawKey: string, variantId: UseKeyVariantId) {
  if (variantId === "windows-cmd") {
    return [
      `set ANTHROPIC_BASE_URL=${baseUrl}`,
      `set ANTHROPIC_AUTH_TOKEN=${rawKey}`,
      "set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"
    ].join("\n");
  }

  if (variantId === "powershell") {
    return [
      `$env:ANTHROPIC_BASE_URL="${baseUrl}"`,
      `$env:ANTHROPIC_AUTH_TOKEN="${rawKey}"`,
      "$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"
    ].join("\n");
  }

  return [
    `export ANTHROPIC_BASE_URL="${baseUrl}"`,
    `export ANTHROPIC_AUTH_TOKEN="${rawKey}"`,
    "export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"
  ].join("\n");
}

function buildClaudeSettingsSnippet(baseUrl: string, rawKey: string) {
  return JSON.stringify(
    {
      env: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: rawKey,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_ATTRIBUTION_HEADER: "0"
      }
    },
    null,
    2
  );
}

function buildOpenCodeModel(name: string, context: number, output: number, variants: string[] = ["low", "medium", "high", "xhigh"]) {
  return {
    name,
    limit: {
      context,
      output
    },
    options: {
      store: false
    },
    variants: Object.fromEntries(variants.map((variant) => [variant, {}]))
  };
}

function buildOpenCodeConfig(baseUrl: string, rawKey: string) {
  return JSON.stringify(
    {
      provider: {
        openai: {
          options: {
            baseURL: buildOpenCodeBaseUrl(baseUrl),
            apiKey: rawKey
          },
          models: {
            "gpt-5.2": buildOpenCodeModel("GPT-5.2", 400000, 128000),
            "gpt-5.5": buildOpenCodeModel("GPT-5.5", 1050000, 128000),
            "gpt-5.4": buildOpenCodeModel("GPT-5.4", 1050000, 128000),
            "gpt-5.4-mini": buildOpenCodeModel("GPT-5.4 Mini", 400000, 128000),
            "gpt-5.3-codex-spark": buildOpenCodeModel("GPT-5.3 Codex Spark", 128000, 32000),
            "gpt-5.3-codex": buildOpenCodeModel("GPT-5.3 Codex", 400000, 128000),
            "codex-mini-latest": buildOpenCodeModel("Codex Mini", 200000, 100000, ["low", "medium", "high"])
          }
        }
      },
      agent: {
        build: {
          options: {
            store: false
          }
        },
        plan: {
          options: {
            store: false
          }
        }
      },
      $schema: "https://opencode.ai/config.json"
    },
    null,
    2
  );
}

function buildUseKeyClientConfigs(baseUrl: string, rawKey: string): UseKeyClientConfig[] {
  const authJson = JSON.stringify(
    {
      OPENAI_API_KEY: rawKey
    },
    null,
    2
  );
  const claudeSettings = buildClaudeSettingsSnippet(baseUrl, rawKey);

  return [
    {
      id: "codex-cli",
      label: "Codex CLI",
      intro: "将以下配置文件添加到 Codex CLI 配置目录中。",
      variants: [
        {
          id: "macos-linux",
          label: "macOS / Linux",
          preface: "请确保以下内容位于 config.toml 文件的开头部分",
          note: "请确保配置目录存在。macOS/Linux 用户可运行 mkdir -p ~/.codex 创建目录。",
          snippets: [
            {
              id: "codex-cli-unix-config",
              label: "配置文件",
              path: "~/.codex/config.toml",
              code: buildCodexCliConfig(baseUrl, false)
            },
            {
              id: "codex-cli-unix-auth",
              label: "认证文件",
              path: "~/.codex/auth.json",
              code: authJson
            }
          ]
        },
        {
          id: "windows",
          label: "Windows",
          preface: "请确保以下内容位于 config.toml 文件的开头部分",
          note: "请确保 %USERPROFILE%\\.codex 目录存在，如不存在请先手动创建。",
          snippets: [
            {
              id: "codex-cli-windows-config",
              label: "配置文件",
              path: "%USERPROFILE%\\.codex\\config.toml",
              code: buildCodexCliConfig(baseUrl, false)
            },
            {
              id: "codex-cli-windows-auth",
              label: "认证文件",
              path: "%USERPROFILE%\\.codex\\auth.json",
              code: authJson
            }
          ]
        }
      ]
    },
    {
      id: "codex-cli-websocket",
      label: "Codex CLI (WebSocket)",
      intro: "将以下配置文件添加到 Codex CLI 配置目录中。",
      variants: [
        {
          id: "macos-linux",
          label: "macOS / Linux",
          preface: "请确保以下内容位于 config.toml 文件的开头部分",
          note: "请确保配置目录存在。macOS/Linux 用户可运行 mkdir -p ~/.codex 创建目录。",
          snippets: [
            {
              id: "codex-websocket-unix-config",
              label: "配置文件",
              path: "~/.codex/config.toml",
              code: buildCodexCliConfig(baseUrl, true)
            },
            {
              id: "codex-websocket-unix-auth",
              label: "认证文件",
              path: "~/.codex/auth.json",
              code: authJson
            }
          ]
        },
        {
          id: "windows",
          label: "Windows",
          preface: "请确保以下内容位于 config.toml 文件的开头部分",
          note: "请确保 %USERPROFILE%\\.codex 目录存在，如不存在请先手动创建。",
          snippets: [
            {
              id: "codex-websocket-windows-config",
              label: "配置文件",
              path: "%USERPROFILE%\\.codex\\config.toml",
              code: buildCodexCliConfig(baseUrl, true)
            },
            {
              id: "codex-websocket-windows-auth",
              label: "认证文件",
              path: "%USERPROFILE%\\.codex\\auth.json",
              code: authJson
            }
          ]
        }
      ]
    },
    {
      id: "claude-code",
      label: "Claude Code",
      intro: "将以下环境变量添加到您的终端配置文件中，或直接在终端里执行。",
      variants: [
        {
          id: "macos-linux",
          label: "macOS / Linux",
          note: "这些环境变量会在当前终端会话中生效。如需永久配置，请把它们加入 ~/.bashrc、~/.zshrc 或相应的 shell 配置文件。",
          snippets: [
            {
              id: "claude-unix-terminal",
              label: "Terminal",
              path: "当前终端",
              code: buildClaudeTerminalSnippet(baseUrl, rawKey, "macos-linux")
            },
            {
              id: "claude-unix-settings",
              label: "VSCode Claude Code",
              path: "~/.claude/settings.json",
              code: claudeSettings
            }
          ]
        },
        {
          id: "windows-cmd",
          label: "Windows CMD",
          note: "这些环境变量只会在当前 CMD 会话中生效。如需长期使用，请写入系统环境变量或命令启动脚本。",
          snippets: [
            {
              id: "claude-windows-cmd-terminal",
              label: "Terminal",
              path: "cmd.exe",
              code: buildClaudeTerminalSnippet(baseUrl, rawKey, "windows-cmd")
            },
            {
              id: "claude-windows-cmd-settings",
              label: "VSCode Claude Code",
              path: "~/.claude/settings.json",
              code: claudeSettings
            }
          ]
        },
        {
          id: "powershell",
          label: "PowerShell",
          note: "这些环境变量只会在当前 PowerShell 会话中生效。如需长期使用，请写入 PowerShell 配置文件或启动脚本。",
          snippets: [
            {
              id: "claude-powershell-terminal",
              label: "Terminal",
              path: "PowerShell",
              code: buildClaudeTerminalSnippet(baseUrl, rawKey, "powershell")
            },
            {
              id: "claude-powershell-settings",
              label: "VSCode Claude Code",
              path: "~/.claude/settings.json",
              code: claudeSettings
            }
          ]
        }
      ]
    },
    {
      id: "opencode",
      label: "OpenCode",
      intro:
        "配置文件路径: ~/.config/opencode/opencode.json (或 opencode.jsonc)。如不存在请手动创建。可使用默认 provider (openai/anthropic/google) 或自定义 provider_id。",
      variants: [
        {
          id: "macos-linux",
          label: "默认",
          note: "API Key 支持直接配置，或通过客户端 /connect 命令补充。示例仅供参考，模型与选项可按需调整。",
          snippets: [
            {
              id: "opencode-config",
              label: "配置文件",
              path: "opencode.json",
              code: buildOpenCodeConfig(baseUrl, rawKey)
            }
          ]
        }
      ]
    }
  ];
}

export function KeysPage({
  managedKeys,
  groups,
  subscriptions = [],
  subscriptionSummary,
  subscriptionSwitchRules = [],
  selectedAccountId,
  selectedSiteBaseUrl,
  selectedSiteName,
  onRefresh,
  onError,
  onBusy,
  onSaveFeedback = () => undefined,
  onRefreshSubscriptionChain
}: {
  managedKeys: PaginatedResult<ManagedKeyRecord> | null;
  groups: GroupRecord[];
  subscriptions?: SubscriptionRecord[];
  subscriptionSummary?: SubscriptionSummaryPayload | null;
  subscriptionSwitchRules?: SubscriptionSwitchRuleRecord[];
  profileRecord: UserProfileRecord | null;
  selectedAccountId: string | null;
  selectedSiteBaseUrl?: string | null;
  selectedSiteName?: string | null;
  onRefresh: () => void;
  onError: (message: string | null) => void;
  onBusy: (text: string | null) => void;
  onSaveFeedback?: SaveFeedbackHandler;
  onRefreshSubscriptionChain?: () => void | Promise<void>;
}) {
  const [keyModalOpen, setKeyModalOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<ManagedKeyRecord | null>(null);
  const [keyGroupPickerOpen, setKeyGroupPickerOpen] = useState(false);
  const [keyGroupSearch, setKeyGroupSearch] = useState("");
  const [keyCustomKeyEnabled, setKeyCustomKeyEnabled] = useState(false);
  const [keyIpLimitEnabled, setKeyIpLimitEnabled] = useState(false);
  const [keyRateLimitEnabled, setKeyRateLimitEnabled] = useState(false);
  const [keyExpiryEnabled, setKeyExpiryEnabled] = useState(false);
  const [keyExpiryPreset, setKeyExpiryPreset] = useState<KeyExpiryPreset>("30d");
  const [keyExpiryDateTime, setKeyExpiryDateTime] = useState(buildKeyExpiryValue(30));
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);
  const copiedKeyTimerRef = useRef<number | null>(null);
  const [useKeyModalRecord, setUseKeyModalRecord] = useState<ManagedKeyRecord | null>(null);
  const [ccsClientSelectKey, setCcsClientSelectKey] = useState<ManagedKeyRecord | null>(null);
  const ccsImportTimerRef = useRef<number | null>(null);
  const keyUsageSummaryCacheRef = useRef<ScopedResourceCache<KeyUsageSummaryPayload> | null>(null);
  const keyUsageWarmupScopeRef = useRef<string | null>(null);
  const [usageDetailKey, setUsageDetailKey] = useState<ManagedKeyRecord | null>(null);
  const [usageDetailAccountId, setUsageDetailAccountId] = useState<string | null>(null);
  const [usageDetailSummary, setUsageDetailSummary] = useState<KeyUsageSummaryPayload | null>(null);
  const [usageDetailRange, setUsageDetailRange] = useState<KeyUsageRangeQuery>(() => buildKeyUsagePresetRange("today"));
  const [usageDetailRangeMode, setUsageDetailRangeMode] = useState<KeyUsageRangeMode>("today");
  const [usageDetailCustomStartDate, setUsageDetailCustomStartDate] = useState("");
  const [usageDetailCustomEndDate, setUsageDetailCustomEndDate] = useState("");
  const [usageDetailLoading, setUsageDetailLoading] = useState(false);
  const [usageDetailRefreshing, setUsageDetailRefreshing] = useState(false);
  const [usageDetailError, setUsageDetailError] = useState<string | null>(null);
  const usageDetailSequenceRef = useRef(0);
  const [editingRuleKeyId, setEditingRuleKeyId] = useState<string | null>(null);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null);
  const [ruleSaving, setRuleSaving] = useState(false);
  const ruleSavingRef = useRef(false);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [quickSwitchSavingKeyId, setQuickSwitchSavingKeyId] = useState<string | null>(null);
  const [quickSwitchModalKeyId, setQuickSwitchModalKeyId] = useState<string | null>(null);
  const [keyForm, setKeyForm] = useState<KeyFormState>({
    name: "",
    groupId: null,
    customKey: "",
    ipWhitelist: "",
    ipBlacklist: "",
    quota: null,
    expiresInDays: 30,
    status: "active",
    rateLimit5h: null,
    rateLimit1d: null,
    rateLimit7d: null
  });

  const orderedGroups = sortAvailableGroups(groups);
  const currentManagedKeys = managedKeys?.items ?? [];
  if (!keyUsageSummaryCacheRef.current) {
    keyUsageSummaryCacheRef.current = new ScopedResourceCache<KeyUsageSummaryPayload>({
      maxEntries: KEY_USAGE_SUMMARY_CACHE_MAX_ENTRIES
    });
  }
  const keyUsageSummaryCache = keyUsageSummaryCacheRef.current;
  const subscriptionGroups = useMemo(
    () => groups.filter((group) => group.subscriptionType?.trim().toLowerCase() === "subscription"),
    [groups]
  );
  const quickSwitchSubscriptionDetails = useMemo(
    () => buildSubscriptionDetailRecords({
      summary: subscriptionSummary ?? null,
      cacheViewSubscriptions: subscriptions
    }),
    [subscriptionSummary, subscriptions]
  );
  const quickSwitchModalKey = currentManagedKeys.find((item) => item.id === quickSwitchModalKeyId) ?? null;
  const editingRuleKey = currentManagedKeys.find((item) => item.id === editingRuleKeyId) ?? null;
  const editingSubscriptionSwitchRule = subscriptionSwitchRules.find((item) => item.keyId === ruleDraft?.keyId) ?? null;
  const editingSourceGroup = subscriptionGroups.find((group) => group.id === ruleDraft?.sourceGroupId) ?? null;
  const candidateGroups = useMemo(
    () => buildOrderedCandidateGroups(subscriptions, subscriptionGroups, ruleDraft?.sourceGroupId ?? null),
    [subscriptions, ruleDraft?.sourceGroupId, subscriptionGroups]
  );
  const editingKeyCurrentGroupName = editingRuleKey?.groupName ?? resolveGroupName(groups, editingRuleKey?.groupId ?? null);
  const filteredKeyGroups = orderedGroups.filter((group) => {
    if (!keyGroupSearch.trim()) return true;
    const keyword = keyGroupSearch.trim().toLowerCase();
    return (
      group.name.toLowerCase().includes(keyword) ||
      group.platform.toLowerCase().includes(keyword) ||
      (group.subscriptionType ?? "").toLowerCase().includes(keyword)
    );
  });
  const resetKeyUsageDetail = useCallback(() => {
    usageDetailSequenceRef.current += 1;
    setUsageDetailKey(null);
    setUsageDetailAccountId(null);
    setUsageDetailSummary(null);
    setUsageDetailRange(buildKeyUsagePresetRange("today"));
    setUsageDetailRangeMode("today");
    setUsageDetailCustomStartDate("");
    setUsageDetailCustomEndDate("");
    setUsageDetailError(null);
    setUsageDetailLoading(false);
    setUsageDetailRefreshing(false);
  }, []);

  useEffect(() => {
    if (!selectedAccountId || currentManagedKeys.length === 0) {
      return;
    }

    const range = buildKeyUsagePresetRange("today");
    const warmupScope = buildScopedResourceKey("key-usage-summary-warmup", {
      accountId: selectedAccountId,
      startDate: range.startDate,
      endDate: range.endDate,
      keyIds: currentManagedKeys.map((key) => key.id)
    });
    if (keyUsageWarmupScopeRef.current === warmupScope) {
      return;
    }
    keyUsageWarmupScopeRef.current = warmupScope;
    let cancelled = false;

    void preloadKeyUsageSummaryRange({
      cache: keyUsageSummaryCache,
      accountId: selectedAccountId,
      keys: currentManagedKeys,
      range,
      shouldContinue: () => !cancelled
    });

    return () => {
      cancelled = true;
      if (keyUsageWarmupScopeRef.current === warmupScope) {
        keyUsageWarmupScopeRef.current = null;
      }
    };
  }, [currentManagedKeys, keyUsageSummaryCache, selectedAccountId]);

  useEffect(() => {
    if (!usageDetailAccountId || usageDetailAccountId === selectedAccountId) {
      return;
    }
    resetKeyUsageDetail();
  }, [resetKeyUsageDetail, selectedAccountId, usageDetailAccountId]);

  const selectedKeyGroup =
    groups.find((group) => group.id === keyForm.groupId) ??
    (editingKey && keyForm.groupId != null
      ? {
          id: keyForm.groupId,
          name: editingKey.groupName ?? `当前分组 #${keyForm.groupId}`,
          platform: editingKey.platform ?? "unknown",
          rateMultiplier: 1,
          subscriptionType: "unknown"
        }
      : null);

  function resetKeyForm(nextGroupId?: number | null) {
    setKeyForm({
      name: "",
      groupId: nextGroupId ?? orderedGroups[0]?.id ?? null,
      customKey: "",
      ipWhitelist: "",
      ipBlacklist: "",
      quota: null,
      expiresInDays: 30,
      status: "active",
      rateLimit5h: 0,
      rateLimit1d: 0,
      rateLimit7d: 0
    });
    setKeyGroupPickerOpen(false);
    setKeyGroupSearch("");
    setKeyCustomKeyEnabled(false);
    setKeyIpLimitEnabled(false);
    setKeyRateLimitEnabled(false);
    setKeyExpiryEnabled(false);
    setKeyExpiryPreset("30d");
    setKeyExpiryDateTime(buildKeyExpiryValue(30));
  }

  function openNewKey() {
    if (!selectedAccountId) {
      onError("请先选择一个账号，再新增密钥。");
      return;
    }
    onError(null);
    setEditingKey(null);
    resetKeyForm();
    setKeyModalOpen(true);
  }

  function openEditKey(key: ManagedKeyRecord) {
    if (!selectedAccountId) return;
    onError(null);
    setEditingKey(key);
    setKeyForm({
      name: key.name,
      groupId: key.groupId ?? null,
      customKey: key.rawKey ?? "",
      ipWhitelist: key.ipWhitelist ?? "",
      ipBlacklist: key.ipBlacklist ?? "",
      quota: key.quota ?? 0,
      expiresInDays: null,
      status: key.status,
      rateLimit5h: key.rateLimit5h ?? 0,
      rateLimit1d: key.rateLimit1d ?? 0,
      rateLimit7d: key.rateLimit7d ?? 0
    });
    setKeyGroupPickerOpen(false);
    setKeyGroupSearch("");
    setKeyCustomKeyEnabled(Boolean(key.rawKey));
    setKeyIpLimitEnabled(Boolean((key.ipWhitelist ?? "").trim() || (key.ipBlacklist ?? "").trim()));
    setKeyRateLimitEnabled(Boolean((key.rateLimit5h ?? 0) || (key.rateLimit1d ?? 0) || (key.rateLimit7d ?? 0)));
    const expiryState = inferKeyExpiryPreset(key.expiresAt);
    setKeyExpiryEnabled(expiryState.enabled);
    setKeyExpiryPreset(expiryState.preset);
    setKeyExpiryDateTime(expiryState.value);
    setKeyModalOpen(true);
  }

  function handleKeyExpiryPresetSelect(nextPreset: KeyExpiryPreset) {
    setKeyExpiryPreset(nextPreset);
    if (nextPreset === "custom") {
      if (!keyExpiryDateTime) {
        setKeyExpiryDateTime(buildKeyExpiryValue(30));
      }
      return;
    }
    const nextDays = Number(nextPreset.replace("d", ""));
    setKeyExpiryDateTime(buildKeyExpiryValue(nextDays));
  }

  async function submitKeyForm() {
    if (!selectedAccountId) {
      onError("请先选择一个账号，再提交密钥。");
      return;
    }
    if (!keyForm.name.trim()) {
      onError("请输入密钥名称。");
      return;
    }
    if (keyForm.groupId == null) {
      onError("请选择一个可用分组。");
      return;
    }
    if (keyCustomKeyEnabled) {
      const customKey = keyForm.customKey?.trim() || "";
      if (customKey.length < 16) {
        onError("自定义密钥至少需要 16 个字符。");
        return;
      }
    }
    if (keyExpiryEnabled && (!keyExpiryDateTime || Number.isNaN(new Date(keyExpiryDateTime).getTime()))) {
      onError("请选择有效的过期时间。");
      return;
    }

    const successMessage = editingKey ? "API Key 已更新。" : "API Key 已创建。";
    onBusy(editingKey ? "正在更新密钥..." : "正在创建密钥...");
    onError(null);
    try {
      const normalizedCustomKey = keyCustomKeyEnabled ? keyForm.customKey?.trim() || "" : undefined;
      const normalizedIpWhitelist = keyIpLimitEnabled ? parseIpList(keyForm.ipWhitelist) : undefined;
      const normalizedIpBlacklist = keyIpLimitEnabled ? parseIpList(keyForm.ipBlacklist) : undefined;
      const normalizedExpiryDays = keyExpiryEnabled
        ? (keyExpiryPreset === "custom"
            ? Math.max(1, Math.ceil((new Date(keyExpiryDateTime).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
            : Number(keyExpiryPreset.replace("d", "")))
        : null;
      const payload: KeyMutationInput = {
        ...keyForm,
        name: keyForm.name.trim(),
        customKey: normalizedCustomKey,
        ipWhitelist: normalizedIpWhitelist,
        ipBlacklist: normalizedIpBlacklist,
        expiresInDays: normalizedExpiryDays,
        rateLimit5h: keyRateLimitEnabled ? keyForm.rateLimit5h : 0,
        rateLimit1d: keyRateLimitEnabled ? keyForm.rateLimit1d : 0,
        rateLimit7d: keyRateLimitEnabled ? keyForm.rateLimit7d : 0
      };
      if (editingKey) {
        await updateManagedKey(selectedAccountId, editingKey.id, payload);
      } else {
        await createManagedKey(selectedAccountId, payload);
      }
      setKeyModalOpen(false);
      onRefresh();
      onSaveFeedback({
        tone: "success",
        title: "保存成功",
        message: successMessage
      });
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      onBusy(null);
    }
  }

  async function handleDeleteKey(keyId: string) {
    if (!selectedAccountId) return;
    onBusy("正在删除密钥...");
    onError(null);
    try {
      await deleteManagedKey(selectedAccountId, keyId);
      onRefresh();
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      onBusy(null);
    }
  }

  async function handleToggleKeyStatus(key: ManagedKeyRecord) {
    if (!selectedAccountId) return;
    onBusy(`正在${key.status === "active" ? "停用" : "启用"}密钥...`);
    onError(null);
    try {
      await updateManagedKey(selectedAccountId, key.id, {
        status: key.status === "active" ? "inactive" : "active"
      });
      onRefresh();
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      onBusy(null);
    }
  }

  async function handleResetQuota(key: ManagedKeyRecord) {
    if (!selectedAccountId) return;
    onBusy("正在重置已用额度...");
    onError(null);
    try {
      await updateManagedKey(selectedAccountId, key.id, { resetQuota: true });
      onRefresh();
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      onBusy(null);
    }
  }

  async function handleResetRateLimitUsage(key: ManagedKeyRecord) {
    if (!selectedAccountId) return;
    onBusy("正在重置限流用量...");
    onError(null);
    try {
      await updateManagedKey(selectedAccountId, key.id, { resetRateLimitUsage: true });
      onRefresh();
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      onBusy(null);
    }
  }

  async function handleCopyKey(key: ManagedKeyRecord) {
    const rawKey = key.rawKey?.trim();
    if (!rawKey) {
      onError("当前密钥未返回原始 Key, 无法复制。");
      return;
    }

    onError(null);
    try {
      await copyTextToClipboard(rawKey);
      setCopiedKeyId(key.id);
      if (copiedKeyTimerRef.current != null) {
        window.clearTimeout(copiedKeyTimerRef.current);
      }
      copiedKeyTimerRef.current = window.setTimeout(() => {
        setCopiedKeyId((current) => (current === key.id ? null : current));
      }, 1800);
    } catch (cause) {
      onError((cause as Error).message);
    }
  }

  function openUseKeyModal(key: ManagedKeyRecord) {
    const rawKey = key.rawKey?.trim();
    if (!rawKey) {
      onError("当前密钥未返回原始 Key, 无法生成接入配置。");
      return;
    }
    onError(null);
    setUseKeyModalRecord({
      ...key,
      rawKey
    });
  }

  function openSubscriptionChainEditor(key: ManagedKeyRecord) {
    const existingRule = subscriptionSwitchRules.find((item) => item.keyId === key.id);
    const sourceGroupId = existingRule?.sourceGroupId ?? key.groupId ?? null;
    const sourceGroup = sourceGroupId == null ? null : groups.find((item) => item.id === sourceGroupId) ?? null;
    const sourceSubscription = resolveSubscriptionRecord(subscriptions, groups, sourceGroupId);
    if (sourceGroupId == null || !sourceGroup || !isSubscriptionGroup(sourceGroup)) {
      setRuleError("当前密钥还不在可切换的订阅分组中。");
      return;
    }
    setEditingRuleKeyId(key.id);
    setRuleDraft({
      keyId: key.id,
      sourceGroupId,
      activeTargetGroupId: existingRule?.activeTargetGroupId ?? null,
      enabled: existingRule?.enabled ?? true,
      chainNodes: existingRule?.chainNodes?.length
        ? existingRule.chainNodes.map((node) => ({
            groupId: node.groupId,
            thresholdMode: node.thresholdMode,
            thresholdValueInput: formatDraftThresholdValue(node.thresholdValue, node.thresholdMode)
          }))
        : [
            {
              groupId: sourceGroupId,
              thresholdMode: DEFAULT_SUBSCRIPTION_SWITCH_THRESHOLD_MODE,
              thresholdValueInput: buildSuggestedThresholdValueInput(
                DEFAULT_SUBSCRIPTION_SWITCH_THRESHOLD_MODE,
                sourceSubscription,
                resolveSubscriptionSummaryRecord(subscriptionSummary, sourceGroupId)
              )
            }
          ],
      autoRestore: existingRule?.autoRestore ?? true,
      strictMode: existingRule?.strictMode ?? false
    });
    setRuleError(null);
  }

  function closeSubscriptionChainEditor() {
    setEditingRuleKeyId(null);
    setRuleDraft(null);
    ruleSavingRef.current = false;
    setRuleSaving(false);
    setRuleError(null);
  }

  async function submitSubscriptionChainEditor() {
    if (ruleSavingRef.current || !selectedAccountId || !ruleDraft) {
      return;
    }
    if (ruleDraft.chainNodes.length < 2) {
      setRuleError("至少需要选择 1 个候补订阅。");
      return;
    }
    const sourceGroupId = ruleDraft.chainNodes[0]?.groupId;
    if (sourceGroupId == null) {
      setRuleError("请先选择链首订阅。");
      return;
    }
    const currentGroupId = editingRuleKey?.groupId ?? null;
    if (currentGroupId == null || !ruleDraft.chainNodes.some((node) => node.groupId === currentGroupId)) {
      setRuleError("当前密钥所在订阅必须保留在订阅链中。");
      return;
    }
    if (
      ruleDraft.activeTargetGroupId != null &&
      !ruleDraft.chainNodes.some((node) => node.groupId === ruleDraft.activeTargetGroupId)
    ) {
      setRuleError("已切换规则不能移除当前生效订阅。");
      return;
    }
    const seenGroupIds = new Set<number>();
    const chainNodes: SubscriptionSwitchChainNode[] = [];
    for (const node of ruleDraft.chainNodes) {
      const thresholdValue = Number(node.thresholdValueInput);
      if (!Number.isFinite(thresholdValue) || thresholdValue <= 0) {
        setRuleError("每个订阅的切换阈值都必须是大于 0 的数字。");
        return;
      }
      if (node.thresholdMode === "usage_percent" && thresholdValue > 100) {
        setRuleError("百分比阈值不能超过 100%。");
        return;
      }
      if (seenGroupIds.has(node.groupId)) {
        setRuleError("订阅链里不能出现重复订阅。");
        return;
      }
      seenGroupIds.add(node.groupId);
      chainNodes.push({
        groupId: node.groupId,
        thresholdMode: node.thresholdMode,
        thresholdValue
      });
    }

    ruleSavingRef.current = true;
    setRuleSaving(true);
    setRuleError(null);
    try {
      await upsertSubscriptionSwitchRule(selectedAccountId, ruleDraft.keyId, {
        enabled: ruleDraft.enabled,
        sourceGroupId,
        chainNodes,
        autoRestore: ruleDraft.autoRestore,
        strictMode: ruleDraft.strictMode
      });
    } catch (cause) {
      const message = (cause as Error)?.message?.trim() || "订阅链规则保存失败。";
      setRuleError(message);
      onSaveFeedback({
        tone: "error",
        title: "保存失败",
        message
      });
      ruleSavingRef.current = false;
      setRuleSaving(false);
      return;
    }

    try {
      await onRefreshSubscriptionChain?.();
    } catch (cause) {
      const detail = (cause as Error)?.message?.trim() || "请稍后重试。";
      const message = `订阅链规则已保存，但刷新显示失败: ${detail}`;
      setRuleError(message);
      onSaveFeedback({
        tone: "error",
        title: "刷新失败",
        message
      });
      ruleSavingRef.current = false;
      setRuleSaving(false);
      return;
    }

    closeSubscriptionChainEditor();
    onSaveFeedback({
      tone: "success",
      title: "保存成功",
      message: "订阅链规则已保存。"
    });
  }

  async function handleQuickSubscriptionSwitch(key: ManagedKeyRecord, targetGroupId: number) {
    if (!selectedAccountId) {
      onError("请先选择一个账号，再切换订阅。");
      return;
    }
    if (quickSwitchSavingKeyId || !Number.isInteger(targetGroupId) || targetGroupId <= 0 || key.groupId === targetGroupId) {
      return;
    }

    const candidate = buildKeySubscriptionSwitchCandidates({
      currentGroupId: key.groupId,
      subscriptionDetails: quickSwitchSubscriptionDetails
    }).find((item) => item.groupId === targetGroupId);
    if (!candidate) {
      onError("目标订阅暂不可切换，请刷新后重试。");
      return;
    }

    setQuickSwitchSavingKeyId(key.id);
    onBusy(`正在将 ${key.name} 切换到 ${candidate.name}...`);
    onError(null);
    try {
      await updateManagedKey(selectedAccountId, key.id, { groupId: targetGroupId });
      onRefresh();
      setQuickSwitchModalKeyId(null);
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setQuickSwitchSavingKeyId(null);
      onBusy(null);
    }
  }

  function openQuickSubscriptionSwitchModal(key: ManagedKeyRecord) {
    if (!selectedAccountId) {
      onError("请先选择一个账号，再查看订阅。");
      return;
    }
    setQuickSwitchModalKeyId(key.id);
  }

  function closeQuickSubscriptionSwitchModal() {
    if (quickSwitchSavingKeyId === quickSwitchModalKeyId) {
      return;
    }
    setQuickSwitchModalKeyId(null);
  }

  async function deleteCurrentSubscriptionChainRule() {
    if (ruleSavingRef.current || !selectedAccountId || !ruleDraft) {
      return;
    }
    ruleSavingRef.current = true;
    setRuleSaving(true);
    setRuleError(null);
    try {
      await deleteSubscriptionSwitchRule(selectedAccountId, ruleDraft.keyId);
      await onRefreshSubscriptionChain?.();
      closeSubscriptionChainEditor();
    } catch (cause) {
      setRuleError((cause as Error).message);
      ruleSavingRef.current = false;
      setRuleSaving(false);
    }
  }

  function triggerCcsImport(key: ManagedKeyRecord, clientType: CcsClientType) {
    const rawKey = key.rawKey?.trim();
    if (!rawKey) {
      onError("当前密钥未返回原始 Key, 无法导入到 CCS。");
      return;
    }

    const importUrl = buildCcsImportUrl({
      baseUrl: normalizeUseKeyBaseUrl(selectedSiteBaseUrl),
      platform: key.platform,
      clientType,
      providerName: selectedSiteName,
      apiKey: rawKey
    });

    onError(null);
    try {
      window.open(importUrl, "_self");
      if (ccsImportTimerRef.current != null) {
        window.clearTimeout(ccsImportTimerRef.current);
      }
      ccsImportTimerRef.current = window.setTimeout(() => {
        if (document.hasFocus()) {
          onError("未检测到 CCS，请先安装并启动后重试。");
        }
      }, 100);
    } catch {
      onError("未检测到 CCS，请先安装并启动后重试。");
    }
  }

  function handleImportToCcs(key: ManagedKeyRecord) {
    const rawKey = key.rawKey?.trim();
    if (!rawKey) {
      onError("当前密钥未返回原始 Key, 无法导入到 CCS。");
      return;
    }

    onError(null);
    if (normalizeCcsImportPlatform(key.platform) === "antigravity") {
      setCcsClientSelectKey({
        ...key,
        rawKey
      });
      return;
    }

    triggerCcsImport(
      {
        ...key,
        rawKey
      },
      normalizeCcsImportPlatform(key.platform) === "gemini" ? "gemini" : "claude"
    );
  }

  function closeCcsClientSelect() {
    setCcsClientSelectKey(null);
  }

  function handleCcsClientSelect(clientType: CcsClientType) {
    if (!ccsClientSelectKey) return;
    const selectedKey = ccsClientSelectKey;
    setCcsClientSelectKey(null);
    triggerCcsImport(selectedKey, clientType);
  }

  async function openKeyUsageDetail(key: ManagedKeyRecord, range = buildKeyUsagePresetRange("today")) {
    if (!selectedAccountId) {
      onError("请先选择一个账号，再查看密钥用量。");
      return;
    }

    const requestSequence = usageDetailSequenceRef.current + 1;
    usageDetailSequenceRef.current = requestSequence;
    onError(null);
    setUsageDetailKey(key);
    setUsageDetailAccountId(selectedAccountId);
    setUsageDetailRange(range);
    setUsageDetailRangeMode(range.mode);
    if (range.mode === "custom") {
      setUsageDetailCustomStartDate(range.startDate);
      setUsageDetailCustomEndDate(range.endDate);
    }
    const scopeKey = buildKeyUsageSummaryScopeKey({
      accountId: selectedAccountId,
      keyId: key.id,
      range
    });
    const cachedEntry = keyUsageSummaryCache.peek(scopeKey);
    const cachedSummary = cachedEntry.hasSnapshot ? cachedEntry.data ?? null : null;
    const hasCachedSummary = cachedSummary !== null;
    setUsageDetailSummary(cachedSummary);
    setUsageDetailError(null);
    setUsageDetailLoading(!hasCachedSummary);
    setUsageDetailRefreshing(hasCachedSummary);

    try {
      const result = await loadKeyUsageSummary(keyUsageSummaryCache, {
        accountId: selectedAccountId,
        keyId: key.id,
        range
      });
      if (usageDetailSequenceRef.current !== requestSequence) {
        return;
      }
      if (result.status === "success") {
        setUsageDetailSummary(result.data);
        setUsageDetailError(null);
      } else if (result.status === "error") {
        setUsageDetailError(result.error.message);
        if (!hasCachedSummary) {
          setUsageDetailSummary(null);
        }
      }
    } finally {
      if (usageDetailSequenceRef.current === requestSequence) {
        setUsageDetailLoading(false);
        setUsageDetailRefreshing(false);
      }
    }
  }

  function closeKeyUsageDetail() {
    resetKeyUsageDetail();
  }

  function handleUsageDetailRangeModeChange(mode: KeyUsageRangeMode) {
    setUsageDetailRangeMode(mode);
    if (mode === "custom") {
      const draftRange = usageDetailRange.mode === "custom" ? usageDetailRange : refreshKeyUsagePresetRange(usageDetailRange);
      setUsageDetailCustomStartDate((current) => current || draftRange.startDate);
      setUsageDetailCustomEndDate((current) => current || draftRange.endDate);
      return;
    }

    const nextRange = buildKeyUsagePresetRange(mode);
    if (!usageDetailKey) {
      setUsageDetailRange(nextRange);
      return;
    }
    void openKeyUsageDetail(usageDetailKey, nextRange);
  }

  function handleUsageDetailCustomRangeApply() {
    const nextRange = buildKeyUsageCustomRange(usageDetailCustomStartDate, usageDetailCustomEndDate);
    if (!nextRange) {
      onError("请选择有效的自定义时间范围。");
      return;
    }
    if (!usageDetailKey) {
      setUsageDetailRange(nextRange);
      setUsageDetailRangeMode("custom");
      return;
    }
    void openKeyUsageDetail(usageDetailKey, nextRange);
  }

  return (
    <>
      <section className="stack-list keys-page-layout">
        <SectionCard title="可用分组" subtitle="这里会显示当前账号下可以直接使用的分组">
          <div className="available-group-grid">
            {orderedGroups.map((group) => {
              const platformTone = (group.platform ?? "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
              const subscriptionType = formatAvailableGroupTypeLabel(group.subscriptionType);
              const quotaItems = buildAvailableGroupQuotaItems(group);
              return (
                <div key={group.id} className="subscription-card available-group-card">
                  <div className="available-group-row">
                    <div className="available-group-copy">
                      <strong className="available-group-name-pill">{group.name}</strong>
                      <div className="available-group-tags">
                        <span className={`key-platform-pill ${platformTone}`}>{group.platform ?? "unknown"}</span>
                      </div>
                    </div>
                    <div className="available-group-inline">
                      <span className="subscription-type-pill">{subscriptionType}</span>
                      {quotaItems.length > 0 && (
                        <div className="available-group-quotas" aria-label="分组额度">
                          {quotaItems.map((item) => (
                            <span key={item.label} className="available-group-quota-pill">
                              <small>{item.label}</small>
                              <strong>{formatAvailableGroupQuota(item.value)}</strong>
                            </span>
                          ))}
                        </div>
                      )}
                      <span className="subscription-rate-pill">倍率: x{group.rateMultiplier.toFixed(2)}</span>
                      <span className={`available-group-dispatch-pill ${group.allowMessagesDispatch ? "ready" : "neutral"}`}>
                        {group.allowMessagesDispatch ? "支持调度" : "仅直连"}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
            {groups.length === 0 && (
              <EmptyState title="当前没有可用分组" detail="刷新账号后, 这里会显示可以使用的分组。" compact />
            )}
          </div>
        </SectionCard>
        <SectionCard
          title="密钥管理"
          subtitle="你可以在这里新增、修改、启用、停用或重置密钥"
          actions={
            <button className="primary-button" onClick={openNewKey}>
              <Plus size={16} />
              新增密钥
            </button>
          }
        >
          <div className="table-list wide">
            {managedKeys?.items.map((key) => {
              const maskedKey = key.rawKey ? maskKeyListSecret(key.rawKey) : "自定义密钥未暴露";
              const canCopyKey = Boolean(key.rawKey?.trim());
              const canUseKey = Boolean(key.rawKey?.trim());
              const hasQuotaLimit = Number(key.quota ?? 0) > 0;
              const currentConcurrency = key.currentConcurrency ?? null;
              const concurrencyTone = currentConcurrency === null ? "unknown" : currentConcurrency > 0 ? "active" : "idle";
              const quickSwitchCandidates = buildKeySubscriptionSwitchCandidates({
                currentGroupId: key.groupId,
                subscriptionDetails: quickSwitchSubscriptionDetails
              });
              const quickSwitchSaving = quickSwitchSavingKeyId === key.id;
              const quickSwitchDisabled = !selectedAccountId || quickSwitchSavingKeyId !== null;
              const quickSwitchTitle = !selectedAccountId
                ? "请先选择一个账号"
                : quickSwitchSaving
                  ? "正在切换订阅"
                  : quickSwitchCandidates.length === 0
                    ? "当前没有可切换的可用订阅，仍可查看全部订阅"
                    : "选择要切换的订阅";
              return (
                <div
                  key={key.id}
                  className="table-row wide key-row key-row-trigger"
                    onClick={() => void openKeyUsageDetail(key)}
                    onKeyDown={(event) => handleActionKey(event, () => void openKeyUsageDetail(key))}
                    role="button"
                    tabIndex={0}
                    aria-label={`查看 ${key.name} 的密钥用量详情`}
                    title="查看密钥用量详情"
                >
                  <div className="row-main key-row-main key-row-summary-trigger">
                    <div className="key-heading-row">
                      <div className="key-title-cluster">
                        <StatusBadge state={key.status === "active" ? "ready" : "expired"} />
                        <strong>{key.name}</strong>
                      </div>
                      <div className="key-secret-line">
                        <span className="key-subscription-switch">
                          <button
                            type="button"
                            className="key-subscription-trigger"
                            aria-label={`切换 ${key.name} 的订阅`}
                            aria-haspopup="dialog"
                            aria-expanded={quickSwitchModalKeyId === key.id}
                            aria-busy={quickSwitchSaving || undefined}
                            disabled={quickSwitchDisabled}
                            title={quickSwitchTitle}
                            onClick={(event) => {
                              stopRowTriggerPropagation(event);
                              openQuickSubscriptionSwitchModal(key);
                            }}
                            onKeyDown={stopRowTriggerPropagation}
                          >
                            <span className="key-subscription-tag name">{key.groupName ?? "未分组"}</span>
                            <span className="key-subscription-tag platform">{key.platform ?? "unknown"}</span>
                          </button>
                        </span>
                      </div>
                    </div>
                    <div className="row-meta key-row-meta">
                      {hasQuotaLimit && <span>限制额度 ${Number(key.quota ?? 0).toFixed(2)}</span>}
                      <span className={`key-concurrency-pill ${concurrencyTone}`} title="当前密钥的实时并发数">
                        当前并发：{currentConcurrency ?? "-"}
                      </span>
                      <span>{key.lastUsedAt ? `最后使用时间：${formatTime(key.lastUsedAt)}` : "最近未使用"}</span>
                    </div>
                    <div
                      className={`key-secret-row ${canCopyKey ? "copyable" : ""}`}
                      onClick={(event) => {
                        if (!canCopyKey) {
                          return;
                        }
                        stopRowTriggerPropagation(event);
                        void handleCopyKey(key);
                      }}
                      title={canCopyKey ? "点击复制密钥" : "当前密钥未返回原始 Key"}
                    >
                      <small className="key-secret-text">{maskedKey}</small>
                      <button
                        type="button"
                        className={`key-copy-button ${copiedKeyId === key.id ? "copied" : ""}`}
                        onClick={(event) => {
                          stopRowTriggerPropagation(event);
                          void handleCopyKey(key);
                        }}
                        onKeyDown={stopRowTriggerPropagation}
                        disabled={!canCopyKey}
                      >
                        {copiedKeyId === key.id ? "已复制" : "复制"}
                      </button>
                    </div>
                  </div>
                  <div className="row-actions wrap-actions key-row-actions">
                    <div className="key-action-cluster">
                      <button
                        className="inline-text-button"
                        type="button"
                        onClick={(event) => {
                          stopRowTriggerPropagation(event);
                          openUseKeyModal(key);
                        }}
                        onKeyDown={stopRowTriggerPropagation}
                        disabled={!canUseKey}
                        title={canUseKey ? "查看当前密钥的接入配置" : "当前密钥未返回原始 Key"}
                      >
                        使用密钥
                      </button>
                      <button
                        className="inline-text-button"
                        type="button"
                        onClick={(event) => {
                          stopRowTriggerPropagation(event);
                          openSubscriptionChainEditor(key);
                        }}
                        onKeyDown={stopRowTriggerPropagation}
                        title="配置当前密钥的订阅链"
                      >
                        配置订阅链
                      </button>
                      <button
                        className="inline-text-button"
                        type="button"
                        onClick={(event) => {
                          stopRowTriggerPropagation(event);
                          openEditKey(key);
                        }}
                        onKeyDown={stopRowTriggerPropagation}
                      >
                        编辑
                      </button>
                      <button
                        className="inline-text-button"
                        type="button"
                        onClick={(event) => {
                          stopRowTriggerPropagation(event);
                          handleToggleKeyStatus(key);
                        }}
                        onKeyDown={stopRowTriggerPropagation}
                      >
                        {key.status === "active" ? "停用" : "启用"}
                      </button>
                      <button
                        className="inline-text-button danger"
                        type="button"
                        onClick={(event) => {
                          stopRowTriggerPropagation(event);
                          handleDeleteKey(key.id);
                        }}
                        onKeyDown={stopRowTriggerPropagation}
                      >
                        删除
                      </button>
                    </div>
                    <div className="key-action-cluster secondary">
                      <button
                        className="inline-text-button"
                        type="button"
                        onClick={(event) => {
                          stopRowTriggerPropagation(event);
                          handleResetRateLimitUsage(key);
                        }}
                        onKeyDown={stopRowTriggerPropagation}
                      >
                        重置限流
                      </button>
                      <button
                        className="inline-text-button"
                        type="button"
                        onClick={(event) => {
                          stopRowTriggerPropagation(event);
                          handleResetQuota(key);
                        }}
                        onKeyDown={stopRowTriggerPropagation}
                      >
                        重置额度
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
            {(!managedKeys || managedKeys.items.length === 0) && (
              <EmptyState title="当前没有密钥数据" detail="先登录并刷新当前账号后再管理密钥。" compact />
            )}
          </div>
        </SectionCard>
      </section>

      {keyModalOpen && (
        <Modal
          title={editingKey ? "编辑密钥" : "创建密钥"}
          onClose={() => setKeyModalOpen(false)}
          onSubmit={() => submitKeyForm()}
          submitText={editingKey ? "更新密钥" : "创建密钥"}
          size="wide"
          className="key-modal"
          bodyClassName="key-modal-body"
          footerClassName="key-modal-footer"
          headerClassName="key-modal-header"
          closeText={null}
        >
          <div className="key-modal-shell">
            <section className="key-modal-section">
              <label className="field key-modal-field">
                <span>名称</span>
                <input
                  value={keyForm.name}
                  onChange={(event) => setKeyForm((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="我的 API 密钥"
                />
              </label>
              <div className="field key-modal-field">
                <span>分组</span>
                <div className="key-group-picker">
                  <button
                    type="button"
                    className={`key-group-trigger ${keyGroupPickerOpen ? "open" : ""}`}
                    onClick={() => {
                      if (groups.length === 0) return;
                      setKeyGroupPickerOpen((prev) => !prev);
                    }}
                    disabled={groups.length === 0}
                    aria-expanded={keyGroupPickerOpen}
                    aria-label="选择分组"
                  >
                    <div className="key-group-trigger-copy">
                      <strong>{selectedKeyGroup?.name ?? "选择分组"}</strong>
                      <span>{selectedKeyGroup ? `${selectedKeyGroup.platform} / x${selectedKeyGroup.rateMultiplier.toFixed(1)}` : ""}</span>
                    </div>
                    <ChevronDown size={18} className={`site-picker-icon ${keyGroupPickerOpen ? "open" : ""}`} />
                  </button>
                  {keyGroupPickerOpen && groups.length > 0 && (
                    <div className="key-group-dropdown">
                      <label className="key-group-search">
                        <Search size={16} />
                        <input
                          value={keyGroupSearch}
                          onChange={(event) => setKeyGroupSearch(event.target.value)}
                          placeholder="搜索分组..."
                        />
                      </label>
                      <div className="key-group-list">
                        {filteredKeyGroups.map((group) => (
                          <button
                            key={group.id}
                            type="button"
                            className={`key-group-option ${group.id === keyForm.groupId ? "selected" : ""}`}
                            onClick={() => {
                              setKeyForm((prev) => ({ ...prev, groupId: group.id }));
                              setKeyGroupPickerOpen(false);
                              setKeyGroupSearch("");
                            }}
                          >
                            <div className="key-group-option-main">
                              <span className={`key-group-platform ${group.platform}`}>{group.platform}</span>
                              <strong>{group.name}</strong>
                            </div>
                            <span className="key-group-rate">{`${group.rateMultiplier.toFixed(group.rateMultiplier < 1 ? 1 : 0)}x 倍率`}</span>
                          </button>
                        ))}
                        {filteredKeyGroups.length === 0 && <div className="key-group-empty">没有匹配的分组</div>}
                      </div>
                    </div>
                  )}
                </div>
                {groups.length === 0 && <p className="field-help">当前账号没有返回可用分组，先刷新账号后再创建密钥。</p>}
              </div>
            </section>

            <section className="key-modal-section">
              <div className="key-switch-row">
                <div>
                  <strong>自定义密钥</strong>
                  <p>仅允许字母、数字、下划线和连字符，最少16个字符。</p>
                </div>
                <button
                  type="button"
                  className={`switch-pill ${keyCustomKeyEnabled ? "on" : ""}`}
                  onClick={() => setKeyCustomKeyEnabled((prev) => !prev)}
                  aria-pressed={keyCustomKeyEnabled}
                  aria-label="自定义密钥"
                >
                  <span />
                </button>
              </div>
              {keyCustomKeyEnabled && (
                <label className="field key-modal-field">
                  <span>自定义密钥</span>
                  <input
                    value={keyForm.customKey ?? ""}
                    onChange={(event) => setKeyForm((prev) => ({ ...prev, customKey: event.target.value }))}
                    placeholder="输入自定义密钥 (至少16个字符)"
                  />
                  <p className="field-help">仅允许字母、数字、下划线和连字符，最少16个字符。</p>
                </label>
              )}
            </section>

            <section className="key-modal-section">
              <div className="key-switch-row">
                <div>
                  <strong>IP 限制</strong>
                  <p>开启后可按白名单和黑名单限制此密钥的来源 IP。</p>
                </div>
                <button
                  type="button"
                  className={`switch-pill ${keyIpLimitEnabled ? "on" : ""}`}
                  onClick={() => setKeyIpLimitEnabled((prev) => !prev)}
                  aria-pressed={keyIpLimitEnabled}
                  aria-label="IP 限制"
                >
                  <span />
                </button>
              </div>
              {keyIpLimitEnabled && (
                <>
                  <label className="field key-modal-field">
                    <span>IP 白名单</span>
                    <textarea
                      value={keyForm.ipWhitelist ?? ""}
                      onChange={(event) => setKeyForm((prev) => ({ ...prev, ipWhitelist: event.target.value }))}
                      placeholder={"192.168.1.100\n10.0.0.0/8"}
                      rows={4}
                    />
                    <p className="field-help">每行一个 IP 或 CIDR。设置后仅允许这些 IP 使用此密钥</p>
                  </label>
                  <label className="field key-modal-field">
                    <span>IP 黑名单</span>
                    <textarea
                      value={keyForm.ipBlacklist ?? ""}
                      onChange={(event) => setKeyForm((prev) => ({ ...prev, ipBlacklist: event.target.value }))}
                      placeholder={"1.2.3.4\n5.6.0.0/16"}
                      rows={4}
                    />
                    <p className="field-help">每行一个 IP 或 CIDR。这些 IP 将被禁止使用此密钥</p>
                  </label>
                </>
              )}
            </section>

            <section className="key-modal-section">
              <label className="field key-modal-field">
                <span>额度限制</span>
                <div className="money-input">
                  <span>$</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={keyForm.quota ?? ""}
                    onChange={(event) =>
                      setKeyForm((prev) => ({ ...prev, quota: parseOptionalNumberInput(event.target.value) }))
                    }
                    placeholder="输入 USD 额度限制"
                  />
                </div>
                <p className="field-help">设置此密钥可消耗的最大金额。0 = 无限制。</p>
              </label>
            </section>

            <section className="key-modal-section">
              <div className="key-switch-row">
                <div>
                  <strong>速率限制</strong>
                  <p>设置此密钥在指定时间窗口内的最大消费额。0 = 无限制。</p>
                </div>
                <button
                  type="button"
                  className={`switch-pill ${keyRateLimitEnabled ? "on" : ""}`}
                  onClick={() => setKeyRateLimitEnabled((prev) => !prev)}
                  aria-pressed={keyRateLimitEnabled}
                  aria-label="速率限制"
                >
                  <span />
                </button>
              </div>
              {keyRateLimitEnabled && (
                <div className="key-rate-grid">
                  <label className="field key-modal-field">
                    <span>5小时限额 (USD)</span>
                    <div className="money-input">
                      <span>$</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={keyForm.rateLimit5h ?? ""}
                        onChange={(event) =>
                          setKeyForm((prev) => ({ ...prev, rateLimit5h: parseOptionalNumberInput(event.target.value) }))
                        }
                        placeholder="0"
                      />
                    </div>
                  </label>
                  <label className="field key-modal-field">
                    <span>日限额 (USD)</span>
                    <div className="money-input">
                      <span>$</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={keyForm.rateLimit1d ?? ""}
                        onChange={(event) =>
                          setKeyForm((prev) => ({ ...prev, rateLimit1d: parseOptionalNumberInput(event.target.value) }))
                        }
                        placeholder="0"
                      />
                    </div>
                  </label>
                  <label className="field key-modal-field">
                    <span>周限额 (USD)</span>
                    <div className="money-input">
                      <span>$</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={keyForm.rateLimit7d ?? ""}
                        onChange={(event) =>
                          setKeyForm((prev) => ({ ...prev, rateLimit7d: parseOptionalNumberInput(event.target.value) }))
                        }
                        placeholder="0"
                      />
                    </div>
                  </label>
                </div>
              )}
            </section>

            <section className="key-modal-section">
              <div className="key-switch-row">
                <div>
                  <strong>密钥有效期</strong>
                  <p>默认关闭。开启后可快速选择 7 天、30 天、90 天或自定义过期时间。</p>
                </div>
                <button
                  type="button"
                  className={`switch-pill ${keyExpiryEnabled ? "on" : ""}`}
                  onClick={() => setKeyExpiryEnabled((prev) => !prev)}
                  aria-pressed={keyExpiryEnabled}
                  aria-label="密钥有效期"
                >
                  <span />
                </button>
              </div>
              {keyExpiryEnabled && (
                <>
                  <div className="expiry-preset-row">
                    {KEY_EXPIRY_PRESET_DAYS.map((days) => {
                      const presetKey = `${days}d` as KeyExpiryPreset;
                      return (
                        <button
                          key={days}
                          type="button"
                          className={`expiry-pill ${keyExpiryPreset === presetKey ? "active" : ""}`}
                          onClick={() => handleKeyExpiryPresetSelect(presetKey)}
                        >
                          {days}天
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      className={`expiry-pill ${keyExpiryPreset === "custom" ? "active" : ""}`}
                      onClick={() => handleKeyExpiryPresetSelect("custom")}
                    >
                      自定义
                    </button>
                  </div>
                  <label className="field key-modal-field">
                    <span>过期时间</span>
                    <div className="date-input-shell">
                      <input
                        type="datetime-local"
                        value={keyExpiryDateTime}
                        onChange={(event) => {
                          setKeyExpiryDateTime(event.target.value);
                          setKeyExpiryPreset("custom");
                        }}
                      />
                      <CalendarDays size={18} />
                    </div>
                    <p className="field-help">选择此 API 密钥的过期时间。</p>
                  </label>
                </>
              )}
            </section>
          </div>
        </Modal>
      )}
      {quickSwitchModalKey && (
        <KeySubscriptionPickerModal
          keyRecord={quickSwitchModalKey}
          subscriptionDetails={quickSwitchSubscriptionDetails}
          candidates={buildKeySubscriptionSwitchCandidates({
            currentGroupId: quickSwitchModalKey.groupId,
            subscriptionDetails: quickSwitchSubscriptionDetails
          })}
          saving={quickSwitchSavingKeyId === quickSwitchModalKey.id}
          onSelect={(targetGroupId) => {
            void handleQuickSubscriptionSwitch(quickSwitchModalKey, targetGroupId);
          }}
          onClose={closeQuickSubscriptionSwitchModal}
        />
      )}
      {ruleDraft && editingRuleKey && editingSourceGroup && (
        <Modal
          title={`${editingRuleKey.name} · 订阅链规则`}
          onClose={closeSubscriptionChainEditor}
          onSubmit={() => void submitSubscriptionChainEditor()}
          submitText={ruleSaving ? "保存中..." : "保存规则"}
          size="wide"
          className="subscription-switch-modal"
        >
          <div className="stack-list">
            <div className="subscription-switch-summary-grid">
              <DetailItem label="当前密钥" value={editingRuleKey.name} />
              <DetailItem label="链首订阅" value={editingSourceGroup.name} />
              <DetailItem label="当前分组" value={editingKeyCurrentGroupName} />
            </div>
            <div className="subscription-switch-toggle-grid">
              <div className="subscription-switch-toggle-field">
                <div className="subscription-switch-toggle-title">
                  <strong>启用自动切换</strong>
                  <TitleHint
                    content="当前订阅达到自身阈值、失效或额度耗尽时，系统从下一位开始扫描；链尾没有可用项时会回到链首继续查找，最多检查一圈。"
                    label="查看启用自动切换说明"
                  />
                </div>
                <label className="subscription-switch-toggle-control">
                  <input
                    type="checkbox"
                    aria-label="启用自动切换"
                    checked={ruleDraft.enabled}
                    disabled={ruleSaving}
                    onChange={(event) => setRuleDraft((prev) => (prev ? { ...prev, enabled: event.target.checked } : prev))}
                  />
                  <span className="subscription-switch-toggle-track" aria-hidden="true" />
                </label>
              </div>
              <div className="subscription-switch-toggle-field">
                <div className="subscription-switch-toggle-title">
                  <strong>恢复后自动切回链首</strong>
                  <TitleHint
                    content="严格模式关闭时，链首订阅恢复正常且低于自身阈值后，自动把当前密钥切回链首。关闭此项不会阻止触发后的环形候补扫描。"
                    label="查看自动切回链首说明"
                  />
                </div>
                <label className="subscription-switch-toggle-control">
                  <input
                    type="checkbox"
                    aria-label="恢复后自动切回链首"
                    checked={ruleDraft.autoRestore}
                    disabled={ruleSaving}
                    onChange={(event) => setRuleDraft((prev) => (prev ? { ...prev, autoRestore: event.target.checked } : prev))}
                  />
                  <span className="subscription-switch-toggle-track" aria-hidden="true" />
                </label>
              </div>
              <div className="subscription-switch-toggle-field">
                <div className="subscription-switch-toggle-title">
                  <strong>严格模式</strong>
                  <TitleHint
                    content="当前订阅之前只要存在仍有正额度、状态正常且低于自身阈值的节点，就自动切到优先级最高的可用节点。"
                    label="查看严格模式说明"
                  />
                </div>
                <label className="subscription-switch-toggle-control">
                  <input
                    type="checkbox"
                    aria-label="严格模式"
                    checked={ruleDraft.strictMode}
                    disabled={ruleSaving}
                    onChange={(event) => setRuleDraft((prev) => (prev ? { ...prev, strictMode: event.target.checked } : prev))}
                  />
                  <span className="subscription-switch-toggle-track" aria-hidden="true" />
                </label>
              </div>
            </div>
            {ruleDraft.activeTargetGroupId != null && (
              <p className="subscription-switch-rule-caption">
                {`当前生效订阅: ${resolveGroupName(groups, ruleDraft.activeTargetGroupId)}。保存时需保留该节点。`}
              </p>
            )}
            {editingSubscriptionSwitchRule?.lastError && (
              <p className="subscription-switch-rule-caption" role="status">
                {`上次链路诊断: ${editingSubscriptionSwitchRule.lastError}`}
              </p>
            )}

            <div className="subscription-switch-modal-grid">
              <section className="subscription-switch-picker">
                <div className="section-mini-title">全部订阅</div>
                <div className="subscription-switch-picker-list">
                  {candidateGroups.map((group) => {
                    const selected = ruleDraft.chainNodes.some((node) => node.groupId === group.id);
                    const groupSubscription = resolveSubscriptionRecord(subscriptions, groups, group.id);
                    const groupWindow = resolveSubscriptionDisplayWindow(
                      groupSubscription,
                      resolveSubscriptionSummaryRecord(subscriptionSummary, group.id)
                    );
                    return (
                      <div key={group.id} className="subscription-switch-available-row">
                        <div className="subscription-switch-row-copy">
                          <strong>{group.name}</strong>
                          <p>{buildAvailableSubscriptionDescription(group, groupWindow)}</p>
                        </div>
                        <button
                          type="button"
                          className={`inline-text-button ${selected ? "ghost-selected" : ""}`}
                          title={selected ? "已加入订阅链" : `将 ${group.name} 加入订阅链`}
                          aria-label={selected ? `${group.name} 已加入订阅链` : `将 ${group.name} 加入订阅链`}
                          disabled={selected}
                          onClick={() => {
                            setRuleDraft((prev) => {
                              if (!prev || prev.chainNodes.some((node) => node.groupId === group.id)) return prev;
                              const subscription = resolveSubscriptionRecord(subscriptions, groups, group.id);
                              const summary = resolveSubscriptionSummaryRecord(subscriptionSummary, group.id);
                              return {
                                ...prev,
                                chainNodes: [
                                  ...prev.chainNodes,
                                  {
                                    groupId: group.id,
                                    thresholdMode: DEFAULT_SUBSCRIPTION_SWITCH_THRESHOLD_MODE,
                                    thresholdValueInput: buildSuggestedThresholdValueInput(
                                      DEFAULT_SUBSCRIPTION_SWITCH_THRESHOLD_MODE,
                                      subscription,
                                      summary
                                    )
                                  }
                                ]
                              };
                            });
                          }}
                        >
                          {selected ? "已添加" : <Plus size={15} aria-hidden="true" />}
                        </button>
                      </div>
                    );
                  })}
                  {candidateGroups.length === 0 && (
                    <EmptyState title="当前没有可配置订阅" detail="同步订阅后可以在这里配置完整的候补链。" compact />
                  )}
                </div>
              </section>

              <section className="subscription-switch-picker">
                <div className="section-mini-title">订阅链</div>
                <div className="subscription-switch-picker-list">
                  {ruleDraft.chainNodes.map((node, index) => {
                    const group = groups.find((item) => item.id === node.groupId);
                    if (!group) return null;
                    const isActiveTarget = node.groupId === ruleDraft.activeTargetGroupId;
                    const isCurrentGroup = node.groupId === editingRuleKey.groupId;
                    const isProtectedNode = isCurrentGroup || isActiveTarget;
                    const groupSubscription = resolveSubscriptionRecord(subscriptions, groups, group.id);
                    const groupWindow = resolveSubscriptionDisplayWindow(
                      groupSubscription,
                      resolveSubscriptionSummaryRecord(subscriptionSummary, group.id)
                    );
                    return (
                      <div key={node.groupId} className="subscription-switch-chain-node">
                        <div className="subscription-switch-node-header">
                          <div className="subscription-switch-row-copy">
                            <strong>{index === 0 ? "链首" : `候补 ${index}`} · {group.name}</strong>
                            <p>{buildAvailableSubscriptionDescription(group, groupWindow)}</p>
                          </div>
                          <div className="inline-actions wrap-actions">
                            <button
                              type="button"
                              className="inline-text-button"
                              title="上移订阅"
                              aria-label={`上移 ${group.name}`}
                              onClick={() => moveChainNode(setRuleDraft, node.groupId, -1)}
                              disabled={index === 0 || ruleSaving}
                            >
                              <ArrowUp size={14} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="inline-text-button"
                              title="下移订阅"
                              aria-label={`下移 ${group.name}`}
                              onClick={() => moveChainNode(setRuleDraft, node.groupId, 1)}
                              disabled={index === ruleDraft.chainNodes.length - 1 || ruleSaving}
                            >
                              <ArrowDown size={14} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="inline-text-button danger"
                              title={
                                isCurrentGroup
                                  ? "当前密钥所在订阅不能移除"
                                  : isActiveTarget
                                    ? "当前生效订阅不能移除"
                                    : "移除订阅"
                              }
                              aria-label={
                                isCurrentGroup
                                  ? `${group.name} 是当前密钥所在订阅，不能移除`
                                  : isActiveTarget
                                    ? `${group.name} 当前生效，不能移除`
                                    : `移除 ${group.name}`
                              }
                              disabled={isProtectedNode || ruleSaving}
                              onClick={() => {
                                setRuleDraft((prev) => {
                                  if (!prev) return prev;
                                  const chainNodes = prev.chainNodes.filter((item) => item.groupId !== node.groupId);
                                  const sourceGroupId = chainNodes[0]?.groupId;
                                  return sourceGroupId == null ? prev : { ...prev, sourceGroupId, chainNodes };
                                });
                              }}
                            >
                              <Trash2 size={14} aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                        <div className="subscription-switch-node-fields">
                          <label className="subscription-switch-field">
                            <span>切换口径</span>
                            <select
                              value={node.thresholdMode}
                              onChange={(event) => {
                                const thresholdMode = event.target.value as SubscriptionSwitchThresholdMode;
                                updateRuleDraftChainNode(setRuleDraft, node.groupId, (current) => ({
                                  ...current,
                                  thresholdMode,
                                  thresholdValueInput: buildSuggestedThresholdValueInput(
                                    thresholdMode,
                                    groupSubscription,
                                    resolveSubscriptionSummaryRecord(subscriptionSummary, group.id)
                                  )
                                }));
                              }}
                            >
                              <option value="usage_percent">按额度百分比</option>
                              <option value="amount_usd">按已用金额</option>
                            </select>
                          </label>
                          <label className="subscription-switch-field">
                            <span>{node.thresholdMode === "usage_percent" ? "阈值百分比" : "阈值金额"}</span>
                            <input
                              type="number"
                              min="0"
                              max={node.thresholdMode === "usage_percent" ? "100" : undefined}
                              step={node.thresholdMode === "usage_percent" ? "1" : "0.01"}
                              value={node.thresholdValueInput}
                              onChange={(event) =>
                                updateRuleDraftChainNode(setRuleDraft, node.groupId, (current) => ({
                                  ...current,
                                  thresholdValueInput: event.target.value
                                }))
                              }
                            />
                          </label>
                        </div>
                      </div>
                    );
                  })}
                  {ruleDraft.chainNodes.length === 1 && (
                    <EmptyState title="还没有候补订阅" detail="从左侧把至少 1 个订阅加入链路，并为每个节点配置阈值。" compact />
                  )}
                </div>
              </section>
            </div>
            {subscriptionSwitchRules.some((rule) => rule.keyId === ruleDraft.keyId) && (
              <button
                type="button"
                className="inline-text-button danger"
                onClick={() => void deleteCurrentSubscriptionChainRule()}
                disabled={ruleSaving}
              >
                <Trash2 size={14} />
                删除当前规则
              </button>
            )}
            {ruleError && <div className="status-pill danger">{ruleError}</div>}
          </div>
        </Modal>
      )}
      {usageDetailKey && usageDetailAccountId === selectedAccountId && (
        <KeyUsageDetailModal
          keyRecord={usageDetailKey}
          summary={usageDetailSummary}
          range={usageDetailRange}
          rangeMode={usageDetailRangeMode}
          customStartDate={usageDetailCustomStartDate}
          customEndDate={usageDetailCustomEndDate}
          loading={usageDetailLoading}
          refreshing={usageDetailRefreshing}
          error={usageDetailError}
          onClose={closeKeyUsageDetail}
          onRangeModeChange={handleUsageDetailRangeModeChange}
          onCustomStartDateChange={setUsageDetailCustomStartDate}
          onCustomEndDateChange={setUsageDetailCustomEndDate}
          onApplyCustomRange={handleUsageDetailCustomRangeApply}
        />
      )}
      {useKeyModalRecord && (
        <UseApiKeyModal
          keyRecord={useKeyModalRecord}
          siteBaseUrl={selectedSiteBaseUrl}
          onError={onError}
          onImportToCcs={(key) => {
            setUseKeyModalRecord(null);
            handleImportToCcs(key);
          }}
          onClose={() => setUseKeyModalRecord(null)}
        />
      )}
      {ccsClientSelectKey && (
        <CcsClientSelectModal
          onSelect={handleCcsClientSelect}
          onClose={closeCcsClientSelect}
        />
      )}
    </>
  );
}

// 调整顺序后立即同步链首，保证页面摘要和保存载荷始终使用同一节点。
function moveChainNode(
  setRuleDraft: Dispatch<SetStateAction<RuleDraft | null>>,
  groupId: number,
  direction: -1 | 1
) {
  setRuleDraft((prev) => {
    if (!prev) return prev;
    const currentIndex = prev.chainNodes.findIndex((node) => node.groupId === groupId);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= prev.chainNodes.length) return prev;
    const chainNodes = [...prev.chainNodes];
    [chainNodes[currentIndex], chainNodes[nextIndex]] = [chainNodes[nextIndex], chainNodes[currentIndex]];
    const sourceGroupId = chainNodes[0]?.groupId;
    return sourceGroupId == null ? prev : { ...prev, sourceGroupId, chainNodes };
  });
}

function updateRuleDraftChainNode(
  setRuleDraft: Dispatch<SetStateAction<RuleDraft | null>>,
  groupId: number,
  update: (node: RuleDraftChainNode) => RuleDraftChainNode
) {
  setRuleDraft((prev) =>
    prev
      ? {
          ...prev,
          chainNodes: prev.chainNodes.map((node) => (node.groupId === groupId ? update(node) : node))
        }
      : prev
  );
}

function resolveSubscriptionRecord(
  subscriptions: SubscriptionRecord[],
  groups: GroupRecord[],
  sourceGroupId: number | null
) {
  if (sourceGroupId == null) {
    return null;
  }
  const subscription = subscriptions.find((item) => item.groupId === sourceGroupId);
  if (subscription) {
    return subscription;
  }
  const group = groups.find((item) => item.id === sourceGroupId);
  if (!group || !isSubscriptionGroup(group)) {
    return null;
  }
  return {
    id: `group-${group.id}`,
    subscriptionKey: `group:${group.id}`,
    identityKind: "group",
    identityAmbiguous: false,
    groupId: group.id,
    name: group.name,
    status: "active",
    groupName: group.name,
    platform: group.platform,
    expiresAt: null,
    daily: group.dailyLimitUsd
      ? { current: 0, limit: group.dailyLimitUsd, windowStart: null }
      : null,
    weekly: group.weeklyLimitUsd
      ? { current: 0, limit: group.weeklyLimitUsd, windowStart: null }
      : null,
    monthly: group.monthlyLimitUsd
      ? { current: 0, limit: group.monthlyLimitUsd, windowStart: null }
      : null
  } satisfies SubscriptionRecord;
}

function resolveSubscriptionSummaryRecord(
  subscriptionSummary: SubscriptionSummaryPayload | null | undefined,
  groupId: number | null
) {
  if (!subscriptionSummary || groupId == null) {
    return null;
  }
  return subscriptionSummary.subscriptions.find((item) => item.groupId === groupId) ?? null;
}

function resolveSubscriptionDisplayWindow(
  subscription: SubscriptionRecord | null,
  summaryRecord: SubscriptionSummaryPayload["subscriptions"][number] | null
) {
  if (summaryRecord && summaryRecord.dailyLimitUsd > 0) {
    return {
      label: "日额度",
      current: summaryRecord.dailyUsedUsd,
      limit: summaryRecord.dailyLimitUsd
    };
  }
  return selectSubscriptionSwitchWindow(subscription);
}

function formatDateOnly(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}

function selectSubscriptionSwitchWindow(subscription: SubscriptionRecord | null) {
  if (!subscription) {
    return null;
  }
  const candidates = [
    { label: "日额度", window: subscription.daily },
    { label: "周额度", window: subscription.weekly },
    { label: "月额度", window: subscription.monthly }
  ];
  const match = candidates.find((item) => item.window && item.window.limit > 0);
  if (!match?.window) {
    return null;
  }
  return {
    label: match.label,
    current: match.window.current,
    limit: match.window.limit
  };
}

function buildAvailableSubscriptionDescription(
  group: GroupRecord,
  window: { label: string; current: number; limit: number } | null
) {
  if (!window) {
    return `${group.platform} · ${group.subscriptionType ?? "subscription"}`;
  }
  return `${group.platform} · ${window.label} $${window.current.toFixed(2)} / $${window.limit.toFixed(2)}`;
}

export function buildSuggestedThresholdValueInput(
  thresholdMode: SubscriptionSwitchThresholdMode,
  subscription: SubscriptionRecord | null,
  summaryRecord: SubscriptionSummaryPayload["subscriptions"][number] | null
) {
  if (thresholdMode === "usage_percent") {
    return String(DEFAULT_SUBSCRIPTION_SWITCH_THRESHOLD_VALUE);
  }
  const window = resolveSubscriptionDisplayWindow(subscription, summaryRecord);
  if (!window) {
    return "1";
  }
  const roundedSuggestion = Number((window.limit * 0.97).toFixed(2));
  return String(Math.min(window.limit, roundedSuggestion > 0 ? roundedSuggestion : window.limit));
}

function formatDraftThresholdValue(
  value: number,
  thresholdMode: SubscriptionSwitchThresholdMode
) {
  if (thresholdMode === "usage_percent") {
    return formatThresholdNumber(value);
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatThresholdNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function resolveGroupName(groups: GroupRecord[], groupId: number | null) {
  if (groupId == null) {
    return "未分组";
  }
  return groups.find((item) => item.id === groupId)?.name ?? `订阅 #${groupId}`;
}

export function buildOrderedCandidateGroups(
  subscriptions: SubscriptionRecord[],
  groups: GroupRecord[],
  sourceGroupId: number | null
) {
  const candidateGroupMap = new Map(
    groups
      .filter((group) => isSubscriptionGroup(group))
      .map((group) => [group.id, group] as const)
  );
  const ordered: GroupRecord[] = [];
  const seen = new Set<number>();

  if (sourceGroupId != null) {
    const sourceGroup = candidateGroupMap.get(sourceGroupId);
    if (sourceGroup) {
      ordered.push(sourceGroup);
      seen.add(sourceGroup.id);
    }
  }

  for (const subscription of subscriptions) {
    if (subscription.groupId == null) {
      continue;
    }
    const group = candidateGroupMap.get(subscription.groupId);
    if (!group || seen.has(group.id)) {
      continue;
    }
    ordered.push(group);
    seen.add(group.id);
  }

  for (const group of candidateGroupMap.values()) {
    if (seen.has(group.id)) {
      continue;
    }
    ordered.push(group);
  }

  return ordered;
}

function CcsClientSelectModal({
  onSelect,
  onClose
}: {
  onSelect: (clientType: CcsClientType) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title="选择要导入的客户端"
      onClose={onClose}
      className="ccs-client-modal"
      bodyClassName="ccs-client-modal-body"
      footerClassName="ccs-client-modal-footer"
      closeText={null}
      footer={
        <button className="ghost-button" onClick={onClose}>
          取消
        </button>
      }
    >
      <div className="ccs-client-modal-shell">
        <p className="ccs-client-modal-description">
          当前密钥需要先确定导入目标。请选择要交给 CCS 创建配置的客户端。
        </p>
        <div className="ccs-client-grid">
          <button type="button" className="ccs-client-option" onClick={() => onSelect("claude")}>
            <strong>Claude Code</strong>
            <span>导入为 Claude Code 可直接使用的 provider 配置</span>
          </button>
          <button type="button" className="ccs-client-option" onClick={() => onSelect("gemini")}>
            <strong>Gemini CLI</strong>
            <span>导入为 Gemini CLI 可直接使用的 provider 配置</span>
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function UseApiKeyModal({
  keyRecord,
  siteBaseUrl,
  onError,
  onImportToCcs,
  onClose
}: {
  keyRecord: ManagedKeyRecord;
  siteBaseUrl?: string | null;
  onError: (message: string | null) => void;
  onImportToCcs: (keyRecord: ManagedKeyRecord) => void;
  onClose: () => void;
}) {
  const copiedSnippetTimerRef = useRef<number | null>(null);
  const [activeClientId, setActiveClientId] = useState<UseKeyClientId>("codex-cli");
  const [activeVariantId, setActiveVariantId] = useState<UseKeyVariantId>("macos-linux");
  const [copiedSnippetId, setCopiedSnippetId] = useState<string | null>(null);
  const rawKey = keyRecord.rawKey?.trim() || "";
  const canImportToCcs = Boolean(rawKey);
  const resolvedBaseUrl = normalizeUseKeyBaseUrl(siteBaseUrl);
  const clientConfigs = buildUseKeyClientConfigs(resolvedBaseUrl, rawKey);
  const currentClient =
    clientConfigs.find((client) => client.id === activeClientId) ??
    clientConfigs[0];
  const currentVariant =
    currentClient.variants.find((variant) => variant.id === activeVariantId) ??
    currentClient.variants[0];

  async function handleCopySnippet(snippet: UseKeySnippet) {
    onError(null);
    try {
      await copyTextToClipboard(snippet.code);
      setCopiedSnippetId(snippet.id);
      if (copiedSnippetTimerRef.current != null) {
        window.clearTimeout(copiedSnippetTimerRef.current);
      }
      copiedSnippetTimerRef.current = window.setTimeout(() => {
        setCopiedSnippetId((current) => (current === snippet.id ? null : current));
      }, 1800);
    } catch (cause) {
      onError((cause as Error).message);
    }
  }

  return (
    <Modal
      title="使用 API 密钥"
      onClose={onClose}
      size="wide"
      className="use-key-modal"
      bodyClassName="use-key-modal-body"
      headerClassName="use-key-modal-header"
      footerClassName="use-key-modal-footer"
      closeText={null}
      footer={
        <div className="use-key-modal-footer-actions">
          <button
            type="button"
            className="inline-text-button use-key-ccs-import-button"
            onClick={() => onImportToCcs(keyRecord)}
            disabled={!canImportToCcs}
            title={canImportToCcs ? "把当前密钥导入到 CCS" : "当前密钥未返回原始 Key"}
          >
            导入到 CCS
          </button>
          <button className="ghost-button" onClick={onClose}>
            关闭
          </button>
        </div>
      }
    >
      <div className="use-key-modal-shell">
        <div className="use-key-modal-copy">
          <p>{currentClient.intro}</p>
        </div>

        <nav className="use-key-client-tabs" aria-label="Client">
          {clientConfigs.map((client) => (
            <button
              key={client.id}
              type="button"
              className={`use-key-tab ${client.id === currentClient.id ? "active" : ""}`}
              onClick={() => {
                setActiveClientId(client.id);
                setActiveVariantId(client.variants[0].id);
                setCopiedSnippetId(null);
              }}
            >
              {client.label}
            </button>
          ))}
        </nav>

        {currentClient.variants.length > 1 && (
          <nav className="use-key-variant-tabs" aria-label="Tabs">
            {currentClient.variants.map((variant) => (
              <button
                key={variant.id}
                type="button"
                className={`use-key-tab secondary ${variant.id === currentVariant.id ? "active" : ""}`}
                onClick={() => {
                  setActiveVariantId(variant.id);
                  setCopiedSnippetId(null);
                }}
              >
                {variant.label}
              </button>
            ))}
          </nav>
        )}

        {currentVariant.preface && <p className="use-key-modal-preface">{currentVariant.preface}</p>}

        <div className="use-key-snippet-list">
          {currentVariant.snippets.map((snippet) => (
            <section key={snippet.id} className="use-key-snippet-card">
              <div className="use-key-snippet-header">
                <div className="use-key-snippet-heading">
                  <span className="use-key-snippet-label">{snippet.label}</span>
                  <span className="use-key-snippet-path">{snippet.path}</span>
                </div>
                <button
                  type="button"
                  className={`key-copy-button use-key-snippet-copy ${copiedSnippetId === snippet.id ? "copied" : ""}`}
                  onClick={() => void handleCopySnippet(snippet)}
                >
                  {copiedSnippetId === snippet.id ? "已复制" : "复制"}
                </button>
              </div>
              <pre className="use-key-code-block">
                <code>{snippet.code}</code>
              </pre>
            </section>
          ))}
        </div>

        {currentVariant.note && <div className="use-key-modal-note">{currentVariant.note}</div>}
      </div>
    </Modal>
  );
}

const EMPTY_KEY_USAGE_TOKEN_STATS: KeyUsageTokenStats = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  cost: 0,
  actualCost: 0
};

function getKeyUsageActualCost(stats: KeyUsageTokenStats) {
  return Number(stats.actualCost ?? stats.cost ?? 0);
}

function formatKeyUsageSubscriptionAmount(current?: number | null, limit?: number | null) {
  const hasCurrent = current !== null && current !== undefined && Number.isFinite(current);
  const hasLimit = limit !== null && limit !== undefined && Number.isFinite(limit) && limit > 0;
  if (hasCurrent && hasLimit) {
    return `${formatUsd(current, 2)} / ${formatUsd(limit, 2)}`;
  }
  if (hasCurrent) {
    return formatUsd(current, 2);
  }
  if (hasLimit) {
    return `0 / ${formatUsd(limit, 2)}`;
  }
  return "未返回";
}

function formatKeyUsageAverageDuration(value?: number | null) {
  return value === null || value === undefined ? "-" : formatDurationSeconds(value, 2, "秒");
}

function getModelUsageActualCost(row: KeyUsageSummaryPayload["modelStats"][number]) {
  return Number(row.actualCost ?? row.cost ?? 0);
}

export function KeyUsageDetailModal({
  keyRecord,
  summary,
  range,
  rangeMode,
  customStartDate,
  customEndDate,
  loading,
  refreshing = false,
  error,
  onClose,
  onRangeModeChange,
  onCustomStartDateChange,
  onCustomEndDateChange,
  onApplyCustomRange
}: {
  keyRecord: ManagedKeyRecord;
  summary: KeyUsageSummaryPayload | null;
  range: KeyUsageRangeQuery;
  rangeMode: KeyUsageRangeMode;
  customStartDate: string;
  customEndDate: string;
  loading: boolean;
  refreshing?: boolean;
  error: string | null;
  onClose: () => void;
  onRangeModeChange: (mode: KeyUsageRangeMode) => void;
  onCustomStartDateChange: (value: string) => void;
  onCustomEndDateChange: (value: string) => void;
  onApplyCustomRange: () => void;
}) {
  const platformTone = (keyRecord.platform ?? "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const maskedKey = keyRecord.rawKey ? maskSecret(keyRecord.rawKey) : "原始密钥未返回";
  const rows = summary?.dailyUsage ?? [];
  const modelRows = summary?.modelStats ?? [];
  const todayTotals = summary?.today ?? EMPTY_KEY_USAGE_TOKEN_STATS;
  const totalStats = summary?.total ?? EMPTY_KEY_USAGE_TOKEN_STATS;
  const subscriptionSnapshot = summary?.subscription ?? null;
  const subscriptionName = summary?.planName ?? "未返回";
  const subscriptionUsageText = formatKeyUsageSubscriptionAmount(
    subscriptionSnapshot?.dailyUsageUsd,
    subscriptionSnapshot?.dailyLimitUsd
  );
  const subscriptionExpiresAt = subscriptionSnapshot?.expiresAt ?? null;
  const subscriptionRemaining = summary?.remaining ?? null;
  const rangeLabel = formatKeyUsageRangeTag(range);

  return (
    <Modal
      title={`${keyRecord.name} 用量详情`}
      onClose={onClose}
      size="wide"
      className="key-usage-modal"
      bodyClassName="key-usage-modal-body"
      closeText="关闭"
    >
      <section className="key-usage-modal-hero">
        <div className="key-usage-modal-copy">
          <div className="key-usage-title-row">
            <strong>{keyRecord.name}</strong>
            <StatusBadge state={keyRecord.status === "active" ? "ready" : "expired"} />
          </div>
          <p>
            {maskedKey} · {keyRecord.groupName ?? "未分组"} · {keyRecord.lastUsedAt ? `最近使用 ${formatTime(keyRecord.lastUsedAt)}` : "最近未使用"}
          </p>
        </div>
        <div className="key-usage-modal-tags">
          <span className={`key-platform-pill ${platformTone}`}>{keyRecord.platform ?? "unknown"}</span>
          <span className="subscription-type-pill">{rangeLabel}</span>
        </div>
      </section>

      <section className="key-usage-summary-grid">
        <div className="summary-stat compact-stat">
          <span>订阅类型</span>
          <strong>{subscriptionName}</strong>
        </div>
        <div className="summary-stat compact-stat">
          <span>已用额度（日）</span>
          <strong>{subscriptionUsageText}</strong>
        </div>
        <div className="summary-stat compact-stat">
          <span>订阅到期</span>
          <strong>{subscriptionExpiresAt ? formatDateOnly(subscriptionExpiresAt) : "无到期时间"}</strong>
        </div>
        <div className="summary-stat compact-stat">
          <span>剩余额度</span>
          <strong>{subscriptionRemaining === null ? "未返回" : formatUsd(subscriptionRemaining, 2)}</strong>
        </div>
      </section>

      <section className="key-usage-range-section" aria-labelledby="key-usage-range-title">
        <span id="key-usage-range-title" className="key-usage-range-title">统计范围:</span>
        <div className="key-usage-day-selector" aria-label="时间范围统计">
          {KEY_USAGE_RANGE_PRESETS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`expiry-pill ${rangeMode === option.key ? "active" : ""}`}
              onClick={() => onRangeModeChange(option.key)}
              disabled={loading && rangeMode === option.key}
              aria-pressed={rangeMode === option.key}
            >
              {option.label}
            </button>
          ))}
          <button
            type="button"
            className={`expiry-pill ${rangeMode === "custom" ? "active" : ""}`}
            onClick={() => onRangeModeChange("custom")}
            aria-pressed={rangeMode === "custom"}
          >
            自定义
          </button>
        </div>
        {rangeMode === "custom" && (
          <div className="key-usage-custom-range" aria-label="自定义时间范围">
            <label className="key-usage-date-field">
              <span>开始</span>
              <input
                type="date"
                value={customStartDate}
                onChange={(event) => onCustomStartDateChange(event.target.value)}
              />
            </label>
            <span className="key-usage-date-divider">-</span>
            <label className="key-usage-date-field">
              <span>结束</span>
              <input
                type="date"
                value={customEndDate}
                onChange={(event) => onCustomEndDateChange(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="ghost-button key-usage-range-apply"
              onClick={onApplyCustomRange}
              disabled={loading}
            >
              应用
            </button>
          </div>
        )}
        {refreshing && (
          <span className="key-usage-refresh-state" role="status" aria-live="polite">
            正在后台更新
          </span>
        )}
        {error && summary && !refreshing && (
          <span className="key-usage-refresh-error" role="status">
            刷新失败，正在显示预热数据
          </span>
        )}
      </section>

      <section className="key-usage-stat-section">
        <div className="section-card-header compact-header key-usage-table-header">
          <div className="title-with-hint">
            <h3>模型用量统计</h3>
            <TitleHint content={`${rangeLabel}范围内按模型聚合。`} label="查看模型用量统计说明" />
          </div>
        </div>
        {loading && !summary ? (
          <EmptyState title="正在加载模型用量" detail="正在读取这个密钥的模型用量统计。" compact />
        ) : error && !summary ? (
          <EmptyState title="模型用量加载失败" detail={error} compact />
        ) : modelRows.length > 0 ? (
          <div className="usage-table-wrap key-usage-table-wrap">
            <table className="usage-table key-usage-model-table">
              <thead>
                <tr>
                  <th>模型</th>
                  <th>请求数</th>
                  <th>输入 Tokens</th>
                  <th>输出 Tokens</th>
                  <th>缓存创建</th>
                  <th>缓存读取</th>
                  <th>总 Tokens</th>
                  <th>费用</th>
                </tr>
              </thead>
              <tbody>
                {modelRows.map((row) => (
                  <tr key={row.model}>
                    <td>{row.model}</td>
                    <td>{row.requests.toLocaleString()}</td>
                    <td>{row.inputTokens.toLocaleString()}</td>
                    <td>{row.outputTokens.toLocaleString()}</td>
                    <td>{Number(row.cacheCreationTokens ?? 0).toLocaleString()}</td>
                    <td>{Number(row.cacheReadTokens ?? 0).toLocaleString()}</td>
                    <td>{row.totalTokens.toLocaleString()}</td>
                    <td>{formatUsd(getModelUsageActualCost(row), 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="这个密钥暂时没有模型用量" detail={`${formatKeyUsageRangeTag(range)}没有可展示的模型统计。`} compact />
        )}
      </section>

      <section className="key-usage-stat-section">
        <div className="section-card-header compact-header">
          <div className="title-with-hint">
            <h3>今日与累计 Token 统计</h3>
            <TitleHint
              content={`今日与累计是不同统计口径；${rangeLabel}范围用于模型统计和按日明细。`}
              label="查看今日与累计 Token 统计说明"
            />
          </div>
        </div>
        <div className="key-usage-summary-grid key-usage-token-grid">
          <KeyUsageMetric label="今日请求" value={todayTotals.requests.toLocaleString()} />
          <KeyUsageMetric label="今日输入" value={compact(todayTotals.inputTokens)} />
          <KeyUsageMetric label="今日输出" value={compact(todayTotals.outputTokens)} />
          <KeyUsageMetric label="今日 Tokens" value={compact(todayTotals.totalTokens)} />
          <KeyUsageMetric label="今日缓存创建" value={compact(Number(todayTotals.cacheCreationTokens ?? 0))} />
          <KeyUsageMetric label="今日缓存读取" value={compact(Number(todayTotals.cacheReadTokens ?? 0))} />
          <KeyUsageMetric label="今日费用" value={formatUsd(getKeyUsageActualCost(todayTotals), 4)} />
          <KeyUsageMetric label="RPM / TPM" value={`${formatKeyUsageRate(summary?.rpm)} / ${formatKeyUsageRate(summary?.tpm)}`} />
          <KeyUsageMetric label="累计请求" value={totalStats.requests.toLocaleString()} />
          <KeyUsageMetric label="累计输入" value={compact(totalStats.inputTokens)} />
          <KeyUsageMetric label="累计输出" value={compact(totalStats.outputTokens)} />
          <KeyUsageMetric label="累计 Tokens" value={compact(totalStats.totalTokens)} />
          <KeyUsageMetric label="累计缓存创建" value={compact(Number(totalStats.cacheCreationTokens ?? 0))} />
          <KeyUsageMetric label="累计缓存读取" value={compact(Number(totalStats.cacheReadTokens ?? 0))} />
          <KeyUsageMetric label="累计费用" value={formatUsd(getKeyUsageActualCost(totalStats), 4)} />
          <KeyUsageMetric label="平均耗时" value={formatKeyUsageAverageDuration(summary?.averageDurationMs)} />
        </div>
      </section>

      <section className="key-usage-stat-section">
        <div className="section-card-header compact-header key-usage-table-header">
          <div className="title-with-hint">
            <h3>按日明细</h3>
            <TitleHint
              content={`${rangeLabel}范围内按日聚合，切换时间范围会重新读取当前密钥的用量统计。`}
              label="查看按日明细说明"
            />
          </div>
        </div>
        {loading ? (
          <EmptyState title="正在加载密钥用量" detail="正在读取这个密钥的最近使用明细。" compact />
        ) : error && !summary ? (
          <EmptyState title="密钥用量加载失败" detail={error} compact />
        ) : rows.length > 0 ? (
          <div className="usage-table-wrap key-usage-table-wrap">
            <table className="usage-table key-usage-table">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>请求数</th>
                  <th>输入 Tokens</th>
                  <th>输出 Tokens</th>
                  <th>缓存读取</th>
                  <th>缓存写入</th>
                  <th>总 Tokens</th>
                  <th>实际费用</th>
                  <th>标准费用</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.date}>
                    <td>{row.date}</td>
                    <td>{row.requests.toLocaleString()}</td>
                    <td>{row.inputTokens.toLocaleString()}</td>
                    <td>{row.outputTokens.toLocaleString()}</td>
                    <td>{Number(row.cacheReadTokens ?? 0).toLocaleString()}</td>
                    <td>{Number(row.cacheWriteTokens ?? 0).toLocaleString()}</td>
                    <td>{Number(row.totalTokens ?? 0).toLocaleString()}</td>
                    <td>{formatUsd(getDailyRowActualCost(row), 4)}</td>
                    <td>{formatUsd(Number(row.totalCost ?? 0), 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="这个密钥暂时没有用量记录" detail={`${formatKeyUsageRangeTag(range)}没有可展示的 daily usage。`} compact />
        )}
      </section>
    </Modal>
  );
}

function KeyUsageMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="summary-stat compact-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
