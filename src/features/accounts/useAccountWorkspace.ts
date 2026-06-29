import { useDeferredValue, useMemo, useState } from "react";

import {
  DISABLED_BALANCE_WARNING,
  normalizeBalanceWarning
} from "../../account-warning";
import type {
  AccountInput,
  AccountRuntime,
  AccountSyncStatusRecord,
  SiteInput,
  SiteRecord
} from "../../types";
import {
  completeAccount2fa,
  createAccount,
  createSite,
  getAccountSyncStatus,
  loginAccount,
  removeAccount,
  removeSite,
  syncAccountData,
  updateAccount,
  updateSite
} from "./client";

const defaultSiteForm: SiteInput = {
  name: "",
  baseUrl: "https://ai.input.im"
};

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
  emailMasked?: string | null;
}

interface RefreshAccountOptions {
  busyText?: string;
  successMessage?: string;
  silent?: boolean;
  triggerSource?: "manual" | "stale_auto";
  scope?: "core" | "keys" | "usage" | "full";
}

export function useAccountWorkspace({
  sites,
  accounts,
  selectedSiteId,
  selectedAccountId,
  setSelectedSiteId,
  setSelectedAccountId,
  loadOverview,
  onSyncStatusChange,
  setBusyText,
  setError
}: {
  sites: SiteRecord[];
  accounts: AccountRuntime[];
  selectedSiteId: string | null;
  selectedAccountId: string | null;
  setSelectedSiteId: (value: string | null) => void;
  setSelectedAccountId: (value: string | null) => void;
  loadOverview: (options?: { busyText?: string; successMessage?: string }) => Promise<void>;
  onSyncStatusChange?: (accountId: string, statuses: AccountSyncStatusRecord[]) => void;
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
  const [siteForm, setSiteForm] = useState<SiteInput>(defaultSiteForm);
  const [accountForm, setAccountForm] = useState<AccountInput>(defaultAccountForm);

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

  function closeSiteForm() {
    setSiteFormOpen(false);
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
      } else {
        const created = await createAccount(accountForm);
        setSelectedAccountId(created.id);
        setSelectedSiteId(created.siteId);
        if (password) {
          try {
            const loginResult = await loginAccount(created.id, password);
            if (loginResult.type === "success") {
              setSelectedAccountId(loginResult.account.id);
              setSelectedSiteId(loginResult.account.siteId);
            } else {
              setLoginModal({
                account: created,
                phase: "2fa",
                password,
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
      await loadOverview(
        options?.successMessage
          ? {
              successMessage: options.successMessage
            }
          : undefined
      );
    } catch (cause) {
      try {
        const latestStatus = await getAccountSyncStatus(accountId);
        onSyncStatusChange?.(accountId, latestStatus.statuses);
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

  return {
    siteFormOpen,
    editingSite,
    siteForm,
    setSiteForm,
    openNewSite,
    openEditSite,
    closeSiteForm,
    submitSiteForm,
    accountFormOpen,
    editingAccount,
    accountForm,
    setAccountForm,
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
