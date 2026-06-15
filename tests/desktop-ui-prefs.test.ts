import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DESKTOP_UI_PREFS_STORAGE_KEY,
  isDesktopUiPrefsPayload,
  readBrowserDesktopUiPrefs,
  writeBrowserDesktopUiPrefs
} from "../src/features/desktop-ui/useDesktopUiPrefs";
import type { DesktopUiPrefs } from "../src/types";

const samplePrefs: DesktopUiPrefs = {
  version: 1,
  launchMode: "floating",
  openFloatingInMainMode: true,
  keepFloatingPanelVisible: true,
  closeBehavior: "switch_to_floating",
  theme: "graphite-cyan"
};

describe("desktop ui prefs browser sync helpers", () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalWindow) {
      globalThis.window = originalWindow;
    } else {
      // @ts-expect-error test cleanup
      delete globalThis.window;
    }
  });

  it("accepts a valid desktop prefs payload", () => {
    expect(isDesktopUiPrefsPayload(samplePrefs)).toBe(true);
  });

  it("rejects an invalid desktop prefs payload", () => {
    expect(
      isDesktopUiPrefsPayload({
        version: 1,
        launchMode: "floating",
        openFloatingInMainMode: true,
        keepFloatingPanelVisible: "yes"
      })
    ).toBe(false);
  });

  it("reads and writes browser desktop prefs through localStorage", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        }
      }
    });

    writeBrowserDesktopUiPrefs(samplePrefs);

    expect(storage.get(DESKTOP_UI_PREFS_STORAGE_KEY)).toBe(JSON.stringify(samplePrefs));
    expect(readBrowserDesktopUiPrefs()).toEqual(samplePrefs);
  });
});
