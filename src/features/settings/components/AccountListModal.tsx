import { formatBalanceWarningSummary } from "../../../account-warning";
import { formatTime } from "../../../shared/lib/formatters";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Modal } from "../../../shared/ui/Modal";
import { StatusBadge } from "../../../shared/ui/StatusBadge";
import type { AccountRuntime, SiteRecord } from "../../../types";

export function AccountListModal({
  selectedSite,
  totalAccounts,
  onlineCount,
  alertCount,
  siteBalance,
  searchValue,
  onSearchChange,
  accounts,
  onClose,
  onEditSite,
  onOpenNewAccount,
  onLogin,
  onRefresh,
  onEdit,
  onRemove
}: {
  selectedSite: SiteRecord | null;
  totalAccounts: number;
  onlineCount: number;
  alertCount: number;
  siteBalance: number;
  searchValue: string;
  onSearchChange: (value: string) => void;
  accounts: AccountRuntime[];
  onClose: () => void;
  onEditSite: () => void;
  onOpenNewAccount: () => void;
  onLogin: (account: AccountRuntime) => void;
  onRefresh: (accountId: string) => void;
  onEdit: (account: AccountRuntime) => void;
  onRemove: (accountId: string) => void;
}) {
  return (
    <Modal
      title={selectedSite ? `${selectedSite.name} · 站点详情` : "站点详情"}
      onClose={onClose}
      size="wide"
      className="account-list-modal"
      footer={
        <button className="ghost-button" onClick={onClose}>
          关闭
        </button>
      }
    >
      {selectedSite ? (
        <>
          <div className="modal-site-overview">
            <div className="modal-site-copy">
              <strong>{selectedSite.name}</strong>
              <p>{selectedSite.baseUrl}</p>
            </div>
            <div className="inline-actions wrap-actions">
              <button className="inline-text-button" onClick={onEditSite}>
                编辑站点
              </button>
              <button className="inline-text-button" onClick={onOpenNewAccount}>
                加账号
              </button>
            </div>
          </div>
          <div className="site-summary modal-site-summary">
            <div className="summary-stat">
              <span>账号数</span>
              <strong>{totalAccounts}</strong>
            </div>
            <div className="summary-stat">
              <span>在线账号</span>
              <strong>{onlineCount}</strong>
            </div>
            <div className="summary-stat">
              <span>异常</span>
              <strong>{alertCount}</strong>
            </div>
            <div className="summary-stat">
              <span>站点余额</span>
              <strong>${siteBalance.toFixed(2)}</strong>
            </div>
          </div>
        </>
      ) : (
        <p className="modal-hint">当前站点下的账号、状态和余额明细会显示在这里。</p>
      )}
      <p className="modal-hint">当前站点下的所有账号都会在这里列出，登录、刷新和编辑也统一在这里处理。</p>
      <div className="context-section">
        <input
          className="search-input"
          value={searchValue}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="搜索当前站点账号"
        />
        <div className="table-list wide">
          {accounts.map((account) => (
            <div key={account.id} className="table-row wide">
              <div className="row-main">
                <strong>{account.label}</strong>
                <p>{account.email}</p>
                <small>{account.site?.name ?? "未知站点"}</small>
              </div>
              <div className="row-meta">
                <span>{formatBalanceWarningSummary(account.balanceWarning)}</span>
                <span>{account.cacheView ? formatTime(account.cacheView.fetchedAt) : "未拉取"}</span>
              </div>
              <div className="row-actions">
                <StatusBadge state={account.sessionState} />
                <button className="inline-text-button" onClick={() => onLogin(account)}>
                  登录
                </button>
                <button className="inline-text-button" onClick={() => onRefresh(account.id)}>
                  刷新
                </button>
                <button className="inline-text-button" onClick={() => onEdit(account)}>
                  编辑
                </button>
                <button className="inline-text-button danger" onClick={() => onRemove(account.id)}>
                  删除
                </button>
              </div>
            </div>
          ))}
          {accounts.length === 0 && (
            <EmptyState title="还没有账号" detail="先为当前站点添加一个账号。" compact />
          )}
        </div>
      </div>
    </Modal>
  );
}
