import { ServiceStatusTerminal } from "../features/service-status/ServiceStatusTerminal";
import { useServiceStatusWorkspace } from "../features/service-status/useServiceStatusWorkspace";

export function ServiceStatusPage({
  setError,
  enabled = true
}: {
  setError: (message: string | null) => void;
  enabled?: boolean;
}) {
  const workspace = useServiceStatusWorkspace({ setError, enabled });

  return (
    <ServiceStatusTerminal
      status={workspace.status}
      loading={workspace.loading}
      refreshing={workspace.refreshing}
      lastError={workspace.lastError}
      onRefresh={workspace.refreshNow}
    />
  );
}
