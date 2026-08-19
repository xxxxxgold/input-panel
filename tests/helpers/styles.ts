import { readFileSync } from "node:fs";

const importPattern = /^\s*@import\s+["']([^"'\r\n]+)["']\s*;[ \t]*$/gm;

function isRelativeCssImport(source: string) {
  return source.startsWith("./") || source.startsWith("../");
}

/** 递归展开本地样式导入，让静态测试检查浏览器实际加载的样式集合。 */
function readStylesheet(stylesheetUrl: URL, activeUrls: Set<string>): string {
  const stylesheetId = stylesheetUrl.href;
  if (activeUrls.has(stylesheetId)) return "";

  activeUrls.add(stylesheetId);
  try {
    const stylesheet = readFileSync(stylesheetUrl, "utf8").replace(/\r\n?/g, "\n");
    let bundled = stylesheet;

    for (const match of stylesheet.matchAll(importPattern)) {
      const importSource = match[1];
      if (!isRelativeCssImport(importSource)) continue;

      const importUrl = new URL(importSource, stylesheetUrl);
      importUrl.search = "";
      importUrl.hash = "";
      bundled += "\n" + readStylesheet(importUrl, activeUrls);
    }

    return bundled;
  } finally {
    activeUrls.delete(stylesheetId);
  }
}

/** 按浏览器解析本地导入的方式读取分层主样式。 */
export function readBundledStyles() {
  const entryUrl = new URL("../../src/styles.css", import.meta.url);
  return readStylesheet(entryUrl, new Set());
}
