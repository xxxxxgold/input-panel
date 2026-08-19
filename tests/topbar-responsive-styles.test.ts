import { describe, expect, it } from "vitest";

import { readBundledStyles } from "./helpers/styles";

const styles = readBundledStyles();

describe("topbar responsive styles", () => {
  it("keeps the topbar in a single row under the tablet breakpoint", () => {
    expect(styles).toMatch(/@media \(max-width: 1200px\) \{[\s\S]*?\.global-topbar \{\s*flex-direction: row;\s*align-items: center;\s*flex-wrap: nowrap;/);
  });

  it("hides the live time text on narrow shells", () => {
    expect(styles).toMatch(/@media \(max-width: 960px\) \{[\s\S]*?\.topbar-clock-time \{\s*display: none;/);
  });
});
