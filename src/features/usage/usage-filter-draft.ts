import type {
  UsageF64Range,
  UsageFilter,
  UsageI64Range,
  UsageTextFilter,
  UsageTextMatchMode
} from "../../types";

export type UsageBooleanDraft = "" | "true" | "false";

export type UsageTextFilterDraft = {
  value: string;
  mode: UsageTextMatchMode;
};

export type UsageRangeDraft = {
  min: string;
  max: string;
};

export type UsageFilterDraft = {
  usageId: UsageTextFilterDraft;
  requestId: UsageTextFilterDraft;
  apiKeyId: string;
  apiKeyName: UsageTextFilterDraft;
  upstreamUserId: string;
  upstreamAccountId: string;
  model: UsageTextFilterDraft;
  platform: UsageTextFilterDraft;
  endpoint: UsageTextFilterDraft;
  upstreamEndpoint: UsageTextFilterDraft;
  groupId: string;
  groupName: UsageTextFilterDraft;
  subscriptionId: string;
  subscriptionName: UsageTextFilterDraft;
  subscriptionType: UsageTextFilterDraft;
  serviceTier: UsageTextFilterDraft;
  reasoningEffort: UsageTextFilterDraft;
  requestType: UsageTextFilterDraft;
  billingType: string;
  billingMode: UsageTextFilterDraft;
  stream: UsageBooleanDraft;
  openaiWsMode: UsageBooleanDraft;
  longContextBillingApplied: UsageBooleanDraft;
  cacheTtlOverridden: UsageBooleanDraft;
  inputTokens: UsageRangeDraft;
  outputTokens: UsageRangeDraft;
  totalTokens: UsageRangeDraft;
  cacheCreationTokens: UsageRangeDraft;
  cacheReadTokens: UsageRangeDraft;
  cacheCreation5mTokens: UsageRangeDraft;
  cacheCreation1hTokens: UsageRangeDraft;
  imageInputTokens: UsageRangeDraft;
  imageOutputTokens: UsageRangeDraft;
  actualCost: UsageRangeDraft;
  totalCost: UsageRangeDraft;
  inputCost: UsageRangeDraft;
  outputCost: UsageRangeDraft;
  cacheCreationCost: UsageRangeDraft;
  cacheReadCost: UsageRangeDraft;
  imageInputCost: UsageRangeDraft;
  imageOutputCost: UsageRangeDraft;
  rateMultiplier: UsageRangeDraft;
  durationMs: UsageRangeDraft;
  firstTokenMs: UsageRangeDraft;
  imageCount: UsageRangeDraft;
  mediaType: UsageTextFilterDraft;
  imageSize: UsageTextFilterDraft;
  imageInputSize: UsageTextFilterDraft;
  imageOutputSize: UsageTextFilterDraft;
  imageSizeSource: UsageTextFilterDraft;
  imageSizeBreakdown: UsageTextFilterDraft;
  ipAddress: UsageTextFilterDraft;
  userAgentQuery: string;
};

function emptyTextFilter(): UsageTextFilterDraft {
  return { value: "", mode: "exact" };
}

function emptyRange(): UsageRangeDraft {
  return { min: "", max: "" };
}

