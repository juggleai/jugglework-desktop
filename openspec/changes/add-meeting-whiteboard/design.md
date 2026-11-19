# Design

## Context

会议窗口 `jugglework-meeting` 是主渲染进程通过 `window.open("about:blank")` 打开的子窗口，由 React Portal 渲染。共享屏幕时，会议窗口调用自己的 `navigator.mediaDevices.getDisplayMedia`，主进程 `setDisplayMediaRequestHandler` 交给 `meeting-screen-picker`，用户在「桌面与窗口」选择器中确认来源后回调 `{ video: source }`。`MeetingMedia.startShare` 把采集轨道包成 ZEGO 自定义流（`videoOptimizationMode: "detail"`），以 `<room>_<user>_<session>_screen` 推流；本地共享画面显示在会议窗口舞台的共享区域（`.share-stage`），参会人按 `_screen` 后缀识别共享画面。

## 评审修正

1. **Excalidraw 不能直接渲染进 Portal。** 0.18.1 在全局 `window`/`document` 上绑定了绘制必需的事件：按下后的 `pointermove`/`pointerup`/`keydown`/`keyup` 绑在 `window`；`copy`/`paste`/`cut` 及 `document.fonts` 的字体加载绑在 `document`。直接 Portal 进会议窗口时，这些都会落到主窗口，拖拽绘制、快捷键和粘贴会失效。
2. **白板不另开窗口。** 产品确认白板与屏幕共享一样显示在会议窗口的共享区域。因此白板页面 `whiteboard.html` 以同源 `iframe` 嵌入共享区域：iframe 有自己的 `window`/`document`，满足第 1 点；它仍在会议窗口内，不产生新的原生窗口。（早期方案用独立 `BrowserWindow` 加 `WebFrameMain` 采集，已废弃。）
3. **画面来源是画布镜像，不经过系统采集。** 白板页面把 Excalidraw 的场景画布逐帧绘制到一张输出画布，`canvas.captureStream(15)` 得到视频轨，再走 `MeetingMedia` 的 ZEGO 自定义流发布。好处：不需要系统屏幕录制权限，不经过选择器的主进程回调，会议窗口被遮挡、隐藏或收成小窗时画面不受影响（会议窗口 `backgroundThrottling: false`）。
4. **字体必须随包。** Excalidraw 先按 `window.EXCALIDRAW_ASSET_PATH` 拼本地地址，再追加 `https://esm.sh/...` 作为兜底源。构建把 `dist/prod/fonts` 打进 `whiteboard-assets/`，`whiteboard.html` 在 `<head>` 设置该路径。

已验证（Electron 44.0.0）：`about:blank` 弹窗内插入的同源 iframe 能读到父页面在 iframe 元素上设置的桥接对象；iframe 内 `canvas.captureStream()` 的轨道可在父页面包成新 `MediaStream` 并播放；iframe 移除后轨道 `ended`。在与会议窗口同构的环境中，向会议窗口发送鼠标、键盘与中文输入，Excalidraw 能画出矩形和中文文本，自动保存得到 `rectangle`、`text` 两个元素，镜像流 1804×1080 且画面有内容。

## Goals / Non-Goals

**Goals:**

- 从「共享屏幕」选择器选择白板；白板显示在会议窗口共享区域并开始共享；参会人看到清晰的白板画面和「白板共享」标签。
- 白板与屏幕共享共用一个 `_screen` 流，同一时间只共享一种；切换必须先停止当前共享。
- 停止共享、离会、会议结束或会议窗口关闭时停止推流，并提交最后一次保存。
- Excalidraw 只出现在 `domains/meeting/whiteboard/` 目录内；二期接入协作时只改该目录。

**Non-Goals:**

- 多人编辑、协作光标、服务端快照、会后打开（二期）。
- 白板图片发到会内聊天。
- 白板与屏幕共享同时进行。
- 新的服务端接口或 `claim-share` 调用。

## Decisions

### 1. 入口：选择器中的白板来源

- `MeetingScreenPicker` 的筛选栏为「全部 / 桌面 / 白板 / 窗口」；「全部」中顺序为桌面、会议白板卡片、窗口。白板卡片不来自 `desktopCapturer`，不需要缩略图，也不受来源列表加载状态影响。
- 选择白板并点「开始共享」时，选择器先以「取消」结束当前的原生采集请求（主进程回调 `null`，`getDisplayMedia` 以 `AbortError` 结束，`startShare` 静默返回），再调用 `shareWhiteboard`。store 会等待这次被取消的采集请求结束，避免与之竞争。
- 会议工具栏不再有单独的白板按钮。共享进行中（屏幕或白板），「共享屏幕」按钮显示为「停止共享」；用户必须先停止，才能重新打开选择器选白板，因此没有「替换当前共享」的确认对话框。

