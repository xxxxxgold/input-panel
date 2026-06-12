import type { UserProfileRecord } from "../../types";

const QQ_AVATAR_DOMAINS = new Set(["qq.com", "foxmail.com"]);

export function resolveAccountAvatarUrl({
  accountEmail,
  profileRecord
}: {
  accountEmail?: string | null;
  profileRecord?: UserProfileRecord | null;
}) {
  const profileAvatarUrl = normalizeAvatarUrl(profileRecord?.avatarUrl);
  if (profileAvatarUrl) {
    return profileAvatarUrl;
  }

  return buildQqAvatarUrl(accountEmail ?? profileRecord?.email ?? null);
}

export function buildQqAvatarUrl(email: string | null | undefined) {
  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail) {
    return null;
  }

  const [mailbox, domain] = normalizedEmail.split("@");
  if (!mailbox || !domain) {
    return null;
  }

  if (!QQ_AVATAR_DOMAINS.has(domain) || !/^\d{5,12}$/.test(mailbox)) {
    return null;
  }

  return `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(mailbox)}&s=100`;
}

function normalizeAvatarUrl(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
