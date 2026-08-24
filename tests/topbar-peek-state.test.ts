import { describe, expect, it } from "vitest";

import {
  clearTopbarPeekPreviewState,
  CLOSED_TOPBAR_PEEK_STATE,
  isTopbarPeekExpanded,
  previewTopbarPeekState,
  toggleTopbarPeekState
} from "../src/app/topbar-peek-state";

describe("topbar peek state", () => {
  it("keeps click-opened panel expanded after mouse leaves", () => {
    let state = previewTopbarPeekState(CLOSED_TOPBAR_PEEK_STATE, "subscriptions");
    expect(isTopbarPeekExpanded(state, "subscriptions")).toBe(true);

    state = toggleTopbarPeekState(state, "subscriptions");
    expect(state).toEqual({
      pinned: "subscriptions",
      preview: null
    });

    state = clearTopbarPeekPreviewState(state, "subscriptions");
    expect(isTopbarPeekExpanded(state, "subscriptions")).toBe(true);
  });

  it("closes preview-only panel after mouse leaves", () => {
    let state = previewTopbarPeekState(CLOSED_TOPBAR_PEEK_STATE, "serviceStatus");
    expect(isTopbarPeekExpanded(state, "serviceStatus")).toBe(true);

    state = clearTopbarPeekPreviewState(state, "serviceStatus");
    expect(state).toEqual(CLOSED_TOPBAR_PEEK_STATE);
    expect(isTopbarPeekExpanded(state, "serviceStatus")).toBe(false);
  });

  it("switches pinned panel when clicking another trigger", () => {
    let state = toggleTopbarPeekState(CLOSED_TOPBAR_PEEK_STATE, "serviceStatus");
    expect(isTopbarPeekExpanded(state, "serviceStatus")).toBe(true);

    state = toggleTopbarPeekState(state, "alerts");
    expect(state).toEqual({
      pinned: "alerts",
      preview: null
    });
    expect(isTopbarPeekExpanded(state, "serviceStatus")).toBe(false);
    expect(isTopbarPeekExpanded(state, "alerts")).toBe(true);
  });

  it("supports the site-endpoints panel key", () => {
    const state = previewTopbarPeekState(CLOSED_TOPBAR_PEEK_STATE, "siteEndpoints");

    expect(isTopbarPeekExpanded(state, "siteEndpoints")).toBe(true);
    expect(clearTopbarPeekPreviewState(state, "siteEndpoints")).toEqual(CLOSED_TOPBAR_PEEK_STATE);
  });
});
