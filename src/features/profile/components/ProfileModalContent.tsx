import type { Dispatch, SetStateAction } from "react";

import type { PlatformQuotaPayload, ProfileUpdateInput, UserProfileRecord } from "../../../types";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { SectionCard } from "../../../shared/ui/SectionCard";

export function ProfileModalContent({
  profileRecord,
  profileForm,
  setProfileForm,
  profilePassword,
  setProfilePassword,
  notifyEmailDraft,
  setNotifyEmailDraft,
  platformQuotas,
  onProfileSave,
  onPasswordChange,
  onNotifyEmailSend,
  onNotifyEmailVerify,
  onUnbind
}: {
  profileRecord: UserProfileRecord | null;
  profileForm: ProfileUpdateInput;
  setProfileForm: Dispatch<SetStateAction<ProfileUpdateInput>>;
  profilePassword: { oldPassword: string; newPassword: string };
  setProfilePassword: Dispatch<SetStateAction<{ oldPassword: string; newPassword: string }>>;
  notifyEmailDraft: { email: string; code: string; target: string };
  setNotifyEmailDraft: Dispatch<SetStateAction<{ email: string; code: string; target: string }>>;
  platformQuotas: PlatformQuotaPayload | null;
  onProfileSave: () => void;
  onPasswordChange: () => void;
  onNotifyEmailSend: () => void;
  onNotifyEmailVerify: () => void;
  onUnbind: (provider: string) => void;
}) {
  return (
    <div className="profile-modal-shell">
      <section className="content-grid profile-modal-grid">
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
              <button className="primary-button" onClick={onProfileSave}>
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
    </div>
  );
}
