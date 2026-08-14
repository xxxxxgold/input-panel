import { RefreshCcw } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";

import type { AccountDataResourcePresentation } from "../../accounts/useAccountDataWorkspace";
import { Modal } from "../../../shared/ui/Modal";
import type {
  AccountRuntime,
  PlatformQuotaPayload,
  ProfileUpdateInput,
  UserProfileRecord
} from "../../../types";
import { ProfileModalContent } from "./ProfileModalContent";

export function ProfileWorkspaceModal({
  open,
  selectedAccount,
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
  onClose,
  onRefreshSelectedAccount,
  onRetryProfile,
  onRetryPlatformQuotas,
  onProfileSave,
  onPasswordChange,
  onNotifyEmailSend,
  onNotifyEmailVerify,
  onUnbind
}: {
  open: boolean;
  selectedAccount: AccountRuntime | null;
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
  onClose: () => void;
  onRefreshSelectedAccount: () => void;
  onRetryProfile: () => void;
  onRetryPlatformQuotas: () => void;
  onProfileSave: () => void;
  onPasswordChange: () => void;
  onNotifyEmailSend: () => void;
  onNotifyEmailVerify: () => void;
  onUnbind: (provider: string) => void;
}) {
  if (!open) {
    return null;
  }

  return (
    <Modal
      title={`${selectedAccount?.label || "当前账号"} · 个人中心`}
      onClose={onClose}
      size="wide"
      className="profile-modal"
      bodyClassName="profile-modal-body"
      footerClassName="profile-modal-footer"
      closeText={null}
      footer={
        <>
          <button className="ghost-button" onClick={onClose}>
            关闭
          </button>
          {selectedAccount && (
            <button className="ghost-button" onClick={onRefreshSelectedAccount}>
              <RefreshCcw size={16} />
              刷新当前账号
            </button>
          )}
        </>
      }
    >
      <ProfileModalContent
        profileRecord={profileRecord}
        profilePresentation={profilePresentation}
        profileForm={profileForm}
        setProfileForm={setProfileForm}
        profilePassword={profilePassword}
        setProfilePassword={setProfilePassword}
        notifyEmailDraft={notifyEmailDraft}
        setNotifyEmailDraft={setNotifyEmailDraft}
        platformQuotas={platformQuotas}
        platformQuotasPresentation={platformQuotasPresentation}
        onRetryProfile={onRetryProfile}
        onRetryPlatformQuotas={onRetryPlatformQuotas}
        onProfileSave={onProfileSave}
        onPasswordChange={onPasswordChange}
        onNotifyEmailSend={onNotifyEmailSend}
        onNotifyEmailVerify={onNotifyEmailVerify}
        onUnbind={onUnbind}
      />
    </Modal>
  );
}
