const DAY_MS = 24 * 60 * 60 * 1000;

export const KEY_EXPIRY_PRESET_DAYS = [7, 30, 90] as const;

export type KeyExpiryPreset = `${(typeof KEY_EXPIRY_PRESET_DAYS)[number]}d` | "custom";

export function toDateTimeLocalValue(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export function buildKeyExpiryValue(days: number) {
  const target = new Date();
  target.setDate(target.getDate() + days);
  target.setHours(23, 59, 0, 0);
  return toDateTimeLocalValue(target);
}

export function inferKeyExpiryPreset(expiresAt?: string | null): { enabled: boolean; preset: KeyExpiryPreset; value: string } {
  if (!expiresAt) {
    return { enabled: false, preset: "30d", value: buildKeyExpiryValue(30) };
  }
  const target = new Date(expiresAt);
  if (Number.isNaN(target.getTime())) {
    return { enabled: false, preset: "30d", value: buildKeyExpiryValue(30) };
  }
  const remainingDays = Math.max(1, Math.ceil((target.getTime() - Date.now()) / DAY_MS));
  if (remainingDays === 7 || remainingDays === 30 || remainingDays === 90) {
    return { enabled: true, preset: `${remainingDays}d`, value: toDateTimeLocalValue(target) };
  }
  return { enabled: true, preset: "custom", value: toDateTimeLocalValue(target) };
}

export function parseOptionalNumberInput(value: string): number | null {
  if (!value.trim()) return null;
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
}
