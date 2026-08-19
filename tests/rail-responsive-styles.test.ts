import { describe, expect, it } from "vitest";

import { readBundledStyles } from "./helpers/styles";

const styles = readBundledStyles();

describe("mobile rail responsive styles", () => {
  it("keeps collapsed and expanded shell tracks distinct under the 960px breakpoint", () => {
    expect(styles).toContain("@media (max-width: 960px) {");
    expect(styles).toContain(".app-shell.rail-collapsed");
    expect(styles).toContain(".app-shell:not(.rail-collapsed)");
  });

  it("does not force expanded rail back to icon-only mode on narrow screens", () => {
    expect(styles).not.toContain(".rail.expanded .brand-copy,\n  .rail.expanded .rail-item-label {\n    display: none;");
  });
});
