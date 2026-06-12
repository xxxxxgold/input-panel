import type { Dispatch, SetStateAction } from "react";

import { ChevronDown } from "lucide-react";

import { maskEmail } from "../../../shared/lib/formatters";
import { Modal } from "../../../shared/ui/Modal";
import type { AccountInput, OverviewPayload, SiteInput, SiteRecord } from "../../../types";
import type { useAccountWorkspace } from "../useAccountWorkspace";
import { AccountListModal } from "../../settings/components/AccountListModal";

type AccountWorkspaceController = ReturnType<typeof useAccountWorkspace>;

export function AccountWorkspaceModals({
  workspace,
  selectedSite,
  sites,
  overview
}: {
  workspace: AccountWorkspaceController;
  selectedSite: SiteRecord | null;
  sites: SiteRecord[];
  overview: OverviewPayload | null;
}) {
  const onlineCount = workspace.accountManagerAccounts.filter((account) => account.snapshot?.online).length;
  const alertCount = selectedSite
    ? overview?.alerts.filter((alert) => alert.siteId === selectedSite.id).length ?? 0
    : 0;
  const siteBalance = workspace.accountManagerAccounts.reduce(
    (sum, account) => sum + (account.snapshot?.balance ?? 0),
    0
  );

  return (
    <>
      {workspace.accountManagerOpen && (
        <AccountListModal
          selectedSite={selectedSite}
          totalAccounts={workspace.accountManagerAccounts.length}
          onlineCount={onlineCount}
          alertCount={alertCount}
          siteBalance={siteBalance}
          searchValue={workspace.accountSearch}
          onSearchChange={workspace.setAccountSearch}
          accounts={workspace.accountManagerAccounts}
          onClose={workspace.closeAccountManager}
          onEditSite={() => {
            if (!selectedSite) {
              return;
            }
            workspace.closeAccountManager();
            workspace.openEditSite(selectedSite);
          }}
          onOpenNewAccount={() => {
            workspace.closeAccountManager();
            workspace.openNewAccount(selectedSite?.id);
          }}
          onLogin={(account) => {
            workspace.closeAccountManager();
            workspace.openPasswordLogin(account);
          }}
          onRefresh={(accountId) => void workspace.handleRefreshAccount(accountId)}
          onEdit={(account) => {
            workspace.closeAccountManager();
            workspace.openEditAccount(account);
          }}
          onRemove={(accountId) => void workspace.handleRemoveAccount(accountId)}
        />
      )}

      {workspace.siteFormOpen && (
        <SiteFormModal
          editingSiteName={workspace.editingSite?.name ?? null}
          siteForm={workspace.siteForm}
          setSiteForm={workspace.setSiteForm}
          onClose={workspace.closeSiteForm}
          onSubmit={() => void workspace.submitSiteForm()}
        />
      )}

      {workspace.accountFormOpen && (
        <AccountFormModal
          editingAccountLabel={workspace.editingAccount?.label ?? null}
          accountForm={workspace.accountForm}
          setAccountForm={workspace.setAccountForm}
          accountSitePickerOpen={workspace.accountSitePickerOpen}
          setAccountSitePickerOpen={workspace.setAccountSitePickerOpen}
          selectedAccountSite={workspace.selectedAccountSite}
          sites={sites}
          accountPassword={workspace.accountPassword}
          setAccountPassword={workspace.setAccountPassword}
          accountBalanceWarningInput={workspace.accountBalanceWarningInput}
          onBalanceWarningInput={workspace.handleBalanceWarningInput}
          onClose={workspace.closeAccountForm}
          onSubmit={() => void workspace.submitAccountForm()}
        />
      )}

      {workspace.loginModal && (
        <LoginAccountModal
          loginModal={workspace.loginModal}
          onClose={workspace.closeLoginModal}
          onSubmit={() => void workspace.submitLogin()}
          onPasswordChange={workspace.updateLoginPassword}
          onCodeChange={workspace.updateLoginCode}
        />
      )}
    </>
  );
}

