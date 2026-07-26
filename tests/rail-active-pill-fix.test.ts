import { describe, expect, it } from "vitest";

import { readBundledStyles } from "./helpers/styles";

// 这些规则原先在 rail-active-pill-fix.css 补丁文件里靠加载顺序覆盖生效，
// 现已归位 02-layout.css；断言改为面向打包后的完整样式。
const styles = readBundledStyles();

describe("rail active pill fix", () => {
  it("keeps expanded rail items left-aligned so the active pill stays before the icon", () => {
    expect(styles).toContain(".rail.expanded .rail-item");
    expect(styles).toContain("justify-content: flex-start;");
    expect(styles).toContain("padding: 0 12px 0 20px;");
  });

  it("places the rail toggle as a right-edge drawer handle", () => {
    expect(styles).toContain(".rail-content");
    expect(styles).toContain("overflow-y: auto;");
    expect(styles).toContain(".rail-toggle-handle");
    expect(styles).toContain("top: 50%;");
    expect(styles).toContain("right: -16px;");
    expect(styles).toContain("transform: translateY(-50%);");
    expect(styles).toContain(".rail-toggle-handle.open svg");
  });
});
