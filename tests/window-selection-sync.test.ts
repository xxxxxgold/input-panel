import { describe, expect, it } from "vitest";

import {
  readWindowSelection,
  writeWindowSelection
} from "../src/app/window-selection-sync";

describe("window selection sync", () => {
  it("reads and writes browser selection state through localStorage", () => {
    const originalWindow = globalThis.window;
    const store = new Map<string, string>();

    // @ts-expect-error test runtime
    globalThis.window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        }
      }
    };

    writeWindowSelection({
      selectedSiteId: "site-1",
      selectedAccountId: "account-2"
    });

    expect(readWindowSelection()).toEqual({
      selectedSiteId: "site-1",
      selectedAccountId: "account-2"
    });

    if (originalWindow) {
      globalThis.window = originalWindow;
    } else {
      // @ts-expect-error test cleanup
      delete globalThis.window;
    }
  });
});
