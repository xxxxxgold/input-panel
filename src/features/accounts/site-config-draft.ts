import type {
  SiteFailoverAddressStatus,
  SiteFailoverAddressStatusKind,
  SiteFailoverStatusPayload,
  SiteInput,
  SiteRecord
} from "../../types";

export const MAX_SITE_FALLBACK_ADDRESSES = 10;
export const SITE_PRIMARY_ADDRESS_ROW_ID = "site-primary";
const MAX_U32 = 0xffff_ffff;

let fallbackRowSequence = 0;

export interface SiteFallbackAddressDraft {
  id: string;
  baseUrl: string;
}

export interface SiteConfigDraft {
  name: string;
  baseUrl: string;
  fallbackAddresses: SiteFallbackAddressDraft[];
  failoverCooldownSeconds: string;
  retryCountPerAddress: string;
}

export function createSiteFallbackAddressDraft(baseUrl = ""): SiteFallbackAddressDraft {
  fallbackRowSequence += 1;
  return {
    id: `site-fallback-${fallbackRowSequence}`,
    baseUrl
  };
}

export function createSiteConfigDraft(site?: SiteRecord | null): SiteConfigDraft {
  if (!site) {
    return {
      name: "",
      baseUrl: "https://ai.input.im",
      fallbackAddresses: [],
      failoverCooldownSeconds: "60",
      retryCountPerAddress: "0"
    };
  }

  return {
    name: site.name,
    baseUrl: site.baseUrl,
    fallbackAddresses: site.fallbackBaseUrls.map((baseUrl) =>
      createSiteFallbackAddressDraft(baseUrl)
    ),
    failoverCooldownSeconds: String(site.failoverCooldownSeconds),
    retryCountPerAddress: String(site.retryCountPerAddress)
  };
}

/** 在提交边界将可为空的字符串草稿转换为 generated contract。 */
export function siteInputFromDraft(draft: SiteConfigDraft): SiteInput {
  const name = draft.name.trim();
  if (!name) {
    throw new Error("站点名称不能为空。");
  }
  if (draft.fallbackAddresses.length > MAX_SITE_FALLBACK_ADDRESSES) {
    throw new Error(`备用地址最多只能添加 ${MAX_SITE_FALLBACK_ADDRESSES} 个。`);
  }

  const baseUrl = canonicalizeSiteBaseUrlDraft(draft.baseUrl, "主地址");
  const fallbackBaseUrls = draft.fallbackAddresses.map((item, index) =>
    canonicalizeSiteBaseUrlDraft(item.baseUrl, `备用地址 ${index + 1}`)
  );
  const uniqueAddresses = new Set([baseUrl, ...fallbackBaseUrls]);
  if (uniqueAddresses.size !== fallbackBaseUrls.length + 1) {
    throw new Error("主地址和备用地址不能重复。");
  }

  return {
    name,
    baseUrl,
    fallbackBaseUrls,
    failoverCooldownSeconds: parsePositiveU32(
      draft.failoverCooldownSeconds,
      "冷却时长"
    ),
    retryCountPerAddress: parseNonNegativeU32(
      draft.retryCountPerAddress,
      "重试次数"
    )
  };
}

export function canonicalizeSiteBaseUrlDraft(value: string, label = "站点地址") {
  const input = value.trim();
  if (!input) {
    throw new Error(`${label}不能为空。`);
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${label}格式无效。`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw new Error(`${label}必须使用 http 或 https 协议并包含主机名。`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label}不能包含账号信息、查询参数或片段。`);
  }

  const normalizedPath = url.pathname.replace(/\/+$/, "");
  url.pathname = normalizedPath || "/";
  return url.toString().replace(/\/$/, "");
}

export function parsePositiveU32(value: string, label: string) {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${label}必须是正整数。`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_U32) {
    throw new Error(`${label}必须是 1 到 ${MAX_U32} 之间的整数。`);
  }
  return parsed;
}

export function parseNonNegativeU32(value: string, label: string) {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${label}必须是非负整数。`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_U32) {
    throw new Error(`${label}必须是 0 到 ${MAX_U32} 之间的整数。`);
  }
  return parsed;
}

export function siteDraftAddressBelongsToPersistedSite(
  site: SiteRecord | null,
  baseUrl: string
) {
  if (!site) {
    return false;
  }
  try {
    const canonical = canonicalizeSiteBaseUrlDraft(baseUrl);
    return [site.baseUrl, ...site.fallbackBaseUrls].some(
      (candidate) => canonicalizeSiteBaseUrlDraft(candidate) === canonical
    );
  } catch {
    return false;
  }
}

export function findSiteFailoverAddressStatus(
  status: SiteFailoverStatusPayload | null,
  baseUrl: string
): SiteFailoverAddressStatus | null {
  if (!status) {
    return null;
  }
  try {
    const canonical = canonicalizeSiteBaseUrlDraft(baseUrl);
    return status.addresses.find(
      (address) => canonicalizeSiteBaseUrlDraft(address.baseUrl) === canonical
    ) ?? null;
  } catch {
    return null;
  }
}

/** 确认运行状态快照仍对应当前保存的主备地址拓扑，避免展示已替换的旧地址。 */
export function isSiteFailoverStatusForSite(
  status: SiteFailoverStatusPayload | null,
  site: SiteRecord | null
) {
  if (!status || !site || status.siteId !== site.id) {
    return false;
  }

  const expectedAddresses = [
    { baseUrl: site.baseUrl, kind: "primary" as const },
    ...site.fallbackBaseUrls.map((baseUrl) => ({
      baseUrl,
      kind: "fallback" as const
    }))
  ];
  if (status.addresses.length !== expectedAddresses.length) {
    return false;
  }

  return expectedAddresses.every((expectedAddress, index) => {
    const actualAddress = status.addresses[index];
    if (!actualAddress || actualAddress.kind !== expectedAddress.kind) {
      return false;
    }
    try {
      return canonicalizeSiteBaseUrlDraft(actualAddress.baseUrl)
        === canonicalizeSiteBaseUrlDraft(expectedAddress.baseUrl);
    } catch {
      return false;
    }
  });
}

export function getSiteCooldownRemainingSeconds(
  address: SiteFailoverAddressStatus | null,
  serverNowMs: number
) {
  if (!address?.cooldownUntil) {
    return 0;
  }
  const cooldownUntilMs = Date.parse(address.cooldownUntil);
  if (!Number.isFinite(cooldownUntilMs)) {
    return 0;
  }
  return Math.max(0, Math.ceil((cooldownUntilMs - serverNowMs) / 1_000));
}

export function resolveSiteAddressStatusKind(
  address: SiteFailoverAddressStatus | null,
  serverNowMs: number
): SiteFailoverAddressStatusKind {
  if (!address) {
    return "pending";
  }
  if (address.status === "cooling" && getSiteCooldownRemainingSeconds(address, serverNowMs) <= 0) {
    return "pending";
  }
  return address.status;
}
