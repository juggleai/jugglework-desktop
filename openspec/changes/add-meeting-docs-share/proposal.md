# Change: 会议共享 JuggleWork 与云文档妙享

## Why

会议目前只能通过系统窗口或桌面进行像素级屏幕共享。参会者只能看共享人的画面，不能按自己的节奏阅读，也不能在会中直接评论或编辑。参考飞书妙享（投文档）：参会者默认跟随共享人，滚动后进入自由浏览，点击「跟随共享人」回到共享人所在位置。

## What Changes

- 共享选择器增加「JuggleWork 主窗口」快捷项，使用主窗口自身的采集源，沿用现有 ZEGO 自定义源推流。
- 共享弹窗改为「桌面与窗口 | 云文档」两个页签；新增文档级共享（妙享）：共享人在「云文档」页选择当前组织的云文档。每位参会者在会议窗口中用自己的 Docs 会话和权限打开同一文档，不传输画面或正文。
- 共享人通过 JuggleIM 状态消息 `jw:meeting-share-docs` 持续发布自己当前的文档与视口，接收方按最新状态收敛。
- 参会者默认跟随，本地滚动、键盘导航或编辑后切到自由浏览，可一键回到共享人位置。缩放只在本地生效。
- Server 会议聚合新增唯一的共享槽，只记录谁在共享，屏幕共享与文档共享互斥。
- Docs 宿主桥新增视口上报与视口应用两条受限消息，以 `docs.ready` 能力协商开启。

## Impact

- Affected specs: meeting-docs-share
- Affected code：
  - Desktop：`apps/app/src/react-app/domains/meeting/`（共享状态、跟随控制、会议窗口文档舞台）、`apps/desktop/electron/meeting-screen-picker.mjs`、`cloud-docs-panel.mjs`、`cloud-docs-preload.cjs`。
  - Server：`services/meetings.go`、`storages/models/meetings.go` 的共享状态与 action。
  - Docs：`jugglework-host.tsx` 宿主协议，编辑器视口读写。
- Related changes：add-desktop-meetings、optimize-cloud-docs-startup、Docs 仓库 add-jugglework-docs-adaptation。
- 不涉及数据库外键或约束、CRDT、Docs ACL、保存 ACK、录制，不改 Docs launch grant 合同。

## Status

方案阶段，未实现。界面参考图见 `mockups/`，M0 技术验证项见 `tasks.md`。
