# TASK-009：跨平台打包、安全与诊断

## 基本信息

| 属性 | 内容 |
| --- | --- |
| 类型 | [INFRA] |
| 职责层 | 构建发布基础设施层 |
| 所属模块 | MOD-009 跨平台打包、安全与诊断 |
| 状态 | IN_PROGRESS |
| 依赖任务 | TASK-004 |
| 解锁任务 | TASK-010 |
| 预计工作量 | 14–20 小时 |

## 任务描述

把固定版 Codex sidecar 纳入 macOS arm64/x64、Windows x64 的下载、校验、打包、签名、升级、进程回收和脱敏诊断。每个平台安装包只携带对应架构资产，避免重复增加包体。

## 包含文件

| 文件路径 | 类/导出 | 操作 | 说明 |
| --- | --- | --- | --- |
| `apps/desktop/scripts/prepare-sidecar.mjs` | Codex asset resolver | 修改 | 下载、SHA/version/schema 校验和目标复制 |
| `apps/desktop/resources/sidecars/codex-versions.json` | manifest | 修改 | 固化三个目标资产信息 |
| `apps/desktop/electron-builder.yml` | `extraResources` | 修改 | 按 target 打入 Codex sidecar |
| `apps/desktop/scripts/electron-after-sign.cjs` | nested signing | 修改 | macOS Codex 嵌套签名 |
| `apps/desktop/scripts/electron-after-pack.cjs` | package validation | 修改 | 检查目标资产和签名/版本 |
| `apps/desktop/electron/codex-runtime-diagnostics.mjs` | `runCodexDiagnostics` | 创建 | 版本、握手、网关、模型、sandbox 诊断 |
| `apps/desktop/electron/codex-runtime-diagnostics.test.mjs` | diagnostics tests | 创建 | 脱敏和故障分类测试 |
| `apps/desktop/electron/codex-packaging.test.mjs` | manifest tests | 创建 | target 选择、重复资产和校验测试 |

## 上下文与约束

**架构引用**：架构文档 §10–§11、执行计划 MOD-009。

**目标资产**：

```text
codex-aarch64-apple-darwin
codex-x86_64-apple-darwin
codex-x86_64-pc-windows-msvc.exe
```

**技术约束**：

- Windows 启动使用参数数组、`shell:false`、`windowsHide:true`，并回收完整进程树。
- macOS sidecar 在外层 App 签名前完成嵌套签名，并验证 hardened runtime/notarization。
- 包内不得同时出现通用 Codex 和目标架构 Codex。
- 诊断不输出 Token、secret、Prompt、响应正文、真实 workspace path 或 broker nonce。

## Done Definition

- [x] 三个平台资产均按固定 manifest 下载并校验 SHA-256、`codex --version` 和 App Server schema/version。
- [ ] macOS arm64/x64 安装包完成嵌套签名、notarization、Gatekeeper 和 DMG 安装后启动验证。
- [ ] Windows x64 安装包完成 Authenticode/目标签名验证，退出和崩溃均无残留进程树。
- [ ] 正常升级、运行中升级、回滚兼容检查不因 sidecar 文件占用失败。
- [ ] 空格、中文、括号、`&`、长路径、不同盘符和 UNC 场景按支持策略验证。
- [x] 诊断可分类二进制、版本、握手、Token、网关、模型、sandbox 和工作区权限故障且输出完全脱敏。
- [ ] 记录三个目标包的实际压缩/安装体积；构建测试和 `git diff --check` 通过。

## 执行快照

**中断时间**：2026-08-13 08:40 +08:00  
**已完成文件**：`prepare-sidecar.mjs`、`codex-versions.json`、`electron-builder.yml`、afterPack/afterSign、packaging/diagnostics/evidence 模块及测试、三平台构建 workflow  
**未完成文件**：CI 三平台实际安装包、签名/notarization/AuthentiCode/升级/路径矩阵与包体报告  
**当前卡点**：本机仅能实测 macOS arm64；macOS x64、Windows x64 和发行证书验收必须由现有矩阵 CI/发布环境执行  
**下一步行动**：运行发布矩阵，收集已接入的 macOS arm64/x64、Windows x64 release artifact evidence，并执行 notarization、Gatekeeper、Authenticode、升级和路径矩阵  
**关键决策记录**：manifest 只声明 macOS arm64/x64、Windows x64；非首发 target 不强制 Codex；afterPack 仅保留当前 target；Codex 在外层 App 签名前完成 hardened runtime 嵌套签名

### 2026-08-13 macOS arm64 产物证据

- `package:electron:dir` 成功；Electron Bridge 静态校验覆盖 85 个 Renderer 方法。
- 产物只包含当前 Codex target：`codex-aarch64-apple-darwin`，运行输出 `codex-cli 0.147.0`。
- Codex 安装体积 `218,720,784` bytes（约 `208.59 MiB`），对应上游压缩资产 `87,984,231` bytes（约 `83.91 MiB`）；完整 `.app` 磁盘占用约 `785.34 MiB`。
- 签名后的 Codex SHA-256：`08ea5fd5420c60a87a1e43e22d25e82ea841051e6d427047df4a90e8d26f2a27`。签名会改变原始二进制哈希，下载阶段仍按 manifest 校验上游 archive SHA-256。
- 系统环境下 `codesign --verify --deep --strict` 验证完整 App、Computer Use helper 与 Codex sidecar 均通过；本次目录构建明确关闭 notarization，不能替代 DMG 公证/Gatekeeper 验收。
- `afterSign` 现在即使 `MACOS_NOTARIZE != true` 也强制验证 helper、Codex 和完整 App 签名，避免输出结构已损坏的未公证测试产物。
- release workflow 已在三个首发 target 打包/签名后生成并上传 `codex-package-evidence-<target>.json`，用于汇总实际安装包和 sidecar 体积及哈希。
- packaging/diagnostics 专项测试 `4/4`、`git diff --check` 通过。

## 变更历史

| 版本 | 时间 | 触发原因 | 变更文件 | 变更类型 | 影响的下游任务 |
| --- | --- | --- | --- | --- | --- |
| v1 | 2026-08-12 22:02 +08:00 | 固定 sidecar 纳入构建 | prepare/builder/hooks/diagnostics/tests | 新增 | TASK-010 |
| v2 | 2026-08-13 08:40 +08:00 | 完成 macOS arm64 真实打包并收紧构建期签名验证 | afterSign/evidence/workflows | 修改 | TASK-010 |