function SiteFormModal({
  editingSiteName,
  siteForm,
  setSiteForm,
  onClose,
  onSubmit
}: {
  editingSiteName: string | null;
  siteForm: SiteInput;
  setSiteForm: Dispatch<SetStateAction<SiteInput>>;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <Modal
      title={editingSiteName ? "编辑站点" : "新增站点"}
      onClose={onClose}
      onSubmit={onSubmit}
      submitText={editingSiteName ? "更新站点" : "创建站点"}
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
  );
}

function AccountFormModal({
  editingAccountLabel,
  accountForm,
  setAccountForm,
  accountSitePickerOpen,
  setAccountSitePickerOpen,
  selectedAccountSite,
  sites,
  accountPassword,
  setAccountPassword,
  accountBalanceWarningInput,
  onBalanceWarningInput,
  onClose,
  onSubmit
}: {
  editingAccountLabel: string | null;
  accountForm: AccountInput;
  setAccountForm: Dispatch<SetStateAction<AccountInput>>;
  accountSitePickerOpen: boolean;
  setAccountSitePickerOpen: Dispatch<SetStateAction<boolean>>;
  selectedAccountSite: SiteRecord | null;
  sites: SiteRecord[];
  accountPassword: string;
  setAccountPassword: Dispatch<SetStateAction<string>>;
  accountBalanceWarningInput: string;
  onBalanceWarningInput: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <Modal
      title={editingAccountLabel ? "编辑账号" : "新增账号"}
      onClose={onClose}
      onSubmit={onSubmit}
      submitText={editingAccountLabel ? "更新账号" : "创建账号"}
    >
      <div className="form-callout">
        {editingAccountLabel ? (
          <p>这里编辑的是账号资料，不改密码。若要重新登录，请在账号卡片点“登录”，本地会安全保存凭据用于自动续登。</p>
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
              if (sites.length === 0) {
                return;
              }
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
      {!editingAccountLabel && (
        <label className="field">
          <span>登录密码</span>
          <input
            type="password"
            value={accountPassword}
            onChange={(event) => setAccountPassword(event.target.value)}
            placeholder="可选。填写后创建完成会自动登录"
          />
          <p className="field-help">密码仅保存在当前设备本地，用于自动续登与 token 失效后的自动重登。</p>
        </label>
      )}
      <label className="field">
        <span>低余额预警阈值</span>
        <input
          type="number"
          value={accountBalanceWarningInput}
          onChange={(event) => onBalanceWarningInput(event.target.value)}
          placeholder="-1"
        />
        <p className="field-help">设为 `-1` 表示关闭低余额提醒。默认值为 `-1`。</p>
      </label>
    </Modal>
  );
}

function LoginAccountModal({
  loginModal,
  onClose,
  onSubmit,
  onPasswordChange,
  onCodeChange
}: {
  loginModal: NonNullable<AccountWorkspaceController["loginModal"]>;
  onClose: () => void;
  onSubmit: () => void;
  onPasswordChange: (value: string) => void;
  onCodeChange: (value: string) => void;
}) {
  return (
    <Modal
      title={loginModal.phase === "password" ? `登录 ${loginModal.account.label}` : `验证 ${loginModal.account.label}`}
      onClose={onClose}
      onSubmit={onSubmit}
      submitText={loginModal.phase === "password" ? "登录并拉取" : "验证并继续"}
    >
      <p className="modal-hint">
        {loginModal.phase === "password"
          ? "密码会仅在当前设备本地安全保存，用于自动续登和 token 失效后的重登。"
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
            onChange={(event) => onPasswordChange(event.target.value)}
            placeholder="输入当前账号密码"
          />
        </label>
      ) : (
        <label className="field">
          <span>2FA 验证码</span>
          <input
            value={loginModal.code}
            onChange={(event) => onCodeChange(event.target.value)}
            placeholder="输入 6 位验证码"
          />
          <p className="field-help">若本地时间漂移较大，验证码可能会被站点拒绝。</p>
        </label>
      )}
    </Modal>
  );
}
