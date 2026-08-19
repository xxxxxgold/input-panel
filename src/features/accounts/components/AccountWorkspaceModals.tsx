import type { Dispatch, SetStateAction } from "react";

import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  LoaderCircle,
  Plus,
  Save,
  TimerReset,
  Trash2,
  X
} from "lucide-react";

import { formatAppErrorMessage } from "../../../shared/lib/error-display";
import { maskEmail } from "../../../shared/lib/formatters";
import { Modal } from "../../../shared/ui/Modal";
import type { AccountInput, OverviewPayload, SiteRecord } from "../../../types";
import type { useAccountWorkspace } from "../useAccountWorkspace";
import {
  findSiteFailoverAddressStatus,
  getSiteCooldownRemainingSeconds,
  MAX_SITE_FALLBACK_ADDRESSES,
  resolveSiteAddressStatusKind,
  SITE_PRIMARY_ADDRESS_ROW_ID
} from "../site-config-draft";
import { AccountListModal } from "../../settings/components/AccountListModal";

type AccountWorkspaceController = ReturnType<typeof useAccountWorkspace>;
export type SiteFormWorkspace = Pick<
  AccountWorkspaceController,
  | "editingSite"
  | "siteForm"
  | "setSiteForm"
  | "siteFormError"
  | "siteFormSubmitting"
  | "siteFailoverStatus"
  | "siteFailoverStatusLoading"
  | "siteFailoverStatusError"
  | "siteStatusNowMs"
  | "siteAddressActions"
  | "closeSiteForm"
  | "submitSiteForm"
  | "updateSitePrimaryBaseUrl"
  | "addSiteFallbackAddress"
  | "updateSiteFallbackAddress"
  | "removeSiteFallbackAddress"
  | "canUseSiteAddressActions"
  | "handleTestSiteAddress"
  | "handleClearSiteAddressCooldown"
