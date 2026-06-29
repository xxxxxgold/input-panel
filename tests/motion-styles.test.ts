import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

describe("motion style hooks", () => {
  it("keeps shell page transition classes and reduced-motion fallback", () => {
    expect(styles).toContain(".workspace-page.page-motion-enter");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("defines rail active pill and floating orb motion hooks", () => {
    expect(styles).toContain(".rail-item-active-pill");
    expect(styles).toContain(".floating-orb-button.menu-open");
    expect(styles).toContain("@keyframes floating-orb-breathe");
  });
});
