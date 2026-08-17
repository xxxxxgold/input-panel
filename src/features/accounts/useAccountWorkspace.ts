import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import {
  DISABLED_BALANCE_WARNING,
  normalizeBalanceWarning
} from "../../account-warning";
import type { SaveFeedbackHandler } from "../../shared/lib/save-feedback";
import type {
  AccountInput,
  AccountRuntime,
  AccountSyncStatusRecord,
  SiteEndpointTestResult,
  SiteFailoverStatusPayload,
  SiteRecord
} from "../../types";
import {
  clearSiteFailoverCooldown,
  completeAccount2fa,
  createAccount,
  createSite,
  getAccountSyncStatus,
  getSiteFailoverStatus,
  loginAccount,
  persistAccountCredential,
  removeAccount,
  removeSite,
  syncAccountData,
  testSiteEndpoint,
  updateAccount,
  updateSite
} from "./client";
import {
  createSiteConfigDraft,
  createSiteFallbackAddressDraft,
  findSiteFailoverAddressStatus,
  getSiteCooldownRemainingSeconds,
  MAX_SITE_FALLBACK_ADDRESSES,
  SITE_PRIMARY_ADDRESS_ROW_ID,
  siteDraftAddressBelongsToPersistedSite,
  siteInputFromDraft,
  type SiteConfigDraft
} from "./site-config-draft";
import { publishSiteFailoverStatus } from "./useSiteFailoverStatus";

export interface SiteAddressActionState {
  testing: boolean;
  clearing: boolean;
  result: SiteEndpointTestResult | null;
  error: string | null;
}

const defaultAccountForm: AccountInput = {
  siteId: "",
  label: "",
  email: "",
  balanceWarning: DISABLED_BALANCE_WARNING
};

export interface AccountLoginModalState {
  account: AccountRuntime;
  phase: "password" | "2fa";
  password: string;
  code: string;
  tempToken?: string;
  originBaseUrl?: string;
  emailMasked?: string | null;
}

interface RefreshAccountOptions {
  busyText?: string;
  successMessage?: string;
  silent?: boolean;
  triggerSource?: "manual" | "stale_auto";
  scope?: "core" | "keys" | "usage" | "full";
}

/** 总览协调结束后重放当前选择，且总览失败不反转已完成的账号操作。 */
export async function reconcileSelectedAccountSelection(input: {
  loadOverview: () => Promise<void>;
  refreshSelectedAccountSync: () => void;
  reportOverviewError: (cause: unknown) => void;
}) {
  let reconciled = true;
  try {
    await input.loadOverview();
  } catch (cause) {
    reconciled = false;
    input.reportOverviewError(cause);
  } finally {
    input.refreshSelectedAccountSync();
  }
  return reconciled;
}

