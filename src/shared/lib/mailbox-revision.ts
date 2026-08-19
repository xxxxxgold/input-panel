export function shouldApplyMailboxRevision(
  lastAppliedRevision: number,
  incomingRevision: number
): boolean {
  return incomingRevision > lastAppliedRevision;
}
