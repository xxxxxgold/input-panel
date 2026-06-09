import {
  AlertTriangle,
  BadgeDollarSign,
  Bell,
  CalendarDays,
  ChartColumn,
  ChevronDown,
  ChevronRight,
  Crown,
  KeyRound,
  LayoutDashboard,
  LoaderCircle,
  MonitorDot,
  Plus,
  RefreshCcw,
  Server,
  Settings2,
  ShieldAlert,
  UserRound
} from "lucide-react";
import { startTransition, useDeferredValue, useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import {
  changeProfilePassword,
  completeAccount2fa,
  createAccount,
  createManagedKey,
  createSite,
  deleteManagedKey,
  getApiKeyDailyUsage,
  getAvailableGroups,
  getDashboardModels,
  getDashboardTrend,
  getOverview,
  getPlatformQuotas,
  getProfileRecord,
  getSubscriptionSummary,
  getUsageStats,
  getManagedKey,
  listManagedKeys,
  listUsageRecords,
  loginAccount,
  refreshAccount,
  refreshAllAccounts,
  removeAccount,
  removeSite,
  sendEmailBindingCode,
  sendNotifyEmailCode,
  toggleNotifyEmail,
  unbindAuthIdentity,
  updateManagedKey,
  updateAccount,
  updateProfileRecord,
  verifyNotifyEmail,
  updateSite
} from "./api";
import projectLogo from "./assets/project-logo.webp";
import { useMonitorStore } from "./store/monitor-store";
import type {
  AccountInput,
  AccountRuntime,
  DailyUsagePoint,
  DashboardModelsPayload,
  GroupRecord,
  KeyRecord,
  KeyMutationInput,
  ManagedKeyRecord,
  NavKey,
  OverviewPayload,
  PaginatedResult,
  PlatformQuotaPayload,
  ProfileUpdateInput,
  SiteInput,
  SiteRecord,
  SubscriptionSummaryPayload,
  SubscriptionRecord,
  UsageRow,
  UsageStatsRecord,
  UsageTrendPayload,
  UsageHistoryRow,
  UserProfileRecord
} from "./types";

const NAV_ITEMS: Array<{
  key: NavKey;
  label: string;
  icon: typeof LayoutDashboard;
}> = [
  { key: "overview", label: "总览", icon: LayoutDashboard },
  { key: "keys", label: "密钥", icon: KeyRound },
  { key: "usage", label: "用量", icon: ChartColumn },
  { key: "subscriptions", label: "订阅", icon: BadgeDollarSign },
  { key: "keyUsage", label: "单 Key", icon: MonitorDot },
  { key: "profile", label: "资料", icon: UserRound },
  { key: "trends", label: "趋势", icon: ChartColumn },
  { key: "alerts", label: "告警", icon: ShieldAlert },
  { key: "settings", label: "设置", icon: Server },
  { key: "systemSettings", label: "系统设置", icon: Settings2 }
];

const defaultSiteForm: SiteInput = {
  name: "",
  baseUrl: "https://ai.input.im"
};

const defaultAccountForm: AccountInput = {
  siteId: "",
  label: "",
  email: "",
  balanceWarning: 0
};

const USAGE_RANGE_PRESETS = [
  { key: "today", label: "今天" },
  { key: "yesterday", label: "昨天" },
  { key: "last24Hours", label: "近24小时" },
  { key: "last7Days", label: "近 7 天" },
  { key: "last14Days", label: "近 14 天" },
  { key: "last30Days", label: "近 30 天" },
  { key: "thisMonth", label: "本月" },
  { key: "lastMonth", label: "上月" }
] as const;

const RAIL_EXPANDED_BREAKPOINT = 960;

function isCompactRailViewport() {
  return typeof window !== "undefined" && window.innerWidth < RAIL_EXPANDED_BREAKPOINT;
}

export default function App() {
  const nav = useMonitorStore((state) => state.nav);
  const setNav = useMonitorStore((state) => state.setNav);
  const theme = useMonitorStore((state) => state.theme);
  const setTheme = useMonitorStore((state) => state.setTheme);
  const overview = useMonitorStore((state) => state.overview);
  const loading = useMonitorStore((state) => state.loading);
  const busyText = useMonitorStore((state) => state.busyText);
  const setBusyText = useMonitorStore((state) => state.setBusyText);
  const error = useMonitorStore((state) => state.error);
  const setError = useMonitorStore((state) => state.setError);
  const selectedSiteId = useMonitorStore((state) => state.selectedSiteId);
  const setSelectedSiteId = useMonitorStore((state) => state.setSelectedSiteId);
  const selectedAccountId = useMonitorStore((state) => state.selectedAccountId);
  const setSelectedAccountId = useMonitorStore((state) => state.setSelectedAccountId);
  const siteSearch = useMonitorStore((state) => state.siteSearch);
  const setSiteSearch = useMonitorStore((state) => state.setSiteSearch);
  const accountSearch = useMonitorStore((state) => state.accountSearch);
  const setAccountSearch = useMonitorStore((state) => state.setAccountSearch);
  const loadOverview = useMonitorStore((state) => state.loadOverview);
  const replaceOverview = useMonitorStore((state) => state.replaceOverview);
  const [siteFormOpen, setSiteFormOpen] = useState(false);
  const [accountFormOpen, setAccountFormOpen] = useState(false);
  const [accountSitePickerOpen, setAccountSitePickerOpen] = useState(false);
  const [accountPassword, setAccountPassword] = useState("");
  const [accountManagerOpen, setAccountManagerOpen] = useState(false);
  const [loginModal, setLoginModal] = useState<{
    account: AccountRuntime;
    phase: "password" | "2fa";
    password: string;
    code: string;
    tempToken?: string;
    emailMasked?: string | null;
  } | null>(null);
  const [editingSite, setEditingSite] = useState<SiteRecord | null>(null);
  const [editingAccount, setEditingAccount] = useState<AccountRuntime | null>(null);
  const [siteForm, setSiteForm] = useState<SiteInput>(defaultSiteForm);
  const [accountForm, setAccountForm] = useState<AccountInput>(defaultAccountForm);
  const [selectedHistoryRow, setSelectedHistoryRow] = useState<UsageHistoryRow | null>(null);
  const [groups, setGroups] = useState<GroupRecord[]>([]);
  const [managedKeys, setManagedKeys] = useState<PaginatedResult<ManagedKeyRecord> | null>(null);
  const [keyModalOpen, setKeyModalOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<ManagedKeyRecord | null>(null);
  const [keysPage, setKeysPage] = useState(1);
  const [keyForm, setKeyForm] = useState<KeyMutationInput>({
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
  const [usageRecords, setUsageRecords] = useState<PaginatedResult<UsageRow> | null>(null);
  const [usagePage, setUsagePage] = useState(1);
  const [usageStats, setUsageStats] = useState<UsageStatsRecord | null>(null);
  const [usageTrend, setUsageTrend] = useState<UsageTrendPayload | null>(null);
  const [usageModels, setUsageModels] = useState<DashboardModelsPayload | null>(null);
  const [usageApiKeyFilter, setUsageApiKeyFilter] = useState<string>("");
  const [usageStartDate, setUsageStartDate] = useState<string>("");
  const [usageEndDate, setUsageEndDate] = useState<string>("");
  const [usageRangePickerOpen, setUsageRangePickerOpen] = useState(false);
  const [usageRangePreset, setUsageRangePreset] =
    useState<(typeof USAGE_RANGE_PRESETS)[number]["key"]>("today");
  const [usageDraftRange, setUsageDraftRange] = useState({ startDate: "", endDate: "" });
  const [keyUsageKeyId, setKeyUsageKeyId] = useState<string>("");
  const [keyUsageRows, setKeyUsageRows] = useState<DailyUsagePoint[]>([]);
  const [subscriptionSummary, setSubscriptionSummary] = useState<SubscriptionSummaryPayload | null>(null);
  const [profileRecord, setProfileRecord] = useState<UserProfileRecord | null>(null);
  const [profileForm, setProfileForm] = useState<ProfileUpdateInput>({});
  const [profilePassword, setProfilePassword] = useState({ oldPassword: "", newPassword: "" });
  const [platformQuotas, setPlatformQuotas] = useState<PlatformQuotaPayload | null>(null);
  const [notifyEmailDraft, setNotifyEmailDraft] = useState({ email: "", code: "", target: "" });
  const [isRailExpanded, setIsRailExpanded] = useState(() => !isCompactRailViewport());

  const deferredSiteSearch = useDeferredValue(siteSearch.trim().toLowerCase());
  const deferredAccountSearch = useDeferredValue(accountSearch.trim().toLowerCase());

  useEffect(() => {
    document.documentElement.classList.remove("light", "dark", "deep-blue");
    document.documentElement.classList.add(theme);
  }, [theme]);

  useEffect(() => {
    let previousCompact = isCompactRailViewport();
    setIsRailExpanded(!previousCompact);

    function handleResize() {
      const nextCompact = isCompactRailViewport();
      if (nextCompact !== previousCompact) {
        setIsRailExpanded(!nextCompact);
        previousCompact = nextCompact;
      }
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    void loadOverview();
  }, []);

  useEffect(() => {
    if (nav === "sites" || nav === "accounts") {
      setNav("systemSettings");
    }
  }, [nav, setNav]);

  useEffect(() => {
    if (!selectedAccountId) {
      setManagedKeys(null);
      setUsageRecords(null);
      setUsageStats(null);
      setUsageTrend(null);
      setUsageModels(null);
      setSubscriptionSummary(null);
      setProfileRecord(null);
      setPlatformQuotas(null);
      setKeyUsageRows([]);
      return;
    }
    const today = new Date();
    const effectiveStart = usageStartDate || toDateValue(today);
    const effectiveEnd = usageEndDate || toDateValue(today);
    if (!usageStartDate) {
      setUsageStartDate(effectiveStart);
    }
    if (!usageEndDate) {
      setUsageEndDate(effectiveEnd);
    }
    setUsageDraftRange((current) => ({
      startDate: current.startDate || effectiveStart,
      endDate: current.endDate || effectiveEnd
    }));
    void loadAccountScopedData(selectedAccountId, effectiveStart, effectiveEnd);
  }, [selectedAccountId]);

  const sites = overview?.sites ?? [];
  const accounts = overview?.accounts ?? [];
  const filteredSites = sites.filter((item) => {
    if (!deferredSiteSearch) return true;
    return (
      item.name.toLowerCase().includes(deferredSiteSearch) ||
      item.baseUrl.toLowerCase().includes(deferredSiteSearch)
    );
  });
  const filteredAccounts = accounts.filter((item) => {
    if (selectedSiteId && item.siteId !== selectedSiteId && nav !== "overview") {
      return false;
    }
    if (!deferredAccountSearch) return true;
    return (
      item.label.toLowerCase().includes(deferredAccountSearch) ||
      item.email.toLowerCase().includes(deferredAccountSearch) ||
      item.site?.name.toLowerCase().includes(deferredAccountSearch)
    );
  });
  const selectedAccount =
    accounts.find((item) => item.id === selectedAccountId) ?? filteredAccounts[0] ?? null;
  const selectedSite =
    sites.find((item) => item.id === selectedSiteId) ??
    (selectedAccount ? sites.find((item) => item.id === selectedAccount.siteId) ?? null : null);
  const selectedAccountSite = sites.find((item) => item.id === accountForm.siteId) ?? null;
  const visibleSnapshot = selectedAccount?.snapshot ?? null;
  const visibleHistory = visibleSnapshot?.requestHistory ?? [];
  const latestHistory = visibleHistory.filter((item) => item.isLatest);
  const usageRangeLabel = formatUsageRangeLabel(usageRangePreset, usageStartDate, usageEndDate);
  const alertCount = overview?.alerts.length ?? 0;
  const subscriptionCount =
    subscriptionSummary?.activeCount ?? visibleSnapshot?.subscriptions.length ?? 0;
  const subscriptionSpend = subscriptionSummary?.totalUsedUsd ?? 0;
  const usageStatusLabel = subscriptionSummary
    ? `${subscriptionCount} 个有效订阅`
    : visibleSnapshot?.activeSubscription?.status ?? (subscriptionCount > 0 ? "已同步订阅" : "等待同步");
  const usageStatusHint = subscriptionSummary
    ? `已用 ${formatUsd(subscriptionSpend, 2)}`
    : visibleSnapshot?.activeSubscription?.expiresAt
      ? `到期 ${formatTime(visibleSnapshot.activeSubscription.expiresAt)}`
      : subscriptionCount > 0
        ? "查看配额与到期时间"
        : "暂无订阅数据";
  const shellClassName = [
    "app-shell",
    isRailExpanded ? "" : "rail-collapsed"
  ]
    .filter(Boolean)
    .join(" ");
  const railToggleTitle = isRailExpanded ? "收起导航" : "展开导航";

  useEffect(() => {
    if (!visibleHistory.length) {
      setSelectedHistoryRow(null);
      return;
    }
    setSelectedHistoryRow((current) => {
      if (current) {
        const matched = visibleHistory.find(
          (item) => item.id === current.id && item.firstSeenAt === current.firstSeenAt
        );
        if (matched) {
          return matched;
        }
      }
      return visibleHistory[0] ?? null;
    });
  }, [visibleHistory]);

  function openNewSite() {
    setEditingSite(null);
    setSiteForm(defaultSiteForm);
    setSiteFormOpen(true);
  }

  function openEditSite(site: SiteRecord) {
    setEditingSite(site);
    setSiteForm({
      name: site.name,
      baseUrl: site.baseUrl
    });
    setSiteFormOpen(true);
  }

  function openNewAccount(siteId?: string) {
    setEditingAccount(null);
    setAccountSitePickerOpen(false);
    setAccountPassword("");
    setAccountForm({
      ...defaultAccountForm,
      siteId: siteId ?? selectedSiteId ?? sites[0]?.id ?? ""
    });
    setAccountFormOpen(true);
  }

  function openEditAccount(account: AccountRuntime) {
    setEditingAccount(account);
    setAccountSitePickerOpen(false);
    setAccountPassword("");
    setAccountForm({
      siteId: account.siteId,
      label: account.label,
      email: account.email,
      balanceWarning: account.balanceWarning
    });
    setAccountFormOpen(true);
  }

  function openAccountManager(account: AccountRuntime) {
    setSelectedSiteId(account.siteId);
    setSelectedAccountId(account.id);
    setAccountManagerOpen(true);
  }

  function openPasswordLogin(account: AccountRuntime) {
    setLoginModal({ account, phase: "password", password: "", code: "" });
  }

  function handleActionKey(event: KeyboardEvent<HTMLElement>, action: () => void) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  }

  function handleNavChange(nextNav: NavKey) {
    setNav(nextNav);
  }

  async function submitSiteForm() {
    setBusyText(editingSite ? "正在更新站点..." : "正在创建站点...");
    setError(null);
    try {
      if (editingSite) {
        await updateSite(editingSite.id, siteForm);
      } else {
        const created = await createSite(siteForm);
        setSelectedSiteId(created.id);
      }
      setSiteFormOpen(false);
      await loadOverview();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function submitAccountForm() {
    setBusyText(editingAccount ? "正在更新账号..." : accountPassword.trim() ? "正在创建账号并自动登录..." : "正在创建账号...");
    setError(null);
    try {
      if (editingAccount) {
        await updateAccount(editingAccount.id, {
          label: accountForm.label,
          email: accountForm.email,
          balanceWarning: accountForm.balanceWarning
        });
      } else {
        const created = await createAccount(accountForm);
        setSelectedAccountId(created.id);
        setSelectedSiteId(created.siteId);
        if (accountPassword.trim()) {
          try {
            const loginResult = await loginAccount(created.id, accountPassword.trim());
            if (loginResult.type === "success") {
              setSelectedAccountId(loginResult.account.id);
              setSelectedSiteId(loginResult.account.siteId);
            } else {
              setLoginModal({
                account: created,
                phase: "2fa",
                password: accountPassword.trim(),
                code: "",
                tempToken: loginResult.tempToken,
                emailMasked: loginResult.emailMasked
              });
              setError(loginResult.message ?? "账号已创建，请继续输入 2FA 验证码完成登录。");
            }
          } catch (cause) {
            setError(
              `账号已创建，但自动登录失败: ${(cause as Error).message}。你可以在账号列表点“登录”重新输入密码。`
            );
          }
        }
      }
      setAccountFormOpen(false);
      setAccountPassword("");
      await loadOverview();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleLogin() {
    if (!loginModal) return;
    setBusyText(
      loginModal.phase === "password"
        ? `正在登录 ${loginModal.account.label}...`
        : `正在校验 ${loginModal.account.label} 的 2FA...`
    );
    setError(null);
    try {
      if (loginModal.phase === "password") {
        const result = await loginAccount(loginModal.account.id, loginModal.password);
        if (result.type === "success") {
          setSelectedAccountId(result.account.id);
          setSelectedSiteId(result.account.siteId);
          setLoginModal(null);
        } else {
          setLoginModal((prev) =>
            prev
              ? {
                  ...prev,
                  phase: "2fa",
                  code: "",
                  tempToken: result.tempToken,
                  emailMasked: result.emailMasked
                }
              : prev
          );
          setError(result.message ?? "检测到 2FA 验证，请输入验证码继续登录。");
        }
      } else {
        const updated = await completeAccount2fa(
          loginModal.account.id,
          loginModal.tempToken ?? "",
          loginModal.code.trim()
        );
        setSelectedAccountId(updated.id);
        setSelectedSiteId(updated.siteId);
        setLoginModal(null);
      }
      await loadOverview();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleRefreshAccount(accountId: string) {
    setBusyText("正在刷新账号数据...");
    setError(null);
    try {
      const updated = await refreshAccount(accountId);
      setSelectedAccountId(updated.id);
      setSelectedSiteId(updated.siteId);
      await loadOverview();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleRefreshAll() {
    setBusyText("正在刷新全部账号...");
    setError(null);
    try {
      const next = await refreshAllAccounts();
      startTransition(() => {
        replaceOverview(next);
      });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleRemoveSite(siteId: string) {
    setBusyText("正在删除站点...");
    setError(null);
    try {
      await removeSite(siteId);
      if (selectedSiteId === siteId) {
        setSelectedSiteId(null);
      }
      await loadOverview();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleRemoveAccount(accountId: string) {
    setBusyText("正在删除账号...");
    setError(null);
    try {
      await removeAccount(accountId);
      if (selectedAccountId === accountId) {
        setSelectedAccountId(null);
      }
      await loadOverview();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function loadAccountScopedData(accountId: string, startDate: string, endDate: string) {
    try {
      const [
        nextGroups,
        nextKeys,
        nextUsageStats,
        nextUsageTrend,
        nextUsageModels,
        nextProfile,
        nextPlatformQuotas,
        nextSubscriptionSummary
      ] = await Promise.all([
        getAvailableGroups(accountId),
        listManagedKeys(accountId, keysPage, 100),
        getUsageStats(accountId, { period: "today" }),
        getDashboardTrend(accountId, 7),
        getDashboardModels(accountId, 7),
        getProfileRecord(accountId),
        getPlatformQuotas(accountId),
        getSubscriptionSummary(accountId)
      ]);
      setGroups(nextGroups);
      setManagedKeys(nextKeys);
      setUsageStats(nextUsageStats);
      setUsageTrend(nextUsageTrend);
      setUsageModels(nextUsageModels);
      setProfileRecord(nextProfile);
      setProfileForm({
        email: nextProfile.email,
        username: nextProfile.username ?? "",
        balanceNotifyEnabled: nextProfile.balanceNotifyEnabled ?? false,
        balanceNotifyThresholdType: nextProfile.balanceNotifyThresholdType ?? "fixed",
        balanceNotifyThreshold: nextProfile.balanceNotifyThreshold ?? 0
      });
      setPlatformQuotas(nextPlatformQuotas);
      setSubscriptionSummary(nextSubscriptionSummary);
      await loadUsageRecordsForFilters(accountId, startDate, endDate, usageApiKeyFilter, usagePage);
      const initialKeyId = keyUsageKeyId || nextKeys.items[0]?.id || "";
      setKeyUsageKeyId(initialKeyId);
      if (initialKeyId) {
        const daily = await getApiKeyDailyUsage(accountId, initialKeyId, 30);
        setKeyUsageRows(daily);
      }
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  async function loadUsageRecordsForFilters(
    accountId: string,
    startDate: string,
    endDate: string,
    apiKeyId: string,
    page = 1
  ) {
    const next = await listUsageRecords(accountId, {
      page,
      pageSize: 20,
      apiKeyId,
      startDate,
      endDate
    });
    setUsageRecords(next);
  }

  function resetKeyForm(nextGroupId?: number | null) {
    setKeyForm({
      name: "",
      groupId: nextGroupId ?? groups[0]?.id ?? null,
      customKey: "",
      ipWhitelist: "",
      ipBlacklist: "",
      quota: 0,
      expiresInDays: 30,
      status: "active",
      rateLimit5h: 0,
      rateLimit1d: 0,
      rateLimit7d: 0
    });
  }

  function openNewKey() {
    setEditingKey(null);
    resetKeyForm();
    setKeyModalOpen(true);
  }

  async function openEditKey(keyId: string) {
    if (!selectedAccountId) return;
    setBusyText("正在加载密钥详情...");
    setError(null);
    try {
      const key = await getManagedKey(selectedAccountId, keyId);
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
      setKeyModalOpen(true);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function refreshManagedKeys() {
    if (!selectedAccountId) return;
    const next = await listManagedKeys(selectedAccountId, keysPage, 100);
    setManagedKeys(next);
  }

  async function submitKeyForm() {
    if (!selectedAccountId) return;
    setBusyText(editingKey ? "正在更新密钥..." : "正在创建密钥...");
    setError(null);
    try {
      if (editingKey) {
        await updateManagedKey(selectedAccountId, editingKey.id, keyForm);
      } else {
        await createManagedKey(selectedAccountId, keyForm);
      }
      setKeyModalOpen(false);
      await refreshManagedKeys();
      await loadOverview();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleDeleteKey(keyId: string) {
    if (!selectedAccountId) return;
    setBusyText("正在删除密钥...");
    setError(null);
    try {
      await deleteManagedKey(selectedAccountId, keyId);
      await refreshManagedKeys();
      await loadOverview();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleToggleKeyStatus(key: ManagedKeyRecord) {
    if (!selectedAccountId) return;
    setBusyText(`正在${key.status === "active" ? "停用" : "启用"}密钥...`);
    setError(null);
    try {
      await updateManagedKey(selectedAccountId, key.id, {
        status: key.status === "active" ? "inactive" : "active"
      });
      await refreshManagedKeys();
      await loadOverview();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleResetQuota(key: ManagedKeyRecord) {
    if (!selectedAccountId) return;
    setBusyText("正在重置已用额度...");
    setError(null);
    try {
      await updateManagedKey(selectedAccountId, key.id, { resetQuota: true });
      await refreshManagedKeys();
      await loadOverview();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleResetRateLimitUsage(key: ManagedKeyRecord) {
    if (!selectedAccountId) return;
    setBusyText("正在重置限流用量...");
    setError(null);
    try {
      await updateManagedKey(selectedAccountId, key.id, { resetRateLimitUsage: true });
      await refreshManagedKeys();
      await loadOverview();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleUsageSearch() {
    if (!selectedAccountId) return;
    setBusyText("正在刷新用量明细...");
    setError(null);
    try {
      setUsagePage(1);
      await loadUsageRecordsForFilters(
        selectedAccountId,
        usageStartDate,
        usageEndDate,
        usageApiKeyFilter,
        1
      );
      const stats = await getUsageStats(selectedAccountId, {
        startDate: usageStartDate,
        endDate: usageEndDate,
        apiKeyId: usageApiKeyFilter || null
      });
      setUsageStats(stats);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleUsagePageChange(nextPage: number) {
    if (!selectedAccountId || !usageRecords) return;
    const safePage = Math.min(Math.max(1, nextPage), Math.max(usageRecords.pages, 1));
    setBusyText(`正在加载第 ${safePage} 页用量记录...`);
    setError(null);
    try {
      await loadUsageRecordsForFilters(
        selectedAccountId,
        usageStartDate,
        usageEndDate,
        usageApiKeyFilter,
        safePage
      );
      setUsagePage(safePage);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  function toggleUsageRangePicker() {
    if (usageRangePickerOpen) {
      setUsageRangePickerOpen(false);
      return;
    }
    setUsageDraftRange({
      startDate: usageStartDate,
      endDate: usageEndDate
    });
    setUsageRangePickerOpen(true);
  }

  function applyUsagePreset(preset: (typeof USAGE_RANGE_PRESETS)[number]["key"]) {
    const range = buildPresetRange(preset);
    setUsageRangePreset(preset);
    setUsageDraftRange(range);
  }

  async function applyUsageRange() {
    if (!selectedAccountId) return;
    const nextStart = usageDraftRange.startDate || usageStartDate;
    const nextEnd = usageDraftRange.endDate || usageEndDate;
    setUsageStartDate(nextStart);
    setUsageEndDate(nextEnd);
    setUsagePage(1);
    setUsageRangePickerOpen(false);
    setBusyText("正在应用时间范围...");
    setError(null);
    try {
      await loadUsageRecordsForFilters(
        selectedAccountId,
        nextStart,
        nextEnd,
        usageApiKeyFilter,
        1
      );
      const stats = await getUsageStats(selectedAccountId, {
        startDate: nextStart,
        endDate: nextEnd,
        apiKeyId: usageApiKeyFilter || null
      });
      setUsageStats(stats);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleLoadKeyUsage(keyId: string) {
    if (!selectedAccountId || !keyId) return;
    setBusyText("正在加载单 Key 用量...");
    setError(null);
    try {
      setKeyUsageKeyId(keyId);
      const daily = await getApiKeyDailyUsage(selectedAccountId, keyId, 30);
      setKeyUsageRows(daily);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleProfileSave() {
    if (!selectedAccountId) return;
    setBusyText("正在保存资料...");
    setError(null);
    try {
      const next = await updateProfileRecord(selectedAccountId, profileForm);
      setProfileRecord(next);
      await loadOverview();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleProfilePasswordChange() {
    if (!selectedAccountId) return;
    setBusyText("正在更新密码...");
    setError(null);
    try {
      await changeProfilePassword(
        selectedAccountId,
        profilePassword.oldPassword,
        profilePassword.newPassword
      );
      setProfilePassword({ oldPassword: "", newPassword: "" });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleNotifyEmailSend() {
    if (!selectedAccountId || !notifyEmailDraft.email) return;
    setBusyText("正在发送通知邮箱验证码...");
    setError(null);
    try {
      await sendNotifyEmailCode(selectedAccountId, notifyEmailDraft.email);
      setNotifyEmailDraft((prev) => ({ ...prev, target: prev.email }));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleNotifyEmailVerify() {
    if (!selectedAccountId || !notifyEmailDraft.target || !notifyEmailDraft.code) return;
    setBusyText("正在验证通知邮箱...");
    setError(null);
    try {
      await verifyNotifyEmail(selectedAccountId, notifyEmailDraft.target, notifyEmailDraft.code);
      const next = await getProfileRecord(selectedAccountId);
      setProfileRecord(next);
      setNotifyEmailDraft({ email: "", code: "", target: "" });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleNotifyEmailToggle(email: string, disabled: boolean) {
    if (!selectedAccountId) return;
    setBusyText("正在更新通知邮箱状态...");
    setError(null);
    try {
      const next = await toggleNotifyEmail(selectedAccountId, email, disabled);
      setProfileRecord(next);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleUnbind(provider: string) {
    if (!selectedAccountId) return;
    setBusyText("正在解绑账号...");
    setError(null);
    try {
      await unbindAuthIdentity(selectedAccountId, provider);
      const next = await getProfileRecord(selectedAccountId);
      setProfileRecord(next);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  return (
    <div className={shellClassName}>
      <aside className={`rail ${isRailExpanded ? "expanded" : ""}`}>
        <button
          className="brand-button"
          title="Input面板"
          aria-label="Input面板"
          onClick={() => setNav("overview")}
        >
          <span className="brand-glyph brand-logo-shell" aria-hidden="true">
            <img className="brand-logo" src={projectLogo} alt="" />
          </span>
          {isRailExpanded && (
            <span className="brand-copy">
              <span className="eyebrow">INPUT PANEL</span>
              <strong>Input面板</strong>
            </span>
          )}
        </button>
        <button
          className={`rail-item rail-toggle ${isRailExpanded ? "open" : ""}`}
          onClick={() => setIsRailExpanded((current) => !current)}
          title={railToggleTitle}
          aria-label={railToggleTitle}
          aria-expanded={isRailExpanded}
        >
          <ChevronRight size={18} />
          {isRailExpanded && <span className="rail-item-label">导航</span>}
        </button>
        <div className="rail-stack">
          {NAV_ITEMS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              className={`rail-item ${nav === key ? "active" : ""}`}
              onClick={() => handleNavChange(key)}
              title={label}
              aria-label={label}
            >
              <Icon size={18} />
              {isRailExpanded && <span className="rail-item-label">{label}</span>}
            </button>
          ))}
        </div>
        <div className="rail-stack rail-bottom">
          <button
            className="rail-item"
            onClick={() => {
              setTheme(theme === "deep-blue" ? "light" : theme === "light" ? "dark" : "deep-blue");
            }}
            title="切换主题"
            aria-label="切换主题"
          >
            <MonitorDot size={18} />
            {isRailExpanded && <span className="rail-item-label">切换主题</span>}
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="global-topbar">
          <div className="global-topbar-grid">
            <button className="topbar-card topbar-card-brand" onClick={() => setNav("settings")}>
              <div className="topbar-card-icon">
                <Server size={18} />
              </div>
              <div className="topbar-card-copy">
                <span className="topbar-card-label">站点</span>
                <strong>{selectedSite?.name ?? "未选择站点"}</strong>
                <p>{selectedSite?.baseUrl ?? "点击前往站点设置与账号绑定"}</p>
              </div>
              <ChevronRight size={16} />
            </button>

            <button
              className="topbar-card"
              onClick={() => {
                if (selectedSite) {
                  setSelectedSiteId(selectedSite.id);
                }
                setNav("settings");
              }}
            >
              <div className="topbar-card-icon">
                <UserRound size={18} />
              </div>
              <div className="topbar-card-copy">
                <span className="topbar-card-label">账号</span>
                <strong>{selectedAccount?.label ?? "未选择账号"}</strong>
                <p>{selectedAccount ? maskEmail(selectedAccount.email) : "点击维护登录、资料与密钥上下文"}</p>
              </div>
              {selectedAccount ? <StatusBadge state={selectedAccount.sessionState} /> : <ChevronRight size={16} />}
            </button>

            <button className="topbar-card" onClick={() => setNav("alerts")}>
              <div className="topbar-card-icon">
                <Bell size={18} />
              </div>
              <div className="topbar-card-copy">
                <span className="topbar-card-label">通知</span>
                <strong>{alertCount === 0 ? "全部正常" : `${alertCount} 条待处理`}</strong>
                <p>{alertCount === 0 ? "当前没有新的余额或订阅告警" : "点击进入告警中心查看详情"}</p>
              </div>
              <span className={`status-pill ${alertCount > 0 ? "critical" : "ready"}`}>
                {alertCount === 0 ? "静默" : "提醒"}
              </span>
            </button>

            <button className="topbar-card" onClick={() => setNav("subscriptions")}>
              <div className="topbar-card-icon">
                <Crown size={18} />
              </div>
              <div className="topbar-card-copy">
                <span className="topbar-card-label">订阅使用情况</span>
                <strong>{usageStatusLabel}</strong>
                <p>{usageStatusHint}</p>
              </div>
              <span className="topbar-metric">
                {subscriptionSpend > 0 ? formatUsd(subscriptionSpend, 2) : subscriptionCount.toString()}
              </span>
            </button>
          </div>

          <div className="header-actions global-topbar-actions">
            {nav !== "systemSettings" && (
              <button className="ghost-button" onClick={() => setNav("systemSettings")}>
                <Settings2 size={16} />
                系统设置
              </button>
            )}
            <button className="ghost-button" onClick={() => void loadOverview()}>
              <RefreshCcw size={16} />
              重新加载
            </button>
            {selectedAccount && (
              <button className="primary-button" onClick={() => openPasswordLogin(selectedAccount)}>
                <UserRound size={16} />
                登录当前账号
              </button>
            )}
          </div>
        </header>

        <header className="workspace-header">
          <div>
            <p className="eyebrow">QMAI-inspired Shell</p>
            <h2>{navTitle(nav)}</h2>
            <p className="workspace-subtitle">
              {selectedSite ? `${selectedSite.name} / ${selectedAccount?.label ?? "未选择账号"}` : "请先添加站点与账号"}
            </p>
          </div>
          <div className="workspace-header-summary">
            <span>{overview ? `${overview.totals.totalSites} 个站点` : "等待同步站点"}</span>
            <span>{overview ? `${overview.totals.totalAccounts} 个账号` : "等待同步账号"}</span>
            <span>{overview ? `今日 ${compact(overview.totals.todayRequests)} 请求` : "暂无今日请求数据"}</span>
          </div>
        </header>

        {error && (
          <div className="inline-banner error">
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        )}
        {busyText && (
          <div className="inline-banner info">
            <LoaderCircle size={16} className="spin" />
            <span>{busyText}</span>
          </div>
        )}

        {loading && !overview ? (
          <div className="loading-state">
            <LoaderCircle size={22} className="spin" />
            <span>正在加载工作台...</span>
          </div>
        ) : (
          <div className="workspace-scroll">
            {nav === "overview" && overview && (
              <>
                <section className="metric-grid">
                  <MetricCard
                    label="总余额"
                    value={`$${overview.totals.balance.toFixed(2)}`}
                    accent="emerald"
                    icon={<BadgeDollarSign size={18} />}
                    hint="聚合所有已登录账号"
                  />
                  <MetricCard
                    label="今日请求"
                    value={overview.totals.todayRequests.toLocaleString()}
                    accent="sky"
                    icon={<LayoutDashboard size={18} />}
                    hint={`累计 ${overview.totals.totalRequests.toLocaleString()}`}
                  />
                  <MetricCard
                    label="今日实际成本"
                    value={`$${overview.totals.todayActualCost.toFixed(4)}`}
                    accent="violet"
                    icon={<ChartColumn size={18} />}
                    hint={`累计 $${overview.totals.totalActualCost.toFixed(4)}`}
                  />
                  <MetricCard
                    label="活跃 Keys"
                    value={`${overview.totals.activeApiKeys}`}
                    accent="amber"
                    icon={<KeyRound size={18} />}
                    hint={`总数 ${overview.totals.totalApiKeys}`}
                  />
                  <MetricCard
                    label="今日 Tokens"
                    value={compact(overview.totals.todayTokens)}
                    accent="indigo"
                    icon={<MonitorDot size={18} />}
                    hint={`累计 ${compact(overview.totals.totalTokens)}`}
                  />
                  <MetricCard
                    label="异常数"
                    value={String(overview.alerts.length)}
                    accent="rose"
                    icon={<ShieldAlert size={18} />}
                    hint="低余额、会话失效、拉取失败"
                  />
                </section>

                <section className="content-grid">
                  <SectionCard
                    title="近 7 天趋势"
                    subtitle="按全部账号聚合 actual cost / requests / tokens"
                  >
                    <div className="chart-wrap tall">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={overview.trend}>
                          <defs>
                            <linearGradient id="trendCost" x1="0" x2="0" y1="0" y2="1">
                              <stop offset="0%" stopColor="rgba(83, 205, 181, 0.75)" />
                              <stop offset="100%" stopColor="rgba(83, 205, 181, 0.03)" />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-strong)" />
                          <XAxis dataKey="bucket" stroke="var(--text-subtle)" tickLine={false} axisLine={false} />
                          <YAxis stroke="var(--text-subtle)" tickLine={false} axisLine={false} />
                          <Tooltip />
                          <Area type="monotone" dataKey="actualCost" stroke="#53cdb5" fill="url(#trendCost)" strokeWidth={2} />
                          <Area type="monotone" dataKey="requests" stroke="#7aa2ff" fill="transparent" strokeWidth={2} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </SectionCard>

                  <SectionCard title="平台分布" subtitle="按平台汇总实际成本与 tokens">
                    <div className="chart-wrap">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={overview.platformSeries}
                            dataKey="totalActualCost"
                            nameKey="platform"
                            outerRadius={88}
                            innerRadius={52}
                            paddingAngle={2}
                            fill="#7aa2ff"
                          />
                          <Tooltip />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="legend-list">
                      {overview.platformSeries.map((item) => (
                        <div key={item.platform} className="legend-row">
                          <span>{item.platform}</span>
                          <strong>${item.totalActualCost.toFixed(4)}</strong>
                        </div>
                      ))}
                    </div>
                  </SectionCard>
                </section>

                <section className="content-grid">
                  <SectionCard title="异常优先" subtitle="当前需要关注的问题">
                    <div className="stack-list">
                      {overview.alerts.slice(0, 8).map((alert) => (
                        <div key={alert.id} className={`alert-item ${alert.severity}`}>
                          <div>
                            <strong>{alert.title}</strong>
                            <p>{alert.detail}</p>
                          </div>
                          <span>{formatTime(alert.createdAt)}</span>
                        </div>
                      ))}
                      {overview.alerts.length === 0 && (
                        <EmptyState title="当前没有异常" detail="最近一次聚合已经成功完成。" compact />
                      )}
                    </div>
                  </SectionCard>

                  <SectionCard title="最近使用" subtitle="当前选中账号的近期调用">
                    <div className="table-list">
                      {visibleSnapshot?.recentUsage.slice(0, 8).map((row) => (
                        <div key={row.id} className="table-row">
                          <div>
                            <strong>{row.model}</strong>
                            <p>{row.apiKeyName ?? "未知 Key"} / {row.endpoint ?? "-"}</p>
                          </div>
                          <div className="table-numbers">
                            <strong>${row.actualCost.toFixed(5)}</strong>
                            <span>{compact(row.totalTokens)} tokens</span>
                          </div>
                        </div>
                      ))}
                      {!visibleSnapshot && (
                        <EmptyState title="还没有账号快照" detail="先登录账号并刷新数据。" compact />
                      )}
                    </div>
                  </SectionCard>
                </section>

                <section className="content-grid">
                  <SectionCard title="全部订阅" subtitle="当前账号返回的全部套餐与额度窗口">
                    {visibleSnapshot ? (
                      <SubscriptionList subscriptions={visibleSnapshot.subscriptions} />
                    ) : (
                      <EmptyState title="当前没有订阅数据" detail="该账号未返回有效订阅或套餐信息。" compact />
                    )}
                  </SectionCard>

                  <SectionCard title="全部 API Keys" subtitle="状态、最近使用、额度与限流摘要">
                    {visibleSnapshot ? (
                      <ApiKeyList keys={visibleSnapshot.keys} />
                    ) : (
                      <EmptyState title="还没有 Key 快照" detail="登录并刷新后这里会展示 key 列表。" compact />
                    )}
                  </SectionCard>
                </section>
              </>
            )}

            {nav === "settings" && (
              <>
                <section className="management-grid">
                  <SectionCard
                    title="站点默认管理"
                    subtitle="默认站点配置现在统一收口到设置页内维护。"
                    actions={
                      <button className="mini-button" onClick={openNewSite} title="新增站点" aria-label="新增站点">
                        <Plus size={14} />
                      </button>
                    }
                  >
                    <div className="context-section">
                      <input
                        className="search-input"
                        value={siteSearch}
                        onChange={(event) => setSiteSearch(event.target.value)}
                        placeholder="搜索站点"
                      />
                      <div className="context-list">
                        {filteredSites.map((site) => {
                          const siteAccounts = accounts.filter((item) => item.siteId === site.id);
                          const siteBalance = siteAccounts.reduce(
                            (sum, item) => sum + (item.snapshot?.balance ?? 0),
                            0
                          );
                          const activeCount = siteAccounts.filter((item) => item.sessionState === "ready").length;
                          return (
                            <div
                              key={site.id}
                              className={`context-card ${selectedSite?.id === site.id ? "selected" : ""}`}
                              onClick={() => {
                                setSelectedSiteId(site.id);
                                if (siteAccounts[0]) {
                                  setSelectedAccountId(siteAccounts[0].id);
                                }
                              }}
                              role="button"
                              tabIndex={0}
                            >
                              <div className="context-card-head">
                                <strong>{site.name}</strong>
                                <span className="status-pill neutral">{activeCount}/{siteAccounts.length}</span>
                              </div>
                              <div className="context-card-body">
                                <span>{site.baseUrl}</span>
                                <span>余额 ${siteBalance.toFixed(2)}</span>
                              </div>
                              <div className="context-card-actions">
                                <button
                                  className="inline-text-button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    openEditSite(site);
                                  }}
                                >
                                  编辑
                                </button>
                                <button
                                  className="inline-text-button danger"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void handleRemoveSite(site.id);
                                  }}
                                >
                                  删除
                                </button>
                              </div>
                            </div>
                          );
                        })}
                        {filteredSites.length === 0 && (
                          <EmptyState title="还没有站点" detail="先添加第一个 Sub2API 站点。" compact />
                        )}
                      </div>
                    </div>
                  </SectionCard>

                  <SectionCard
                    title="账号默认管理"
                    subtitle={
                      selectedSite
                        ? `当前聚焦 ${selectedSite.name}，默认账号与登录维护都放在这里。`
                        : "先选择一个站点，再维护当前默认账号。"
                    }
                    actions={
                      <button
                        className="mini-button"
                        onClick={() => openNewAccount()}
                        title="新增账号"
                        aria-label="新增账号"
                      >
                        <Plus size={14} />
                      </button>
                    }
                  >
                    <div className="context-section">
                      <input
                        className="search-input"
                        value={accountSearch}
                        onChange={(event) => setAccountSearch(event.target.value)}
                        placeholder="搜索账号"
                      />
                      <div className="context-list">
                        {filteredAccounts.map((account) => (
                          <div
                            key={account.id}
                            className={`context-card ${selectedAccount?.id === account.id ? "selected" : ""}`}
                            onClick={() => openAccountManager(account)}
                            onKeyDown={(event) => handleActionKey(event, () => openAccountManager(account))}
                            role="button"
                            tabIndex={0}
                            title="打开账号管理"
                          >
                            <div className="context-card-head">
                              <strong>{account.label}</strong>
                              <StatusBadge state={account.sessionState} />
                            </div>
                            <div className="context-card-body">
                              <span>{account.email}</span>
                              <span>{account.snapshot ? `$${account.snapshot.balance.toFixed(2)}` : "未拉取"}</span>
                            </div>
                            <div className="context-card-actions">
                              <button
                                className="inline-text-button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openEditAccount(account);
                                }}
                              >
                                编辑
                              </button>
                              <button
                                className="inline-text-button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openPasswordLogin(account);
                                }}
                              >
                                登录
                              </button>
                              <button
                                className="inline-text-button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleRefreshAccount(account.id);
                                }}
                              >
                                刷新
                              </button>
                            </div>
                          </div>
                        ))}
                        {filteredAccounts.length === 0 && (
                          <EmptyState title="还没有账号" detail="为当前站点添加一个登录账号。" compact />
                        )}
                      </div>
                    </div>
                  </SectionCard>
                </section>

                <section className="panel-grid">
                  {sites.map((site) => {
                    const siteAccounts = accounts.filter((item) => item.siteId === site.id);
                    const onlineCount = siteAccounts.filter((item) => item.snapshot?.online).length;
                    const alerts = overview?.alerts.filter((item) => item.siteId === site.id).length ?? 0;
                    return (
                      <SectionCard
                        key={site.id}
                        title={site.name}
                        subtitle={site.baseUrl}
                        actions={
                          <>
                            <button className="inline-text-button" onClick={() => openEditSite(site)}>
                              编辑
                            </button>
                            <button className="inline-text-button" onClick={() => openNewAccount(site.id)}>
                              加账号
                            </button>
                          </>
                        }
                      >
                        <div className="site-summary">
                          <div className="summary-stat">
                            <span>账号数</span>
                            <strong>{siteAccounts.length}</strong>
                          </div>
                          <div className="summary-stat">
                            <span>在线账号</span>
                            <strong>{onlineCount}</strong>
                          </div>
                          <div className="summary-stat">
                            <span>异常</span>
                            <strong>{alerts}</strong>
                          </div>
                          <div className="summary-stat">
                            <span>站点余额</span>
                            <strong>
                              $
                              {siteAccounts
                                .reduce((sum, item) => sum + (item.snapshot?.balance ?? 0), 0)
                                .toFixed(2)}
                            </strong>
                          </div>
                        </div>
                        <div className="table-list">
                          {siteAccounts.map((account) => (
                            <div
                              key={account.id}
                              className="table-row account-row-trigger"
                              onClick={() => openAccountManager(account)}
                              onKeyDown={(event) => handleActionKey(event, () => openAccountManager(account))}
                              role="button"
                              tabIndex={0}
                              title="打开账号管理"
                            >
                              <div>
                                <strong>{account.label}</strong>
                                <p>{account.email}</p>
                              </div>
                              <div className="table-numbers">
                                <StatusBadge state={account.sessionState} />
                                <span>{account.snapshot ? `$${account.snapshot.balance.toFixed(2)}` : "未登录"}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </SectionCard>
                    );
                  })}
                </section>
              </>
            )}

            {nav === "settings" && (
              <>
                <SectionCard title="当前账号详情" subtitle="当前所选账号的余额、全部订阅和全部 API Keys">
                  {visibleSnapshot ? (
                    <div className="stack-list">
                      <div className="summary-stat">
                        <span>余额</span>
                        <strong>${visibleSnapshot.balance.toFixed(2)}</strong>
                      </div>
                      <div className="summary-stat">
                        <span>订阅总数</span>
                        <strong>{visibleSnapshot.subscriptions.length}</strong>
                      </div>
                      <div className="summary-stat">
                        <span>Key 总数 / 活跃</span>
                        <strong>
                          {visibleSnapshot.stats.totalApiKeys} / {visibleSnapshot.stats.activeApiKeys}
                        </strong>
                      </div>
                      <div className="account-detail-grid">
                        <div className="account-detail-column">
                          <div className="section-mini-title">全部订阅</div>
                          <SubscriptionList subscriptions={visibleSnapshot.subscriptions} />
                        </div>
                        <div className="account-detail-column">
                          <div className="section-mini-title">全部 API Keys</div>
                          <ApiKeyList keys={visibleSnapshot.keys} />
                        </div>
                      </div>
                      <div className="summary-stat">
                        <span>本地累计请求记录</span>
                        <strong>{visibleHistory.length}</strong>
                      </div>
                      <div className="summary-stat">
                        <span>本次最新拉取</span>
                        <strong>{latestHistory.length}</strong>
                      </div>
                    </div>
                  ) : (
                    <EmptyState title="还没有当前账号详情" detail="先登录并刷新当前账号。" compact />
                  )}
                </SectionCard>
                <SectionCard title="请求记录详情" subtitle="本地累计存储, 新数据会持续追加并标记是否为本次最新">
                  {visibleSnapshot ? (
                    <div className="stack-list">
                      <div className="detail-toolbar">
                        <div className="summary-stat compact-stat">
                          <span>最后刷新</span>
                          <strong>{formatTime(visibleSnapshot.fetchedAt)}</strong>
                        </div>
                        <div className="summary-stat compact-stat">
                          <span>最新命中</span>
                          <strong>{latestHistory.length}</strong>
                        </div>
                      </div>
                      <div className="table-list">
                        {visibleHistory.slice(0, 16).map((row) => (
                          <button
                            key={`${row.id}-${row.firstSeenAt}`}
                            type="button"
                            className={`history-row ${selectedHistoryRow?.id === row.id ? "selected" : ""}`}
                            onClick={() => setSelectedHistoryRow(row)}
                          >
                            <div className="history-main">
                              <div className="history-title-row">
                                <strong>{row.model}</strong>
                                <span className={`latest-pill ${row.isLatest ? "yes" : "no"}`}>
                                  {row.isLatest ? "最新" : "历史"}
                                </span>
                              </div>
                              <p>{row.apiKeyName ?? "未知 Key"} / {row.endpoint ?? "-"}</p>
                              <small>
                                请求时间 {formatTime(row.createdAt)} · 首次入库 {formatTime(row.firstSeenAt)}
                              </small>
                            </div>
                            <div className="table-numbers">
                              <strong>${row.actualCost.toFixed(5)}</strong>
                              <span>{compact(row.totalTokens)} tokens</span>
                              <span>{row.platform ?? "unknown"}</span>
                            </div>
                          </button>
                        ))}
                        {visibleHistory.length === 0 && (
                          <EmptyState title="还没有请求记录" detail="下一次刷新成功后会把 usage 记录写入本地历史。" compact />
                        )}
                      </div>
                      {selectedHistoryRow && (
                        <div className="request-detail-card">
                          <div className="request-detail-head">
                            <div>
                              <strong>{selectedHistoryRow.model}</strong>
                              <p>{selectedHistoryRow.subscriptionName ?? "未关联订阅"} / {selectedHistoryRow.platform ?? "unknown"}</p>
                            </div>
                            <span className={`latest-pill ${selectedHistoryRow.isLatest ? "yes" : "no"}`}>
                              {selectedHistoryRow.isLatest ? "当前最新数据" : "本地历史数据"}
                            </span>
                          </div>
                          <div className="request-detail-grid">
                            <DetailItem label="请求时间" value={formatTime(selectedHistoryRow.createdAt)} />
                            <DetailItem label="首次入库" value={formatTime(selectedHistoryRow.firstSeenAt)} />
                            <DetailItem label="最后命中" value={formatTime(selectedHistoryRow.lastSeenAt)} />
                            <DetailItem label="API Key" value={selectedHistoryRow.apiKeyName ?? "未知"} />
                            <DetailItem label="Endpoint" value={selectedHistoryRow.endpoint ?? "-"} />
                            <DetailItem label="实际成本" value={`$${selectedHistoryRow.actualCost.toFixed(6)}`} />
                            <DetailItem label="标准成本" value={`$${selectedHistoryRow.totalCost.toFixed(6)}`} />
                            <DetailItem label="输入 Tokens" value={compact(selectedHistoryRow.inputTokens)} />
                            <DetailItem label="输出 Tokens" value={compact(selectedHistoryRow.outputTokens)} />
                            <DetailItem label="总 Tokens" value={compact(selectedHistoryRow.totalTokens)} />
                            <DetailItem label="首 Token 延迟" value={selectedHistoryRow.firstTokenMs ? `${selectedHistoryRow.firstTokenMs} ms` : "-"} />
                            <DetailItem label="总耗时" value={selectedHistoryRow.durationMs ? `${selectedHistoryRow.durationMs} ms` : "-"} />
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <EmptyState title="还没有请求记录详情" detail="先登录并刷新当前账号, 这里会展示本地累积的请求历史。" compact />
                  )}
                </SectionCard>
              </>
            )}

            {nav === "keys" && (
              <section className="content-grid">
                <SectionCard
                  title="密钥管理"
                  subtitle="对齐用户网页版的创建、编辑、启停、删除与重置动作"
                  actions={
                    <button className="primary-button" onClick={openNewKey}>
                      <Plus size={16} />
                      新增密钥
                    </button>
                  }
                >
                  <div className="table-list wide">
                    {managedKeys?.items.map((key) => (
                      <div key={key.id} className="table-row wide">
                        <div className="row-main">
                          <strong>{key.name}</strong>
                          <p>{key.groupName ?? "未分组"} / {key.platform ?? "unknown"}</p>
                          <small>{key.rawKey ? maskSecret(key.rawKey) : "自定义密钥未暴露"}</small>
                        </div>
                        <div className="row-meta">
                          <span>额度 ${Number(key.quota ?? 0).toFixed(2)}</span>
                          <span>{key.lastUsedAt ? formatTime(key.lastUsedAt) : "最近未使用"}</span>
                        </div>
                        <div className="row-actions wrap-actions">
                          <StatusBadge state={key.status === "active" ? "ready" : "expired"} />
                          <button className="inline-text-button" onClick={() => void openEditKey(key.id)}>
                            编辑
                          </button>
                          <button className="inline-text-button" onClick={() => void handleToggleKeyStatus(key)}>
                            {key.status === "active" ? "停用" : "启用"}
                          </button>
                          <button className="inline-text-button" onClick={() => void handleResetQuota(key)}>
                            重置额度
                          </button>
                          <button className="inline-text-button" onClick={() => void handleResetRateLimitUsage(key)}>
                            重置限流
                          </button>
                          <button className="inline-text-button danger" onClick={() => void handleDeleteKey(key.id)}>
                            删除
                          </button>
                        </div>
                      </div>
                    ))}
                    {(!managedKeys || managedKeys.items.length === 0) && (
                      <EmptyState title="当前没有密钥数据" detail="先登录并刷新当前账号后再管理密钥。" compact />
                    )}
                  </div>
                </SectionCard>
                <SectionCard title="可用分组" subtitle="当前账号真实可创建密钥的分组能力">
                  <div className="stack-list">
                    {groups.map((group) => (
                      <div key={group.id} className="subscription-card">
                        <div className="subscription-card-head">
                          <div>
                            <strong>{group.name}</strong>
                            <p>{group.platform} / {group.subscriptionType ?? "standard"}</p>
                          </div>
                          <div className="table-numbers">
                            <span>x{group.rateMultiplier.toFixed(2)}</span>
                            <strong>{group.allowMessagesDispatch ? "支持调度" : "仅直连"}</strong>
                          </div>
                        </div>
                        <div className="summary-stat">
                          <span>日 / 周 / 月额度</span>
                          <strong>
                            ${Number(group.dailyLimitUsd ?? 0).toFixed(0)} / ${Number(group.weeklyLimitUsd ?? 0).toFixed(0)} / ${Number(group.monthlyLimitUsd ?? 0).toFixed(0)}
                          </strong>
                        </div>
                      </div>
                    ))}
                    {groups.length === 0 && (
                      <EmptyState title="当前没有可用分组" detail="若网页版能创建密钥，这里应返回可用 groups。" compact />
                    )}
                  </div>
                </SectionCard>
              </section>
            )}

            {nav === "usage" && (
              <section className="usage-view">
                <SectionCard
                  title="用量明细"
                  subtitle="按真实 usage 单条记录展示 API Key、模型、计费、耗时与 USER-AGENT"
                  actions={
                    <button className="ghost-button" onClick={() => void handleUsageSearch()}>
                      <RefreshCcw size={16} />
                      重新查询
                    </button>
                  }
                >
                  <div className="filter-grid">
                    <label className="field">
                      <span>API Key</span>
                      <select
                        value={usageApiKeyFilter}
                        onChange={(event) => setUsageApiKeyFilter(event.target.value)}
                      >
                        <option value="">全部</option>
                        {(managedKeys?.items ?? []).map((key) => (
                          <option key={key.id} value={key.id}>
                            {key.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="field range-field">
                      <span>时间范围</span>
                      <div className="range-picker-shell">
                        <button
                          type="button"
                          className={`range-trigger ${usageRangePickerOpen ? "open" : ""}`}
                          onClick={toggleUsageRangePicker}
                        >
                          <CalendarDays size={16} />
                          <span>{usageRangeLabel}</span>
                          <ChevronDown
                            size={16}
                            className={`range-trigger-chevron ${usageRangePickerOpen ? "open" : ""}`}
                          />
                        </button>
                        {usageRangePickerOpen && (
                          <div className="range-popover">
                            <div className="range-presets">
                              {USAGE_RANGE_PRESETS.map((preset) => (
                                <button
                                  key={preset.key}
                                  type="button"
                                  className={`range-preset ${usageRangePreset === preset.key ? "active" : ""}`}
                                  onClick={() => applyUsagePreset(preset.key)}
                                >
                                  {preset.label}
                                </button>
                              ))}
                            </div>
                            <div className="range-custom-grid">
                              <label className="field">
                                <span>开始日期</span>
                                <input
                                  type="date"
                                  value={usageDraftRange.startDate}
                                  onChange={(event) =>
                                    setUsageDraftRange((prev) => ({ ...prev, startDate: event.target.value }))
                                  }
                                />
                              </label>
                              <div className="range-arrow">
                                <ChevronRight size={16} />
                              </div>
                              <label className="field">
                                <span>结束日期</span>
                                <input
                                  type="date"
                                  value={usageDraftRange.endDate}
                                  onChange={(event) =>
                                    setUsageDraftRange((prev) => ({ ...prev, endDate: event.target.value }))
                                  }
                                />
                              </label>
                            </div>
                            <div className="range-popover-footer">
                              <button
                                type="button"
                                className="primary-button"
                                onClick={() => void applyUsageRange()}
                              >
                                应用
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  {usageStats && (
                    <div className="metric-grid compact-metrics">
                      <MetricCard label="请求数" value={String(usageStats.totalRequests)} hint="筛选结果" accent="sky" icon={<LayoutDashboard size={18} />} />
                      <MetricCard label="输入 Tokens" value={compact(usageStats.totalInputTokens)} hint="筛选结果" accent="emerald" icon={<MonitorDot size={18} />} />
                      <MetricCard label="输出 Tokens" value={compact(usageStats.totalOutputTokens)} hint="筛选结果" accent="indigo" icon={<MonitorDot size={18} />} />
                      <MetricCard
                        label="实际成本"
                        value={`$${usageStats.totalActualCost.toFixed(4)}`}
                        hint={`平均 ${formatDurationSeconds(usageStats.averageDurationMs)}`}
                        accent="violet"
                        icon={<BadgeDollarSign size={18} />}
                      />
                    </div>
                  )}
                  <div className="usage-table-wrap">
                    <table className="usage-table">
                      <colgroup>
                        <col style={{ width: "9%" }} />
                        <col style={{ width: "8%" }} />
                        <col style={{ width: "6%" }} />
                        <col style={{ width: "10%" }} />
                        <col style={{ width: "5%" }} />
                        <col style={{ width: "7%" }} />
                        <col style={{ width: "11%" }} />
                        <col style={{ width: "9%" }} />
                        <col style={{ width: "6%" }} />
                        <col style={{ width: "6%" }} />
                        <col style={{ width: "8%" }} />
                        <col style={{ width: "15%" }} />
                      </colgroup>
                      <thead>
                        <tr>
                          <th>API 密钥</th>
                          <th>模型</th>
                          <th>推理强度</th>
                          <th>端点</th>
                          <th>类型</th>
                          <th>计费模式</th>
                          <th>TOKEN</th>
                          <th>费用</th>
                          <th>首 Token</th>
                          <th>耗时</th>
                          <th>时间</th>
                          <th>USER-AGENT</th>
                        </tr>
                      </thead>
                      <tbody>
                        {usageRecords?.items.map((row) => (
                          <tr key={row.id}>
                            <td>
                              <div className="usage-cell usage-cell-primary">
                                <strong>{row.apiKeyName ?? "未知 Key"}</strong>
                                <span>{row.apiKeyId ? `#${row.apiKeyId}` : "未返回 Key ID"}</span>
                              </div>
                            </td>
                            <td>
                              <div className="usage-cell usage-cell-primary">
                                <strong>{row.model}</strong>
                                <span>{row.platform ?? row.subscriptionName ?? "unknown"}</span>
                              </div>
                            </td>
                            <td>{row.reasoningEffort ?? "-"}</td>
                            <td>
                              <div className="usage-cell">
                                <strong>{row.endpoint ?? "-"}</strong>
                                <span>{row.upstreamEndpoint ?? "-"}</span>
                              </div>
                            </td>
                            <td>{row.stream ? "stream" : row.requestType ?? "-"}</td>
                            <td>{formatBillingMode(row.billingMode, row.billingType)}</td>
                            <td>
                              <UsageDetailPopover
                                trigger={(
                                  <div className="usage-cell usage-cell-number">
                                    <strong>{compact(row.totalTokens)}</strong>
                                    <span>I {compact(row.inputTokens)} / O {compact(row.outputTokens)}</span>
                                    <span>C {compact((row.cacheCreationTokens ?? 0) + (row.cacheReadTokens ?? 0))}</span>
                                  </div>
                                )}
                                title="Token 明细"
                              >
                                <DetailItem label="输入 Token" value={compact(row.inputTokens)} />
                                <DetailItem label="输出 Token" value={compact(row.outputTokens)} />
                                <DetailItem label="缓存写入 Token" value={compact(row.cacheCreationTokens ?? 0)} />
                                <DetailItem label="缓存读取 Token" value={compact(row.cacheReadTokens ?? 0)} />
                                <DetailItem label="总 Token" value={compact(row.totalTokens)} />
                              </UsageDetailPopover>
                            </td>
                            <td>
                              <UsageDetailPopover
                                trigger={(
                                  <div className="usage-cell usage-cell-number">
                                    <strong>{formatUsd(row.actualCost)}</strong>
                                    <span>标准 {formatUsd(row.totalCost)}</span>
                                  </div>
                                )}
                                title="成本明细"
                              >
                                <DetailItem label="输入成本" value={formatUsd(row.inputCost)} />
                                <DetailItem label="输出成本" value={formatUsd(row.outputCost)} />
                                <DetailItem label="缓存写入成本" value={formatUsd(row.cacheCreationCost)} />
                                <DetailItem label="缓存读取成本" value={formatUsd(row.cacheReadCost)} />
                                <DetailItem
                                  label="输入单价"
                                  value={formatUsdPerMillion(row.inputCost, row.inputTokens)}
                                />
                                <DetailItem
                                  label="输出单价"
                                  value={formatUsdPerMillion(row.outputCost, row.outputTokens)}
                                />
                                <DetailItem
                                  label="缓存读单价"
                                  value={formatUsdPerMillion(row.cacheReadCost, row.cacheReadTokens)}
                                />
                                <DetailItem label="服务档位" value={row.groupName ?? row.subscriptionName ?? "-"} />
                                <DetailItem label="倍率" value={`${Number(row.rateMultiplier ?? 1).toFixed(2)}x`} />
                                <DetailItem label="原始" value={formatUsd(row.totalCost)} />
                                <DetailItem label="计费" value={formatUsd(row.actualCost)} />
                              </UsageDetailPopover>
                            </td>
                            <td>{formatMilliseconds(row.firstTokenMs)}</td>
                            <td>{formatMilliseconds(row.durationMs)}</td>
                            <td>{formatDateTimeFull(row.createdAt)}</td>
                            <td className="usage-user-agent" title={row.userAgent ?? "-"}>
                              {row.userAgent ?? "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {(!usageRecords || usageRecords.items.length === 0) && (
                      <EmptyState title="当前没有用量明细" detail="修改筛选后重新查询，或先刷新账号数据。" compact />
                    )}
                  </div>
                  {usageRecords && usageRecords.items.length > 0 && (
                    <div className="usage-pagination">
                      <div className="usage-pagination-meta">
                        <span>共 {usageRecords.total.toLocaleString()} 条</span>
                        <span>第 {usageRecords.page} / {usageRecords.pages} 页</span>
                      </div>
                      <div className="usage-pagination-actions">
                        <button
                          className="ghost-button"
                          disabled={usageRecords.page <= 1}
                          onClick={() => void handleUsagePageChange(usageRecords.page - 1)}
                        >
                          上一页
                        </button>
                        <button
                          className="ghost-button"
                          disabled={usageRecords.page >= usageRecords.pages}
                          onClick={() => void handleUsagePageChange(usageRecords.page + 1)}
                        >
                          下一页
                        </button>
                      </div>
                    </div>
                  )}
                </SectionCard>
                <div className="usage-insights-grid">
                  <SectionCard title="趋势" subtitle="对齐 dashboard/trend 接口">
                    {usageTrend?.trend?.length ? (
                      <div className="chart-wrap tall">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart
                            data={usageTrend.trend.map((item) => ({
                              bucket: item.date,
                              actualCost: item.actualCost ?? 0,
                              requests: item.requests,
                              totalTokens: item.totalTokens ?? 0
                            }))}
                          >
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-strong)" />
                            <XAxis dataKey="bucket" stroke="var(--text-subtle)" tickLine={false} axisLine={false} />
                            <YAxis stroke="var(--text-subtle)" tickLine={false} axisLine={false} />
                            <Tooltip />
                            <Area type="monotone" dataKey="actualCost" stroke="#53cdb5" fill="rgba(83, 205, 181, 0.22)" strokeWidth={2} />
                            <Area type="monotone" dataKey="requests" stroke="#7aa2ff" fill="transparent" strokeWidth={2} />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    ) : (
                      <EmptyState title="当前没有趋势数据" detail="站点未返回 dashboard/trend 数据。" compact />
                    )}
                  </SectionCard>
                  <SectionCard title="模型分布" subtitle="对齐 dashboard/models 接口">
                    <div className="table-list">
                      {usageModels?.models.map((model) => (
                        <div key={model.model} className="table-row">
                          <div>
                            <strong>{model.model}</strong>
                            <p>{model.requests.toLocaleString()} 请求 / {compact(model.totalTokens)} tokens</p>
                          </div>
                          <div className="table-numbers">
                            <strong>${Number(model.actualCost ?? model.cost ?? 0).toFixed(4)}</strong>
                          </div>
                        </div>
                      ))}
                    </div>
                  </SectionCard>
                </div>
              </section>
            )}

            {nav === "subscriptions" && (
              <section className="content-grid">
                <SectionCard title="订阅视图" subtitle="当前账号全部订阅与订阅摘要">
                  {visibleSnapshot ? (
                    <SubscriptionList subscriptions={visibleSnapshot.subscriptions} />
                  ) : (
                    <EmptyState title="当前没有订阅数据" detail="先登录并刷新当前账号。" compact />
                  )}
                </SectionCard>
                <SectionCard title="订阅摘要" subtitle="对齐 subscriptions/summary 接口">
                  {subscriptionSummary ? (
                    <div className="stack-list">
                      <div className="summary-stat">
                        <span>活跃订阅数</span>
                        <strong>{subscriptionSummary.activeCount}</strong>
                      </div>
                      <div className="summary-stat">
                        <span>累计已用金额</span>
                        <strong>${subscriptionSummary.totalUsedUsd.toFixed(4)}</strong>
                      </div>
                      <div className="table-list">
                        {subscriptionSummary.subscriptions.map((item) => (
                          <div key={`${item.id}-${item.groupId}`} className="table-row">
                            <div>
                              <strong>{item.groupName}</strong>
                              <p>{item.status}</p>
                            </div>
                            <div className="table-numbers">
                              <span>日用量 ${item.dailyUsedUsd.toFixed(2)} / ${item.dailyLimitUsd.toFixed(2)}</span>
                              <span>{item.expiresAt ? formatTime(item.expiresAt) : "无到期时间"}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <EmptyState title="当前没有订阅摘要" detail="站点未返回 subscriptions/summary 数据。" compact />
                  )}
                </SectionCard>
              </section>
            )}

            {nav === "keyUsage" && (
              <section className="content-grid">
                <SectionCard title="单 Key 用量" subtitle="对齐 key-usage 页面与 daily usage 接口">
                  <div className="filter-grid">
                    <label className="field">
                      <span>选择 API Key</span>
                      <select
                        value={keyUsageKeyId}
                        onChange={(event) => void handleLoadKeyUsage(event.target.value)}
                      >
                        <option value="">请选择</option>
                        {(managedKeys?.items ?? []).map((key) => (
                          <option key={key.id} value={key.id}>
                            {key.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="table-list">
                    {keyUsageRows.map((row) => (
                      <div key={row.date} className="table-row">
                        <div>
                          <strong>{row.date}</strong>
                          <p>{row.requests.toLocaleString()} 请求</p>
                        </div>
                        <div className="table-numbers">
                          <span>{compact(row.totalTokens ?? 0)} tokens</span>
                          <strong>${Number(row.actualCost ?? row.totalCost ?? 0).toFixed(4)}</strong>
                        </div>
                      </div>
                    ))}
                    {keyUsageRows.length === 0 && (
                      <EmptyState title="当前没有单 Key 用量" detail="选择一个密钥后会查询最近 30 天的每日用量。" compact />
                    )}
                  </div>
                </SectionCard>
                <SectionCard title="当前 Key 概览" subtitle="额度与限流命中情况">
                  {managedKeys?.items.find((item) => item.id === keyUsageKeyId) ? (
                    <KeyRateSummary keyRecord={managedKeys.items.find((item) => item.id === keyUsageKeyId)!} />
                  ) : (
                    <EmptyState title="还没有选中密钥" detail="先从左侧选择账号，再在这里选择一个 API Key。" compact />
                  )}
                </SectionCard>
              </section>
            )}

            {nav === "profile" && (
              <section className="content-grid">
                <SectionCard title="个人资料" subtitle="对齐 user/profile 与 user 更新接口">
                  {profileRecord ? (
                    <div className="stack-list">
                      <label className="field">
                        <span>邮箱</span>
                        <input
                          value={profileForm.email ?? ""}
                          onChange={(event) => setProfileForm((prev) => ({ ...prev, email: event.target.value }))}
                        />
                      </label>
                      <label className="field">
                        <span>用户名</span>
                        <input
                          value={profileForm.username ?? ""}
                          onChange={(event) => setProfileForm((prev) => ({ ...prev, username: event.target.value }))}
                        />
                      </label>
                      <div className="summary-stat">
                        <span>并发数 / RPM 限制</span>
                        <strong>{profileRecord.concurrency} / {profileRecord.rpmLimit ?? 0}</strong>
                      </div>
                      <button className="primary-button" onClick={() => void handleProfileSave()}>
                        保存资料
                      </button>
                    </div>
                  ) : (
                    <EmptyState title="当前没有资料数据" detail="先登录并刷新当前账号。" compact />
                  )}
                </SectionCard>
                <SectionCard title="密码与通知" subtitle="改密、通知邮箱与账号绑定状态">
                  <div className="stack-list">
                    <label className="field">
                      <span>旧密码</span>
                      <input
                        type="password"
                        value={profilePassword.oldPassword}
                        onChange={(event) => setProfilePassword((prev) => ({ ...prev, oldPassword: event.target.value }))}
                      />
                    </label>
                    <label className="field">
                      <span>新密码</span>
                      <input
                        type="password"
                        value={profilePassword.newPassword}
                        onChange={(event) => setProfilePassword((prev) => ({ ...prev, newPassword: event.target.value }))}
                      />
                    </label>
                    <button className="ghost-button" onClick={() => void handleProfilePasswordChange()}>
                      修改密码
                    </button>
                    <div className="summary-stat">
                      <span>通知邮箱草稿</span>
                      <strong>{notifyEmailDraft.target || "未验证"}</strong>
                    </div>
                    <label className="field">
                      <span>通知邮箱</span>
                      <input
                        value={notifyEmailDraft.email}
                        onChange={(event) => setNotifyEmailDraft((prev) => ({ ...prev, email: event.target.value }))}
                      />
                    </label>
                    <div className="inline-actions">
                      <button className="ghost-button" onClick={() => void handleNotifyEmailSend()}>
                        发送验证码
                      </button>
                      <input
                        className="inline-input"
                        value={notifyEmailDraft.code}
                        onChange={(event) => setNotifyEmailDraft((prev) => ({ ...prev, code: event.target.value }))}
                        placeholder="验证码"
                      />
                      <button className="primary-button" onClick={() => void handleNotifyEmailVerify()}>
                        验证
                      </button>
                    </div>
                    <div className="table-list">
                      {Object.entries(profileRecord?.identityBindings ?? {}).map(([provider, binding]) => (
                        <div key={provider} className="table-row">
                          <div>
                            <strong>{provider}</strong>
                            <p>{binding.displayName ?? binding.subjectHint ?? "未绑定"}</p>
                          </div>
                          <div className="table-numbers">
                            <span>{binding.bound ? "已绑定" : "未绑定"}</span>
                            {binding.canUnbind && (
                              <button className="inline-text-button danger" onClick={() => void handleUnbind(provider)}>
                                解绑
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </SectionCard>
                <SectionCard title="平台配额" subtitle="对齐 user/platform-quotas 接口">
                  <div className="table-list">
                    {(platformQuotas?.platformQuotas ?? []).map((quota, index) => (
                      <div key={`${quota.platform ?? "platform"}-${index}`} className="table-row">
                        <div>
                          <strong>{quota.platform ?? "unknown"}</strong>
                          <p>已用 {Number(quota.used ?? 0).toFixed(2)} / 总额 {Number(quota.quota ?? 0).toFixed(2)}</p>
                        </div>
                        <div className="table-numbers">
                          <strong>{Number(quota.remaining ?? 0).toFixed(2)}</strong>
                        </div>
                      </div>
                    ))}
                    {(!platformQuotas || platformQuotas.platformQuotas.length === 0) && (
                      <EmptyState title="当前没有平台配额" detail="站点当前返回为空，这与网页版一致。" compact />
                    )}
                  </div>
                </SectionCard>
              </section>
            )}

            {nav === "trends" && (
              <section className="content-grid">
                <SectionCard title="当前账号趋势" subtitle="actual cost / requests / total tokens">
                  {visibleSnapshot ? (
                    <div className="chart-wrap tall">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={visibleSnapshot.trend}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-strong)" />
                          <XAxis dataKey="bucket" stroke="var(--text-subtle)" tickLine={false} axisLine={false} />
                          <YAxis stroke="var(--text-subtle)" tickLine={false} axisLine={false} />
                          <Tooltip />
                          <Area type="monotone" dataKey="actualCost" stroke="#53cdb5" fill="rgba(83, 205, 181, 0.22)" strokeWidth={2} />
                          <Area type="monotone" dataKey="totalTokens" stroke="#9e8bff" fill="transparent" strokeWidth={2} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <EmptyState title="还没有趋势数据" detail="先为账号完成登录并执行一次刷新。" compact />
                  )}
                </SectionCard>
                <SectionCard title="当前账号平台分布" subtitle="按平台聚合成本">
                  {visibleSnapshot ? (
                    <>
                      <div className="legend-list">
                        {visibleSnapshot.stats.byPlatform.map((item) => (
                          <div key={item.platform} className="legend-row">
                            <span>{item.platform}</span>
                            <strong>${item.totalActualCost.toFixed(4)}</strong>
                          </div>
                        ))}
                      </div>
                      <div className="stack-list">
                        {visibleSnapshot.stats.byPlatform.map((item) => (
                          <div key={item.platform} className="bar-row">
                            <div className="bar-label">
                              <span>{item.platform}</span>
                              <strong>{compact(item.totalTokens)} tokens</strong>
                            </div>
                            <div className="bar-track">
                              <div
                                className="bar-fill"
                                style={{
                                  width: `${Math.min(
                                    100,
                                    (item.totalActualCost /
                                      Math.max(...visibleSnapshot.stats.byPlatform.map((value) => value.totalActualCost), 0.0001)) *
                                      100
                                  )}%`
                                }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <EmptyState title="没有可展示的平台分布" detail="当前账号尚未返回平台统计。" compact />
                  )}
                </SectionCard>
              </section>
            )}

            {nav === "alerts" && (
              <SectionCard title="告警列表" subtitle="按严重级别集中处理低余额、失效和拉取失败">
                <div className="stack-list">
                  {overview?.alerts.map((alert) => (
                    <div key={alert.id} className={`alert-item ${alert.severity}`}>
                      <div>
                        <strong>{alert.title}</strong>
                        <p>{alert.detail}</p>
                      </div>
                      <span>{formatTime(alert.createdAt)}</span>
                    </div>
                  ))}
                  {overview?.alerts.length === 0 && (
                    <EmptyState title="没有待处理告警" detail="所有已刷新账号都处于健康状态。" compact />
                  )}
                </div>
              </SectionCard>
            )}

            {nav === "systemSettings" && (
              <section className="content-grid">
                <SectionCard title="主题与展示" subtitle="浅色、深色、深蓝护眼三套主题可切换">
                  <div className="stack-list">
                    <button className={`theme-option ${theme === "light" ? "selected" : ""}`} onClick={() => setTheme("light")}>
                      浅色
                    </button>
                    <button className={`theme-option ${theme === "dark" ? "selected" : ""}`} onClick={() => setTheme("dark")}>
                      深色
                    </button>
                    <button
                      className={`theme-option ${theme === "deep-blue" ? "selected" : ""}`}
                      onClick={() => setTheme("deep-blue")}
                    >
                      深蓝护眼
                    </button>
                  </div>
                </SectionCard>
                <SectionCard title="当前实现说明" subtitle="本地 BFF 将承担登录、会话兼容与聚合">
                  <ul className="plain-list">
                    <li>前端只连接本地 `/api/*`，不直接跨域请求第三方站点。</li>
                    <li>后端会保存站点、账号元数据与会话快照，用于刷新与聚合。</li>
                    <li>登录层会兼容多个候选 auth/profile 路径，降低 Sub2API 版本漂移风险。</li>
                  </ul>
                </SectionCard>
              </section>
            )}
          </div>
        )}
      </main>

      {accountManagerOpen && (
        <Modal
          title={selectedSite ? `${selectedSite.name} · 账号管理` : "账号管理"}
          onClose={() => setAccountManagerOpen(false)}
          size="wide"
          footer={
            <button className="ghost-button" onClick={() => setAccountManagerOpen(false)}>
              关闭
            </button>
          }
        >
          <p className="modal-hint">登录、刷新、预警阈值与当前会话状态都集中放在这里维护。</p>
          <div className="table-list wide">
            {filteredAccounts.map((account) => (
              <div key={account.id} className="table-row wide">
                <div className="row-main">
                  <strong>{account.label}</strong>
                  <p>{account.email}</p>
                  <small>{account.site?.name ?? "未知站点"}</small>
                </div>
                <div className="row-meta">
                  <span>预警 ${account.balanceWarning.toFixed(2)}</span>
                  <span>{account.snapshot ? formatTime(account.snapshot.fetchedAt) : "未拉取"}</span>
                </div>
                <div className="row-actions">
                  <StatusBadge state={account.sessionState} />
                  <button
                    className="inline-text-button"
                    onClick={() => {
                      setAccountManagerOpen(false);
                      openPasswordLogin(account);
                    }}
                  >
                    登录
                  </button>
                  <button className="inline-text-button" onClick={() => void handleRefreshAccount(account.id)}>
                    刷新
                  </button>
                  <button
                    className="inline-text-button"
                    onClick={() => {
                      setAccountManagerOpen(false);
                      openEditAccount(account);
                    }}
                  >
                    编辑
                  </button>
                  <button className="inline-text-button danger" onClick={() => void handleRemoveAccount(account.id)}>
                    删除
                  </button>
                </div>
              </div>
            ))}
            {filteredAccounts.length === 0 && (
              <EmptyState title="还没有账号" detail="先为当前站点添加一个账号。" compact />
            )}
          </div>
        </Modal>
      )}

      {siteFormOpen && (
        <Modal
          title={editingSite ? "编辑站点" : "新增站点"}
          onClose={() => setSiteFormOpen(false)}
          onSubmit={() => void submitSiteForm()}
          submitText={editingSite ? "更新站点" : "创建站点"}
        >
          <label className="field">
            <span>站点名称</span>
            <input
              value={siteForm.name}
              onChange={(event) => setSiteForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="AI INPUT"
            />
          </label>
          <label className="field">
            <span>Base URL</span>
            <input
              value={siteForm.baseUrl}
              onChange={(event) => setSiteForm((prev) => ({ ...prev, baseUrl: event.target.value }))}
              placeholder="https://ai.input.im"
            />
          </label>
        </Modal>
      )}

      {accountFormOpen && (
        <Modal
          title={editingAccount ? "编辑账号" : "新增账号"}
          onClose={() => setAccountFormOpen(false)}
          onSubmit={() => void submitAccountForm()}
          submitText={editingAccount ? "更新账号" : "创建账号"}
        >
          <div className="form-callout">
            {editingAccount ? (
              <p>这里编辑的是账号资料，不改密码。若要重新登录，请在账号卡片点“登录”，密码不会被本地持久保存。</p>
            ) : (
              <p>这里可以直接填密码。填写后会在创建账号后自动登录并拉取数据；留空则只创建账号。运行消息会显示在主工作区标题下方的提示横幅里。</p>
            )}
          </div>
          <label className="field">
            <span>所属站点</span>
            <div className="site-picker">
              <button
                type="button"
                className={`site-picker-trigger ${accountSitePickerOpen ? "open" : ""}`}
                onClick={() => {
                  if (sites.length === 0) return;
                  setAccountSitePickerOpen((prev) => !prev);
                }}
                disabled={sites.length === 0}
                aria-expanded={accountSitePickerOpen}
                aria-label="选择所属站点"
              >
                <div className="site-picker-copy">
                  <strong>{selectedAccountSite?.name ?? (sites.length === 0 ? "请先新增站点" : "请选择站点")}</strong>
                  <span>{selectedAccountSite?.baseUrl ?? "账号会归属到这里选中的站点"}</span>
                </div>
                <ChevronDown size={16} className={`site-picker-icon ${accountSitePickerOpen ? "open" : ""}`} />
              </button>
              {accountSitePickerOpen && sites.length > 0 && (
                <div className="site-picker-menu">
                  {sites.map((site) => (
                    <button
                      key={site.id}
                      type="button"
                      className={`site-picker-option ${site.id === accountForm.siteId ? "selected" : ""}`}
                      onClick={() => {
                        setAccountForm((prev) => ({ ...prev, siteId: site.id }));
                        setAccountSitePickerOpen(false);
                      }}
                    >
                      <strong>{site.name}</strong>
                      <span>{site.baseUrl}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {sites.length === 0 && <p className="field-help">请先新增站点，再添加账号。</p>}
          </label>
          <label className="field">
            <span>账号标签</span>
            <input
              value={accountForm.label}
              onChange={(event) => setAccountForm((prev) => ({ ...prev, label: event.target.value }))}
              placeholder="主账号"
            />
          </label>
          <label className="field">
            <span>登录邮箱</span>
            <input
              value={accountForm.email}
              onChange={(event) => setAccountForm((prev) => ({ ...prev, email: event.target.value }))}
              placeholder="name@example.com"
            />
          </label>
          {!editingAccount && (
            <label className="field">
              <span>登录密码</span>
              <input
                type="password"
                value={accountPassword}
                onChange={(event) => setAccountPassword(event.target.value)}
                placeholder="可选。填写后创建完成会自动登录"
              />
              <p className="field-help">密码只用于当前登录请求，不会写入本地状态文件。</p>
            </label>
          )}
          <label className="field">
            <span>低余额预警阈值</span>
            <input
              type="number"
              value={accountForm.balanceWarning}
              onChange={(event) =>
                setAccountForm((prev) => ({ ...prev, balanceWarning: Number(event.target.value) || 0 }))
              }
            />
          </label>
        </Modal>
      )}

      {loginModal && (
        <Modal
          title={loginModal.phase === "password" ? `登录 ${loginModal.account.label}` : `验证 ${loginModal.account.label}`}
          onClose={() => setLoginModal(null)}
          onSubmit={() => void handleLogin()}
          submitText={loginModal.phase === "password" ? "登录并拉取" : "验证并继续"}
        >
          <p className="modal-hint">
            {loginModal.phase === "password"
              ? "仅在本地后端保存会话，不会在前端长期保存密码。"
              : "当前站点要求 2FA 验证。验证码通过后才会完成登录并拉取数据。"}
          </p>
          <label className="field">
            <span>邮箱</span>
            <input
              value={
                loginModal.phase === "2fa"
                  ? loginModal.emailMasked ?? maskEmail(loginModal.account.email)
                  : loginModal.account.email
              }
              disabled
            />
          </label>
          {loginModal.phase === "password" ? (
            <label className="field">
              <span>密码</span>
              <input
                type="password"
                value={loginModal.password}
                onChange={(event) =>
                  setLoginModal((prev) => (prev ? { ...prev, password: event.target.value } : prev))
                }
                placeholder="输入当前账号密码"
              />
            </label>
          ) : (
            <label className="field">
              <span>2FA 验证码</span>
              <input
                value={loginModal.code}
                onChange={(event) =>
                  setLoginModal((prev) => (prev ? { ...prev, code: event.target.value } : prev))
                }
                placeholder="输入 6 位验证码"
              />
              <p className="field-help">若本地时间漂移较大，验证码可能会被站点拒绝。</p>
            </label>
          )}
        </Modal>
      )}
    </div>
  );
}

function navTitle(key: NavKey) {
  switch (key) {
    case "overview":
      return "总览面板";
    case "sites":
      return "设置";
    case "accounts":
      return "设置";
    case "keys":
      return "密钥管理";
    case "usage":
      return "用量明细";
    case "subscriptions":
      return "订阅视图";
    case "keyUsage":
      return "单 Key 用量";
    case "profile":
      return "个人资料";
    case "trends":
      return "趋势视图";
    case "alerts":
      return "告警中心";
    case "settings":
      return "设置";
    case "systemSettings":
      return "系统设置";
  }
}

function StatusBadge({ state }: { state: AccountRuntime["sessionState"] }) {
  const label = state === "ready" ? "已连接" : state === "expired" ? "已失效" : "未登录";
  return <span className={`status-pill ${state}`}>{label}</span>;
}

function MetricCard({
  label,
  value,
  hint,
  accent,
  icon
}: {
  label: string;
  value: string;
  hint: string;
  accent: "emerald" | "sky" | "violet" | "amber" | "indigo" | "rose";
  icon: ReactNode;
}) {
  return (
    <article className="metric-card">
      <div className={`metric-icon ${accent}`}>{icon}</div>
      <div>
        <p className="metric-label">{label}</p>
        <h3 className="metric-value">{value}</h3>
        <p className="metric-hint">{hint}</p>
      </div>
    </article>
  );
}

function UsageDetailPopover({
  title,
  trigger,
  children
}: {
  title: string;
  trigger: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="usage-detail-popover">
      <div className="usage-detail-trigger" title={title}>
        {trigger}
      </div>
      <div className="usage-detail-panel">
        <div className="usage-detail-panel-title">{title}</div>
        <div className="usage-detail-grid">{children}</div>
      </div>
    </div>
  );
}

function SectionCard({
  title,
  subtitle,
  children,
  actions
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="section-card">
      <header className="section-card-header">
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        {actions && <div className="section-card-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

function Modal({
  title,
  children,
  onClose,
  onSubmit,
  submitText,
  footer,
  size = "default"
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onSubmit?: () => void;
  submitText?: string;
  footer?: ReactNode;
  size?: "default" | "wide";
}) {
  return (
    <div className="modal-backdrop">
      <div className={`modal-card ${size === "wide" ? "wide" : ""}`}>
        <header className="modal-header">
          <h3>{title}</h3>
          <button className="inline-text-button" onClick={onClose}>
            关闭
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {(footer || onSubmit) && (
          <footer className="modal-footer">
            {footer ?? (
              <>
                <button className="ghost-button" onClick={onClose}>
                  取消
                </button>
                <button className="primary-button" onClick={onSubmit}>
                  {submitText}
                </button>
              </>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}

function EmptyState({
  title,
  detail,
  compact = false
}: {
  title: string;
  detail: string;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state ${compact ? "compact" : ""}`}>
      <Bell size={compact ? 18 : 22} />
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SubscriptionList({ subscriptions }: { subscriptions: SubscriptionRecord[] }) {
  if (subscriptions.length === 0) {
    return <EmptyState title="当前没有订阅数据" detail="该账号未返回有效订阅或套餐信息。" compact />;
  }
  return (
    <div className="stack-list">
      {subscriptions.map((subscription) => (
        <div key={subscription.id} className="subscription-card">
          <div className="subscription-card-head">
            <div>
              <strong>{subscription.name}</strong>
              <p>
                {subscription.groupName ?? "未分组"} / {subscription.platform ?? "unknown"}
              </p>
            </div>
            <div className="table-numbers">
              <span>{subscription.status}</span>
              <strong>
                {subscription.expiresAt ? formatTime(subscription.expiresAt) : "无到期时间"}
              </strong>
            </div>
          </div>
          {renderQuotaWindow("每日额度", subscription.daily)}
          {renderQuotaWindow("每周额度", subscription.weekly)}
          {renderQuotaWindow("每月额度", subscription.monthly)}
        </div>
      ))}
    </div>
  );
}

function ApiKeyList({ keys }: { keys: KeyRecord[] }) {
  if (keys.length === 0) {
    return <EmptyState title="当前没有 Key 数据" detail="该账号没有返回 API keys 列表。" compact />;
  }
  return (
    <div className="table-list">
      {keys.map((key) => (
        <div key={key.id} className="table-row">
          <div>
            <strong>{key.name}</strong>
            <p>{key.groupName ?? "未分组"} / {key.platform ?? "unknown"}</p>
          </div>
          <div className="table-numbers">
            <span>{key.status}</span>
            <span>{key.lastUsedAt ? formatTime(key.lastUsedAt) : "最近未使用"}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function KeyRateSummary({ keyRecord }: { keyRecord: ManagedKeyRecord }) {
  return (
    <div className="stack-list">
      <div className="summary-stat">
        <span>密钥名称</span>
        <strong>{keyRecord.name}</strong>
      </div>
      <div className="summary-stat">
        <span>状态</span>
        <strong>{keyRecord.status}</strong>
      </div>
      <div className="summary-stat">
        <span>额度 / 已用</span>
        <strong>
          ${Number(keyRecord.quota ?? 0).toFixed(2)} / ${Number(keyRecord.quotaUsed ?? 0).toFixed(2)}
        </strong>
      </div>
      <div className="summary-stat">
        <span>5h / 1d / 7d 限流</span>
        <strong>
          ${Number(keyRecord.rateLimit5h ?? 0).toFixed(2)} / ${Number(keyRecord.rateLimit1d ?? 0).toFixed(2)} / ${Number(keyRecord.rateLimit7d ?? 0).toFixed(2)}
        </strong>
      </div>
      <div className="summary-stat">
        <span>5h / 1d / 7d 已用</span>
        <strong>
          ${Number(keyRecord.usage5h ?? 0).toFixed(2)} / ${Number(keyRecord.usage1d ?? 0).toFixed(2)} / ${Number(keyRecord.usage7d ?? 0).toFixed(2)}
        </strong>
      </div>
      <div className="summary-stat">
        <span>过期时间</span>
        <strong>{keyRecord.expiresAt ? formatTime(keyRecord.expiresAt) : "无到期时间"}</strong>
      </div>
    </div>
  );
}

function renderQuotaWindow(
  label: string,
  windowValue:
    | {
        current: number;
        limit: number;
        windowStart?: string | null;
      }
    | null
    | undefined
) {
  if (!windowValue) return null;
  const percent = Math.min(100, (windowValue.current / Math.max(windowValue.limit, 0.0001)) * 100);
  return (
    <div className="quota-row">
      <div className="bar-label">
        <span>{label}</span>
        <strong>
          ${windowValue.current.toFixed(2)} / ${windowValue.limit.toFixed(2)}
        </strong>
      </div>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${percent}%` }} />
      </div>
      {windowValue.windowStart && <p className="quota-hint">窗口起点: {formatTime(windowValue.windowStart)}</p>}
    </div>
  );
}

function compact(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function formatDateTimeFull(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function formatMilliseconds(value?: number | null) {
  if (value === null || value === undefined || value <= 0) return "-";
  return `${Math.round(value)} ms`;
}

function formatDurationSeconds(value?: number | null) {
  if (value === null || value === undefined || value <= 0) return "-";
  return `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} s`;
}

function formatUsd(value?: number | null, digits = 6) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `$${Number(value).toFixed(digits)}`;
}

function formatUsdPerMillion(cost?: number | null, tokens?: number | null) {
  if (!cost || !tokens || tokens <= 0) return "-";
  return `${formatUsd((cost / tokens) * 1_000_000, 4)} / 1M Token`;
}

function formatBillingMode(mode?: string | null, billingType?: number | null) {
  if (mode && billingType) return `${mode} / #${billingType}`;
  if (mode) return mode;
  if (billingType) return `#${billingType}`;
  return "-";
}

function buildPresetRange(preset: (typeof USAGE_RANGE_PRESETS)[number]["key"]) {
  const today = new Date();
  const start = new Date(today);
  const end = new Date(today);
  switch (preset) {
    case "today":
      break;
    case "yesterday":
      start.setDate(today.getDate() - 1);
      end.setDate(today.getDate() - 1);
      break;
    case "last24Hours":
      start.setDate(today.getDate() - 1);
      break;
    case "last7Days":
      start.setDate(today.getDate() - 6);
      break;
    case "last14Days":
      start.setDate(today.getDate() - 13);
      break;
    case "last30Days":
      start.setDate(today.getDate() - 29);
      break;
    case "thisMonth":
      start.setDate(1);
      break;
    case "lastMonth": {
      start.setMonth(today.getMonth() - 1, 1);
      end.setMonth(today.getMonth(), 0);
      break;
    }
  }
  return {
    startDate: toDateValue(start),
    endDate: toDateValue(end)
  };
}

function formatUsageRangeLabel(
  preset: (typeof USAGE_RANGE_PRESETS)[number]["key"],
  startDate: string,
  endDate: string
) {
  const presetLabel = USAGE_RANGE_PRESETS.find((item) => item.key === preset)?.label;
  if (presetLabel) return presetLabel;
  if (startDate && endDate) return `${startDate} - ${endDate}`;
  return "选择时间范围";
}

function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  if (local.length <= 3) {
    return `${local.charAt(0) || "*"}***@${domain}`;
  }
  return `${local.slice(0, 3)}***@${domain}`;
}

function maskSecret(value: string) {
  if (!value) return "";
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function toDateValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
