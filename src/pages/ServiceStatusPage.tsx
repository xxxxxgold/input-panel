import { ServiceStatusTerminal } from "../features/service-status/ServiceStatusTerminal";
import type { useServiceStatusWorkspace } from "../features/service-status/useServiceStatusWorkspace";

export function ServiceStatusPage({
  workspace
}: {
  workspace: ReturnType<typeof useServiceStatusWorkspace>;
}) {
  return (
    <ServiceStatusTerminal
      status={workspace.status}
      lastSyncedAt={workspace.lastSyncedAt}
    />
  );
}
