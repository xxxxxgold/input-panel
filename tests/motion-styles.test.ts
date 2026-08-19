import { describe, expect, it } from "vitest";

import { readBundledStyles } from "./helpers/styles";

const styles = readBundledStyles();

describe("motion style hooks", () => {
  it("keeps shell page transition classes and reduced-motion fallback", () => {
    expect(styles).toContain(".workspace-page.page-motion-enter");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("defines the rail active pill and drag-safe floating orb hooks", () => {
    expect(styles).toContain(".rail-item-active-pill");
    expect(styles).toContain(`.floating-orb-button {
  position: relative;`);
    expect(styles).toContain("cursor: grab;");
    expect(styles).toContain("touch-action: none;");
  });
});
