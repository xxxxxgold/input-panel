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
  floatingPanelOpacity: 0.82,
  closeBehavior: "switch_to_floating",
  autoRefreshEnabled: true,
  autoRefreshIntervalSeconds: 9,
  autoRefreshCoreEnabled: true,
  autoRefreshCoreIntervalSeconds: 9,
  autoRefreshKeysEnabled: true,
  autoRefreshKeysIntervalSeconds: 12,
  autoRefreshUsageEnabled: false,
  autoRefreshUsageIntervalSeconds: 30,
  theme: "spectral-lab"
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

    const stored = JSON.parse(storage.get(DESKTOP_UI_PREFS_STORAGE_KEY) ?? "null");
    expect(stored).toEqual(readBrowserDesktopUiPrefs());
    expect(readBrowserDesktopUiPrefs()).toMatchObject({
      launchMode: samplePrefs.launchMode,
      openFloatingInMainMode: samplePrefs.openFloatingInMainMode,
      keepFloatingPanelVisible: samplePrefs.keepFloatingPanelVisible,
      floatingPanelOpacity: samplePrefs.floatingPanelOpacity
    });
  });

  it("backfills grouped auto refresh fields for legacy stored prefs", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        }
      }
    });
    storage.set(
      DESKTOP_UI_PREFS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        launchMode: "main",
        openFloatingInMainMode: true,
        keepFloatingPanelVisible: false,
        floatingPanelOpacity: 0.82,
        closeBehavior: "ask",
        autoRefreshEnabled: true,
        autoRefreshIntervalSeconds: 9,
        theme: "light"
      })
    );

    expect(readBrowserDesktopUiPrefs()).toMatchObject({
      autoRefreshCoreEnabled: true,
      autoRefreshCoreIntervalSeconds: 9,
      autoRefreshKeysEnabled: true,
      autoRefreshKeysIntervalSeconds: 9,
      autoRefreshUsageEnabled: true,
      autoRefreshUsageIntervalSeconds: 9
    });
  });
});
