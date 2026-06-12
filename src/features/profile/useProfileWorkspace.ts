import { useEffect, useState } from "react";

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

export function useProfileWorkspace({
  selectedAccountId,
  profileRecord,
  setProfileRecord,
  loadOverview,
  setBusyText,
  setError
}: {
  selectedAccountId: string | null;
  profileRecord: UserProfileRecord | null;
  setProfileRecord: (value: UserProfileRecord | null) => void;
  loadOverview: () => Promise<void>;
  setBusyText: (value: string | null) => void;
  setError: (value: string | null) => void;
}) {
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [profileForm, setProfileForm] = useState<ProfileUpdateInput>({});
  const [profilePassword, setProfilePassword] = useState({ oldPassword: "", newPassword: "" });
  const [notifyEmailDraft, setNotifyEmailDraft] = useState({ email: "", code: "", target: "" });

  useEffect(() => {
    if (!profileRecord) {
      setProfileForm({});
      return;
    }

    setProfileForm({
      email: profileRecord.email,
      username: profileRecord.username ?? "",
      balanceNotifyEnabled: profileRecord.balanceNotifyEnabled ?? false,
      balanceNotifyThresholdType: profileRecord.balanceNotifyThresholdType ?? "fixed",
      balanceNotifyThreshold: profileRecord.balanceNotifyThreshold ?? 0
    });
  }, [profileRecord]);

  useEffect(() => {
    if (selectedAccountId) {
      return;
    }
    setProfileModalOpen(false);
    setProfileForm({});
    setProfilePassword({ oldPassword: "", newPassword: "" });
    setNotifyEmailDraft({ email: "", code: "", target: "" });
  }, [selectedAccountId]);

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
    if (!selectedAccountId) {
      return;
    }
    setBusyText("正在更新密码...");
    setError(null);
    try {
      await changeProfilePassword(
        selectedAccountId,
        profilePassword.oldPassword,
        profilePassword.newPassword
      );
      await persistAccountCredential(selectedAccountId, profilePassword.newPassword);
      setProfilePassword({ oldPassword: "", newPassword: "" });
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
    if (!selectedAccountId || !notifyEmailDraft.target || !notifyEmailDraft.code) {
      return;
    }
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

  async function handleUnbind(provider: string) {
    if (!selectedAccountId) {
      return;
    }
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
