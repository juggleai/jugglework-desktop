# 漫剧工厂打包与发版检查

本文是 workspace-local `release-jugglework-desktop` Skill 的 Git 内配套检查表。
适用于内嵌 Toonflow sidecar、视频操作按钮、逐帧拉片和 Agent 剪辑导出。
这里只描述发版要求，不表示所有平台或真实安装包验收已完成。

## 1. 编译顺序

1. 在匹配目标平台/架构的干净 worktree 构建，记录精确 commit。
2. 根仓库使用 `pnpm install --frozen-lockfile`。嵌套的 `modules/toonflowV2`
   使用其 `package.json` 锁定且通过 `toonFactoryBundle.mjs` 可信哈希验证的 Bun
   （当前 1.3.14），执行 `bun install --frozen-lockfile`。
   不要用机器默认 Bun 版本替代。安装和构建不得改写已提交的 lockfile。
3. 新增 workspace 节点后，即便已有 node_modules，也应显式同步嵌套依赖；
   `buildToonFactory.mjs` 的已有依赖 sentinel 不代表所有新包已链接。
4. 路由变更时，在提交 release commit 前于 `modules/toonflowV2/apps/server`
   执行 `bun run routes` 并审查生成的 `src/router.ts`，不能在发布时静默修复。
5. 正常执行 `pnpm --filter @jugglework/desktop build:electron`，或确认会执行它的
   `pnpm --dir apps/desktop package:mac-release -- --arch <arch>` 包装脚本。
   `build:electron` 已调用漫剧工厂构建；不能只直接运行 electron-builder。

只调试/重建漫剧工厂时，从仓库根目录执行：

```bash
BUN_BINARY="/absolute/path/to/verified/bun" pnpm build:toon-factory
```

这一步构建所有节点 UMD、工具、Web、Server 和 managed Server 入口，再写入
`apps/desktop/resources/toonFactoryV2/build-manifest.json`。
通常无需单独手动编译 frameAnalysisNode。构建会先校验/构建独立媒体工具；首次或源码/recipe 变化时从源码编译 FFmpeg/x264，完整有效的 staging 可复用。

## 2. 必须打包的文件

`resources/toonFactoryV2` 通过 electron-builder 的 extraResources 进入包：

- `server/jugglework.js`、`web/`、`tools/`、`skills/`、`mcp/`、`LICENSE`；
- 可信且匹配目标的 Bun 可执行程序；
- `nodes/videoNode.umd.js`；
- `nodes/videoGenerationNode.umd.js`；
- `nodes/frameAnalysisNode.umd.js`；
- 与全部实际文件一致的 `build-manifest.json`。

宿主还需通过 `electron/**/*` 打包 `toonFactoryRuntime.mjs` 和
`toonFactoryVideoEdit.mjs`。只更新 sidecar 文件不会热更新正在运行的 Electron 主进程。
Dev 测试需重启；发布测试必须使用新安装包，而不是已启动的旧实例。

用仓库 `verifyToonFactoryBundle` 检查目标、Bun 来源/哈希/架构、完整 inventory。
在最终 app、macOS ZIP/DMG、Windows 最终包中重复检查，不能只检查 staging。
不要在生成 manifest 后手工替换资源，不要跨架构复用 bundle。

## 3. FFmpeg/FFprobe：独立随包资源，bundled-only

`build:electron → buildToonFactory.mjs → buildMediaTools.mjs` 在 native Mac 上编译或
校验 `resources/mediaTools`，electron-builder 通过独立 extraResources 复制。
开发和安装包 runtime 均只接受此目录；子进程 PATH 为空。缺失/校验失败提示重建或重装，
没有系统 FFmpeg、Homebrew、项目内程序或模型指定命令回退。

| 目标 | 当前状态 |
| --- | --- |
| macOS ARM64，14+ | 本机源码重编译及真实临时媒体操作通过；真实发行签名/安装包验收待执行 |
| macOS x64，14+ | native recipe、Intel CI 和校验接线已实现；尚无本次 native x64 运行证据 |
| Windows x64/ARM64 | build、after-pack、最终 verifier 明确失败；无接受的 native recipe，不提供仿真替代 |
| Linux x64/ARM64 | 同样 gate；本变更不能发布为 Linux 已支持 |

源码锁：`apps/desktop/electron/mediaToolsSources.json`。FFmpeg 7.1.5 官方 HTTPS
archive 的 SHA-256 已用官方发布公钥的 detached signature 验证；x264 固定官方 Git
commit/tree 和生成 tar 的 SHA-256，尚无独立验证的上游签名。MacPorts/Homebrew
只用作源码摘要/commit 佐证，绝不分发它们的二进制。详细来源及限制见
[`media-tools-supply-chain.md`](../openspec/changes/replace-toon-factory-with-sidecar/media-tools-supply-chain.md)。

