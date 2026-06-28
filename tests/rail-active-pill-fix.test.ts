import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const mainEntry = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
const overrideStyles = readFileSync(new URL("../src/rail-active-pill-fix.css", import.meta.url), "utf8");

describe("rail active pill fix", () => {
  it("loads the rail override after the main stylesheet", () => {
    expect(mainEntry).toContain('import "./styles.css";');
    expect(mainEntry).toContain('import "./rail-active-pill-fix.css";');
  });

  it("keeps expanded rail items left-aligned so the active pill stays before the icon", () => {
    expect(overrideStyles).toContain(".rail.expanded .rail-item");
    expect(overrideStyles).toContain("justify-content: flex-start;");
    expect(overrideStyles).toContain("padding: 0 12px 0 20px;");
  });
});
