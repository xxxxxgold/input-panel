export type TopbarPeekKey = "serviceStatus" | "alerts" | "subscriptions";

export type TopbarPeekState = {
  pinned: TopbarPeekKey | null;
  preview: TopbarPeekKey | null;
};

export const CLOSED_TOPBAR_PEEK_STATE: TopbarPeekState = {
  pinned: null,
  preview: null
};

export function isTopbarPeekExpanded(state: TopbarPeekState, key: TopbarPeekKey) {
  return state.pinned === key || (state.pinned === null && state.preview === key);
}

export function previewTopbarPeekState(state: TopbarPeekState, key: TopbarPeekKey): TopbarPeekState {
  if (state.pinned !== null || state.preview === key) {
    return state;
  }
  return {
    ...state,
    preview: key
  };
}

export function clearTopbarPeekPreviewState(state: TopbarPeekState, key: TopbarPeekKey): TopbarPeekState {
  if (state.pinned !== null || state.preview !== key) {
    return state;
  }
  return {
    ...state,
    preview: null
  };
}

export function toggleTopbarPeekState(state: TopbarPeekState, key: TopbarPeekKey): TopbarPeekState {
  if (state.pinned === key) {
    return CLOSED_TOPBAR_PEEK_STATE;
  }
  return {
    pinned: key,
    preview: null
  };
}