/** 创建互不共享嵌套对象的空筛选草稿。 */
export function createEmptyUsageFilterDraft(): UsageFilterDraft {
  return {
    usageId: emptyTextFilter(),
    requestId: emptyTextFilter(),
    apiKeyId: "",
    apiKeyName: emptyTextFilter(),
    upstreamUserId: "",
    upstreamAccountId: "",
    model: emptyTextFilter(),
    platform: emptyTextFilter(),
    endpoint: emptyTextFilter(),
    upstreamEndpoint: emptyTextFilter(),
    groupId: "",
    groupName: emptyTextFilter(),
    subscriptionId: "",
    subscriptionName: emptyTextFilter(),
    subscriptionType: emptyTextFilter(),
    serviceTier: emptyTextFilter(),
    reasoningEffort: emptyTextFilter(),
    requestType: emptyTextFilter(),
    billingType: "",
    billingMode: emptyTextFilter(),
    stream: "",
    openaiWsMode: "",
    longContextBillingApplied: "",
    cacheTtlOverridden: "",
    inputTokens: emptyRange(),
    outputTokens: emptyRange(),
    totalTokens: emptyRange(),
    cacheCreationTokens: emptyRange(),
    cacheReadTokens: emptyRange(),
    cacheCreation5mTokens: emptyRange(),
    cacheCreation1hTokens: emptyRange(),
    imageInputTokens: emptyRange(),
    imageOutputTokens: emptyRange(),
    actualCost: emptyRange(),
    totalCost: emptyRange(),
    inputCost: emptyRange(),
    outputCost: emptyRange(),
    cacheCreationCost: emptyRange(),
    cacheReadCost: emptyRange(),
    imageInputCost: emptyRange(),
    imageOutputCost: emptyRange(),
    rateMultiplier: emptyRange(),
    durationMs: emptyRange(),
    firstTokenMs: emptyRange(),
    imageCount: emptyRange(),
    mediaType: emptyTextFilter(),
    imageSize: emptyTextFilter(),
    imageInputSize: emptyTextFilter(),
    imageOutputSize: emptyTextFilter(),
    imageSizeSource: emptyTextFilter(),
    imageSizeBreakdown: emptyTextFilter(),
    ipAddress: emptyTextFilter(),
    userAgentQuery: ""
  };
}

