## Why

当前安装的 JuggleWork 仍从 GitHub Releases 检查更新，而七牛 `juggleim` 桶仅发布了可手动安装的 DMG，缺少 macOS 自动更新所需的 ZIP、更新清单与原子发布流程。需要把稳定版、Alpha 和 Den 指定版本的更新发现与下载迁移到 `downloads.jugglechat.cn`，同时提供一条不会中断既有 `1.2.14` 客户端的桥接升级路径。

## What Changes

- 将 Electron stable、Alpha 和指定版本更新 feed 从 GitHub 切换到七牛 CDN `https://downloads.jugglechat.cn/jugglework/releases`
- 将安装包内 `app-update.yml`、架构修复下载和手动下载回退统一到七牛清单及其中的签名 DMG，避免运行时仍残留 GitHub 下载路径
- 定义并实现七牛更新目录：不可变版本目录与可变 stable/alpha 通道清单分离，一个 macOS manifest 可包含 arm64、x64 或 universal 文件
- macOS 发布必须生成 electron-updater 可安装的 ZIP（以及 DMG 和 blockmap），`latest-mac.yml` 的主路径必须指向 ZIP，不能仅发布 DMG
- 新增可重复、非覆盖、可审计的七牛发布脚本：验证版本/架构/签名/公证/哈希，按资源优先、manifest 最后的顺序上传，远端复核后再原子更新通道指针并刷新 CDN
- 发布高于 `1.2.14` 的桥接版本（计划 `1.2.15`）：七牛先完整发布，再最后一次发布到 GitHub，使旧客户端迁移到已内置七牛 feed 的版本
- 将 Den 的 published/latest/allowed desktop version 元数据更新放到七牛 canary 验证之后，防止服务端宣布尚不可下载的版本
- 增加真实升级矩阵：旧 GitHub 客户端到桥接版、桥接版到下一七牛版、下载失败重试、安装重启、同一 Team 签名、用户数据与权限保持

## Capabilities

### New Capabilities

- `desktop-qiniu-update-delivery`: 规定桌面客户端如何从七牛发现 stable/alpha/指定版本更新，选择正确架构的 ZIP，下载、校验、安装及安全回退
- `desktop-qiniu-release-publication`: 规定版本化产物、通道清单、非覆盖上传、远端哈希验证、CDN 缓存、Den 元数据和桥接发布的顺序与原子性

### Modified Capabilities

（无）

## Impact

- Electron updater 与手动下载：`apps/desktop/electron/updater.mjs`、`apps/desktop/electron/main.mjs`、`apps/app/src/app/lib/electron-alpha.ts`、preload/renderer 更新状态和对应测试
- 打包配置与版本：`apps/desktop/electron-builder.yml`、三个 package 版本、macOS ZIP/DMG/blockmap/manifest 生成与现有 package 验证
- 发布工具：新增七牛 release 脚本、清单生成/验证、CDN refresh、dry-run 和不可变对象保护；凭据继续只使用本地/CI secret，不写入仓库
- 外部系统：Qiniu bucket `juggleim`、CDN `downloads.jugglechat.cn`、Den desktop version metadata，以及仅用于 `1.2.14 → 1.2.15` 桥接的最后一次 GitHub Release
- 生产发布要求 Developer ID 同 Team 签名；macOS 公证作为 stable 发布门禁，若凭据不可用则只能生成/验证候选包，不得推进 stable 通道