>;

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
  const onlineCount = workspace.accountManagerAccounts.filter((account) => account.cacheView?.online).length;
  const alertCount = selectedSite
    ? overview?.alerts.filter((alert) => alert.siteId === selectedSite.id).length ?? 0
    : 0;
  const siteBalance = workspace.accountManagerAccounts.reduce(
    (sum, account) => sum + (account.cacheView?.balance ?? 0),
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
        <SiteFormModal workspace={workspace} />
      )}

      {workspace.accountFormOpen && (
        <AccountFormModal
          isEditing={workspace.editingAccount !== null}
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
          isSubmitting={workspace.accountFormSubmitting}
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

export function SiteFormModal({
  workspace
}: {
  workspace: SiteFormWorkspace;
}) {
  const editingSiteName = workspace.editingSite?.name ?? null;
  const fallbackLimitReached =
    workspace.siteForm.fallbackAddresses.length >= MAX_SITE_FALLBACK_ADDRESSES;
  const activeHost = workspace.siteFailoverStatus?.activeBaseUrl
    ? resolveAddressHost(workspace.siteFailoverStatus.activeBaseUrl)
    : null;

  return (
    <Modal
      title={editingSiteName ? "编辑站点" : "新增站点"}
      size="wide"
      className={`site-form-modal ${workspace.siteFormSubmitting ? "is-submitting" : ""}`.trim()}
      bodyClassName="site-form-modal-body"
      onClose={workspace.siteFormSubmitting ? () => {} : workspace.closeSiteForm}
      hideCloseButton={workspace.siteFormSubmitting}
      footer={
        <>
          <button
            type="button"
            className="ghost-button"
            onClick={workspace.closeSiteForm}
            disabled={workspace.siteFormSubmitting}
            title="取消编辑"
            aria-label="取消编辑站点"
          >
            <X size={16} aria-hidden="true" />
            取消
          </button>
          <button
            type="button"
            className="primary-button site-form-submit-button"
            onClick={() => void workspace.submitSiteForm()}
            disabled={workspace.siteFormSubmitting}
            aria-busy={workspace.siteFormSubmitting}
            title={editingSiteName ? "更新站点" : "创建站点"}
            aria-label={editingSiteName ? "更新站点" : "创建站点"}
          >
            {workspace.siteFormSubmitting ? (
              <LoaderCircle size={16} className="spin" aria-hidden="true" />
            ) : (
              <Save size={16} aria-hidden="true" />
            )}
            {workspace.siteFormSubmitting
              ? "正在保存..."
              : editingSiteName
                ? "更新站点"
                : "创建站点"}
          </button>
        </>
      }
    >
      <fieldset className="site-form-fields" disabled={workspace.siteFormSubmitting}>
        <label className="field site-form-name-field">
          <span>站点名称</span>
          <input
            value={workspace.siteForm.name}
            onChange={(event) =>
              workspace.setSiteForm((previous) => ({
                ...previous,
                name: event.target.value
              }))
            }
            placeholder="AI INPUT"
            autoFocus
          />
        </label>

        <section className="site-form-section" aria-labelledby="site-addresses-heading">
          <div className="site-form-section-heading">
            <div>
              <h4 id="site-addresses-heading">站点地址</h4>
              <span>{workspace.siteForm.fallbackAddresses.length} / {MAX_SITE_FALLBACK_ADDRESSES} 个备用地址</span>
            </div>
            <button
              type="button"
              className="ghost-button site-form-add-address"
              onClick={workspace.addSiteFallbackAddress}
              disabled={fallbackLimitReached || workspace.siteFormSubmitting}
              title={fallbackLimitReached ? "已达到 10 个备用地址上限" : "添加备用地址"}
              aria-label="添加备用地址"
            >
              <Plus size={16} aria-hidden="true" />
              添加备用地址
            </button>
          </div>

          <div className="site-form-address-list">
            <SiteAddressRow
              workspace={workspace}
              rowId={SITE_PRIMARY_ADDRESS_ROW_ID}
              label="主地址"
              baseUrl={workspace.siteForm.baseUrl}
              placeholder="https://ai.input.im"
              onBaseUrlChange={workspace.updateSitePrimaryBaseUrl}
            />
            {workspace.siteForm.fallbackAddresses.map((address, index) => (
              <SiteAddressRow
                key={address.id}
                workspace={workspace}
                rowId={address.id}
                label={`备用地址 ${index + 1}`}
                baseUrl={address.baseUrl}
                placeholder="https://input.codes"
                onBaseUrlChange={(value) => workspace.updateSiteFallbackAddress(address.id, value)}
                onRemove={() => workspace.removeSiteFallbackAddress(address.id)}
              />
            ))}
          </div>
        </section>

        <section className="site-form-section" aria-labelledby="site-failover-config-heading">
          <div className="site-form-section-heading">
            <div>
              <h4 id="site-failover-config-heading">故障转移参数</h4>
            </div>
          </div>
          <div className="site-form-config-grid">
            <label className="field">
              <span>冷却时长（秒）</span>
              <input
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={workspace.siteForm.failoverCooldownSeconds}
                onChange={(event) =>
                  workspace.setSiteForm((previous) => ({
                    ...previous,
                    failoverCooldownSeconds: event.target.value
                  }))
                }
                placeholder="60"
              />
            </label>
            <label className="field">
              <span>每地址最大访问次数</span>
              <input
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={workspace.siteForm.maxAttemptsPerAddress}
                onChange={(event) =>
                  workspace.setSiteForm((previous) => ({
                    ...previous,
                    maxAttemptsPerAddress: event.target.value
                  }))
                }
                placeholder="1"
              />
            </label>
          </div>
        </section>

        <section className="site-form-runtime" aria-live="polite">
          <div className="site-form-runtime-copy">
            <strong>运行状态</strong>
            <span>
              {!workspace.editingSite
                ? "保存后可用"
                : workspace.siteFailoverStatusLoading
                  ? "正在读取"
                  : activeHost
                    ? `当前使用 ${activeHost}`
                    : "待检测"}
            </span>
          </div>
          {workspace.siteFailoverStatusLoading && (
            <LoaderCircle size={16} className="spin" aria-hidden="true" />
          )}
        </section>

        {(workspace.siteFormError || workspace.siteFailoverStatusError) && (
          <div className="site-form-error" role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            <span>
              {formatAppErrorMessage(
                workspace.siteFormError ?? workspace.siteFailoverStatusError
              )}
            </span>
          </div>
        )}
      </fieldset>
    </Modal>
  );
}

function SiteAddressRow({
  workspace,
  rowId,
  label,
  baseUrl,
  placeholder,
  onBaseUrlChange,
  onRemove
}: {
  workspace: SiteFormWorkspace;
  rowId: string;
  label: string;
  baseUrl: string;
  placeholder: string;
  onBaseUrlChange: (value: string) => void;
  onRemove?: () => void;
}) {
  const persistedStatus = findSiteFailoverAddressStatus(
    workspace.siteFailoverStatus,
    baseUrl
  );
  const status = resolveSiteAddressStatusKind(
    persistedStatus,
    workspace.siteStatusNowMs
  );
  const remainingSeconds = getSiteCooldownRemainingSeconds(
    persistedStatus,
    workspace.siteStatusNowMs
  );
  const action = workspace.siteAddressActions[rowId];
  const actionInFlight = Boolean(action?.testing || action?.clearing);
  const actionsEnabled = workspace.canUseSiteAddressActions(rowId);
  const statusLabel = status === "active"
    ? "当前使用"
    : status === "cooling"
      ? `冷却中 ${remainingSeconds}s`
      : "待检测";

  return (
    <div className="site-form-address-row" data-row-id={rowId}>
      <div className="site-form-address-main">
        <div className="site-form-address-label">
          <label htmlFor={`site-address-${rowId}`}>{label}</label>
          <span className={`site-form-status-pill is-${status}`}>{statusLabel}</span>
        </div>
        <input
          id={`site-address-${rowId}`}
          value={baseUrl}
          onChange={(event) => onBaseUrlChange(event.target.value)}
          placeholder={placeholder}
          spellCheck={false}
        />
        <div className="site-form-address-feedback" aria-live="polite">
          {action?.testing && (
            <span className="is-loading">
              <LoaderCircle size={13} className="spin" aria-hidden="true" />
              正在测试
            </span>
          )}
          {!action?.testing && action?.result?.ok && (
            <span className="is-success">
              <CheckCircle2 size={13} aria-hidden="true" />
              连接正常{action.result.latencyMs != null ? ` · ${action.result.latencyMs}ms` : ""}
            </span>
          )}
          {!action?.testing && action?.result && !action.result.ok && (
            <span className="is-error">
              <AlertCircle size={13} aria-hidden="true" />
              {formatAppErrorMessage(action.result.message ?? "连接测试失败。")}
            </span>
          )}
          {action?.error && (
            <span className="is-error">
              <AlertCircle size={13} aria-hidden="true" />
              {formatAppErrorMessage(action.error)}
            </span>
          )}
        </div>
      </div>

      <div className="site-form-address-actions">
        <button
          type="button"
          className="site-form-icon-button"
          onClick={() => void workspace.handleTestSiteAddress(rowId)}
          disabled={!actionsEnabled || actionInFlight}
          title={actionsEnabled ? `测试${label}连接` : "保存地址后可测试连接"}
          aria-label={`测试${label}连接`}
        >
          {action?.testing ? (
            <LoaderCircle size={16} className="spin" aria-hidden="true" />
          ) : (
            <Activity size={16} aria-hidden="true" />
          )}
        </button>
        {status === "cooling" && (
          <button
            type="button"
            className="site-form-icon-button"
            onClick={() => void workspace.handleClearSiteAddressCooldown(rowId)}
            disabled={!actionsEnabled || actionInFlight}
            title={`解除${label}冷却`}
            aria-label={`解除${label}冷却`}
          >
            {action?.clearing ? (
              <LoaderCircle size={16} className="spin" aria-hidden="true" />
            ) : (
              <TimerReset size={16} aria-hidden="true" />
            )}
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            className="site-form-icon-button is-danger"
            onClick={onRemove}
            disabled={actionInFlight}
            title={`删除${label}`}
            aria-label={`删除${label}`}
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

function resolveAddressHost(baseUrl: string) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function AccountFormModal({
  isEditing,
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
  onSubmit,
  isSubmitting
}: {
  isEditing: boolean;
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
  isSubmitting: boolean;
}) {
  const submitText = isEditing ? "更新账号" : "创建账号";
  const submittingText = isEditing ? "正在保存账号..." : "正在创建账号...";

  return (
    <Modal
      title={isEditing ? "编辑账号" : "新增账号"}
      className={`account-form-modal ${isSubmitting ? "is-submitting" : ""}`.trim()}
      onClose={isSubmitting ? () => {} : onClose}
      footer={
        <>
          <button className="ghost-button" onClick={onClose} disabled={isSubmitting}>
            取消
          </button>
          <button
            className="primary-button account-form-submit-button"
            onClick={onSubmit}
            disabled={isSubmitting}
            aria-busy={isSubmitting}
          >
            {isSubmitting && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
            {isSubmitting ? submittingText : submitText}
          </button>
        </>
      }
    >
      <div className="form-callout">
        {isEditing ? (
          <p>这里可以修改账号信息, 也可以重新填写密码更新本地保存的登录凭据。保存后不会立即重新登录; 如果要马上验证, 回到账号卡片点“登录”即可。</p>
        ) : (
          <p>这里可以直接填写密码. 填写后创建完成会自动登录; 留空则只先保存账号。</p>
        )}
      </div>
      {isSubmitting && (
        <div className="account-form-submitting" role="status" aria-live="polite">
          <LoaderCircle size={20} className="spin" aria-hidden="true" />
          <div>
            <strong>{submittingText}</strong>
            <span>请稍候, 正在处理账号信息。</span>
          </div>
        </div>
      )}
      <fieldset className="account-form-fields" disabled={isSubmitting}>
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
                <span>{selectedAccountSite?.baseUrl ?? "请选择这个账号要归属到哪个站点"}</span>
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
          {sites.length === 0 && <p className="field-help">请先新增站点, 再添加账号。</p>}
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
        <label className="field">
          <span>登录密码</span>
          <input
            type="password"
            value={accountPassword}
            onChange={(event) => setAccountPassword(event.target.value)}
            placeholder={
              isEditing
                ? "可选, 重新填写后会更新当前设备保存的密码"
                : "可选, 填写后创建完成会自动登录"
            }
          />
          <p className="field-help">
            {isEditing
              ? "留空则保留当前已保存密码; 重新填写后只更新当前设备凭据, 不会立即重新登录。"
              : "密码只会保存在当前设备, 方便下次自动登录。"}
          </p>
        </label>
        <label className="field">
          <span>低余额预警阈值</span>
          <input
            type="number"
            value={accountBalanceWarningInput}
            onChange={(event) => onBalanceWarningInput(event.target.value)}
            placeholder="-1"
          />
          <p className="field-help">设为 `-1` 表示关闭低余额提醒, 默认值也是 `-1`。</p>
        </label>
      </fieldset>
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
          ? "密码只会保存在当前设备, 方便下次继续使用。"
          : "请输入验证码, 通过后才会继续登录。"}
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
          <span>验证码</span>
          <input
            value={loginModal.code}
            onChange={(event) => onCodeChange(event.target.value)}
            placeholder="输入 6 位验证码"
          />
          <p className="field-help">如果验证码一直不通过, 可以先检查设备时间是否正确。</p>
        </label>
      )}
    </Modal>
  );
}
