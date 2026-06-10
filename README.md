# Input Panel

参考 QMAI 的工作台式 UI，面向个人用户的 Sub2API 多站点、多账号统计面板。

当前主架构:

- 桌面框架: Tauri 2
- 前端: React 19 + TypeScript + Vite
- 状态管理: Zustand 5
- 样式: Tailwind CSS 4 + 主题变量
- 后端: 单 Rust 后端
- 浏览器测试: Rust HTTP dev adapter

## 功能

- 多站点、多账号管理
- 本地 `config/config.db` 单库保存站点、账号、密码、session 与快照
- 余额、订阅、API Keys、最近使用、趋势、告警总览
- 针对 Sub2API 契约漂移的候选路径兼容
- 真实站点 smoke 二进制

## 运行

```bash
pnpm install
pnpm dev
```

根目录双击运行:

```text
一键启动.cmd
```

说明:

- 如果已经有 `src-tauri/target/debug/app.exe`，脚本会直接启动它
- 如果还没构建，脚本会自动执行 `pnpm build:desktop` 然后启动

默认地址:

- Tauri dev 会使用前端 `http://127.0.0.1:5777`
- 浏览器 Rust dev API 默认 `http://127.0.0.1:5559`

仅跑浏览器验收:

```bash
pnpm dev:web
```

## 验证

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

## 目录

```text
src/        React 前端工作台
src-tauri/  Rust 核心后端 + Tauri adapter + HTTP dev adapter
tests/      前端测试与上游 mock fixture
config/     运行时 SQLite 数据目录
```
