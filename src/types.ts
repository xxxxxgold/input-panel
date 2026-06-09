export type NavKey =
  | "overview"
  | "sites"
  | "accounts"
  | "keys"
  | "usage"
  | "subscriptions"
  | "keyUsage"
  | "profile"
  | "orders"
  | "trends"
  | "alerts"
  | "settings"
  | "systemSettings";

export interface SiteRecord {
  id: string;
  name: string;
  baseUrl: string;
  createdAt: string;
  updatedAt: string;
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

export interface SubscriptionRecord {
  id: string;
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
}

export interface UsageRow {
  id: string;
  apiKeyId?: number | null;
  createdAt: string;
  model: string;
  reasoningEffort?: string | null;
  endpoint?: string | null;
  upstreamEndpoint?: string | null;
  actualCost: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  inputCost?: number | null;
  outputCost?: number | null;
  cacheCreationTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationCost?: number | null;
  cacheReadCost?: number | null;
  totalTokens: number;
  firstTokenMs?: number | null;
  durationMs?: number | null;
  billingMode?: string | null;
  requestType?: string | null;
  stream?: boolean | null;
  billingType?: number | null;
  rateMultiplier?: number | null;
  userAgent?: string | null;
  apiKeyName?: string | null;
  platform?: string | null;
  subscriptionName?: string | null;
  groupName?: string | null;
  subscriptionType?: string | null;
}

export interface UsageHistoryRow extends UsageRow {
  firstSeenAt: string;
  lastSeenAt: string;
  isLatest: boolean;
}

export interface TrendPoint {
  bucket: string;
  actualCost: number;
  totalCost: number;
  requests: number;
  totalTokens: number;
}

export interface PlatformPoint {
  platform: string;
  totalActualCost: number;
  todayActualCost: number;
  totalRequests: number;
  totalTokens: number;
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

export interface PaymentConfigRecord {
  enabled: boolean;
  minAmount: number;
  maxAmount: number;
  dailyLimit: number;
  orderTimeoutMinutes: number;
  maxPendingOrders: number;
  enabledPaymentTypes: string[];
}

export interface OrderRecord {
  id: number;
  status: string;
  amount: number;
  providerInstanceId?: number | null;
  outTradeNo?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  paidAt?: string | null;
  refundedAt?: string | null;
  productName?: string | null;
}

export interface ManagedKeyRecord extends KeyRecord {
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
  ipWhitelist?: string | null;
  ipBlacklist?: string | null;
  quota?: number | null;
  expiresInDays?: number | null;
  status?: string | null;
  rateLimit5h?: number | null;
  rateLimit1d?: number | null;
  rateLimit7d?: number | null;
}

export interface ProfileUpdateInput {
  email?: string;
  username?: string;
  balanceNotifyEnabled?: boolean;
  balanceNotifyThresholdType?: string | null;
  balanceNotifyThreshold?: number | null;
}

export interface AccountSnapshot {
  fetchedAt: string;
  online: boolean;
  siteName: string;
  siteUrl: string;
  accountLabel: string;
  emailMasked?: string | null;
  balance: number;
  currency: string;
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
  };
  usageSummary: UsageSummary;
  recentUsage: UsageRow[];
  requestHistory: UsageHistoryRow[];
  trend: TrendPoint[];
  keys: KeyRecord[];
  subscriptions: SubscriptionRecord[];
  activeSubscription?: SubscriptionRecord | null;
  alerts: SnapshotAlert[];
}

export interface SnapshotAlert {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  detail: string;
  siteId: string;
  accountId: string;
  createdAt: string;
}

export interface AccountRuntime extends AccountRecord {
  site?: SiteRecord;
  snapshot?: AccountSnapshot | null;
  sessionState: "ready" | "missing" | "expired";
  lastError?: string | null;
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
  alerts: SnapshotAlert[];
  platformSeries: PlatformPoint[];
  trend: TrendPoint[];
  generatedAt: string;
}

export interface SiteInput {
  name: string;
  baseUrl: string;
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
  emailMasked?: string | null;
  message?: string;
}

export interface LoginSuccess {
  type: "success";
  account: AccountRuntime;
}

export type LoginFlowResult = LoginSuccess | Login2faChallenge;
