import { useEffect, type KeyboardEvent } from "react";
import { AppShell } from "./app/AppShell";
import { ModalHost } from "./app/ModalHost";
import { RailNav } from "./app/RailNav";
import { ToastHost } from "./app/ToastHost";
import { Topbar } from "./app/Topbar";
import { WorkspaceFrame } from "./app/WorkspaceFrame";
import { navTitle as workspaceNavTitle } from "./app/navigation";
import { useShellWorkspace } from "./app/useShellWorkspace";
import { AccountWorkspaceModals } from "./features/accounts/components/AccountWorkspaceModals";
import { useAccountScopedWorkspace } from "./features/accounts/useAccountScopedWorkspace";
import { useAccountWorkspace } from "./features/accounts/useAccountWorkspace";
import { useProfileWorkspace } from "./features/profile/useProfileWorkspace";
import { useSettingsWorkspace } from "./features/settings/useSettingsWorkspace";
import { useUsageWorkspace } from "./features/usage/useUsageWorkspace";
import {
  compact,
  formatTime,
  formatUsd
} from "./shared/lib/formatters";
import { resolveAccountAvatarUrl } from "./shared/lib/account-avatar";
import {
  buildTopbarSubscriptionPreviewRecords,
  mergeSubscriptionRecords
} from "./subscription-view";
import { AnalyticsLab } from "./analytics-lab";
import projectLogo from "./assets/project-logo.webp";
import { AlertsPage } from "./pages/AlertsPage";
import { KeyUsagePage } from "./pages/KeyUsagePage";
import { KeysPage } from "./pages/KeysPage";
import { OverviewPage } from "./pages/OverviewPage";
import { ServiceStatusPage } from "./pages/ServiceStatusPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SubscriptionsPage } from "./pages/SubscriptionsPage";
import { SystemSettingsPage } from "./pages/SystemSettingsPage";
import { UsagePage } from "./pages/UsagePage";
import { ProfileWorkspaceModal } from "./features/profile/components/ProfileWorkspaceModal";
import { useMonitorStore } from "./store/monitor-store";
import type {
  AccountRuntime,
  NavKey
} from "./types";

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
  const toasts = useMonitorStore((state) => state.toasts);
  const dismissToast = useMonitorStore((state) => state.dismissToast);
  const selectedSiteId = useMonitorStore((state) => state.selectedSiteId);
  const setSelectedSiteId = useMonitorStore((state) => state.setSelectedSiteId);
  const selectedAccountId = useMonitorStore((state) => state.selectedAccountId);
  const setSelectedAccountId = useMonitorStore((state) => state.setSelectedAccountId);
  const loadOverview = useMonitorStore((state) => state.loadOverview);
  const replaceOverview = useMonitorStore((state) => state.replaceOverview);
  const sites = overview?.sites ?? [];
  const accounts = overview?.accounts ?? [];
  const shellWorkspace = useShellWorkspace({ accounts });
  const accountScopedWorkspace = useAccountScopedWorkspace({
    selectedAccountId,
    setError
  });
  const accountWorkspace = useAccountWorkspace({
    sites,
    accounts,
    selectedSiteId,
    selectedAccountId,
    setSelectedSiteId,
    setSelectedAccountId,
    loadOverview,
    setBusyText,
    setError
  });
  const profileWorkspace = useProfileWorkspace({
    selectedAccountId,
    profileRecord: accountScopedWorkspace.profileRecord,
    setProfileRecord: accountScopedWorkspace.setProfileRecord,
    loadOverview,
    setBusyText,
    setError
  });
  const {
    usageApiKeyFilter,
    setUsageApiKeyFilter,
    usageRangePickerRef,
    usageRangePickerOpen,
    toggleUsageRangePicker,
    usageRangeLabel,
    usageRangePreset,
    applyUsagePreset,
    usageDraftRange,
    setUsageDraftRange,
    applyUsageRange,
    usageStats,
    usageModelSummaries,
    usageModelSummariesLoading,
    usageRecords,
    handleUsageSearch,
    handleUsagePageChange,
    usageTrend,
    usageModels,
    keyUsageRows,
    keyUsageKeyId,
    loadKeyUsage,
    usageStartDate,
    setUsageStartDate,
    usageEndDate,
    setUsageEndDate
  } = useUsageWorkspace({
    nav,
    selectedAccountId,
    managedKeys: accountScopedWorkspace.managedKeys,
    setBusyText,
    setError
  });

  useEffect(() => {
    document.documentElement.classList.remove("light", "dark", "deep-blue");
    document.documentElement.classList.add(theme);
  }, [theme]);

  useEffect(() => {
    void loadOverview();
  }, []);

  useEffect(() => {
    if (nav === "sites" || nav === "accounts") {
      setNav("systemSettings");
    }
  }, [nav, setNav]);

  useEffect(() => {
    if (nav !== "profile") {
      return;
    }
    profileWorkspace.openProfileModal();
    setNav("overview");
  }, [nav, setNav]);
  const selectedSiteAccounts = selectedSiteId
    ? accounts.filter((item) => item.siteId === selectedSiteId)
    : accounts;
  const selectedAccount =
    accounts.find((item) => item.id === selectedAccountId && (!selectedSiteId || item.siteId === selectedSiteId)) ??
    (selectedSiteId
      ? selectedSiteAccounts[0] ?? null
      : accounts.find((item) => item.id === selectedAccountId) ?? accounts[0] ?? null);
  const selectedSite =
    sites.find((item) => item.id === selectedSiteId) ??
    (selectedAccount ? sites.find((item) => item.id === selectedAccount.siteId) ?? null : null);
  const visibleSnapshot = selectedAccount?.snapshot ?? null;
  const visibleHistory = visibleSnapshot?.requestHistory ?? [];
  const settingsWorkspace = useSettingsWorkspace({
    sites,
    visibleHistory
  });
  const alertCount = overview?.alerts.length ?? 0;
  const topbarAlertPreview = overview?.alerts.slice(0, 3) ?? [];
  const subscriptionCount =
    accountScopedWorkspace.subscriptionSummary?.activeCount ?? visibleSnapshot?.subscriptions.length ?? 0;
  const subscriptionSpend = accountScopedWorkspace.subscriptionSummary?.totalUsedUsd ?? 0;
  const mergedTopbarSubscriptions = buildTopbarSubscriptionPreviewRecords({
    overviewSubscriptions: [],
    fallbackSubscriptions: mergeSubscriptionRecords(
      visibleSnapshot?.subscriptions ?? [],
      accountScopedWorkspace.subscriptionSummary
    ),
    fallbackAccountLabel: selectedAccount?.label ?? null,
    fallbackSiteName: selectedSite?.name ?? null
  });
  const usageStatusLabel = accountScopedWorkspace.subscriptionSummary
    ? `${subscriptionCount} 个有效订阅`
    : visibleSnapshot?.activeSubscription?.status ?? (subscriptionCount > 0 ? "已同步订阅" : "等待同步");
  const usageStatusHint = accountScopedWorkspace.subscriptionSummary
    ? `已用 ${formatUsd(subscriptionSpend, 2)}`
    : visibleSnapshot?.activeSubscription?.expiresAt
      ? `到期 ${formatTime(visibleSnapshot.activeSubscription.expiresAt)}`
      : subscriptionCount > 0
        ? "查看配额与到期时间"
        : "暂无订阅数据";
  const selectedAccountStatusLabel = selectedAccount
    ? selectedAccount.sessionState === "ready"
      ? "已连接"
      : selectedAccount.sessionState === "expired"
        ? "已失效"
        : "未登录"
    : "未选择账号";
  const selectedAccountAvatarUrl = resolveAccountAvatarUrl({
    profileRecord: accountScopedWorkspace.profileRecord
  });

  useEffect(() => {
    if (!selectedSiteId) return;
    const accountInSelectedSite = accounts.find(
      (item) => item.id === selectedAccountId && item.siteId === selectedSiteId
    );
    if (accountInSelectedSite) return;
    const fallbackAccount = accounts.find((item) => item.siteId === selectedSiteId) ?? null;
    if ((fallbackAccount?.id ?? null) !== selectedAccountId) {
      setSelectedAccountId(fallbackAccount?.id ?? null);
    }
  }, [selectedSiteId, selectedAccountId, accounts, setSelectedAccountId]);

  function handleActionKey(event: KeyboardEvent<HTMLElement>, action: () => void) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  }

  function handleNavChange(nextNav: NavKey) {
    setNav(nextNav);
  }

  function openProfileModal() {
    shellWorkspace.closeTopbarAccountMenu();
    profileWorkspace.openProfileModal();
  }

  function handleTopbarAccountSelect(account: AccountRuntime) {
    setSelectedSiteId(account.siteId);
    setSelectedAccountId(account.id);
    shellWorkspace.closeTopbarAccountMenu();
  }

  const workspaceSubtitle = nav === "serviceStatus"
    ? "嵌入 status.input.im 的实时服务监控页面"
    : selectedSite
      ? `${selectedSite.name} / ${selectedAccount?.label ?? "未选择账号"}`
      : "请先添加站点与账号";

  const workspaceSummary = (
    <>
      <span>{overview ? `${overview.totals.totalSites} 个站点` : "等待同步站点"}</span>
      <span>{overview ? `${overview.totals.totalAccounts} 个账号` : "等待同步账号"}</span>
      <span>{overview ? `今日 ${compact(overview.totals.todayRequests)} 请求` : "暂无今日请求数据"}</span>
    </>
  );

  const pageContent = (
    <>
      {nav === "overview" && overview && (
        <OverviewPage overview={overview} visibleSnapshot={visibleSnapshot} alertCount={alertCount} />
      )}
      {nav === "serviceStatus" && <ServiceStatusPage />}
      {nav === "settings" && (
        <SettingsPage
          siteSearch={settingsWorkspace.siteSearch}
          onSiteSearchChange={settingsWorkspace.setSiteSearch}
          filteredSites={settingsWorkspace.filteredSites}
          accounts={accounts}
          selectedSite={selectedSite}
          visibleSnapshot={visibleSnapshot}
          visibleHistory={visibleHistory}
          latestHistory={settingsWorkspace.latestHistory}
          selectedHistoryRow={settingsWorkspace.selectedHistoryRow}
          onSelectHistoryRow={settingsWorkspace.setSelectedHistoryRow}
          onOpenNewSite={accountWorkspace.openNewSite}
          onOpenSiteAccountManager={accountWorkspace.openSiteAccountManager}
          onOpenEditSite={accountWorkspace.openEditSite}
          onRemoveSite={(siteId) => void accountWorkspace.handleRemoveSite(siteId)}
          onOpenNewAccount={accountWorkspace.openNewAccount}
          onOpenAccountManager={accountWorkspace.openAccountManager}
          handleActionKey={handleActionKey}
        />
      )}
      {nav === "keys" && (
        <KeysPage
          managedKeys={accountScopedWorkspace.managedKeys}
          groups={accountScopedWorkspace.groups}
          profileRecord={accountScopedWorkspace.profileRecord}
          selectedAccountId={selectedAccountId}
          onRefresh={() => {
            if (selectedAccountId) {
              void accountScopedWorkspace.refreshAccountScopedData();
            }
          }}
          onError={setError}
          onBusy={setBusyText}
        />
      )}
      {nav === "usage" && (
        <UsagePage
          managedKeys={accountScopedWorkspace.managedKeys}
          usageApiKeyFilter={usageApiKeyFilter}
          setUsageApiKeyFilter={setUsageApiKeyFilter}
          usageRangePickerRef={usageRangePickerRef}
          usageRangePickerOpen={usageRangePickerOpen}
          toggleUsageRangePicker={toggleUsageRangePicker}
          usageRangeLabel={usageRangeLabel}
          usageRangePreset={usageRangePreset}
          applyUsagePreset={applyUsagePreset}
          usageDraftRange={usageDraftRange}
          setUsageDraftRange={setUsageDraftRange}
          applyUsageRange={applyUsageRange}
          usageStats={usageStats}
          usageModelSummaries={usageModelSummaries}
          usageModelSummariesLoading={usageModelSummariesLoading}
          usageRecords={usageRecords}
          handleUsageSearch={handleUsageSearch}
          handleUsagePageChange={handleUsagePageChange}
          usageTrend={usageTrend}
          usageModels={usageModels}
        />
      )}
      {nav === "subscriptions" && (
        <SubscriptionsPage
          visibleSnapshot={visibleSnapshot}
          subscriptionSummary={accountScopedWorkspace.subscriptionSummary}
        />
      )}
      {nav === "keyUsage" && (
        <KeyUsagePage
          keyUsageRows={keyUsageRows}
          keyUsageKeyId={keyUsageKeyId}
          managedKeys={accountScopedWorkspace.managedKeys}
          onLoadKeyUsage={(keyId) => void loadKeyUsage(keyId)}
        />
      )}
      {nav === "trends" && (
        <AnalyticsLab
          overview={overview}
          selectedAccount={selectedAccount}
          managedKeys={accountScopedWorkspace.managedKeys}
          usageStats={usageStats}
          usageTrend={usageTrend}
          usageModels={usageModels}
          usageRecords={usageRecords}
          subscriptionSummary={accountScopedWorkspace.subscriptionSummary}
          profileRecord={accountScopedWorkspace.profileRecord}
          platformQuotas={accountScopedWorkspace.platformQuotas}
          keyUsageRows={keyUsageRows}
          keyUsageKeyId={keyUsageKeyId}
          usageApiKeyFilter={usageApiKeyFilter}
          usageStartDate={usageStartDate}
          usageEndDate={usageEndDate}
          onUsageApiKeyFilterChange={setUsageApiKeyFilter}
          onUsageStartDateChange={setUsageStartDate}
          onUsageEndDateChange={setUsageEndDate}
          onUsageSearch={() => void handleUsageSearch()}
          onKeyUsageSelect={(keyId) => void loadKeyUsage(keyId)}
        />
      )}
      {nav === "alerts" && <AlertsPage alerts={overview?.alerts ?? []} />}
      {nav === "systemSettings" && <SystemSettingsPage theme={theme} setTheme={setTheme} />}
    </>
  );

  return (
    <>
      <AppShell
        railCollapsed={!shellWorkspace.isRailExpanded}
        rail={
          <RailNav
            nav={nav}
            isRailExpanded={shellWorkspace.isRailExpanded}
            railToggleTitle={shellWorkspace.railToggleTitle}
            onOpenOverview={() => setNav("overview")}
            onToggleRail={() => shellWorkspace.setIsRailExpanded((current) => !current)}
            onNavChange={handleNavChange}
            theme={theme}
            setTheme={setTheme}
            projectLogo={projectLogo}
          />
        }
      >
        <WorkspaceFrame
          topbar={
            <Topbar
              onReload={() => void loadOverview()}
              alertCount={alertCount}
              topbarAlertsExpanded={shellWorkspace.topbarAlertsExpanded}
              setTopbarAlertsExpanded={shellWorkspace.setTopbarAlertsExpanded}
              topbarAlertsRef={shellWorkspace.topbarAlertsRef}
              topbarAlertPreview={topbarAlertPreview}
              closeTopbarAccountMenu={shellWorkspace.closeTopbarAccountMenu}
              setTopbarSubscriptionsExpanded={shellWorkspace.setTopbarSubscriptionsExpanded}
              topbarSubscriptionsExpanded={shellWorkspace.topbarSubscriptionsExpanded}
              topbarSubscriptionsRef={shellWorkspace.topbarSubscriptionsRef}
              usageStatusLabel={usageStatusLabel}
              usageStatusHint={usageStatusHint}
              subscriptionSpend={subscriptionSpend}
              subscriptionCount={subscriptionCount}
              subscriptionPreviewRecords={mergedTopbarSubscriptions}
              closeTopbarPeekPanels={shellWorkspace.closeTopbarPeekPanels}
              onOpenAlerts={() => {
                shellWorkspace.closeTopbarPeekPanels();
                setNav("alerts");
              }}
              onOpenSubscriptions={() => {
                shellWorkspace.closeTopbarPeekPanels();
                setNav("subscriptions");
              }}
              selectedAccount={selectedAccount}
              topbarAccountMenuOpen={shellWorkspace.topbarAccountMenuOpen}
              setTopbarAccountMenuOpen={shellWorkspace.setTopbarAccountMenuOpen}
              topbarAccountMenuRef={shellWorkspace.topbarAccountMenuRef}
              selectedAccountStatusLabel={selectedAccountStatusLabel}
              selectedAccountAvatarUrl={selectedAccountAvatarUrl}
              selectedSite={selectedSite}
              topbarFilteredAccounts={shellWorkspace.topbarFilteredAccounts}
              accounts={accounts}
              topbarAccountSearch={shellWorkspace.topbarAccountSearch}
              setTopbarAccountSearch={shellWorkspace.setTopbarAccountSearch}
              onAccountSelect={handleTopbarAccountSelect}
              onOpenProfileModal={openProfileModal}
              onOpenSystemSettings={() => {
                shellWorkspace.closeTopbarAccountMenu();
                setNav("systemSettings");
              }}
              onOpenSettings={() => {
                shellWorkspace.closeTopbarAccountMenu();
                setNav("settings");
              }}
              onRefreshSelectedAccount={() => {
                shellWorkspace.closeTopbarAccountMenu();
                if (selectedAccount) {
                  void accountWorkspace.handleRefreshAccount(selectedAccount.id);
                }
              }}
              onOpenSelectedAccountLogin={() => {
                shellWorkspace.closeTopbarAccountMenu();
                if (selectedAccount) {
                  accountWorkspace.openPasswordLogin(selectedAccount);
                }
              }}
            />
          }
          title={workspaceNavTitle(nav)}
          subtitle={workspaceSubtitle}
          summary={workspaceSummary}
          loading={loading}
          ready={Boolean(overview)}
        >
          {pageContent}
        </WorkspaceFrame>
      </AppShell>

      <ToastHost toasts={toasts} onDismiss={dismissToast} />

      <ModalHost>
        <AccountWorkspaceModals
          workspace={accountWorkspace}
          selectedSite={selectedSite}
          sites={sites}
          overview={overview}
        />
        <ProfileWorkspaceModal
          open={profileWorkspace.profileModalOpen}
          selectedAccount={selectedAccount}
          profileRecord={accountScopedWorkspace.profileRecord}
          profileForm={profileWorkspace.profileForm}
          setProfileForm={profileWorkspace.setProfileForm}
          profilePassword={profileWorkspace.profilePassword}
          setProfilePassword={profileWorkspace.setProfilePassword}
          notifyEmailDraft={profileWorkspace.notifyEmailDraft}
          setNotifyEmailDraft={profileWorkspace.setNotifyEmailDraft}
          platformQuotas={accountScopedWorkspace.platformQuotas}
          onClose={profileWorkspace.closeProfileModal}
          onRefreshSelectedAccount={() => {
            if (selectedAccount) {
              void accountWorkspace.handleRefreshAccount(selectedAccount.id);
            }
          }}
          onProfileSave={() => void profileWorkspace.handleProfileSave()}
          onPasswordChange={() => void profileWorkspace.handleProfilePasswordChange()}
          onNotifyEmailSend={() => void profileWorkspace.handleNotifyEmailSend()}
          onNotifyEmailVerify={() => void profileWorkspace.handleNotifyEmailVerify()}
          onUnbind={(provider) => void profileWorkspace.handleUnbind(provider)}
        />
      </ModalHost>
    </>
  );
}
