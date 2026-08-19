export type FloatingNotificationSoundAction =
  | "select"
  | "preview"
  | "restore"
  | "system"
  | "mute"
  | "custom";

const FLOATING_NOTIFICATION_SOUND_FAILURE_MESSAGES: Record<
  FloatingNotificationSoundAction,
  string
> = {
  select: "提示音文件导入失败，请重试。",
  preview: "提示音试听失败，请重试。",
  restore: "恢复默认提示音失败，请重试。",
  system: "切换 Windows 系统提示音失败，请重试。",
  mute: "静音提示音失败，请重试。",
  custom: "已保存的自定义提示音不可用，请重新选择文件。"
};

/**
 * 将可能来自旧配置或原生返回的文件标识收口为安全显示名。
 */
export function normalizeCustomNotificationSoundFileName(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const segments = trimmed.split(/[\\/]/);
  return segments.at(-1)?.trim() || null;
}

/**
 * 原生命令错误可能包含本地绝对路径，Toast 只能展示稳定的安全文案。
 */
export function resolveFloatingNotificationSoundFailureMessage(
  action: FloatingNotificationSoundAction,
  cause: unknown
) {
  void cause;
  return FLOATING_NOTIFICATION_SOUND_FAILURE_MESSAGES[action];
}
