import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime, request } from "../../shared/transport/runtime";
import type { SchedulerConfigPayload } from "../../types";

export function getSchedulerConfig() {
  if (isTauriRuntime()) {
    return invoke<SchedulerConfigPayload>("get_scheduler_config");
  }
  return request<SchedulerConfigPayload>("/api/scheduler/config");
}

export function updateSchedulerConfig(payload: SchedulerConfigPayload) {
  if (isTauriRuntime()) {
    return invoke<SchedulerConfigPayload>("update_scheduler_config", { enabled: payload.enabled, intervalSeconds: payload.intervalSeconds });
  }
  return request<SchedulerConfigPayload>("/api/scheduler/config", {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}
