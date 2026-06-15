import { ServiceStatusTerminal } from "../features/service-status/ServiceStatusTerminal";
import type { useServiceStatusWorkspace } from "../features/service-status/useServiceStatusWorkspace";

export function ServiceStatusPage({
  workspace,
  enabled = true,
  refreshIntervalSeconds
}: {
  workspace: ReturnType<typeof useServiceStatusWorkspace>;
  enabled?: boolean;
  refreshIntervalSeconds: number;
}) {
  return (
    <ServiceStatusTerminal
      status={workspace.status}
      loading={workspace.loading}
      refreshing={workspace.refreshing}
      lastError={workspace.lastError}
      enabled={enabled}
      refreshIntervalSeconds={refreshIntervalSeconds}
      onRefresh={workspace.refreshNow}
    />
  );
}