/** 校验页面草稿并生成可直接提交给 Rust 的稀疏 UsageFilter。 */
export function buildUsageFilterFromDraft(
  draft: UsageFilterDraft,
  startDate: string,
  endDate: string
): UsageFilter {
  const normalizedStartDate = startDate.trim();
  const normalizedEndDate = endDate.trim();
  if (normalizedStartDate && normalizedEndDate && normalizedStartDate > normalizedEndDate) {
    throw new Error("开始日期不能晚于结束日期。");
  }

  return omitUndefined({
    startDate: normalizedStartDate || undefined,
    endDate: normalizedEndDate || undefined,
    usageId: toTextFilter(draft.usageId),
    requestId: toTextFilter(draft.requestId),
    apiKeyId: toOptionalInteger(draft.apiKeyId, "API Key ID"),
    apiKeyName: toTextFilter(draft.apiKeyName),
    upstreamUserId: toOptionalInteger(draft.upstreamUserId, "上游用户 ID"),
    upstreamAccountId: toOptionalInteger(draft.upstreamAccountId, "上游账号 ID"),
    model: toTextFilter(draft.model),
    platform: toTextFilter(draft.platform),
    endpoint: toTextFilter(draft.endpoint),
    upstreamEndpoint: toTextFilter(draft.upstreamEndpoint),
    groupId: toOptionalInteger(draft.groupId, "分组 ID"),
    groupName: toTextFilter(draft.groupName),
    subscriptionId: toOptionalInteger(draft.subscriptionId, "订阅 ID"),
    subscriptionName: toTextFilter(draft.subscriptionName),
    subscriptionType: toTextFilter(draft.subscriptionType),
    serviceTier: toTextFilter(draft.serviceTier),
    reasoningEffort: toTextFilter(draft.reasoningEffort),
    requestType: toTextFilter(draft.requestType),
    billingType: toOptionalInteger(draft.billingType, "计费类型"),
    billingMode: toTextFilter(draft.billingMode),
    stream: toOptionalBoolean(draft.stream),
    openaiWsMode: toOptionalBoolean(draft.openaiWsMode),
    longContextBillingApplied: toOptionalBoolean(draft.longContextBillingApplied),
    cacheTtlOverridden: toOptionalBoolean(draft.cacheTtlOverridden),
    inputTokens: toIntegerRange(draft.inputTokens, "输入 Token"),
    outputTokens: toIntegerRange(draft.outputTokens, "输出 Token"),
    totalTokens: toIntegerRange(draft.totalTokens, "总 Token"),
    cacheCreationTokens: toIntegerRange(draft.cacheCreationTokens, "缓存写入 Token"),
    cacheReadTokens: toIntegerRange(draft.cacheReadTokens, "缓存读取 Token"),
    cacheCreation5mTokens: toIntegerRange(draft.cacheCreation5mTokens, "5 分钟缓存 Token"),
    cacheCreation1hTokens: toIntegerRange(draft.cacheCreation1hTokens, "1 小时缓存 Token"),
    imageInputTokens: toIntegerRange(draft.imageInputTokens, "图片输入 Token"),
    imageOutputTokens: toIntegerRange(draft.imageOutputTokens, "图片输出 Token"),
    actualCost: toFloatRange(draft.actualCost, "实际成本"),
    totalCost: toFloatRange(draft.totalCost, "标准成本"),
    inputCost: toFloatRange(draft.inputCost, "输入成本"),
    outputCost: toFloatRange(draft.outputCost, "输出成本"),
    cacheCreationCost: toFloatRange(draft.cacheCreationCost, "缓存写入成本"),
    cacheReadCost: toFloatRange(draft.cacheReadCost, "缓存读取成本"),
    imageInputCost: toFloatRange(draft.imageInputCost, "图片输入成本"),
    imageOutputCost: toFloatRange(draft.imageOutputCost, "图片输出成本"),
    rateMultiplier: toFloatRange(draft.rateMultiplier, "倍率"),
    durationMs: toIntegerRange(draft.durationMs, "总耗时"),
    firstTokenMs: toIntegerRange(draft.firstTokenMs, "首 Token 耗时"),
    imageCount: toIntegerRange(draft.imageCount, "图片数量"),
    mediaType: toTextFilter(draft.mediaType),
    imageSize: toTextFilter(draft.imageSize),
    imageInputSize: toTextFilter(draft.imageInputSize),
    imageOutputSize: toTextFilter(draft.imageOutputSize),
    imageSizeSource: toTextFilter(draft.imageSizeSource),
    imageSizeBreakdown: toTextFilter(draft.imageSizeBreakdown),
    ipAddress: toTextFilter(draft.ipAddress),
    userAgentQuery: draft.userAgentQuery.trim() || undefined
  });
}

function toTextFilter(draft: UsageTextFilterDraft): UsageTextFilter | undefined {
  const value = draft.value.trim();
  return value ? { value, mode: draft.mode } : undefined;
}

function toOptionalBoolean(value: UsageBooleanDraft) {
  return value === "" ? undefined : value === "true";
}

function toOptionalInteger(value: string, label: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} 必须是非负整数。`);
  }
  return parsed;
}

function toOptionalFloat(value: string, label: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} 必须是非负有限数字。`);
  }
  return parsed;
}

function toIntegerRange(draft: UsageRangeDraft, label: string): UsageI64Range | undefined {
  const min = toOptionalInteger(draft.min, `${label}下限`);
  const max = toOptionalInteger(draft.max, `${label}上限`);
  return buildRange(min, max, label);
}

function toFloatRange(draft: UsageRangeDraft, label: string): UsageF64Range | undefined {
  const min = toOptionalFloat(draft.min, `${label}下限`);
  const max = toOptionalFloat(draft.max, `${label}上限`);
  return buildRange(min, max, label);
}

function buildRange<T extends number>(min: T | undefined, max: T | undefined, label: string) {
  if (min === undefined && max === undefined) {
    return undefined;
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new Error(`${label}下限不能大于上限。`);
  }
  return omitUndefined({ min, max });
}

function omitUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as { [Key in keyof T as undefined extends T[Key] ? Key : Key]: Exclude<T[Key], undefined> };
}
