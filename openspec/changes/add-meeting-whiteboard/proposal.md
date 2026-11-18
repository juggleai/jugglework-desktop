# Proposal

## Why

会议中讲解思路、画流程图时，只能共享其他应用的窗口。会议内需要一块主讲人可直接书写的白板，并以现有屏幕共享链路推给参会人，不增加服务端改动。

方案来源：`白板/docs/meeting-whiteboard-excalidraw-design.md`（Excalidraw 0.18.1，MIT）。本变更实现其中一期，并按评审结论修正窗口形态与采集方式（见 design.md「评审修正」）。

## What Changes

- 会议工具栏新增「白板」入口。主讲人打开独立白板窗口，内含懒加载的 Excalidraw 画布，界面中文、主题跟随应用。
- 白板窗口作为一路共享视频推出，复用现有 `startShare` → ZEGO 自定义流 → `_screen` 流 ID 链路；参会人看到「白板共享 · 某人」。
- 白板与屏幕共享互斥：正在共享屏幕时打开白板需确认后切换；任一共享结束时不残留采集轨道。
- 场景按 Excalidraw 原生 JSON（`serializeAsJSON`）500ms 防抖自动保存到应用数据目录 `whiteboards/<meetingId>/<whiteboardId>.excalidraw`；同一会议再次打开白板沿用同一 `whiteboardId` 并恢复内容。支持导出 PNG 和 `.excalidraw`。
- 字体随应用打包并从本地加载，不访问 CDN；关闭嵌入网页、外部素材库、AI 与外部链接入口。
- 信令 `jw:meeting-sync` 增加可选字段 `shareKind: "screen" | "whiteboard"`，旧客户端忽略该字段。

## Capabilities

### New Capabilities

- `meeting-whiteboard`：会议白板窗口、白板共享、与屏幕共享互斥、本地保存恢复与导出、离线资源与外部入口约束。

### Modified Capabilities

无。`desktop-meetings` 的显式选屏合同保持不变；白板共享只在白板窗口发起的、带用户手势的采集请求上绕过选择器。

## Impact

- 依赖：`apps/app` 新增 `@excalidraw/excalidraw@0.18.1`；构建产物增加约 13MB 字体与按需加载的白板 chunk。
- Electron：新增白板窗口模块、白板 preload、白板 IPC；`meeting-screen-picker` 增加内部来源分支。采集仍由会议窗口发起，白板窗口不获得任何媒体权限。
- 不修改服务端，不修改会议 API。
