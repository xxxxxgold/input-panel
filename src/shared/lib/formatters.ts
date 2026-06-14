export function compact(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

export function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

export function formatDateTimeFull(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

export function formatLiveClockTime(value: Date | string) {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return typeof value === "string" ? value : "";
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

export function formatLiveClockDate(value: Date | string) {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return typeof value === "string" ? value : "";
  return date.toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long"
  });
}

export function formatMilliseconds(value?: number | null) {
  if (value === null || value === undefined || value <= 0) return "-";
  return `${Math.round(value)} ms`;
}

export function formatDurationSeconds(value?: number | null, digits?: number, unitLabel = "s") {
  if (value === null || value === undefined || value <= 0) return "-";
  const precision = digits ?? (value >= 10000 ? 1 : 2);
  return `${(value / 1000).toFixed(precision)} ${unitLabel}`;
}

export function formatUsd(value?: number | null, digits = 6) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `$${Number(value).toFixed(digits)}`;
}

export function formatPercent(value?: number | null, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${Number(value).toFixed(digits)}%`;
}

export function formatUsdPerMillion(cost?: number | null, tokens?: number | null) {
  if (!cost || !tokens || tokens <= 0) return "-";
  return `${formatUsd((cost / tokens) * 1_000_000, 4)} / 1M Token`;
}

export function formatBillingMode(mode?: string | null, billingType?: number | null) {
  if (mode && billingType) return `${mode} / #${billingType}`;
  if (mode) return mode;
  if (billingType) return `#${billingType}`;
  return "-";
}

export function formatSubscriptionTypeLabel(value?: string | null) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "标准";
  if (normalized === "standard") return "标准";
  if (normalized === "subscription") return "订阅";
  if (normalized === "unknown") return "未知";
  return value ?? "标准";
}

export function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  if (local.length <= 3) {
    return `${local.charAt(0) || "*"}***@${domain}`;
  }
  return `${local.slice(0, 3)}***@${domain}`;
}

export function maskSecret(value: string) {
  if (!value) return "";
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function toDateValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatRemainingDaysLabel(value?: string | null) {
  if (!value) {
    return "暂无到期时间";
  }
  const target = new Date(value);
  if (Number.isNaN(target.getTime())) {
    return value;
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const remainingDays = Math.ceil((target.getTime() - Date.now()) / dayMs);
  if (remainingDays < 0) {
    return "已到期";
  }
  if (remainingDays === 0) {
    return "今天到期";
  }
  return `剩余 ${remainingDays} 天`;
}