### 2. 会议窗口内的白板

- `shareWhiteboard` 调用主窗口命令 `meetingWhiteboardOpen({ meetingId })` 取得 `whiteboardId` 与已保存的场景，写入 store 的 `whiteboard` 会话。
- 会议舞台在共享区域渲染 `MeetingWhiteboardStage`：同源 `iframe` 加载 `whiteboard.html`。桥接对象挂在 iframe 元素上，并在设置 `src` 之前就绪；页面通过 `window.frameElement` 读取，桥接提供上下文、保存、导出、发布画面、报告失败与保存钩子。页面不能直接调用 Electron。
- 白板会话存在期间，本地共享区域显示可编辑的白板 iframe，不再显示本地共享预览视频；参会人收到的是镜像流。

### 3. 画面与发布

- `canvas-mirror.ts` 等 Excalidraw 的静态画布挂载后，按 15fps 把场景画布（静态画布和正在绘制的笔画画布，不含选择框等交互层）绘制到输出画布。输出保持白板区域的宽高比，像素密度最多 2 倍，最大 1920×1080，宽高取偶数。
- 页面把 `captureStream(15)` 交给桥接；store 的 `publishWhiteboard` 调用 `MeetingMedia.startCustomShare`，与 `startShare` 共用同一个发布函数（ZEGO 自定义流、`_screen` 流 ID、轨道 `ended` 即停止共享）。
- 任何原因的共享停止（用户点击「停止共享」、轨道结束、离会、会议结束）都会清空 `whiteboard` 会话，iframe 被移除，镜像停止并结束轨道。

### 4. 数据与持久化

- 场景只用 `serializeAsJSON(elements, appState, files, "local")` 的输出保存与导出，不包一层自定义结构。
- 主进程 `whiteboard-store.mjs` 校验 `meetingId`/`whiteboardId` 为安全片段，内容大小上限 20MB，原子写入（临时文件 + rename）。
- 每个会议记住最近一次的 `whiteboardId`（`whiteboards/<meetingId>/current.json`），下次打开复用并加载内容。
- 保存由 iframe 内防抖调度，但请求经桥接由长期存在的主渲染进程发出；舞台在移除 iframe 前的 layout cleanup 中调用保存钩子，所以停止共享时最后一次修改仍会写入。
- 导出 PNG 用 `exportToBlob`，源文件用 `serializeAsJSON`；主进程 `dialog.showSaveDialog` 以会议窗口为父窗口，写到用户选择的位置。

### 5. 主进程命令与安全

- 主窗口命令 `meetingWhiteboardOpen`、`meetingWhiteboardSave`、`meetingWhiteboardExport` 只接受主窗口主框架的调用（会议 UI 是主窗口的 Portal）；导出格式只允许 `png` 与 `excalidraw`，数据为字符串且不超过 60MB。
- 不新增窗口、preload 或媒体权限，`meeting-screen-picker` 与 `media-permissions` 不变。会议窗口已有的拒绝新窗口与跳转规则同样约束白板 iframe。
- `validateEmbeddable={false}`、`aiEnabled={false}`、隐藏素材库「浏览」按钮、`onLinkOpen` 一律阻止；`canvasActions.loadScene/saveToActiveFile/export` 关闭，由白板自己的导出按钮代替。

### 6. 适配层

- `MeetingWhiteboard` 组件对外接口：`initialScene`、`onSceneChange(json)`、`readonly`、`theme`、`langCode`，以及通过 ref 暴露的 `exportPng()`、`exportSource()`、`applyRemoteScene(elements)`、`setCollaborators(map)`；后两项一期为空实现。
- 测试断言：仓库中只有 `domains/meeting/whiteboard/` 目录可以引用 `@excalidraw/excalidraw`。

### 7. 信令

- `announceState` 增加 `shareKind`，值为 `"screen"`、`"whiteboard"` 或缺省；`acceptDeviceState` 只接受这两个字面值。参会人标签按对方最近一次信令显示「白板共享」或「屏幕共享」，未知时显示「屏幕共享」。

## Risks

- 白板 iframe 与主应用同源同 session，Excalidraw 的 localStorage 键可能与主应用冲突；白板不使用 Excalidraw 的 localStorage 持久化，只走主进程存储。
- 镜像按固定帧率重绘整张画布，大白板在低端设备上会占用一定 CPU；一期固定 15fps，必要时再改为仅在场景变化时重绘。
- Windows/macOS 打包版的字体路径、`file://` 下 iframe 同源行为与画质需要实机验收。
