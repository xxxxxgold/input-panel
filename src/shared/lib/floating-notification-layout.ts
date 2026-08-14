import layoutConfig from "./floating-notification-layout.json";

export const FLOATING_NOTIFICATION_WIDTH = 232;
export const FLOATING_NOTIFICATION_DETAIL_WIDTH = 344;
export const DEFAULT_FLOATING_NOTIFICATION_DENSITY = "standard";
export const DEFAULT_FLOATING_NOTIFICATION_MAX_VISIBLE = layoutConfig.maxVisible.default;
export const MIN_FLOATING_NOTIFICATION_MAX_VISIBLE = layoutConfig.maxVisible.min;
export const MAX_FLOATING_NOTIFICATION_MAX_VISIBLE = layoutConfig.maxVisible.max;

export type FloatingNotificationDensity = "compact" | "standard" | "relaxed";

export interface FloatingNotificationLayout {
  density: FloatingNotificationDensity;
  compactHeight: number;
  usageHeight: number;
  gap: number;
  verticalPadding: number;
}

const layouts = Object.fromEntries(
  Object.entries(layoutConfig.densities).map(([density, layout]) => [
    density,
    { density, ...layout }
  ])
) as Record<FloatingNotificationDensity, FloatingNotificationLayout>;

export function normalizeFloatingNotificationDensity(value: unknown): FloatingNotificationDensity {
  return value === "compact" || value === "relaxed" ? value : DEFAULT_FLOATING_NOTIFICATION_DENSITY;
}

export function normalizeFloatingNotificationMaxVisible(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_FLOATING_NOTIFICATION_MAX_VISIBLE;
  }
  return Math.min(
    Math.max(Math.round(value), MIN_FLOATING_NOTIFICATION_MAX_VISIBLE),
    MAX_FLOATING_NOTIFICATION_MAX_VISIBLE
  );
}

export function getFloatingNotificationLayout(
  density: FloatingNotificationDensity | string | null | undefined
): FloatingNotificationLayout {
  return layouts[normalizeFloatingNotificationDensity(density)];
}

export function getFloatingNotificationItemHeight(
  hasUsage: boolean,
  density: FloatingNotificationDensity | string | null | undefined
): number {
  const layout = getFloatingNotificationLayout(density);
  return hasUsage ? layout.usageHeight : layout.compactHeight;
}
