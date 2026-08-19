import { desktopOrHttp } from "../../shared/transport/runtime";

export function clearRuntimeData(removeSitesAndAccounts: boolean) {
  return desktopOrHttp<boolean>({
    command: "clear_runtime_data",
    args: { removeSitesAndAccounts },
    url: "/api/maintenance/clear-runtime-data",
    init: {
      method: "POST",
      body: JSON.stringify({ removeSitesAndAccounts })
    }
  });
}
