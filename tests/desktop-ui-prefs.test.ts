import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DESKTOP_UI_PREFS_STORAGE_KEY,
  isDesktopUiPrefsPayload,
  normalizeCompletedTaskRetentionMinutes,
  readBrowserDesktopUiPrefs,
  writeBrowserDesktopUiPrefs
} from "../src/features/desktop-ui/useDesktopUiPrefs";
import { restoreWindow, stubWindow } from "./helpers/window";
import type { DesktopUiPrefs } from "../src/types";

const samplePrefs: DesktopUiPrefs = {
  version: 1,
  completedTaskRetentionMinutes: 1,
  launchMode: "floating",
  openFloatingInMainMode: true,
  keepFloatingPanelVisible: true,
  floatingPanelOpacity: 0.82,
  floatingNotificationDurationMs: 7000,
  floatingNotificationDensity: "standard",
  floatingNotificationMaxVisible: 3,
  floatingNotificationSoundSource: "default",
  floatingNotificationSoundFileName: null,
  floatingNotificationSoundStorageKey: null,
  floatingNotificationSoundVolume: 100,
  closeBehavior: "switch_to_floating",
  autoRefreshEnabled: true,
  autoRefreshIntervalSeconds: 9,
  autoRefreshServiceStatusEnabled: true,
  autoRefreshCoreEnabled: true,
  autoRefreshCoreIntervalSeconds: 9,
  autoRefreshKeysEnabled: true,
  autoRefreshKeysIntervalSeconds: 12,
  autoRefreshUsageEnabled: false,
  autoRefreshUsageIntervalSeconds: 30,
  overviewAccountRuntimeTimeoutMs: 4500,
  theme: "sakura-signal"
};

describe("desktop ui prefs browser sync helpers", () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    vi.unstubAllGlobals();
    restoreWindow(originalWindow);
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
    stubWindow({
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        }
      }
    } as Window & typeof globalThis);

    writeBrowserDesktopUiPrefs(samplePrefs);

    expect(JSON.parse(storage.get(DESKTOP_UI_PREFS_STORAGE_KEY) ?? "{}")).toMatchObject(samplePrefs);
    expect(readBrowserDesktopUiPrefs()).toMatchObject(samplePrefs);
  });

  it("keeps only a safe custom sound file name in browser preferences", () => {
    const storage = new Map<string, string>();
    stubWindow({
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        }
      }
    } as Window & typeof globalThis);

    writeBrowserDesktopUiPrefs({
      ...samplePrefs,
      floatingNotificationSoundSource: "custom",
      floatingNotificationSoundFileName: "C:\\Users\\qyun\\Music\\private-tone.mp3",
      floatingNotificationSoundStorageKey:
        "notification-sound-550e8400-e29b-41d4-a716-446655440000.mp3"
    });

    expect(JSON.parse(storage.get(DESKTOP_UI_PREFS_STORAGE_KEY) ?? "{}")).toMatchObject({
      floatingNotificationSoundSource: "custom",
      floatingNotificationSoundFileName: "private-tone.mp3",
      floatingNotificationSoundStorageKey:
        "notification-sound-550e8400-e29b-41d4-a716-446655440000.mp3"
    });
  });

  it("rejects browser custom sound metadata without a controlled storage key", () => {
    const storage = new Map<string, string>();
    stubWindow({
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        }
      }
    } as Window & typeof globalThis);

    writeBrowserDesktopUiPrefs({
      ...samplePrefs,
      floatingNotificationSoundSource: "custom",
      floatingNotificationSoundFileName: "private-tone.mp3",
      floatingNotificationSoundStorageKey: "C:\\Users\\qyun\\Music\\private-tone.mp3"
    });

    expect(JSON.parse(storage.get(DESKTOP_UI_PREFS_STORAGE_KEY) ?? "{}")).toMatchObject({
      floatingNotificationSoundSource: "default",
      floatingNotificationSoundFileName: null,
      floatingNotificationSoundStorageKey: null
    });
  });

  it("keeps a valid custom sound selection while browser preferences choose system sound or mute", () => {
    const storage = new Map<string, string>();
    stubWindow({
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        }
      }
    } as Window & typeof globalThis);

    for (const source of ["system", "muted"] as const) {
      writeBrowserDesktopUiPrefs({
        ...samplePrefs,
        floatingNotificationSoundSource: source,
        floatingNotificationSoundFileName: "private-tone.mp3",
        floatingNotificationSoundStorageKey:
          "notification-sound-550e8400-e29b-41d4-a716-446655440000.mp3"
      });

      expect(JSON.parse(storage.get(DESKTOP_UI_PREFS_STORAGE_KEY) ?? "{}")).toMatchObject({
        floatingNotificationSoundSource: source,
        floatingNotificationSoundFileName: "private-tone.mp3",
        floatingNotificationSoundStorageKey:
          "notification-sound-550e8400-e29b-41d4-a716-446655440000.mp3"
      });
    }
  });

  it("backfills grouped auto refresh fields for legacy stored prefs", () => {
    const storage = new Map<string, string>();
    stubWindow({
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        }
      }
    } as Window & typeof globalThis);
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
        theme: "titan-noir"
      })
    );

    expect(readBrowserDesktopUiPrefs()).toMatchObject({
      autoRefreshServiceStatusEnabled: true,
      autoRefreshCoreEnabled: true,
      autoRefreshCoreIntervalSeconds: 9,
      autoRefreshKeysEnabled: true,
      autoRefreshKeysIntervalSeconds: 9,
      autoRefreshUsageEnabled: true,
      autoRefreshUsageIntervalSeconds: 9,
      overviewAccountRuntimeTimeoutMs: 4500,
      floatingNotificationDurationMs: 7000,
      floatingNotificationDensity: "standard",
      floatingNotificationMaxVisible: 3,
      floatingNotificationSoundSource: "default",
      floatingNotificationSoundFileName: null,
      floatingNotificationSoundStorageKey: null,
      floatingNotificationSoundVolume: 100
    });
  });

  it("normalizes completed task retention to supported whole minutes", () => {
    expect(normalizeCompletedTaskRetentionMinutes(Number.NaN)).toBe(1);
    expect(normalizeCompletedTaskRetentionMinutes(0)).toBe(1);
    expect(normalizeCompletedTaskRetentionMinutes(1.6)).toBe(2);
    expect(normalizeCompletedTaskRetentionMinutes(1441)).toBe(1440);
  });

  it("backfills completed task retention for legacy browser preferences", () => {
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
        theme: "titan-noir"
      })
    );

    expect(readBrowserDesktopUiPrefs()).toMatchObject({
      completedTaskRetentionMinutes: 1
    });
  });
});
