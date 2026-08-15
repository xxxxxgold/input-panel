import { desktopOrHttp } from "../../shared/transport/runtime";
import type { UpstreamNetworkConfigPayload } from "../../types";

/** 读取 Web 与 Desktop 共用的上游网络模式。 */
export function getUpstreamNetworkConfig() {
  return desktopOrHttp<UpstreamNetworkConfigPayload>({
    command: "get_upstream_network_config",
    url: "/api/upstream-network/config"
  });
}

/** 独立保存上游网络模式，不与共享请求协调配置合并。 */
export function updateUpstreamNetworkConfig(payload: UpstreamNetworkConfigPayload) {
  return desktopOrHttp<UpstreamNetworkConfigPayload>({
    command: "update_upstream_network_config",
    args: { payload },
    url: "/api/upstream-network/config",
    init: {
      method: "PATCH",
      body: JSON.stringify(payload)
    }
  });
}
