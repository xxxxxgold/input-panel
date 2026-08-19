export function shouldApplyMailboxRevision(
  lastAppliedRevision: number,
  incomingRevision: number
): boolean {
  return incomingRevision > lastAppliedRevision;
}

/** 防止异步 command 的旧展示元数据覆盖请求期间收到的最新 native sync event。 */
export function shouldApplyFloatingNotificationPresentation(
  lastAppliedRevision: number,
  snapshotRevision: number,
  eventVersionAtRequest: number | null,
  currentEventVersion: number
): boolean {
  return (
    eventVersionAtRequest === null ||
    eventVersionAtRequest === currentEventVersion ||
    shouldApplyMailboxRevision(lastAppliedRevision, snapshotRevision)
  );
}

/** prefs hydration 期间优先保留更高 revision, 同 revision 再按 native event 顺序取新值。 */
export function shouldReplaceFloatingNotificationSnapshotBuffer(
  currentEventVersion: number | null,
  currentRevision: number | null,
  incomingEventVersion: number,
  incomingRevision: number
): boolean {
  if (currentEventVersion === null || currentRevision === null) {
    return true;
  }
  if (incomingRevision !== currentRevision) {
    return incomingRevision > currentRevision;
  }
  return incomingEventVersion >= currentEventVersion;
}
