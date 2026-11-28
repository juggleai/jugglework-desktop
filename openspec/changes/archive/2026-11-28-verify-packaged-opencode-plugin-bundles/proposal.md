# Proposal

## Why

Desktop 会把 Server 的 OpenCode plugins 作为独立于 `app.asar` 的运行时代码发布。仅复制 `tsc` 输出会保留 workspace/package import，使源码环境因 `node_modules` 掩盖问题，而安装包在用户机器上启动失败。构建与最终包都需要可重复、默认拒绝的自包含校验。

## What Changes

- 将所有发布的 OpenCode plugin 入口作为同一 Bun build graph 构建，捆绑运行时包依赖并保留共享 chunk。
- 新增确定性的 bundle verifier，拒绝缺失入口、源码映射、源码树相对导入和未允许的裸包 import。
- 在 Server build、Desktop Electron staging 和 macOS packaged verification 三个边界执行同一校验。
- 校验只处理代码结构和相对路径，不读取或记录凭据、用户配置或 workspace 内容。

## Capabilities

### New Capabilities

- `packaged-opencode-plugin-integrity`: OpenCode plugin 的自包含构建、允许依赖边界和分阶段安装包校验。

### Modified Capabilities

无。

## Impact

- `apps/server`：调整 plugin build graph，并新增可单测的 verifier CLI。
- `apps/desktop`：staging 和最终 macOS package verification 增加同一 fail-closed gate。
- 构建输出可以包含 Bun 生成的共享 chunk，但不得依赖仓库 workspace 包或用户机器的 Node package resolution。
