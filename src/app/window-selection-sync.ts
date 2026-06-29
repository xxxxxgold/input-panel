export const WINDOW_SELECTION_STORAGE_KEY = "input-panel.window-selection";

export interface WindowSelectionState {
  selectedSiteId: string | null;
  selectedAccountId: string | null;
}

export function readWindowSelection(): WindowSelectionState {
  if (typeof window === "undefined") {
    return {
      selectedSiteId: null,
      selectedAccountId: null
    };
  }

  try {
    const raw = window.localStorage.getItem(WINDOW_SELECTION_STORAGE_KEY);
    if (!raw) {
      return {
        selectedSiteId: null,
        selectedAccountId: null
      };
    }
    const parsed = JSON.parse(raw) as Partial<WindowSelectionState>;
    return {
      selectedSiteId: parsed.selectedSiteId ?? null,
      selectedAccountId: parsed.selectedAccountId ?? null
    };
  } catch {
    return {
      selectedSiteId: null,
      selectedAccountId: null
    };
  }
}

export function writeWindowSelection(selection: WindowSelectionState) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(WINDOW_SELECTION_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // 浏览器存储失败时不阻断主工作台继续运行。
  }
}
