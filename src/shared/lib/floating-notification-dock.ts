export type FloatingNotificationDock = "left" | "right";

// 原生快照缺失 dock 时保留历史右侧默认行为。
export function normalizeFloatingNotificationDock(
  dock: FloatingNotificationDock | null | undefined
): FloatingNotificationDock {
  return dock === "left" ? "left" : "right";
}