export function useAccountWorkspace({
  sites,
  accounts,
  selectedSiteId,
  selectedAccountId,
  setSelectedSiteId,
  setSelectedAccountId,
  invalidateAccount,
  evictOverviewEntities,
  invalidateSite,
  invalidateAccountsForSite,
  refreshSelectedAccountSync,
  loadOverview,
  onSyncStatusChange,
  onSaveFeedback,
  setBusyText,
  setError
}: {
  sites: SiteRecord[];
  accounts: AccountRuntime[];
  selectedSiteId: string | null;
  selectedAccountId: string | null;
  setSelectedSiteId: (value: string | null) => void;
  setSelectedAccountId: (value: string | null) => void;
  invalidateAccount: (accountId: string) => void;
  evictOverviewEntities?: (input: { accountIds: string[]; siteIds?: string[] }) => void;
  invalidateSite?: (siteId: string) => void;
  invalidateAccountsForSite?: (siteId: string) => void;
  refreshSelectedAccountSync: () => void;
  loadOverview: (options?: { busyText?: string; successMessage?: string }) => Promise<void>;
  onSyncStatusChange?: (accountId: string, statuses: AccountSyncStatusRecord[]) => void;
  onSaveFeedback: SaveFeedbackHandler;
  setBusyText: (value: string | null) => void;
  setError: (value: string | null) => void;
}) {
  const [siteFormOpen, setSiteFormOpen] = useState(false);
  const [accountFormOpen, setAccountFormOpen] = useState(false);
  const [accountSitePickerOpen, setAccountSitePickerOpen] = useState(false);
  const [accountBalanceWarningInput, setAccountBalanceWarningInput] = useState(
    String(DISABLED_BALANCE_WARNING)
  );
  const [accountPassword, setAccountPassword] = useState("");
  const [accountManagerOpen, setAccountManagerOpen] = useState(false);
  const [accountSearch, setAccountSearch] = useState("");
  const [loginModal, setLoginModal] = useState<AccountLoginModalState | null>(null);
  const [editingSite, setEditingSite] = useState<SiteRecord | null>(null);
  const [editingAccount, setEditingAccount] = useState<AccountRuntime | null>(null);
  const [siteForm, setSiteForm] = useState<SiteConfigDraft>(createSiteConfigDraft);
  const [siteFormError, setSiteFormError] = useState<string | null>(null);
  const [siteFormSubmitting, setSiteFormSubmitting] = useState(false);
  const [siteFailoverStatus, setSiteFailoverStatus] = useState<SiteFailoverStatusPayload | null>(null);
  const [siteFailoverStatusLoading, setSiteFailoverStatusLoading] = useState(false);
  const [siteFailoverStatusError, setSiteFailoverStatusError] = useState<string | null>(null);
  const [siteStatusServerOffsetMs, setSiteStatusServerOffsetMs] = useState(0);
  const [siteStatusNowMs, setSiteStatusNowMs] = useState(Date.now());
  const [siteAddressActions, setSiteAddressActions] = useState<Record<string, SiteAddressActionState>>({});
  const [accountForm, setAccountForm] = useState<AccountInput>(defaultAccountForm);
  const [accountFormSubmitting, setAccountFormSubmitting] = useState(false);
  const siteFormRef = useRef(siteForm);
  const siteRequestGenerationRef = useRef(0);
  const siteStatusRequestSequenceRef = useRef(0);
  const siteAddressRequestSequenceRef = useRef(new Map<string, number>());
  const siteExpiredStatusRefreshKeyRef = useRef<string | null>(null);
  const siteFormSubmitInFlightRef = useRef(false);
  const accountFormSubmitInFlightRef = useRef(false);
  siteFormRef.current = siteForm;
  const updateSiteFormState: typeof setSiteForm = (value) => {
    setSiteFormError(null);
    setSiteForm((previous) => {
      const next = typeof value === "function" ? value(previous) : value;
      siteFormRef.current = next;
      return next;
    });
  };

  const deferredAccountSearch = useDeferredValue(accountSearch.trim().toLowerCase());
  const selectedAccountSite =
    sites.find((item) => item.id === accountForm.siteId) ?? null;
  const accountManagerAccounts = useMemo(() => {
    return accounts.filter((item) => {
      if (selectedSiteId && item.siteId !== selectedSiteId) {
        return false;
      }
      if (!deferredAccountSearch) {
        return true;
      }
      return (
        item.label.toLowerCase().includes(deferredAccountSearch) ||
        item.email.toLowerCase().includes(deferredAccountSearch) ||
        item.site?.name?.toLowerCase().includes(deferredAccountSearch)
      );
    });
  }, [accounts, deferredAccountSearch, selectedSiteId]);

  useEffect(() => {
    if (
      !siteFormOpen
      || !siteFailoverStatus?.addresses.some((address) => address.status === "cooling")
    ) {
      return;
    }

    const updateClock = () => setSiteStatusNowMs(Date.now() + siteStatusServerOffsetMs);
    updateClock();
    const timer = globalThis.setInterval(updateClock, 1_000);
    return () => globalThis.clearInterval(timer);
  }, [siteFailoverStatus, siteFormOpen, siteStatusServerOffsetMs]);

  useEffect(() => {
    if (!editingSite || !siteFailoverStatus || !siteFormOpen) {
      return;
    }
    const expiredAddresses = siteFailoverStatus.addresses.filter(
      (address) =>
        address.status === "cooling"
        && getSiteCooldownRemainingSeconds(address, siteStatusNowMs) <= 0
    );
    if (expiredAddresses.length === 0) {
      return;
    }

    const refreshKey = [
      siteRequestGenerationRef.current,
      siteFailoverStatus.evaluationRevision,
      ...expiredAddresses.map((address) => `${address.baseUrl}:${address.cooldownUntil ?? ""}`)
    ].join("|");
    if (siteExpiredStatusRefreshKeyRef.current === refreshKey) {
      return;
    }
    siteExpiredStatusRefreshKeyRef.current = refreshKey;
    void loadSiteFailoverStatus(editingSite.id, siteRequestGenerationRef.current);
  }, [editingSite, siteFailoverStatus, siteFormOpen, siteStatusNowMs]);

  function resetSiteFormRuntimeState() {
    siteAddressRequestSequenceRef.current.clear();
    siteExpiredStatusRefreshKeyRef.current = null;
    setSiteFormError(null);
    setSiteFailoverStatus(null);
    setSiteFailoverStatusLoading(false);
    setSiteFailoverStatusError(null);
    setSiteStatusServerOffsetMs(0);
    setSiteStatusNowMs(Date.now());
    setSiteAddressActions({});
  }

  function commitSiteFailoverStatus(status: SiteFailoverStatusPayload) {
    const parsedServerNow = Date.parse(status.serverNow);
    const serverOffsetMs = Number.isFinite(parsedServerNow)
      ? parsedServerNow - Date.now()
      : 0;
    setSiteStatusServerOffsetMs(serverOffsetMs);
    setSiteStatusNowMs(Date.now() + serverOffsetMs);
    setSiteFailoverStatus(status);
    setSiteFailoverStatusError(null);
    publishSiteFailoverStatus(status);
  }

  async function loadSiteFailoverStatus(siteId: string, generation: number) {
    const requestSequence = ++siteStatusRequestSequenceRef.current;
    setSiteFailoverStatusLoading(true);
    setSiteFailoverStatusError(null);
    try {
      const status = await getSiteFailoverStatus(siteId);
      if (
        generation !== siteRequestGenerationRef.current
        || requestSequence !== siteStatusRequestSequenceRef.current
      ) {
        return;
      }
      commitSiteFailoverStatus(status);
    } catch (cause) {
      if (
        generation === siteRequestGenerationRef.current
        && requestSequence === siteStatusRequestSequenceRef.current
      ) {
        setSiteFailoverStatusError((cause as Error).message);
      }
    } finally {
      if (
        generation === siteRequestGenerationRef.current
        && requestSequence === siteStatusRequestSequenceRef.current
      ) {
        setSiteFailoverStatusLoading(false);
      }
    }
  }

  function openNewSite() {
    const generation = siteRequestGenerationRef.current + 1;
    siteRequestGenerationRef.current = generation;
    siteStatusRequestSequenceRef.current += 1;
    const draft = createSiteConfigDraft();
    setEditingSite(null);
    setSiteForm(draft);
    siteFormRef.current = draft;
    resetSiteFormRuntimeState();
    setSiteFormOpen(true);
  }

  function openEditSite(site: SiteRecord) {
    const generation = siteRequestGenerationRef.current + 1;
    siteRequestGenerationRef.current = generation;
    siteStatusRequestSequenceRef.current += 1;
    const draft = createSiteConfigDraft(site);
    setEditingSite(site);
    setSiteForm(draft);
    siteFormRef.current = draft;
    resetSiteFormRuntimeState();
    setSiteFormOpen(true);
    void loadSiteFailoverStatus(site.id, generation);
  }

  function closeSiteForm() {
    if (siteFormSubmitInFlightRef.current) {
      return;
    }
    siteRequestGenerationRef.current += 1;
    siteStatusRequestSequenceRef.current += 1;
    setSiteFormOpen(false);
    resetSiteFormRuntimeState();
  }

  function invalidateSiteAddressAction(rowId: string) {
    const nextSequence = (siteAddressRequestSequenceRef.current.get(rowId) ?? 0) + 1;
    siteAddressRequestSequenceRef.current.set(rowId, nextSequence);
    setSiteAddressActions((previous) => {
      if (!(rowId in previous)) {
        return previous;
      }
      const next = { ...previous };
      delete next[rowId];
      return next;
    });
  }

  function updateSitePrimaryBaseUrl(baseUrl: string) {
    invalidateSiteAddressAction(SITE_PRIMARY_ADDRESS_ROW_ID);
    updateSiteFormState((previous) => ({ ...previous, baseUrl }));
  }

  function addSiteFallbackAddress() {
    if (siteFormRef.current.fallbackAddresses.length >= MAX_SITE_FALLBACK_ADDRESSES) {
      setSiteFormError(`备用地址最多只能添加 ${MAX_SITE_FALLBACK_ADDRESSES} 个。`);
      return;
    }
    updateSiteFormState((previous) => ({
      ...previous,
      fallbackAddresses: [
        ...previous.fallbackAddresses,
        createSiteFallbackAddressDraft()
      ]
    }));
  }

  function updateSiteFallbackAddress(rowId: string, baseUrl: string) {
    invalidateSiteAddressAction(rowId);
    updateSiteFormState((previous) => ({
      ...previous,
      fallbackAddresses: previous.fallbackAddresses.map((item) =>
        item.id === rowId ? { ...item, baseUrl } : item
      )
    }));
  }

  function removeSiteFallbackAddress(rowId: string) {
    invalidateSiteAddressAction(rowId);
    updateSiteFormState((previous) => ({
      ...previous,
      fallbackAddresses: previous.fallbackAddresses.filter((item) => item.id !== rowId)
    }));
  }

  function getSiteDraftAddress(rowId: string) {
    if (rowId === SITE_PRIMARY_ADDRESS_ROW_ID) {
      return siteFormRef.current.baseUrl;
    }
    return siteFormRef.current.fallbackAddresses.find((item) => item.id === rowId)?.baseUrl ?? null;
  }

  function canUseSiteAddressActions(rowId: string) {
    const baseUrl = getSiteDraftAddress(rowId);
    return Boolean(
      editingSite
      && baseUrl
      && siteDraftAddressBelongsToPersistedSite(editingSite, baseUrl)
    );
  }

  function beginSiteAddressRequest(rowId: string) {
    const requestSequence = (siteAddressRequestSequenceRef.current.get(rowId) ?? 0) + 1;
    siteAddressRequestSequenceRef.current.set(rowId, requestSequence);
    return requestSequence;
  }

  function isCurrentSiteAddressRequest(
    rowId: string,
    baseUrl: string,
    generation: number,
    requestSequence: number
  ) {
    return generation === siteRequestGenerationRef.current
      && requestSequence === siteAddressRequestSequenceRef.current.get(rowId)
      && getSiteDraftAddress(rowId) === baseUrl;
  }

  function updateSiteAddressAction(
    rowId: string,
    update: Partial<SiteAddressActionState>
  ) {
    setSiteAddressActions((previous) => {
      const current = previous[rowId] ?? {
        testing: false,
        clearing: false,
        result: null,
        error: null
      };
      return {
        ...previous,
        [rowId]: {
          ...current,
          ...update
        }
      };
    });
  }

  async function handleTestSiteAddress(rowId: string) {
    const site = editingSite;
    const baseUrl = getSiteDraftAddress(rowId);
    if (!site || !baseUrl || !siteDraftAddressBelongsToPersistedSite(site, baseUrl)) {
      updateSiteAddressAction(rowId, {
        error: "请先保存这个地址，再测试连接。",
        result: null
      });
      return;
    }

    const generation = siteRequestGenerationRef.current;
    const requestSequence = beginSiteAddressRequest(rowId);
    updateSiteAddressAction(rowId, { testing: true, result: null, error: null });
    try {
      const result = await testSiteEndpoint(site.id, { baseUrl });
      if (isCurrentSiteAddressRequest(rowId, baseUrl, generation, requestSequence)) {
        updateSiteAddressAction(rowId, { testing: false, result, error: null });
      }
    } catch (cause) {
      if (isCurrentSiteAddressRequest(rowId, baseUrl, generation, requestSequence)) {
        updateSiteAddressAction(rowId, {
          testing: false,
          result: null,
          error: (cause as Error).message
        });
      }
    }
  }

  async function handleClearSiteAddressCooldown(rowId: string) {
    const site = editingSite;
    const baseUrl = getSiteDraftAddress(rowId);
    const addressStatus = baseUrl
      ? findSiteFailoverAddressStatus(siteFailoverStatus, baseUrl)
      : null;
    if (!site || !baseUrl || !addressStatus) {
      return;
    }

    const generation = siteRequestGenerationRef.current;
    const requestSequence = beginSiteAddressRequest(rowId);
    siteStatusRequestSequenceRef.current += 1;
    setSiteFailoverStatusLoading(false);
    updateSiteAddressAction(rowId, { clearing: true, error: null });
    try {
      const status = await clearSiteFailoverCooldown(site.id, {
        baseUrl: addressStatus.baseUrl
      });
      if (isCurrentSiteAddressRequest(rowId, baseUrl, generation, requestSequence)) {
        commitSiteFailoverStatus(status);
        updateSiteAddressAction(rowId, { clearing: false, error: null });
      }
    } catch (cause) {
      if (isCurrentSiteAddressRequest(rowId, baseUrl, generation, requestSequence)) {
        updateSiteAddressAction(rowId, {
          clearing: false,
          error: (cause as Error).message
        });
      }
    }
  }

  function openNewAccount(siteId?: string) {
    setEditingAccount(null);
    setAccountSitePickerOpen(false);
    setAccountPassword("");
    const nextForm = {
      ...defaultAccountForm,
      siteId: siteId ?? selectedSiteId ?? sites[0]?.id ?? ""
    };
    setAccountForm(nextForm);
    setAccountBalanceWarningInput(String(nextForm.balanceWarning));
    setAccountFormOpen(true);
  }

  function openEditAccount(account: AccountRuntime) {
    setEditingAccount(account);
    setAccountSitePickerOpen(false);
    setAccountPassword("");
    const nextForm = {
      siteId: account.siteId,
      label: account.label,
      email: account.email,
      balanceWarning: account.balanceWarning
    };
    setAccountForm(nextForm);
    setAccountBalanceWarningInput(String(nextForm.balanceWarning));
    setAccountFormOpen(true);
  }

  function closeAccountForm() {
    if (accountFormSubmitting) {
      return;
    }
    setAccountFormOpen(false);
    setAccountSitePickerOpen(false);
  }

  function handleBalanceWarningInput(value: string) {
    setAccountBalanceWarningInput(value);
    if (value.trim() === "" || value === "-" || value === "." || value === "-.") {
      return;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return;
    }
    setAccountForm((prev) => ({ ...prev, balanceWarning: normalizeBalanceWarning(parsed) }));
  }

  function openAccountManager(account?: AccountRuntime | null) {
    setAccountSearch("");
    if (account) {
      setSelectedSiteId(account.siteId);
      setSelectedAccountId(account.id);
    }
    setAccountManagerOpen(true);
  }

  function openSiteAccountManager(site: SiteRecord) {
    const siteAccounts = accounts.filter((item) => item.siteId === site.id);
    const nextSelectedAccount =
      siteAccounts.find((item) => item.id === selectedAccountId) ?? siteAccounts[0] ?? null;
    setAccountSearch("");
    setSelectedSiteId(site.id);
    setSelectedAccountId(nextSelectedAccount?.id ?? null);
    setAccountManagerOpen(true);
  }

  function closeAccountManager() {
    setAccountManagerOpen(false);
  }

  function openPasswordLogin(account: AccountRuntime) {
    setLoginModal({ account, phase: "password", password: "", code: "" });
  }

  function closeLoginModal() {
    setLoginModal(null);
  }

  function updateLoginPassword(password: string) {
    setLoginModal((prev) => (prev ? { ...prev, password } : prev));
  }

  function updateLoginCode(code: string) {
    setLoginModal((prev) => (prev ? { ...prev, code } : prev));
  }

  async function publishLatestSyncStatus(accountId: string) {
    const latestStatus = await getAccountSyncStatus(accountId);
    onSyncStatusChange?.(accountId, latestStatus.statuses);
  }

  async function reconcileCurrentAccountSelection() {
    return reconcileSelectedAccountSelection({
      loadOverview: () => loadOverview(),
      refreshSelectedAccountSync,
      reportOverviewError: (cause) => {
        console.error("账号操作完成后读取总览失败", cause);
      }
    });
  }

  function joinBootstrapFullSync(accountId: string) {
    void (async () => {
      try {
        await syncAccountData(accountId, {
          scope: "full",
          triggerSource: "bootstrap"
        });
      } catch {
        // 终态由后端状态接口和任务中心展示。
      }
      try {
        await publishLatestSyncStatus(accountId);
      } catch {
        // 保留同步请求的原始终态，不用状态读取失败覆盖它。
      }
    })();
  }

  async function submitSiteForm() {
    if (siteFormSubmitInFlightRef.current) {
      return;
    }

    let payload;
    try {
      payload = siteInputFromDraft(siteFormRef.current);
    } catch (cause) {
      setSiteFormError((cause as Error).message);
      return;
    }

    siteFormSubmitInFlightRef.current = true;
    setSiteFormSubmitting(true);
    setSiteFormError(null);
    const successMessage = editingSite ? "站点信息已更新。" : "站点已创建。";
    setBusyText(editingSite ? "正在更新站点..." : "正在创建站点...");
    setError(null);
    try {
      if (editingSite) {
        await updateSite(editingSite.id, payload);
      } else {
        const created = await createSite(payload);
        setSelectedSiteId(created.id);
      }
      siteRequestGenerationRef.current += 1;
      siteStatusRequestSequenceRef.current += 1;
      setSiteFormOpen(false);
      resetSiteFormRuntimeState();
      await loadOverview();
      onSaveFeedback({
        tone: "success",
        title: "保存成功",
        message: successMessage
      });
    } catch (cause) {
      const message = (cause as Error).message;
      setSiteFormError(message);
      setError(message);
    } finally {
      siteFormSubmitInFlightRef.current = false;
      setSiteFormSubmitting(false);
      setBusyText(null);
    }
  }

  async function submitAccountForm() {
    if (accountFormSubmitInFlightRef.current) {
      return;
    }

    accountFormSubmitInFlightRef.current = true;
    setAccountFormSubmitting(true);
    const password = accountPassword.trim();
    setBusyText(
      editingAccount
        ? "正在更新账号..."
        : password
          ? "正在创建账号并自动登录..."
          : "正在创建账号..."
    );
    setError(null);
    try {
      if (editingAccount) {
        await updateAccount(editingAccount.id, {
          label: accountForm.label,
          email: accountForm.email,
          balanceWarning: accountForm.balanceWarning
        });
        let credentialError: string | null = null;
        if (password) {
          try {
            await persistAccountCredential(editingAccount.id, password);
          } catch (cause) {
            credentialError = (cause as Error).message;
          }
        }
        if (!credentialError) {
          setAccountFormOpen(false);
          setAccountPassword("");
        }
        await loadOverview();
        if (credentialError) {
          throw new Error(`账号信息已更新，但本地密码没有保存: ${credentialError}`);
        }
        onSaveFeedback({
          tone: "success",
          title: "保存成功",
          message: password ? "账号信息和本地密码已更新。" : "账号信息已更新。"
        });
      } else {
        const created = await createAccount(accountForm);
        let followupError: string | null = null;
        setSelectedAccountId(created.id);
        setSelectedSiteId(created.siteId);
        if (password) {
          try {
            const loginResult = await loginAccount(created.id, password);
            if (loginResult.type === "success") {
              setSelectedAccountId(loginResult.account.id);
              setSelectedSiteId(loginResult.account.siteId);
              joinBootstrapFullSync(loginResult.account.id);
            } else {
              setLoginModal({
                account: created,
                phase: "2fa",
                password,
                code: "",
                tempToken: loginResult.tempToken,
                originBaseUrl: loginResult.originBaseUrl,
                emailMasked: loginResult.emailMasked
              });
              followupError = loginResult.message ?? "账号已创建，请继续输入 2FA 验证码完成登录。";
            }
          } catch (cause) {
            followupError = `账号已创建，但自动登录失败: ${(cause as Error).message}。你可以在账号列表点“登录”重新输入密码。`;
          }
        }
        setAccountFormOpen(false);
        setAccountPassword("");
        const reconciled = await reconcileCurrentAccountSelection();
        if (followupError) {
          setError(followupError);
        } else if (!reconciled) {
          setError("账号已保存，但总览读取失败，请点击刷新重试。");
        } else {
          onSaveFeedback({
            tone: "success",
            title: "保存成功",
            message: password ? "账号已创建并完成登录。" : "账号已创建。"
          });
        }
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      accountFormSubmitInFlightRef.current = false;
      setAccountFormSubmitting(false);
      setBusyText(null);
    }
  }

  async function submitLogin() {
    if (!loginModal) {
      return;
    }
    setBusyText(
      loginModal.phase === "password"
        ? `正在登录 ${loginModal.account.label}...`
        : `正在校验 ${loginModal.account.label} 的 2FA...`
    );
    setError(null);
    try {
      let completedAccountId: string | null = null;
      if (loginModal.phase === "password") {
        const result = await loginAccount(loginModal.account.id, loginModal.password);
        if (result.type === "success") {
          setSelectedAccountId(result.account.id);
          setSelectedSiteId(result.account.siteId);
          completedAccountId = result.account.id;
          setLoginModal(null);
        } else {
          setLoginModal((prev) =>
            prev
              ? {
                  ...prev,
                  phase: "2fa",
                  code: "",
                  tempToken: result.tempToken,
                  originBaseUrl: result.originBaseUrl,
                  emailMasked: result.emailMasked
                }
              : prev
          );
          setError(result.message ?? "检测到 2FA 验证，请输入验证码继续登录。");
        }
      } else {
        if (!loginModal.originBaseUrl) {
          throw new Error("2FA 验证缺少来源站点地址，请重新输入密码登录。");
        }
        const updated = await completeAccount2fa(
          loginModal.account.id,
          loginModal.tempToken ?? "",
          loginModal.code.trim(),
          loginModal.originBaseUrl
        );
        setSelectedAccountId(updated.id);
        setSelectedSiteId(updated.siteId);
        completedAccountId = updated.id;
        setLoginModal(null);
      }
      if (completedAccountId) {
        joinBootstrapFullSync(completedAccountId);
        const reconciled = await reconcileCurrentAccountSelection();
        if (!reconciled) {
          setError("账号登录已完成，但总览读取失败，请点击刷新重试。");
        }
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleRefreshAccount(accountId: string, options?: RefreshAccountOptions) {
    const busyText = options?.busyText ?? "正在刷新账号数据...";
    if (!options?.silent) {
      setBusyText(busyText);
      setError(null);
    }
    try {
      const syncStatus = await syncAccountData(accountId, {
        scope: options?.scope ?? "full",
        triggerSource: options?.triggerSource ?? "manual"
      });
      onSyncStatusChange?.(accountId, syncStatus.statuses);
      try {
        await publishLatestSyncStatus(accountId);
      } catch {
        // 同步已完成时保留调用结果，状态读取失败不改变成功语义。
      }
      await loadOverview(
        options?.successMessage
          ? {
              successMessage: options.successMessage
            }
          : undefined
      );
    } catch (cause) {
      try {
        await publishLatestSyncStatus(accountId);
      } catch {
        // 以原始同步错误为准。
      }
      if (!options?.silent) {
        setError((cause as Error).message);
      }
    } finally {
      if (!options?.silent) {
        setBusyText(null);
      }
    }
  }

  async function handleRemoveSite(siteId: string) {
    setBusyText("正在删除站点...");
    setError(null);
    try {
      await removeSite(siteId);
      const removedAccountIds = accounts
        .filter((account) => account.siteId === siteId)
        .map((account) => account.id);
      invalidateAccountsForSite?.(siteId);
      invalidateSite?.(siteId);
      evictOverviewEntities?.({ accountIds: removedAccountIds, siteIds: [siteId] });
      if (!evictOverviewEntities && selectedSiteId === siteId) {
        setSelectedSiteId(null);
      }
      if (!evictOverviewEntities && accounts.some((account) => account.id === selectedAccountId && account.siteId === siteId)) {
        setSelectedAccountId(null);
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
      invalidateAccount(accountId);
      evictOverviewEntities?.({ accountIds: [accountId] });
      if (!evictOverviewEntities && selectedAccountId === accountId) {
        setSelectedAccountId(null);
      }
      await loadOverview();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  return {
    siteFormOpen,
    editingSite,
    siteForm,
    setSiteForm: updateSiteFormState,
    siteFormError,
    siteFormSubmitting,
    siteFailoverStatus,
    siteFailoverStatusLoading,
    siteFailoverStatusError,
    siteStatusNowMs,
    siteAddressActions,
    openNewSite,
    openEditSite,
    closeSiteForm,
    updateSitePrimaryBaseUrl,
    addSiteFallbackAddress,
    updateSiteFallbackAddress,
    removeSiteFallbackAddress,
    canUseSiteAddressActions,
    handleTestSiteAddress,
    handleClearSiteAddressCooldown,
    submitSiteForm,
    accountFormOpen,
    editingAccount,
    accountForm,
    setAccountForm,
    accountFormSubmitting,
    openNewAccount,
    openEditAccount,
    closeAccountForm,
    submitAccountForm,
    accountSitePickerOpen,
    setAccountSitePickerOpen,
    selectedAccountSite,
    accountPassword,
    setAccountPassword,
    accountBalanceWarningInput,
    handleBalanceWarningInput,
    accountManagerOpen,
    accountSearch,
    setAccountSearch,
    accountManagerAccounts,
    openAccountManager,
    openSiteAccountManager,
    closeAccountManager,
    loginModal,
    openPasswordLogin,
    closeLoginModal,
    updateLoginPassword,
    updateLoginCode,
    submitLogin,
    handleRefreshAccount,
    handleRemoveSite,
    handleRemoveAccount
  };
}
