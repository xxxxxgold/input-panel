import { desktopOrHttp } from "../../shared/transport/runtime";
import type { SchedulerConfigPayload } from "../../types";

export function getSchedulerConfig() {
  return desktopOrHttp<SchedulerConfigPayload>({
    command: "get_scheduler_config",
    url: "/api/scheduler/config"
  });
}

export function updateSchedulerConfig(payload: SchedulerConfigPayload) {
  return desktopOrHttp<SchedulerConfigPayload>({
    command: "update_scheduler_config",
    args: { payload },
    url: "/api/scheduler/config",
    init: {
      method: "PATCH",
      body: JSON.stringify(payload)
    }
  });
}
