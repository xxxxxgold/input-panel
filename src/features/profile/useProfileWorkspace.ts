import { useEffect, useRef, useState, type SetStateAction } from "react";

import type { SaveFeedbackHandler } from "../../shared/lib/save-feedback";
import type {
  ProfileUpdateInput,
  UserProfileRecord
} from "../../types";
import { persistAccountCredential } from "../accounts/client";
import {
  getProfileRecord,
  sendNotifyEmailCode,
  unbindAuthIdentity,
  updateProfileRecord,
  verifyNotifyEmail,
  changeProfilePassword
} from "./client";

const EMPTY_PROFILE_PASSWORD = { oldPassword: "", newPassword: "" };
const EMPTY_NOTIFY_EMAIL_DRAFT = { email: "", code: "", target: "" };

function profileFormFromRecord(profileRecord: UserProfileRecord): ProfileUpdateInput {
  return {
    email: profileRecord.email,
    username: profileRecord.username ?? "",
    balanceNotifyEnabled: profileRecord.balanceNotifyEnabled ?? false,
    balanceNotifyThresholdType: profileRecord.balanceNotifyThresholdType ?? "fixed",
    balanceNotifyThreshold: profileRecord.balanceNotifyThreshold ?? 0
  };
}

export function useProfileWorkspace({
  selectedAccountId,
  profileRecord,
  setProfileRecord,
  loadOverview,
  onSaveFeedback,
  setBusyText,
  setError
}: {
  selectedAccountId: string | null;
  profileRecord: UserProfileRecord | null;
  setProfileRecord: (value: UserProfileRecord | null, accountId: string) => void;
  loadOverview: () => Promise<void>;
  onSaveFeedback: SaveFeedbackHandler;
  setBusyText: (value: string | null) => void;
  setError: (value: string | null) => void;
}) {
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [profileForm, setProfileFormState] = useState<ProfileUpdateInput>({});
  const [profilePassword, setProfilePassword] = useState(EMPTY_PROFILE_PASSWORD);
  const [notifyEmailDraft, setNotifyEmailDraft] = useState(EMPTY_NOTIFY_EMAIL_DRAFT);
  const previousSelectedAccountIdRef = useRef(selectedAccountId);
  const profileFormAccountIdRef = useRef<string | null>(null);
  const profileFormDirtyRef = useRef(false);
  const selectedAccountIdRef = useRef(selectedAccountId);
  selectedAccountIdRef.current = selectedAccountId;

  useEffect(() => {
    if (previousSelectedAccountIdRef.current === selectedAccountId) {
      return;
    }

    previousSelectedAccountIdRef.current = selectedAccountId;
    profileFormAccountIdRef.current = null;
    profileFormDirtyRef.current = false;
    setProfileModalOpen(false);
    setProfileFormState({});
    setProfilePassword(EMPTY_PROFILE_PASSWORD);
    setNotifyEmailDraft(EMPTY_NOTIFY_EMAIL_DRAFT);
  }, [selectedAccountId]);

  useEffect(() => {
    if (!selectedAccountId) {
      setProfileFormState({});
      profileFormAccountIdRef.current = null;
      profileFormDirtyRef.current = false;
      return;
    }

    if (
      profileFormAccountIdRef.current === selectedAccountId
      && profileFormDirtyRef.current
    ) {
      return;
    }

    if (!profileRecord) {
      setProfileFormState({});
      profileFormAccountIdRef.current = selectedAccountId;
      profileFormDirtyRef.current = false;
      return;
    }

    // 同账号刷新只替换服务端快照, 不覆盖用户尚未提交的资料草稿。
    setProfileFormState(profileFormFromRecord(profileRecord));
    profileFormAccountIdRef.current = selectedAccountId;
    profileFormDirtyRef.current = false;
  }, [profileRecord, selectedAccountId]);

  function setProfileForm(next: SetStateAction<ProfileUpdateInput>) {
    profileFormDirtyRef.current = true;
    setProfileFormState(next);
  }

  function openProfileModal() {
    setProfileModalOpen(true);
  }

  function closeProfileModal() {
    setProfileModalOpen(false);
    setProfilePassword({ oldPassword: "", newPassword: "" });
    setNotifyEmailDraft((prev) => ({ ...prev, code: "" }));
  }

  async function handleProfileSave() {
    if (!selectedAccountId) {
      return;
    }
    const accountId = selectedAccountId;
    setBusyText("正在保存资料...");
    setError(null);
    try {
      const next = await updateProfileRecord(accountId, profileForm);
      setProfileRecord(next, accountId);
      if (selectedAccountIdRef.current === accountId) {
        setProfileFormState(profileFormFromRecord(next));
        profileFormAccountIdRef.current = accountId;
        profileFormDirtyRef.current = false;
      }
      await loadOverview();
      onSaveFeedback({
        tone: "success",
        title: "保存成功",
        message: "个人资料已保存。"
      });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleProfilePasswordChange() {
    if (!selectedAccountId) {
      return;
    }
    if (!profilePassword.oldPassword.trim() || !profilePassword.newPassword.trim()) {
      setError("请填写旧密码和新密码。");
      return;
    }
    const accountId = selectedAccountId;
    setBusyText("正在更新密码...");
    setError(null);
    try {
      await changeProfilePassword(
        accountId,
        profilePassword.oldPassword,
        profilePassword.newPassword
      );
      await persistAccountCredential(accountId, profilePassword.newPassword);
      setProfilePassword(EMPTY_PROFILE_PASSWORD);
      onSaveFeedback({
        tone: "success",
        title: "保存成功",
        message: "登录密码已更新。"
      });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleNotifyEmailSend() {
    if (!selectedAccountId || !notifyEmailDraft.email) {
      return;
    }
    const accountId = selectedAccountId;
    setBusyText("正在发送通知邮箱验证码...");
    setError(null);
    try {
      await sendNotifyEmailCode(accountId, notifyEmailDraft.email);
      setNotifyEmailDraft((prev) => ({ ...prev, target: prev.email }));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleNotifyEmailVerify() {
    if (!selectedAccountId || !notifyEmailDraft.target || !notifyEmailDraft.code) {
      return;
    }
    const accountId = selectedAccountId;
    setBusyText("正在验证通知邮箱...");
    setError(null);
    try {
      await verifyNotifyEmail(accountId, notifyEmailDraft.target, notifyEmailDraft.code);
      const next = await getProfileRecord(accountId, true);
      setProfileRecord(next, accountId);
      setNotifyEmailDraft({ email: "", code: "", target: "" });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  async function handleUnbind(provider: string) {
    if (!selectedAccountId) {
      return;
    }
    const accountId = selectedAccountId;
    setBusyText("正在解绑账号...");
    setError(null);
    try {
      await unbindAuthIdentity(accountId, provider);
      const next = await getProfileRecord(accountId, true);
      setProfileRecord(next, accountId);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyText(null);
    }
  }

  return {
    profileModalOpen,
    openProfileModal,
    closeProfileModal,
    profileForm,
    setProfileForm,
    profilePassword,
    setProfilePassword,
    notifyEmailDraft,
    setNotifyEmailDraft,
    handleProfileSave,
    handleProfilePasswordChange,
    handleNotifyEmailSend,
    handleNotifyEmailVerify,
    handleUnbind
  };
}
