export type FloatingNotificationPlacement = "above" | "below";
export type FloatingNotificationSlotAnchor = "top" | "bottom";

export interface FloatingNotificationSlotInput {
  id: string;
  height: number;
}

export interface FloatingNotificationSlot extends FloatingNotificationSlotInput {
  offset: number;
  anchor: FloatingNotificationSlotAnchor;
}

/** 旧 snapshot 缺失或携带非法值时保持历史 bottom-anchor 行为。 */
export function normalizeFloatingNotificationPlacement(
  value: unknown
): FloatingNotificationPlacement {
  return value === "below" ? "below" : "above";
}

/** 保持 FIFO/DOM 顺序，仅将 newest-first 偏移投影到 placement 对应锚点。 */
export function resolveFloatingNotificationSlots(
  items: readonly FloatingNotificationSlotInput[],
  gap: number,
  verticalPadding: number,
  placement: FloatingNotificationPlacement
): FloatingNotificationSlot[] {
  const slots = new Array<FloatingNotificationSlot>(items.length);
  const anchor: FloatingNotificationSlotAnchor = placement === "below" ? "top" : "bottom";
  let offset = verticalPadding / 2;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) {
      continue;
    }
    slots[index] = { ...item, offset, anchor };
    offset += item.height + gap;
  }
  return slots;
}
