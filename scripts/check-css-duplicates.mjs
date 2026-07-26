// 检查 src/styles/00-08 分层文件之间是否存在跨文件重复定义的顶层类选择器。
// 背景：曾因 .metric-card 等基础组件类分散在 02/03/04 三个文件、靠 import 顺序
// 覆盖生效，连续引发两次样式回归（e20c455、0622bb5）。
// 规则：每个 base 类只允许一个"顶层简单选择器"定义点。@media 内的覆盖不计——
// 00-base 的 prefers-* 降级与 08-motion-responsive 的响应式层就是干这个的；
// 伪类/属性/组合器变体也不计。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const STYLE_DIR = fileURLToPath(new URL("../src/styles/", import.meta.url));

// 允许多文件出现的类：语义上确需分层定义的，人工确认后在此登记（附理由）。
const ALLOWLIST = new Map([
  // ["metric-card", "示例：base 在 04，打印样式在 09-print"]
]);

// 08-motion-responsive 是动效增强层：只给既有组件补 transition/animation/
// transform 属性，属于合法的关注点分层，不参与"重复定义"判定。
// 它自身的纯净性（不写布局/配色）由代码评审保障。
const EXEMPT_LAYERS = new Set(["08-motion-responsive.css"]);

const files = readdirSync(STYLE_DIR)
  .filter((name) => /^\d\d-.*\.css$/.test(name) && !EXEMPT_LAYERS.has(name))
  .sort();

/**
 * 收集"顶层单类定义块"（整条规则的选择器就是一个裸类：`.foo { … }`），
 * 跳过所有 @ 块（@media/@supports/@keyframes…）内部的规则。
 * 判定口径：
 * - 一个类的"自有定义块"在全部分层文件中只允许出现一次——两个文件各写
 *   `.foo { … }` 靠 import 顺序覆盖，正是历次样式回归的形态；
 * - 多类共享的声明列表（`.a, .b { … }`）是合法横切（统一卡片表面、统一
 *   过渡等），不计入；成员类内容放错文件属于评审关注点，不由本脚本裁决；
 * - 伪类/后代/属性变体（`.foo:hover`、`.foo p`）跟随 base 文件即可，不计。
 */
function collectTopLevelSimpleClassSelectors(cssText) {
  const found = new Set();
  const withoutComments = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  let depth = 0;
  let atRuleDepths = [];
  let buffer = "";
  for (let index = 0; index < withoutComments.length; index += 1) {
    const char = withoutComments[index];
    if (char === "{") {
      const selectorText = buffer.trim();
      if (selectorText.startsWith("@")) {
        atRuleDepths.push(depth);
      } else if (atRuleDepths.length === 0) {
        const match = /^\.([A-Za-z][\w-]*)$/.exec(selectorText);
        if (match) {
          found.add(match[1]);
        }
      }
      depth += 1;
      buffer = "";
    } else if (char === "}") {
      depth -= 1;
      if (atRuleDepths.length > 0 && depth === atRuleDepths[atRuleDepths.length - 1]) {
        atRuleDepths.pop();
      }
      buffer = "";
    } else {
      buffer += char;
    }
  }
  return found;
}

const byClass = new Map();
for (const file of files) {
  const classes = collectTopLevelSimpleClassSelectors(
    readFileSync(join(STYLE_DIR, file), "utf8")
  );
  for (const className of classes) {
    if (!byClass.has(className)) {
      byClass.set(className, []);
    }
    byClass.get(className).push(file);
  }
}

const duplicates = [...byClass.entries()]
  .filter(([className, fileList]) => fileList.length > 1 && !ALLOWLIST.has(className))
  .sort(([left], [right]) => left.localeCompare(right));

if (duplicates.length > 0) {
  console.error("跨文件重复定义的顶层 base 类选择器（每类只允许一个定义文件）：");
  for (const [className, fileList] of duplicates) {
    console.error(`  .${className}  →  ${fileList.join(", ")}`);
  }
  console.error(`共 ${duplicates.length} 个。请合并到单一文件，或在 ALLOWLIST 登记理由。`);
  process.exit(1);
}

console.log(`check-css-duplicates: ${files.length} 个分层文件无跨文件重复的顶层 base 选择器。`);
