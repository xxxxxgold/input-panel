import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Windows 继续复用精确的 app.exe 文件锁探测；其他平台没有该前置条件。
if (process.platform !== "win32") {
  process.exit(0);
}

const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "prepare-desktop-build.ps1"
);
const result = spawnSync(
  "pwsh.exe",
  ["-NoLogo", "-NoProfile", "-File", scriptPath],
  { stdio: "inherit", windowsHide: true }
);

if (result.error) {
  console.error(`桌面构建前置脚本启动失败: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = typeof result.status === "number" ? result.status : 1;
}
