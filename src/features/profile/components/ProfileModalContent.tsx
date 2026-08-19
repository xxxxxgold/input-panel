import { RefreshCcw } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";

import type { AccountDataResourcePresentation } from "../../accounts/useAccountDataWorkspace";
import type { PlatformQuotaPayload, ProfileUpdateInput, UserProfileRecord } from "../../../types";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { SectionCard } from "../../../shared/ui/SectionCard";

function ResourceColdState({
  label,
  presentation,
  onRetry
}: {
  label: string;
  presentation: AccountDataResourcePresentation;
  onRetry: () => void;
}) {
  if (presentation.hasSnapshot || (!presentation.initialLoading && !presentation.lastError)) {
    return null;
  }

  const failed = Boolean(presentation.lastError);
  return (
    <div className="stack-list">
      <EmptyState
        title={failed ? `${label}暂时无法读取` : `正在读取${label}`}
        detail={failed ? `${presentation.lastError} 请重新读取。` : `正在读取当前账号的${label}, 请稍候。`}
        compact
      />
      {failed && (
        <button className="ghost-button" type="button" onClick={onRetry}>
          <RefreshCcw size={16} />
          重新读取{label}
        </button>
      )}
    </div>
  );
}

function ResourceRefreshNotice({
  label,
  presentation,
  onRetry
}: {
  label: string;
  presentation: AccountDataResourcePresentation;
  onRetry: () => void;
}) {
  if (!presentation.hasSnapshot || !presentation.lastError) {
    return null;
  }

  return (
    <div className="workspace-refresh-status has-error" role="alert" aria-live="polite">
      <span>{label}刷新失败, 当前展示上次成功的数据。</span>
      <button className="ghost-button" type="button" onClick={onRetry}>
        <RefreshCcw size={16} />
        重试
      </button>
    </div>
  );
}

export function ProfileModalContent({
  profileRecord,
  profilePresentation,
  profileForm,
  setProfileForm,
  profilePassword,
  setProfilePassword,
  notifyEmailDraft,
  setNotifyEmailDraft,
  platformQuotas,
  platformQuotasPresentation,
  onRetryProfile,
  onRetryPlatformQuotas,
  onProfileSave,
  onPasswordChange,
  onNotifyEmailSend,
  onNotifyEmailVerify,
  onUnbind
}: {
  profileRecord: UserProfileRecord | null;
  profilePresentation: AccountDataResourcePresentation;
  profileForm: ProfileUpdateInput;
  setProfileForm: Dispatch<SetStateAction<ProfileUpdateInput>>;
  profilePassword: { oldPassword: string; newPassword: string };
  setProfilePassword: Dispatch<SetStateAction<{ oldPassword: string; newPassword: string }>>;
  notifyEmailDraft: { email: string; code: string; target: string };
  setNotifyEmailDraft: Dispatch<SetStateAction<{ email: string; code: string; target: string }>>;
  platformQuotas: PlatformQuotaPayload | null;
  platformQuotasPresentation: AccountDataResourcePresentation;
  onRetryProfile: () => void;
  onRetryPlatformQuotas: () => void;
  onProfileSave: () => void;
  onPasswordChange: () => void;
  onNotifyEmailSend: () => void;
  onNotifyEmailVerify: () => void;
  onUnbind: (provider: string) => void;
}) {
  return (
    <div className="profile-modal-shell">
      <section className="content-grid profile-modal-grid">
        <SectionCard title="个人资料" subtitle="查看并修改当前账号的基础信息">
          {profileRecord ? (
            <div className="stack-list">
              <ResourceRefreshNotice
                label="个人资料"
                presentation={profilePresentation}
                onRetry={onRetryProfile}
              />
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
              <button className="primary-button" onClick={onProfileSave}>
                保存资料
              </button>
            </div>
          ) : profilePresentation.hasSnapshot ? (
            <div className="stack-list">
              <ResourceRefreshNotice
                label="个人资料"
                presentation={profilePresentation}
                onRetry={onRetryProfile}
              />
              <EmptyState title="当前没有资料数据" detail="先登录并刷新当前账号。" compact />
            </div>
          ) : profilePresentation.initialLoading || profilePresentation.lastError ? (
            <ResourceColdState
              label="个人资料"
              presentation={profilePresentation}
              onRetry={onRetryProfile}
            />
          ) : (
            <EmptyState title="当前没有资料数据" detail="先登录并刷新当前账号。" compact />
          )}
        </SectionCard>
        <SectionCard title="密码与通知" subtitle="修改密码, 设置通知邮箱, 查看绑定状态">
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
            <button className="ghost-button" onClick={onPasswordChange}>
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
              <button className="ghost-button" onClick={onNotifyEmailSend}>
                发送验证码
              </button>
              <input
                className="inline-input"
                value={notifyEmailDraft.code}
                onChange={(event) => setNotifyEmailDraft((prev) => ({ ...prev, code: event.target.value }))}
                placeholder="验证码"
              />
              <button className="primary-button" onClick={onNotifyEmailVerify}>
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
                      <button className="inline-text-button danger" onClick={() => onUnbind(provider)}>
                        解绑
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </SectionCard>
      </section>
      <SectionCard title="平台额度" subtitle="查看各个平台还能用多少">
        <div className="table-list">
          <ResourceRefreshNotice
            label="平台额度"
            presentation={platformQuotasPresentation}
            onRetry={onRetryPlatformQuotas}
          />
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
          {!platformQuotasPresentation.hasSnapshot
            && (platformQuotasPresentation.initialLoading || platformQuotasPresentation.lastError)
            ? <ResourceColdState
                label="平台额度"
                presentation={platformQuotasPresentation}
                onRetry={onRetryPlatformQuotas}
              />
            : (!platformQuotas || platformQuotas.platformQuotas.length === 0) && (
            <EmptyState title="当前没有平台额度" detail="这个账号暂时没有可展示的平台额度。" compact />
            )}
        </div>
      </SectionCard>
    </div>
  );
}