构建启用 GPL、禁用 nonfree/network/autodetect，静态 x264/FFmpeg，只允许 Apple
系统 dylib；仅 file/pipe 协议。`eugeneware/ffmpeg-static/b6.1.1` 的 nonfree
ARM64 二进制仍明确禁止使用。此工程实现不是法律审核或发行许可批准。

随包必须包含 `ffmpeg`、`ffprobe`、`manifest.json`、`NOTICE.txt`、`licenses/`、
`sources/`（两个精确源码 archive、FFmpeg 公钥/签名、source lock、两个 shell recipe）
及 `build-info/`（实际 compiler/SDK/config/version）。发布者仍须完成 GPL 对应源码交付、
notice 和整个分发方式审核。构建记录工具链版本，但未声称跨工具链逐字节可重现。

```bash
pnpm build:media-tools
MEDIA_TOOLS_OFFLINE=1 node apps/desktop/scripts/buildMediaTools.mjs --force
MEDIA_TOOLS_SMOKE=1 node --test apps/desktop/scripts/buildToonFactory.test.mjs
```

离线重编译要求 `.media-tools-cache` 中所有锁定源码及签名证据完整且 hash 一致。
`--force` 真实重编译；普通构建可复用通过完整校验的 staging。首次编译需要 Xcode
Command Line Tools，无需 Homebrew FFmpeg、x264 或 nasm。

签名顺序：after-pack 校验 built inventory → 应用身份显式签署两个媒体程序 → 验证
Developer ID/Team/secure timestamp/hardened runtime → 写入媒体 signed inventory →
主 app 封存 → 再校验。默认 signer 仅额外排除这两个精确媒体路径；Bun 的原始官方
SHA-256、上游 Team `7FRXF46ZSN` 和 Toonflow inventory 不改写。
macOS 最终 app/ZIP/DMG verifier 及 packaged runtime 同时验证主 app 和媒体资源信任。
ad-hoc fixture 仅验证签名字节变化/清单时序，不能替代真实发行签名、公证和安装验收。

## 4. 发布验收，不以编译成功替代

在隔离用户配置及临时授权项目中验证：

- 选中视频/视频生成节点，四按钮可见可操作；菜单能添加逐帧拉片节点；
- 按钮创建拉片节点并自动连线，输出镜头视频、关键帧、音轨与清单；
- 截取、提音轨、分离、Agent 有序拼接导出成功，产物探测/全片解码/播放正常；
- 无音轨输入行为、失败/取消无半成品发布、进程退出无孤儿、禁止覆盖原素材；
- 工作区切换、授权拒绝、越界/符号链接/URL/任意参数拒绝；
- 画布保存重载、撤销、结果节点重建；
- PATH 为空且无系统 FFmpeg；bundle 缺失/篡改拒绝；支持的编解码器与实际系统架构；
- 项目文件系统支持当前硬链接发布；exFAT/网络盘未验收前不得宣称兼容。

当前拉片是本地场景差异检测，并非上游完整自适应/AI 检测算法；截取使用预览和
数值时间区间，并非缩略图拖拽时间轴。不得将适配范围写成完整时间线剪辑器。
截取/分离/拉片分支的 512MB 单文件、2GB 总产物限制不等于 export 分支也有相同磁盘配额。

`/api/ffmpeg/*` 通用执行应继续拒绝；仅使用认证的、宿主授权目录内的受限媒体操作。
不能为通过验收而关闭 managedGuard、资源白名单或路径验证。

现有定向检查（不替代真实 UI 验收）：

```bash
node --test apps/desktop/electron/toonFactoryRuntime.test.mjs apps/desktop/scripts/buildToonFactory.test.mjs
bun run --cwd modules/toonflowV2/apps/server typecheck
bun run --cwd modules/toonflowV2/apps/web typecheck
bun run --cwd modules/toonflowV2/apps/server test src/lib/managed.test.ts
pnpm --dir apps/desktop exec electron scripts/toonFactorySmoke.mjs
```

证据记录 commit、目标架构、Bun/lockfile/manifest/inventory 摘要、节点清单、
FFmpeg/FFprobe 版本与分发策略、打包与 UI/媒体实测结果、未支持平台及依赖缺失行为。
普通 managed guard 单测的 200 响应不证明真实媒体接口执行成功；既有 smoke 不覆盖全部新按钮。
保留 OpenSpec 中尚未完成的真实 Desktop 和跨平台验证任务，不将其自动勾选。
