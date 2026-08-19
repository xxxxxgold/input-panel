import { desktopOrHttp } from "../../shared/transport/runtime";
import type { RuntimeCoordinationConfigPayload } from "../../types";

/** 读取 Web 与 Desktop 共用的请求协调配置。 */
export function getRuntimeCoordinationConfig() {
  return desktopOrHttp<RuntimeCoordinationConfigPayload>({
    command: "get_runtime_coordination_config",
    url: "/api/runtime-coordination/config"
  });
}

/** 独立保存共享协调库配置，不与当前 runtime 的 scheduler 配置合并提交。 */
export function updateRuntimeCoordinationConfig(payload: RuntimeCoordinationConfigPayload) {
  return desktopOrHttp<RuntimeCoordinationConfigPayload>({
    command: "update_runtime_coordination_config",
    args: { payload },
    url: "/api/runtime-coordination/config",
    init: {
      method: "PATCH",
      body: JSON.stringify(payload)
    }
  });
}
