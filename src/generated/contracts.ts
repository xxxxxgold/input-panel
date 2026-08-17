export interface SiteRecord {
  id: string;
  name: string;
  baseUrl: string;
  fallbackBaseUrls: string[];
  failoverCooldownSeconds: number;
  maxAttemptsPerAddress: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublicEndpointRecord {
  name: string;
  endpoint: string;
  description: string;
  pingLatencyMs?: number | null;
  pingStatusCode?: number | null;
  pingCheckedAt?: string | null;
  pingError?: string | null;
}

export interface SitePublicEndpointsPayload {
  siteId: string;
  siteName: string;
  apiBaseUrl: string;
  endpoints: PublicEndpointRecord[];
  fetchedAt: string;
  lastError?: string | null;
}

export interface GroupRecord {
  id: number;
  name: string;
  description?: string | null;
  platform: string;
  rateMultiplier: number;
  subscriptionType?: string | null;
  dailyLimitUsd?: number | null;
  weeklyLimitUsd?: number | null;
  monthlyLimitUsd?: number | null;
  allowMessagesDispatch?: boolean;
}

export interface AccountRecord {
  id: string;
  siteId: string;
  label: string;
  email: string;
  balanceWarning: number;
  lastLoginAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionQuotaWindow {
  current: number;
  limit: number;
  windowStart?: string | null;
}

export type SubscriptionIdentityKind = "group" | "upstream" | "fallback";

export interface SubscriptionRecord {
  id: string;
  subscriptionKey: string;
  identityKind: SubscriptionIdentityKind;
  identityAmbiguous: boolean;
  groupId?: number | null;
  name: string;
  status: string;
  groupName?: string | null;
  platform?: string | null;
  expiresAt?: string | null;
  daily?: SubscriptionQuotaWindow | null;
  weekly?: SubscriptionQuotaWindow | null;
  monthly?: SubscriptionQuotaWindow | null;
}

export interface KeyRecord {
  id: string;
  groupId?: number | null;
  name: string;
  status: string;
  platform?: string | null;
  groupName?: string | null;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  quota?: number | null;
  quotaUsed?: number | null;
  rateLimit5h?: number | null;
  rateLimit1d?: number | null;
  rateLimit7d?: number | null;
  usage5h?: number | null;
  usage1d?: number | null;
  usage7d?: number | null;
  currentConcurrency?: number | null;
}

export interface UsageRow {
  id: string;
  upstreamUserId?: number | null;
  apiKeyId?: number | null;
  upstreamAccountId?: number | null;
  requestId?: string | null;
  createdAt: string;
  model: string;
  reasoningEffort?: string | null;
  endpoint?: string | null;
  upstreamEndpoint?: string | null;
  groupId?: number | null;
  subscriptionId?: number | null;
  actualCost: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  inputCost?: number | null;
  outputCost?: number | null;
  cacheCreationTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreation5mTokens?: number | null;
  cacheCreation1hTokens?: number | null;
  cacheCreationCost?: number | null;
  cacheReadCost?: number | null;
  totalTokens: number;
  firstTokenMs?: number | null;
  durationMs?: number | null;
  billingMode?: string | null;
  requestType?: string | null;
  stream?: boolean | null;
  openaiWsMode?: boolean | null;
  billingType?: number | null;
  serviceTier?: string | null;
  longContextBillingApplied?: boolean | null;
  imageCount?: number | null;
  imageInputTokens?: number | null;
  imageSize?: string | null;
  imageInputSize?: string | null;
  imageOutputSize?: string | null;
  imageOutputTokens?: number | null;
  imageInputCost?: number | null;
  imageOutputCost?: number | null;
  imageSizeSource?: string | null;
  imageSizeBreakdown?: string | null;
  mediaType?: string | null;
  rateMultiplier?: number | null;
  userAgent?: string | null;
  ipAddress?: string | null;
  cacheTtlOverridden?: boolean | null;
  apiKeyName?: string | null;
  platform?: string | null;
  subscriptionName?: string | null;
  groupName?: string | null;
  subscriptionType?: string | null;
}

export type UsageTextMatchMode = "exact" | "prefix";

export interface UsageTextFilter {
  value: string;
  mode?: UsageTextMatchMode;
}

export interface UsageI64Range {
  min?: number | null;
  max?: number | null;
}

export interface UsageF64Range {
  min?: number | null;
  max?: number | null;
}

export interface UsageFilter {
  startDate?: string | null;
  endDate?: string | null;
  usageId?: UsageTextFilter | null;
  requestId?: UsageTextFilter | null;
  apiKeyId?: number | null;
  apiKeyName?: UsageTextFilter | null;
  upstreamUserId?: number | null;
  upstreamAccountId?: number | null;
  model?: UsageTextFilter | null;
  platform?: UsageTextFilter | null;
  endpoint?: UsageTextFilter | null;
  upstreamEndpoint?: UsageTextFilter | null;
  groupId?: number | null;
  groupName?: UsageTextFilter | null;
  subscriptionId?: number | null;
  subscriptionName?: UsageTextFilter | null;
  subscriptionType?: UsageTextFilter | null;
  serviceTier?: UsageTextFilter | null;
  reasoningEffort?: UsageTextFilter | null;
  requestType?: UsageTextFilter | null;
  billingType?: number | null;
  billingMode?: UsageTextFilter | null;
  stream?: boolean | null;
  openaiWsMode?: boolean | null;
  longContextBillingApplied?: boolean | null;
  cacheTtlOverridden?: boolean | null;
  inputTokens?: UsageI64Range;
  outputTokens?: UsageI64Range;
  totalTokens?: UsageI64Range;
  cacheCreationTokens?: UsageI64Range;
  cacheReadTokens?: UsageI64Range;
  cacheCreation5mTokens?: UsageI64Range;
  cacheCreation1hTokens?: UsageI64Range;
  imageInputTokens?: UsageI64Range;
  imageOutputTokens?: UsageI64Range;
  actualCost?: UsageF64Range;
  totalCost?: UsageF64Range;
  inputCost?: UsageF64Range;
  outputCost?: UsageF64Range;
  cacheCreationCost?: UsageF64Range;
  cacheReadCost?: UsageF64Range;
  imageInputCost?: UsageF64Range;
  imageOutputCost?: UsageF64Range;
  rateMultiplier?: UsageF64Range;
  durationMs?: UsageI64Range;
  firstTokenMs?: UsageI64Range;
  imageCount?: UsageI64Range;
  mediaType?: UsageTextFilter | null;
  imageSize?: UsageTextFilter | null;
  imageInputSize?: UsageTextFilter | null;
  imageOutputSize?: UsageTextFilter | null;
  imageSizeSource?: UsageTextFilter | null;
  imageSizeBreakdown?: UsageTextFilter | null;
  ipAddress?: UsageTextFilter | null;
  userAgentQuery?: string | null;
}

export type UsageCursorDirection = "next" | "previous";

export interface UsageListRequest {
  filter: UsageFilter;
  pageSize: number;
  cursor?: string | null;
  direction: UsageCursorDirection;
}

export interface UsageCursorPage<T> {
  items: T[];
  pageSize: number;
  nextCursor?: string | null;
  previousCursor?: string | null;
  hasNext: boolean;
  hasPrevious: boolean;
  total?: number | null;
}

export type UsageFacetField =
  | "apiKey"
  | "model"
  | "platform"
  | "endpoint"
  | "upstreamEndpoint"
  | "group"
  | "subscription"
  | "subscriptionType"
  | "serviceTier"
  | "reasoningEffort"
  | "requestType"
  | "billingType"
  | "billingMode"
  | "mediaType"
  | "imageSize"
  | "imageInputSize"
  | "imageOutputSize"
  | "imageSizeSource"
  | "imageSizeBreakdown";

export interface UsageFacetRequest {
  filter: UsageFilter;
  field: UsageFacetField;
  search?: string | null;
  limit: number;
}

export interface UsageFacetItem {
  value: string;
  label: string;
  count: number;
}

export interface UsageFacetPage {
  field: UsageFacetField;
  items: UsageFacetItem[];
  hasMore: boolean;
}

export interface TrendPoint {
  bucket: string;
  actualCost: number;
  totalCost: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export interface PlatformPoint {
  platform: string;
  totalActualCost: number;
  todayActualCost: number;
  totalRequests: number;
  totalTokens: number;
}

export interface OverviewModelPoint {
  model: string;
  requests: number;
  totalTokens: number;
  actualCost: number;
  totalCost: number;
}

export interface UsageSummary {
  totalRequests: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalActualCost: number;
  totalCost: number;
  averageDurationMs: number;
}

export interface PaginatedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  pages: number;
}

export interface UsageStatsRecord {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheTokens?: number | null;
  totalCacheCreationTokens?: number | null;
  totalCacheReadTokens?: number | null;
  totalTokens: number;
  totalCost: number;
  totalActualCost: number;
  averageDurationMs: number;
  rpm?: number | null;
  tpm?: number | null;
}

export interface UsageExtremesPayload {
  longestFirstToken?: UsageRow | null;
  highestActualCost?: UsageRow | null;
  highestInputTokens?: UsageRow | null;
  highestOutputTokens?: UsageRow | null;
}

export interface OverviewDashboardStatsPayload {
  todayStats: UsageStatsRecord;
  totalStats: UsageStatsRecord;
  totalApiKeys: number;
  activeApiKeys: number;
  platformSeries: PlatformPoint[];
}

export interface DailyUsagePoint {
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  totalTokens?: number | null;
  actualCost?: number | null;
  totalCost?: number | null;
}

export interface ModelUsagePoint {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number | null;
  cacheReadTokens?: number | null;
  totalTokens: number;
  cost?: number | null;
  actualCost?: number | null;
}

export interface KeyUsageTokenStats {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number | null;
  cacheReadTokens?: number | null;
  totalTokens: number;
  cost?: number | null;
  actualCost?: number | null;
}

export interface KeyUsageSubscriptionSnapshot {
  dailyLimitUsd?: number | null;
  dailyUsageUsd?: number | null;
  weeklyLimitUsd?: number | null;
  weeklyUsageUsd?: number | null;
  monthlyLimitUsd?: number | null;
  monthlyUsageUsd?: number | null;
  expiresAt?: string | null;
}

export interface KeyUsageSummaryPayload {
  dailyUsage: DailyUsagePoint[];
  today: KeyUsageTokenStats;
  total: KeyUsageTokenStats;
  averageDurationMs?: number | null;
  rpm?: number | null;
  tpm?: number | null;
  planName?: string | null;
  remaining?: number | null;
  subscription?: KeyUsageSubscriptionSnapshot | null;
  modelStats: ModelUsagePoint[];
}

export interface UsageTrendPayload {
  startDate: string;
  endDate: string;
  granularity?: string | null;
  trend: DailyUsagePoint[];
}

export interface DashboardModelsPayload {
  startDate: string;
  endDate: string;
  models: ModelUsagePoint[];
}

export interface UsageInsightPoint {
  name: string;
  requests: number;
  totalTokens: number;
  actualCost: number;
  totalCost: number;
}

export interface UsageInsightsPayload {
  startDate: string;
  endDate: string;
  totalRequests: number;
  groups: UsageInsightPoint[];
  endpoints: UsageInsightPoint[];
}

export interface UsageAnalyticsAggregatePoint {
  key: string;
  label: string;
  isOther: boolean;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  actualCost: number;
  averageFirstTokenMs: number;
  averageDurationMs: number;
  averageRateMultiplier: number;
}

export interface UsageAnalyticsHeatmapPoint {
  weekday: number;
  hour: number;
  requests: number;
  actualCost: number;
}

export interface UsageAnalyticsFlowPoint {
  key: string;
  label: string;
  isOther: boolean;
  source: string;
  target: string;
  requests: number;
  actualCost: number;
}

export interface UsageAnalyticsCostPoint {
  key: string;
  label: string;
  value: number;
}

export interface UsageAnalyticsPercentilePoint {
  p50: number;
  p90: number;
  p99: number;
}

export interface UsageAnalyticsLatencyPercentiles {
  firstToken?: UsageAnalyticsPercentilePoint | null;
  duration?: UsageAnalyticsPercentilePoint | null;
}

export interface UsageAnalyticsPayload {
  version: number;
  startDate: string;
  endDate: string;
  generatedAt: string;
  matchedRows: number;
  topN: number;
  totals: UsageStatsRecord;
  trend: DailyUsagePoint[];
  models: UsageAnalyticsAggregatePoint[];
  platforms: UsageAnalyticsAggregatePoint[];
  endpoints: UsageAnalyticsAggregatePoint[];
  apiKeys: UsageAnalyticsAggregatePoint[];
  groups: UsageAnalyticsAggregatePoint[];
  subscriptions: UsageAnalyticsAggregatePoint[];
  reasoningEfforts: UsageAnalyticsAggregatePoint[];
  requestTypes: UsageAnalyticsAggregatePoint[];
  reasoningRequestCombinations: UsageAnalyticsAggregatePoint[];
  userAgents: UsageAnalyticsAggregatePoint[];
  hourlyHeatmap: UsageAnalyticsHeatmapPoint[];
  endpointFlows: UsageAnalyticsFlowPoint[];
  costBreakdown: UsageAnalyticsCostPoint[];
  latencyPercentiles: UsageAnalyticsLatencyPercentiles;
  extremes: UsageRow[];
  sampleRows: UsageRow[];
}

export interface ApiKeyUsageStatsRecord {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  actualCost: number;
}

export interface SubscriptionKeyUsageItem {
  keyId: string;
  apiKeyId?: number | null;
  rawKeyAvailable: boolean;
  keyName: string;
  status: string;
  platform?: string | null;
  groupName?: string | null;
  planName?: string | null;
  quotaMode?: string | null;
  quotaRemaining?: number | null;
  quotaLimit?: number | null;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  actualCost: number;
}

export interface SubscriptionKeyUsagePayload {
  items: SubscriptionKeyUsageItem[];
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalActualCost: number;
  activeKeyCount: number;
  inactiveKeyCount: number;
}

export interface ManagedKeyRecord extends KeyRecord {
  apiKeyId?: number | null;
  rawKey?: string | null;
  userId?: number | null;
  ipWhitelist?: string | null;
  ipBlacklist?: string | null;
  window5hStart?: string | null;
  window1dStart?: string | null;
  window7dStart?: string | null;
}

export interface AccountUsageStatsRecord {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  totalActualCost: number;
  averageDurationMs: number;
  rpm?: number | null;
  tpm?: number | null;
}

export interface SubscriptionSummaryRecord {
  id: number;
  groupId: number;
  groupName: string;
  status: string;
  dailyUsedUsd: number;
  dailyLimitUsd: number;
  weeklyUsedUsd: number;
  monthlyUsedUsd: number;
  expiresAt?: string | null;
}

export interface SubscriptionSummaryPayload {
  activeCount: number;
  totalUsedUsd: number;
  subscriptions: SubscriptionSummaryRecord[];
}

export type SubscriptionQuotaAlertThresholdMode = "amount_usd" | "usage_percent";

export interface SubscriptionQuotaAlertRule {
  enabled: boolean;
  thresholdMode: SubscriptionQuotaAlertThresholdMode;
  thresholdValue: number;
  revision: number;
}

export interface SubscriptionQuotaAlertConfig {
  subscriptionKey: string;
  rule: SubscriptionQuotaAlertRule;
}

export interface SubscriptionQuotaAlertSettingsPayload {
  defaultRule: SubscriptionQuotaAlertRule;
  overrides: SubscriptionQuotaAlertConfig[];
}

export interface SubscriptionQuotaAlertUpsertInput {
  subscriptionKey: string;
  enabled: boolean;
  thresholdMode: SubscriptionQuotaAlertThresholdMode;
  thresholdValue: number;
}

export type SubscriptionQuotaAlertWindowKind = "daily" | "weekly" | "monthly";

export interface SubscriptionQuotaAlertTriggeredWindow {
  kind: SubscriptionQuotaAlertWindowKind;
  current: number;
  limit?: number | null;
  windowStart?: string | null;
  usagePercent?: number | null;
}

export interface SubscriptionQuotaAlertEventPayload {
  id: string;
  dedupeKey: string;
  accountId: string;
  subscriptionKey: string;
  subscriptionName: string;
  thresholdMode: SubscriptionQuotaAlertThresholdMode;
  thresholdValue: number;
  configRevision: number;
  triggeredWindows: SubscriptionQuotaAlertTriggeredWindow[];
  createdAt: string;
}

export type SubscriptionSwitchTriggerReason =
  | "balance_low"
  | "source_subscription_amount_threshold_reached"
  | "source_subscription_percent_threshold_reached"
  | "source_subscription_unavailable"
  | "source_subscription_quota_exhausted"
  | "candidate_subscription_unavailable"
  | "candidate_subscription_quota_exhausted"
  | "candidate_subscription_amount_threshold_reached"
  | "candidate_subscription_percent_threshold_reached"
  | "strict_priority_reconciled"
  | "restored";

export type SubscriptionSwitchRuntimeState = "idle" | "switched" | "failed";

export type SubscriptionSwitchThresholdMode = "amount_usd" | "usage_percent";

export interface SubscriptionSwitchChainNode {
  groupId: number;
  thresholdMode: SubscriptionSwitchThresholdMode;
  thresholdValue: number;
}

export interface SubscriptionSwitchRuleRecord {
  accountId: string;
  keyId: string;
  sourceGroupId: number;
  enabled: boolean;
  chainNodes: SubscriptionSwitchChainNode[];
  autoRestore: boolean;
  strictMode: boolean;
  runtimeState: SubscriptionSwitchRuntimeState;
  activeTargetGroupId?: number | null;
  lastTriggerReason?: SubscriptionSwitchTriggerReason | null;
  lastSwitchedAt?: string | null;
  lastRestoredAt?: string | null;
  lastError?: string | null;
  updatedAt: string;
}

export interface SubscriptionSwitchRuleUpsertInput {
  enabled: boolean;
  sourceGroupId: number;
  chainNodes: SubscriptionSwitchChainNode[];
  autoRestore: boolean;
  strictMode: boolean;
}

export interface SubscriptionSwitchEvaluationResult {
  accountId: string;
  keyId: string;
  sourceGroupId: number;
  runtimeState: SubscriptionSwitchRuntimeState;
  activeTargetGroupId?: number | null;
  lastTriggerReason?: SubscriptionSwitchTriggerReason | null;
  lastError?: string | null;
}

export interface UserIdentityBinding {
  provider: string;
  bound: boolean;
  boundCount: number;
  displayName?: string | null;
  subjectHint?: string | null;
  providerKey?: string | null;
  verifiedAt?: string | null;
  canBind: boolean;
  canUnbind: boolean;
  note?: string | null;
  noteKey?: string | null;
}

export interface UserProfileRecord {
  id: number;
  email: string;
  username?: string | null;
  avatarUrl?: string | null;
  role: string;
  balance: number;
  concurrency: number;
  status: string;
  lastActiveAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  totalRecharged?: number | null;
  rpmLimit?: number | null;
  balanceNotifyEnabled?: boolean;
  balanceNotifyThresholdType?: string | null;
  balanceNotifyThreshold?: number | null;
  balanceNotifyExtraEmails?: string[] | null;
  identities: Record<string, UserIdentityBinding>;
  authBindings: Record<string, UserIdentityBinding>;
  identityBindings: Record<string, UserIdentityBinding>;
}

export interface PlatformQuotaRecord {
  platform?: string | null;
  quota?: number | null;
  used?: number | null;
  remaining?: number | null;
  [key: string]: unknown;
}

export interface PlatformQuotaPayload {
  platformQuotas: PlatformQuotaRecord[];
}

export interface KeyMutationInput {
  name: string;
  groupId?: number | null;
  customKey?: string | null;
  ipWhitelist?: string[] | null;
  ipBlacklist?: string[] | null;
  quota?: number | null;
  expiresInDays?: number | null;
  status?: string | null;
  rateLimit5h?: number | null;
  rateLimit1d?: number | null;
  rateLimit7d?: number | null;
  resetQuota?: boolean;
  resetRateLimitUsage?: boolean;
}

export interface KeyPatchInput {
  name?: string | null;
  groupId?: number | null;
  customKey?: string | null;
  ipWhitelist?: string[] | null;
  ipBlacklist?: string[] | null;
  quota?: number | null;
  expiresInDays?: number | null;
  status?: string | null;
  rateLimit5h?: number | null;
  rateLimit1d?: number | null;
  rateLimit7d?: number | null;
  resetQuota?: boolean;
  resetRateLimitUsage?: boolean;
}

export interface ProfileUpdateInput {
  email?: string;
  username?: string;
  balanceNotifyEnabled?: boolean;
  balanceNotifyThresholdType?: string | null;
  balanceNotifyThreshold?: number | null;
}

export interface EmailIdentityBindInput {
  email: string;
  verifyCode: string;
  password: string;
}

export interface AccountCacheView {
  fetchedAt: string;
  online: boolean;
  siteName: string;
  balance: number;
  stats: {
    totalApiKeys: number;
    activeApiKeys: number;
    todayRequests: number;
    totalRequests: number;
    todayActualCost: number;
    totalActualCost: number;
    todayCost: number;
    totalCost: number;
    todayTokens: number;
    totalTokens: number;
    todayInputTokens: number;
    todayOutputTokens: number;
    averageDurationMs: number;
    byPlatform: PlatformPoint[];
    byModel?: OverviewModelPoint[];
  };
  recentUsage: UsageRow[];
  trend: TrendPoint[];
  keys: KeyRecord[];
  subscriptions: SubscriptionRecord[];
  activeSubscription?: SubscriptionRecord | null;
  alerts: AccountAlert[];
}

export interface AccountAlert {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  detail: string;
  siteId: string;
  accountId: string;
  createdAt: string;
}

export interface AccountRuntime extends AccountRecord {
  site?: SiteRecord | null;
  cacheView?: AccountCacheView | null;
  sessionState: "ready" | "missing" | "expired";
  lastError?: string | null;
}

export type RefreshTriggerSource = "manual" | "stale_auto";

export type DataSyncTrigger = "manual" | "stale_auto" | "post_write" | "bootstrap" | "auto";

export type DataSyncScope = "core" | "subscriptions" | "keys" | "usage" | "full";

export type AccountSyncState = "idle" | "running" | "succeeded" | "failed";

export type AccountSyncProgressStageId = "core" | "subscriptions" | "keys" | "usage" | "subscription_rules";

export type AccountSyncProgressStageState = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export type AccountSyncProgressPhase = "history_discovery" | "history_window" | "recent_window" | "latest_incremental";

export type AccountSyncProgressUnit = "records" | "pages" | "days";

export type AccountSyncWaitKind = "rate_limited" | "request_budget" | "peer_runtime";

export interface AccountSyncProgressWait {
  kind: AccountSyncWaitKind;
  retryAttempt?: number | null;
  maxAttempts?: number | null;
  waitMs?: number | null;
  resumeAt?: string | null;
}

export interface AccountSyncProgressDetail {
  phase?: AccountSyncProgressPhase | null;
  processed?: number | null;
  total?: number | null;
  unit?: AccountSyncProgressUnit | null;
  currentDate?: string | null;
  attempt?: number | null;
  wait?: AccountSyncProgressWait | null;
}

export interface AccountSyncProgressStage {
  id: AccountSyncProgressStageId;
  state: AccountSyncProgressStageState;
  detail?: AccountSyncProgressDetail | null;
}

export interface AccountSyncProgress {
  stages: AccountSyncProgressStage[];
}

export type TaskRunStatus = "running" | "succeeded" | "failed";

export type SyncFailureCategory =
  | "unauthorized"
  | "rate_limited"
  | "http"
  | "timeout"
  | "transport"
  | "decode"
  | "business"
  | "internal";

export interface SyncFailurePayload {
  category: SyncFailureCategory;
  message: string;
  code?: string | null;
  httpStatus?: number | null;
  retryAt?: string | null;
  retryAfterMs?: number | null;
  retryExhausted: boolean;
}

export interface SyncFailureResponse {
  error: string;
  failure: SyncFailurePayload;
}

export interface TaskRunRecord {
  id: string;
  accountId: string;
  scope: DataSyncScope;
  primaryTriggerSource: DataSyncTrigger;
  status: TaskRunStatus;
  joinCount: number;
  startedAt: string;
  finishedAt?: string | null;
  errorMessage?: string | null;
}

export interface RefreshAccountTaskResponse {
  account: AccountRuntime;
  run: TaskRunRecord;
}

export interface AccountSyncStatusRecord {
  accountId: string;
  scope: DataSyncScope;
  state: AccountSyncState;
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
  lastError?: string | null;
  itemCount: number;
  runId?: string | null;
  finishedAt?: string | null;
  failure?: SyncFailurePayload | null;
  recoveredAt?: string | null;
  progress?: AccountSyncProgress | null;
}

export interface AccountSyncStatusPayload {
  accountId: string;
  statuses: AccountSyncStatusRecord[];
}

export interface SyncAccountDataInput {
  scope: DataSyncScope;
  triggerSource: DataSyncTrigger;
}

export interface OverviewUsageRow extends UsageRow {
  accountId: string;
  accountLabel: string;
  siteId: string;
  siteName: string;
}

export interface OverviewSubscriptionRecord extends SubscriptionRecord {
  accountId: string;
  accountLabel: string;
  siteId: string;
  siteName: string;
}

export interface OverviewKeyRecord extends KeyRecord {
  accountId: string;
  accountLabel: string;
  siteId: string;
  siteName: string;
}

export interface OverviewPayload {
  sites: SiteRecord[];
  accounts: AccountRuntime[];
  totals: {
    balance: number;
    totalSites: number;
    totalAccounts: number;
    totalApiKeys: number;
    activeApiKeys: number;
    todayRequests: number;
    totalRequests: number;
    todayActualCost: number;
    totalActualCost: number;
    todayTokens: number;
    totalTokens: number;
  };
  alerts: AccountAlert[];
  platformSeries: PlatformPoint[];
  modelSeries?: OverviewModelPoint[];
  trend: TrendPoint[];
  recentUsage: OverviewUsageRow[];
  subscriptions: OverviewSubscriptionRecord[];
  keys: OverviewKeyRecord[];
  generatedAt: string;
}

export interface SiteInput {
  name: string;
  baseUrl: string;
  fallbackBaseUrls: string[];
  failoverCooldownSeconds: number;
  maxAttemptsPerAddress: number;
}

export interface SitePatchInput {
  name?: string | null;
  baseUrl?: string | null;
  fallbackBaseUrls?: string[] | null;
  failoverCooldownSeconds?: number | null;
  maxAttemptsPerAddress?: number | null;
}

export type SiteFailoverAddressKind = "primary" | "fallback";

export type SiteFailoverAddressStatusKind = "active" | "pending" | "cooling";

export interface SiteFailoverAddressStatus {
  baseUrl: string;
  kind: SiteFailoverAddressKind;
  status: SiteFailoverAddressStatusKind;
  cooldownUntil?: string | null;
  cooldownRemainingSeconds?: number | null;
}

export interface SiteFailoverStatusPayload {
  siteId: string;
  activeBaseUrl?: string | null;
  evaluationRevision: number;
  transitionRevision: number;
  serverNow: string;
  addresses: SiteFailoverAddressStatus[];
}

export interface SiteEndpointTestInput {
  baseUrl: string;
}

export interface SiteEndpointTestResult {
  baseUrl: string;
  ok: boolean;
  latencyMs?: number | null;
  checkedAt: string;
  message?: string | null;
}

export interface SiteCooldownClearInput {
  baseUrl: string;
}

export type SiteFailoverTransitionKind = "switchedToFallback" | "primaryRestored";

export interface SiteFailoverTransitionEvent {
  revision: number;
  siteId: string;
  siteName: string;
  fromBaseUrl: string;
  toBaseUrl: string;
  kind: SiteFailoverTransitionKind;
  occurredAt: string;
}

export interface SiteFailoverTransitionBatch {
  latestRevision: number;
  resetRequired: boolean;
  events: SiteFailoverTransitionEvent[];
}

export interface TransportErrorPayload {
  error: string;
  code: string;
  httpStatus?: number | null;
  retryAt?: string | null;
  retryAfterMs?: number | null;
}

export interface AccountInput {
  siteId: string;
  label: string;
  email: string;
  balanceWarning: number;
}

export interface Login2faChallenge {
  type: "2fa";
  tempToken: string;
  originBaseUrl: string;
  emailMasked?: string | null;
  message?: string;
}

export interface LoginSuccess {
  type: "success";
  account: AccountRuntime;
}

export type LoginFlowResult = LoginSuccess | Login2faChallenge;

export type AppLaunchMode = "main" | "floating";

export type CloseBehavior = "ask" | "switch_to_floating" | "exit_app";

export type FloatingNotificationDensity = "compact" | "standard" | "relaxed";

export type FloatingNotificationSoundSource = "default" | "custom" | "system" | "muted";

export interface DesktopUiPrefs {
  version: number;
  launchMode: AppLaunchMode;
  openFloatingInMainMode: boolean;
  keepFloatingPanelVisible: boolean;
  floatingPanelOpacity: number;
  floatingNotificationDurationMs: number;
  floatingNotificationDensity: FloatingNotificationDensity;
  floatingNotificationMaxVisible: number;
  floatingNotificationSoundSource: FloatingNotificationSoundSource;
  floatingNotificationSoundFileName?: string | null;
  floatingNotificationSoundStorageKey?: string | null;
  floatingNotificationSoundVolume: number;
  closeBehavior: CloseBehavior;
  autoRefreshEnabled: boolean;
  autoRefreshIntervalSeconds: number;
  autoRefreshServiceStatusEnabled: boolean;
  autoRefreshCoreEnabled: boolean;
  autoRefreshCoreIntervalSeconds: number;
  autoRefreshKeysEnabled: boolean;
  autoRefreshKeysIntervalSeconds: number;
  autoRefreshUsageEnabled: boolean;
  autoRefreshUsageIntervalSeconds: number;
  overviewAccountRuntimeTimeoutMs: number;
  theme: "titan-noir" | "arctic-relay" | "ember-circuit" | "verdant-core" | "sakura-signal" | string;
}

export interface DesktopUiPrefsPatch {
  launchMode?: AppLaunchMode;
  openFloatingInMainMode?: boolean;
  keepFloatingPanelVisible?: boolean;
  floatingPanelOpacity?: number;
  floatingNotificationDurationMs?: number;
  floatingNotificationDensity?: FloatingNotificationDensity;
  floatingNotificationMaxVisible?: number;
  floatingNotificationSoundVolume?: number;
  closeBehavior?: CloseBehavior;
  autoRefreshEnabled?: boolean;
  autoRefreshIntervalSeconds?: number;
  autoRefreshServiceStatusEnabled?: boolean;
  autoRefreshCoreEnabled?: boolean;
  autoRefreshCoreIntervalSeconds?: number;
  autoRefreshKeysEnabled?: boolean;
  autoRefreshKeysIntervalSeconds?: number;
  autoRefreshUsageEnabled?: boolean;
  autoRefreshUsageIntervalSeconds?: number;
  overviewAccountRuntimeTimeoutMs?: number;
  theme?: "titan-noir" | "arctic-relay" | "ember-circuit" | "verdant-core" | "sakura-signal" | string;
}

export interface OpenMainWindowPayload {
  nav?: string | null;
}

export interface ServiceStatusProbeRecord {
  ts: number;
  ok: boolean;
  latencyMs?: number | null;
  error?: string | null;
}

export interface ServiceStatusServiceRecord {
  model: string;
  uptimePct: number;
  last?: ServiceStatusProbeRecord | null;
  history: ServiceStatusProbeRecord[];
}

export interface ServiceStatusPayload {
  allOk: boolean;
  generatedAt: number;
  services: ServiceStatusServiceRecord[];
}

export type ServiceStatusMonitorNotificationKind =
  | "modelDown"
  | "modelRecovered"
  | "monitorUnavailable"
  | "monitorRecovered";

export type ServiceStatusMonitorNotificationSeverity = "critical" | "success";

export interface ServiceStatusMonitorSnapshotEvent {
  status: ServiceStatusPayload;
  syncedAtEpochMs: number;
}

export interface ServiceStatusMonitorNotificationEvent {
  id: string;
  kind: ServiceStatusMonitorNotificationKind;
  severity: ServiceStatusMonitorNotificationSeverity;
  title: string;
  detail: string;
  createdAt: string;
  dedupeKey: string;
  models: string[];
}

export interface CodexRadarModelIqEntry {
  id: string;
  label: string;
  model: string;
  reasoningEffort: string;
  score: number;
  passed: number;
  averageCostUsd: number;
  status?: string | null;
  observedAt: string;
}

export interface CodexRadarModelIqPayload {
  items: CodexRadarModelIqEntry[];
  sourceUpdatedAt: string;
  fetchedAt: string;
  lastError?: string | null;
  isStale: boolean;
}

export interface CodexRadarIntelligenceEfficiencyPoint {
  id: string;
  label: string;
  model: string;
  reasoningEffort: string;
  score: number;
  passed: number;
  validTasks: number;
  averageCostUsd?: number | null;
  averageMinutes?: number | null;
  combinedCostIndex?: number | null;
  totalRuns: number;
  observedAt: string;
}

export interface CodexRadarIntelligenceHistoryPoint {
  observedAt: string;
  score: number;
  passed: number;
  tasks?: number | null;
  totalTokens?: number | null;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  wallSeconds?: number | null;
  averageCostUsd?: number | null;
  averageTaskSeconds?: number | null;
}

export interface CodexRadarIntelligenceDetailItem {
  id: string;
  label: string;
  model: string;
  reasoningEffort: string;
  score: number;
  status: string;
  passed: number;
  tasks?: number | null;
  validTasks?: number | null;
  averageCostUsd?: number | null;
  totalTokens?: number | null;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  wallSeconds?: number | null;
  averageTaskSeconds?: number | null;
  observedAt: string;
  history: CodexRadarIntelligenceHistoryPoint[];
}

export interface CodexRadarIntelligencePayload {
  efficiencyPoints: CodexRadarIntelligenceEfficiencyPoint[];
  detailItems: CodexRadarIntelligenceDetailItem[];
  sourceUpdatedAt: string;
  fetchedAt: string;
  lastError?: string | null;
  isStale: boolean;
}

export interface CodexRadarFastRadarSummary {
  costMultiplier: number;
  e2eMultiplier: number;
  ttftDeltaSeconds: number;
  tpsMultiplier: number;
}

export interface CodexRadarFastRadarItem {
  model: string;
  standardE2eSeconds: number;
  fastE2eSeconds: number;
  e2eMultiplier: number;
  standardTtftSeconds: number;
  fastTtftSeconds: number;
  ttftChangeLabel: string;
  standardTps: number;
  fastTps: number;
  tpsMultiplier: number;
}

export interface CodexRadarFastRadarPayload {
  summary: CodexRadarFastRadarSummary;
  items: CodexRadarFastRadarItem[];
  sourceUpdatedAt: string;
  fetchedAt: string;
  lastError?: string | null;
  isStale: boolean;
}

export interface CodexRadarInsightsTrendPoint {
  observedAt: string;
  score: number;
  samples?: number | null;
}

export interface CodexRadarRecommendationItem {
  id: string;
  model: string;
  reasoningEffort: string;
  score: number;
  averageCostUsd?: number | null;
  averageMinutes?: number | null;
  slot?: string | null;
  trend: CodexRadarInsightsTrendPoint[];
}

export interface CodexRadarRecommendationGroup {
  key: string;
  title: string;
  rule: string;
  items: CodexRadarRecommendationItem[];
}

export interface CodexRadarDegradationAlert {
  id: string;
  model: string;
  reasoningEffort: string;
  score: number;
  average24hScore?: number | null;
  average48hScore?: number | null;
  drop12h?: number | null;
  dropFrom24hAverage?: number | null;
  dropFrom48hAverage?: number | null;
  severityScore?: number | null;
  trend: CodexRadarInsightsTrendPoint[];
}

export interface CodexRadarInsightsPayload {
  recommendations: CodexRadarRecommendationGroup[];
  degradationRule: string;
  degradationAlerts: CodexRadarDegradationAlert[];
  sourceUpdatedAt: string;
  fetchedAt: string;
  lastError?: string | null;
  isStale: boolean;
}


export interface SchedulerConfigPayload {
  enabled: boolean;
  intervalSeconds: number;
  subscriptionIntervalSeconds?: number | null;
}

export interface RuntimeCoordinationConfigPayload {
  siteRequestsPerSecond: number;
  siteMaxInFlight: number;
  usagePageMaxInFlight: number;
}

export interface UpstreamNetworkConfigPayload {
  useSystemProxy: boolean;
}

export interface DatabaseStorageStatus {
  runtimeScope: string;
  currentDatabasePath: string;
  currentDirectory: string;
  userDirectory: string;
  programDirectory: string;
  targetDirectory: string;
  overrideActive: boolean;
  migrationSupported: boolean;
  migrationPhase: string;
  restartRequired: boolean;
  lastError?: string | null;
}

export interface DatabaseStorageMigrationInput {
  targetDirectory: string;
}

export interface DatabaseStorageMigrationResult {
  sourcePath: string;
  targetPath: string;
  sourceRetained: boolean;
  bootstrapUpdated: boolean;
  restartRequired: boolean;
}
