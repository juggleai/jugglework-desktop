# JuggleWork Desktop

## 项目定位

JuggleWork 桌面应用（Electron + React）。pnpm monorepo，主要包：

- `apps/app`：渲染层（React 19 / TypeScript / Vite），UI 主体在 `apps/app/src/react-app`。
- `apps/desktop`：Electron 主进程（`electron/main.mjs`），通过 `desktopCommandHandlers` + `handleDesktopInvoke` 暴露 IPC，渲染端在 `apps/app/src/app/lib/desktop.ts` 封装调用。

## 技术栈与约定

- Node 24（见 `.nvmrc`）；包管理 pnpm（`corepack`）。开发启动：`pnpm dev`（Electron dev，Vite 默认 5173，CDP 9823）。
- 会话右侧面板经 `SettingsSurface embedded` 渲染，带 `workspaceId`，天然项目级。
- 技能存储：项目级 `.opencode/skills`、`.opencode/skill`、`.claude/skills`；全局 `~/.config/opencode/skills`、`~/.claude/skills` 等。
- i18n 文案键在 `apps/app/src/react-app/i18n/locales/*`。
- 提交遵循 Conventional Commits。

## 外部服务

- SkillHub 技能市场：`https://skillhub.juggle.im`，`GET /api/web/*` 匿名可读，技能包下载为 ZIP。
