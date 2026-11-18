# Design

## Context

会议窗口 `jugglework-meeting` 是主渲染进程通过 `window.open("about:blank")` 打开的子窗口，由 React Portal 渲染。共享屏幕时，会议窗口调用自己的 `navigator.mediaDevices.getDisplayMedia`，主进程 `setDisplayMediaRequestHandler` 交给 `meeting-screen-picker`，用户在缩略图选择器中确认来源后回调 `{ video: source }`。`MeetingMedia.startShare` 把采集轨道包成 ZEGO 自定义流（`videoOptimizationMode: "detail"`），以 `<room>_<user>_<session>_screen` 推流；参会人按 `_screen` 后缀识别共享画面。

## 评审修正

原方案的两项 P0 技术验证已在 Electron 44.0.0 上完成，结论修正了一期的窗口形态和采集方式：

1. **Portal 子窗口不适用于 Excalidraw。** 0.18.1 在全局 `window`/`document` 上绑定了绘制必需的事件：按下后的 `pointermove`/`pointerup`/`keydown`/`keyup` 绑在 `window`；`copy`/`paste`/`cut`/`keyup`/`pointermove` 及 `document.fonts` 的字体加载绑在 `document`；`resize`/`blur`/`focus` 绑在 `window`。在 Portal 子窗口中这些都会落到主窗口，拖拽绘制、快捷键、粘贴和字体刷新都会失效。**一期直接采用原方案的备选：独立页面入口 `whiteboard.html`，由主进程 `BrowserWindow` 加载，配窄 preload。**
2. **窗口作为采集来源可行。** 在 `setDisplayMediaRequestHandler` 回调中传入目标窗口的 `WebFrameMain`（`{ video: whiteboard.webContents.mainFrame }`）得到 `displaySurface: "browser"` 的 live 轨道；目标窗口隐藏后仍有画面；目标窗口销毁时轨道 `ended`，现有 `startShare` 的 `ended` 监听可直接停止共享。**采用 `WebFrameMain` 方式**，它采的是渲染内容本身，不受窗口遮挡、最小化或系统屏幕录制权限影响，也不需要 `desktopCapturer` 枚举。

其他修正：

- 字体：Excalidraw 先按 `window.EXCALIDRAW_ASSET_PATH` 拼本地地址，再追加 `https://esm.sh/...` 作为兜底源。本地字体缺失时会访问外网，所以构建必须把 `dist/prod/fonts` 打进 `whiteboard` 资源目录，并在验收中确认打包版运行时无外部请求。
- 共享发起方：采集仍由会议窗口发起（会议窗口持有 `MeetingMedia`、ZEGO 引擎和用户手势），白板窗口只是被采集的来源。白板窗口不需要任何媒体权限。
- `whiteboardId` 稳定性：同一 `meetingId` 下复用上次的 `whiteboardId`，使「误关后再打开」直接恢复，不需要额外的恢复提示。

## Goals / Non-Goals

**Goals:**

- 主讲人一键打开白板并开始共享；参会人看到清晰的白板画面和「白板共享」标签。
- 白板与屏幕共享共用一个 `_screen` 流，同一时间只共享一种。
- 关闭白板、离会、主窗口重载或会议结束时停止共享并完成一次保存。
- Excalidraw 只出现在 `domains/meeting/whiteboard/` 目录内；二期接入协作时只改该目录。

**Non-Goals:**

- 多人编辑、协作光标、服务端快照、会后打开（二期）。
- 白板图片发到会内聊天。
- 白板与屏幕共享同时进行。
- 新的服务端接口或 `claim-share` 调用。

## Decisions

### 1. 窗口与页面

- 主进程模块 `meeting-whiteboard-window.mjs` 管理唯一白板窗口：`whiteboard.html` 页面、`whiteboard-preload.mjs`、`sandbox`、`contextIsolation`、无 Node；拒绝新窗口和跳转；拒绝白板窗口的所有权限请求。
- 打开时主进程从会议窗口接收 `{ meetingId, title, theme }`，生成或复用 `whiteboardId`，页面通过 preload 的 `getContext()` 取得只读上下文。
- 会议窗口关闭、主窗口导航或渲染进程退出时，主进程关闭白板窗口；白板页面 `beforeunload`/`pagehide` 时同步提交最后一次保存。

### 2. 白板共享

- 会议窗口点击「白板」：若正在共享屏幕，先确认，再 `stopShare`；然后 IPC `meetingWhiteboardOpen` 打开白板，主进程同时为会议窗口登记一次性「内部来源」意图（30 秒有效）。随后会议窗口在同一手势链路里调用 `startShare`。
- `meeting-screen-picker.handle` 在弹选择器前检查意图：请求来自会议窗口主框架、带用户手势、意图未过期、白板窗口存活时，直接回调 `{ video: whiteboard.webContents.mainFrame }` 并消费意图；否则走原有选择器流程。
- 白板共享期间，会议工具栏「共享屏幕」按钮变为「停止共享」；`stopShare` 不关闭白板窗口。关闭白板窗口会让轨道 `ended`，由 `startShare` 现有监听停止共享。

### 3. 数据与持久化

- 场景只用 `serializeAsJSON(elements, appState, files, "local")` 的输出保存与导出，不再包一层自定义结构。
- 主进程 `whiteboard-store.mjs` 校验 `meetingId`/`whiteboardId` 为安全片段、内容大小上限 20MB，原子写入（临时文件 + rename）。
- 每个会议记住最近一次的 `whiteboardId`（`whiteboards/<meetingId>/current.json`），下次打开复用并加载内容。
- 导出 PNG 用 `exportToBlob`，源文件用 `serializeAsJSON`；通过主进程 `dialog.showSaveDialog` 写到用户选择的位置。

### 4. 资源与安全

- `whiteboard.html` 在 `<head>` 设置 `window.EXCALIDRAW_ASSET_PATH`，指向随包发布的 `whiteboard-assets/`；Vite 插件在 dev 中提供、build 中复制 `@excalidraw/excalidraw/dist/prod/fonts`。
- `validateEmbeddable={false}`、`UIOptions.tools.embeddable` 不可用、`aiEnabled={false}`、隐藏素材库的「浏览」按钮、`onLinkOpen` 一律阻止并不打开外部链接；`canvasActions.loadScene/saveToActiveFile/export` 关闭，由白板自己的导出按钮代替。
- 白板窗口 `setPermissionRequestHandler` 不放行任何权限；`media-permissions` 不扩大给白板窗口的权限。

### 5. 适配层

- `MeetingWhiteboard` 组件对外接口：`initialScene`、`onSceneChange(json)`、`readonly`、`theme`、`langCode`，以及通过 ref 暴露的 `exportPng()`、`exportSource()`、`applyRemoteScene(elements)`、`setCollaborators(map)`；后两项一期为空实现。
- 测试断言：仓库中只有 `domains/meeting/whiteboard/` 目录可以引用 `@excalidraw/excalidraw`。

### 6. 信令

- `announceState` 增加 `shareKind`，值为 `"screen"`、`"whiteboard"` 或缺省；`acceptDeviceState` 只接受这两个字面值。参会人标签按对方最近一次信令显示「白板共享」或「屏幕共享」，未知时显示「屏幕共享」。

## Risks

- 白板窗口与会议窗口在同一 session，Excalidraw 的 localStorage 键可能与主应用冲突；白板不使用 Excalidraw 的 localStorage 持久化，只走主进程存储。
- Windows/macOS 打包版的字体路径与画质需要实机验收。
