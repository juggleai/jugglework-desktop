# Proposal

## Why

会议中讲解思路、画流程图时，只能共享其他应用的窗口。会议内需要一块主讲人可直接书写的白板，并以现有屏幕共享链路推给参会人，不增加服务端改动。

方案来源：`白板/docs/meeting-whiteboard-excalidraw-design.md`（Excalidraw 0.18.1，MIT）。本变更实现其中一期，并按评审结论与产品确认修正白板的承载位置与采集方式（见 design.md「评审修正」）。

## What Changes

- 「共享屏幕」的「桌面与窗口」选择器增加「白板」：筛选栏为「全部 / 桌面 / 白板 / 窗口」，列表中「会议白板」卡片排在桌面之后、窗口之前。会议工具栏不再单独提供白板按钮。
- 选择白板后，白板直接显示在会议窗口的共享区域，与屏幕共享画面占同一位置，不打开新窗口。画布为懒加载的 Excalidraw，界面中文、主题跟随应用。
- 白板画面以画布镜像流推出，复用 ZEGO 自定义流与 `_screen` 流 ID；参会人看到「白板共享 · 某人」。
- 白板与屏幕共享互斥：共享进行中，「共享屏幕」按钮显示为「停止共享」，用户需先停止当前共享，再从选择器选白板或其他画面。停止共享即关闭白板。
- 场景按 Excalidraw 原生 JSON（`serializeAsJSON`）500ms 防抖自动保存到应用数据目录 `whiteboards/<meetingId>/<whiteboardId>.excalidraw`；同一会议再次共享白板沿用同一 `whiteboardId` 并恢复内容。支持导出 PNG 和 `.excalidraw`。
- 字体随应用打包并从本地加载，不访问 CDN；关闭嵌入网页、外部素材库、AI 与外部链接入口。
- 信令 `jw:meeting-sync` 增加可选字段 `shareKind: "screen" | "whiteboard"`，旧客户端忽略该字段。

## Capabilities

### New Capabilities

- `meeting-whiteboard`：选择器中的白板入口、会议窗口内的白板共享、与屏幕共享互斥、本地保存恢复与导出、离线资源与外部入口约束。

### Modified Capabilities

无。`desktop-meetings` 的显式选屏合同保持不变：系统屏幕与窗口仍须在选择器中确认；白板是应用内画面，不经过系统采集。

## Impact

- 依赖：`apps/app` 新增 `@excalidraw/excalidraw@0.18.1`；构建产物增加约 13MB 字体与按需加载的白板 chunk。
- Electron：新增白板存储与主窗口专用的白板命令（打开、保存、导出）；不新增窗口、preload 或媒体权限，`meeting-screen-picker` 不变。
- 不修改服务端，不修改会议 API。
