import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import type { WindowLabel } from "../types";
import { isTauriRuntime } from "../shared/transport/runtime";

export function getCurrentWindowLabel(): WindowLabel {
  if (!isTauriRuntime()) {
    return "main";
  }
  const label = getCurrentWebviewWindow().label;
  if (label === "floating" || label === "floating-panel") {
    return label;
  }
  return "main";
}
