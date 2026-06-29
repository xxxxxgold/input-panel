import type { UserProfileRecord } from "../../types";

export function resolveAccountAvatarUrl({
  profileRecord
}: {
  profileRecord?: UserProfileRecord | null;
}) {
  return normalizeAvatarUrl(profileRecord?.avatarUrl);
}

function normalizeAvatarUrl(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
