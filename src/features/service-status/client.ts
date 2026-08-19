import { invoke } from "@tauri-apps/api/core";

import type { ServiceStatusPayload } from "../../types";
import { isTauriRuntime, request } from "../../shared/transport/runtime";

const SERVICE_STATUS_REQUEST_TIMEOUT_MS = 30_000;

export async function getServiceStatus() {
  if (isTauriRuntime()) {
    return invoke<ServiceStatusPayload>("get_service_status");
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => {
    controller.abort();
  }, SERVICE_STATUS_REQUEST_TIMEOUT_MS);

  try {
    return await request<ServiceStatusPayload>("/api/service-status", {
      signal: controller.signal
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") {
      throw new Error("服务状态请求失败, 远端监控接口暂时不可用。", { cause });
    }
    throw cause;
  } finally {
    window.clearTimeout(timeoutId);
  }
}
