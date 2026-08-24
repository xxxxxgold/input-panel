import { describe, expect, it } from "vitest";

import {
  createWindowSelectionEventTracker,
  createWindowSelectionSyncQueue,
  readWindowSelection,
  type WindowSelectionSyncPayload,
  writeWindowSelection
} from "../src/app/window-selection-sync";
import { restoreWindow, stubWindow } from "./helpers/window";

describe("window selection sync", () => {
  it("rejects stale revisions and invalidates an older hydration snapshot", () => {
    const tracker = createWindowSelectionEventTracker();
    const hydrationVersion = tracker.captureVersion();

    expect(tracker.acceptRevision(101)).toBe(true);
    expect(tracker.isCurrent(hydrationVersion)).toBe(false);

    const currentVersion = tracker.captureVersion();
    expect(tracker.acceptRevision(101)).toBe(false);
    expect(tracker.acceptRevision(Number.NaN)).toBe(false);
    expect(tracker.isCurrent(currentVersion)).toBe(true);
    expect(tracker.acceptRevision(102)).toBe(true);
    expect(tracker.isCurrent(currentVersion)).toBe(false);
  });

  it("reads and writes browser selection state through localStorage", () => {
    const originalWindow = globalThis.window;
    const store = new Map<string, string>();

    stubWindow({
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        }
      }
    } as Window & typeof globalThis);

    writeWindowSelection({
      selectedSiteId: "site-1",
      selectedAccountId: "account-2"
    });

    expect(readWindowSelection()).toEqual({
      selectedSiteId: "site-1",
      selectedAccountId: "account-2"
    });

    restoreWindow(originalWindow);
  });

  it("keeps revisions monotonic when the main-window sync queue is recreated", async () => {
    const payloads: WindowSelectionSyncPayload[] = [];
    const createQueue = (initialRevision: number) => createWindowSelectionSyncQueue({
      initialRevision,
      persist: async () => {},
      broadcast: async (payload) => {
        payloads.push(payload);
      },
      reportError: () => {}
    });

    await createQueue(1_000).enqueue({
      selectedSiteId: "site-1",
      selectedAccountId: "account-1"
    });
    await createQueue(2_000).enqueue({
      selectedSiteId: "site-1",
      selectedAccountId: "account-1"
    });

    expect(payloads.map((payload) => payload.revision)).toEqual([1_001, 2_001]);
  });
});
