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

  it("uses the compact rail variable at every expanded breakpoint", () => {
    expect(styles).toContain("--app-shell-rail-width: 192px;");
    expect(styles).toMatch(/\.app-shell-body\s*\{[\s\S]*grid-template-columns:\s*var\(--app-shell-rail-width\) minmax\(0, 1fr\);/);
    expect(styles).toMatch(/@media \(max-width: 960px\)\s*\{[\s\S]*\.app-shell:not\(\.rail-collapsed\) \.app-shell-body\s*\{[\s\S]*grid-template-columns:\s*var\(--app-shell-rail-width\) minmax\(0, 1fr\);/);
    expect(styles).toMatch(/@media \(min-width: 1920px\)\s*\{[\s\S]*\.app-shell:not\(\.rail-collapsed\) \.app-shell-body\s*\{[\s\S]*grid-template-columns:\s*var\(--app-shell-rail-width\) minmax\(0, 1fr\);/);
  });
});
