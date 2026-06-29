# Input Panel

面向个人用户的 Sub2API 多站点、多账号统计工作台. 当前仓库已经统一为 `Tauri 2 + Rust backend + React 19` 架构, 浏览器调试模式和桌面模式共用同一套 Rust 应用服务与契约.

## 当前架构

- 桌面壳层: Tauri 2, 主窗口 + 悬浮球窗口 + 悬浮面板窗口
- 前端: React 19 + TypeScript + Vite + Tailwind CSS 4
- 全局状态: Zustand 5
- 业务后端: `src-tauri/src/application/*`
- 传输边界:
  - 桌面模式通过 Tauri command
  - 浏览器模式通过 Rust HTTP dev adapter `/api/*`
- 本地存储: `config/config.db`

## 真实入口

- 主工作台入口: `src/app/MainWindowApp.tsx`
- 多窗口路由入口: `src/App.tsx`
- 浏览器入口: `src/main.tsx`
- 悬浮球入口: `src/floating-orb-main.tsx`
- 悬浮面板入口: `src/floating-panel-main.tsx`
- 桌面运行入口: `src-tauri/src/lib.rs`

## 目录

```text
src/                 React UI, 页面壳层, feature client, workspace hooks
src-tauri/src/       Rust adapters + application + contracts + infrastructure
tests/               Vitest 前端/展示/状态回归
scripts/             Windows 启动与桌面构建辅助脚本
config/              SQLite 运行时数据目录
.trellis/spec/       项目级前后端实现规范
```

## 开发启动

安装依赖:

```bash
pnpm install
```

浏览器联调模式:

```bash
./start-dev.cmd
```

或分别启动:

```bash
pnpm dev:server
pnpm dev:ui
```

默认地址:

- 前端: `http://127.0.0.1:5777`
- 后端健康检查: `http://127.0.0.1:5559/api/health`

桌面开发模式:

```bash
pnpm dev
```

浏览器真实链路联调模式:

```bash
pnpm dev:web
```

说明:

- `start-dev.cmd` 会调用 `scripts/start-dev.ps1`, 先清理当前仓库残留的 `vite` / `dev_api` 进程, 再分别拉起前后端并轮询健康检查.
- `一键重启前后端.cmd` 是 Windows 中文入口, 会先关闭旧前后端, 再分别打开前端和后端两个常驻 `cmd` 输出窗口, 同时轮询健康检查.
- `pnpm dev:web` 与桌面模式共用同一套 Rust 应用服务, 区别只在 transport.
- `pnpm dev` 的 Tauri `beforeDevCommand` 只负责前端 Vite, 桌面命令直接通过 Tauri command 调 Rust 服务.

## 桌面构建与启动

构建桌面调试包:

```bash
pnpm build:desktop
```

一键启动桌面应用:

```text
一键启动.cmd
```

说明:

- `scripts/prepare-desktop-build.ps1` 会在构建前释放 `src-tauri/target/debug/app.exe` 文件锁.
- `一键启动.cmd` 若已存在 `src-tauri/target/debug/app.exe`, 会直接启动; 否则先执行 `pnpm build:desktop`.

## 验证命令

```bash
pnpm test
pnpm build:web
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
pnpm build:desktop
```

真实站点 smoke:

```bash
$env:SUB2API_SITE_URL='https://ai.input.im'
$env:SUB2API_EMAIL='your@email'
$env:SUB2API_PASSWORD='your-password'
pnpm smoke:real
```

## 运行时约束

- 运行时数据统一落在 `config/config.db`, 页面主数据来自本地缓存/读模型, 不再使用旧的第二套产品后端或 JSON state 存储方案.
- 所有 React feature client 统一走 `src/shared/transport/runtime.ts`.
- 服务状态页为本地渲染页, 通过 `/api/service-status` 或 `get_service_status` 获取数据, 不再嵌远端 iframe.
- 顶部通知完整列表通过“消息盒子”弹窗承载, 当前主工作台 shell 以 `MainWindowApp.tsx` 为准.
