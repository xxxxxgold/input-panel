import { describe, expect, it } from "vitest";

import { readBundledStyles } from "./helpers/styles";

const styles = readBundledStyles();

describe("topbar responsive styles", () => {
  it("keeps topbar peek panels click-opened instead of hover-opened", () => {
    expect(styles).not.toContain(".topbar-peek-card:hover");
    expect(styles).toMatch(/\.topbar-peek-card\.expanded \.topbar-peek-panel \{\s*opacity: 1;\s*visibility: visible;\s*pointer-events: auto;/);
  });

  it("keeps the topbar in a single row under the tablet breakpoint", () => {
    expect(styles).toMatch(/@media \(max-width: 1200px\) \{[\s\S]*?\.global-topbar \{\s*flex-direction: row;\s*align-items: center;\s*flex-wrap: nowrap;/);
  });

  it("lets the outer topbar frame own the workspace summary row", () => {
    expect(styles).toMatch(/\.workspace-header-summary\.workspace-header-summary-topbar \{\s*display:\s*grid;\s*grid-template-columns:\s*minmax\(0, 1fr\) auto;\s*align-items:\s*center;\s*flex:\s*0 0 auto;\s*width:\s*100%;\s*min-width:\s*0;\s*min-height:\s*0;/);
    expect(styles).toMatch(/\.topbar-summary-scroll \{[\s\S]*?justify-content:\s*safe center;[\s\S]*?min-width:\s*0;[\s\S]*?overflow-x:\s*auto;/);
    expect(styles).toMatch(/\.topbar-reload-button \{[\s\S]*?flex:\s*0 0 26px;/);
  });

  it("hides the live time text on narrow shells", () => {
    expect(styles).toMatch(/@media \(max-width: 960px\) \{[\s\S]*?\.topbar-clock-time \{\s*display: none;/);
  });

  it("keeps the API endpoint panel wide enough and prevents latency pills from wrapping", () => {
    expect(styles).toMatch(/\.topbar-site-endpoints-panel \{\s*width: min\(480px, calc\(100vw - 32px\)\);\s*min-width: min\(380px, calc\(100vw - 32px\)\);\s*max-width: min\(480px, calc\(100vw - 32px\)\);/);
    expect(styles).toMatch(/\.topbar-endpoint-main \{\s*min-width: 0;\s*flex: 1 1 0%;/);
    expect(styles).toMatch(/\.topbar-endpoint-main \.status-pill \{\s*flex: 0 0 auto;\s*white-space: nowrap;/);
  });
});
