import { desktopOrHttp } from "../shared/transport/runtime";
import type { WindowSelectionState } from "./window-selection-sync";

export function getPersistedWindowSelection() {
  return desktopOrHttp<WindowSelectionState>({
    command: "get_window_selection",
    url: "/api/window-selection"
  });
}

export function updatePersistedWindowSelection(selection: WindowSelectionState) {
  return desktopOrHttp<WindowSelectionState>({
    command: "update_window_selection",
    args: { selection },
    url: "/api/window-selection",
    init: {
      method: "PATCH",
      body: JSON.stringify(selection)
    }
  });
}
