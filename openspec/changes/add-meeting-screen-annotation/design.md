# Design

## Context

共享屏幕时，会议窗口调用 `getDisplayMedia`，主进程 `setDisplayMediaRequestHandler` 交给 `meeting-screen-picker`，用户在「桌面与窗口」选择器中确认后回调 `{ video: source }`。`desktopCapturer` 的 `screen:` 来源带 `display_id`，`MeetingMedia` 把采集轨道包成 ZEGO 自定义流以 `_screen` 推出。共享白板时走应用内画布镜像，不经过系统采集。

## 评审修正

原方案方向正确，一期可以实施。P0 已在 macOS 26.2、Electron 44.0.0、双显示器（内置 Retina + 外接 4K）上验证：

1. **整屏采集会拍进标注窗口。** 在主屏上放一个透明、`screen-saver` 层级的窗口并画一块纯色区域，以 `screen:1:0` 共享整屏，采集画面（3024×1964，`displaySurface: "monitor"`）中该区域按预期出现，约占 16% 的采样点。
2. **`setContentProtection(true)` 在 macOS 上能让工具栏不被采集。** 同一次采集中，带内容保护的纯绿工具栏窗口没有一个采样点出现在画面里，该位置显示的是下面的桌面。Windows 上需另行实机验证。
3. **`display_id` 在 macOS 上可靠。** `getSources` 返回的 `display_id` 与 `screen.getAllDisplays()` 的 `id` 一一对应。Windows 上若为空则不显示入口（见下文），不做按尺寸和顺序猜测匹配，避免把标注盖到错误的屏幕上。

其他修正：

- **工作量与复用方式。** 原方案要把 `composer/sketch/` 拆成共享模块并改为比例坐标，同时保证草图行为不变，风险集中在一个已上线功能上。一期改为在新领域 `domains/annotation/` 中实现标注自己的模型与画布，只沿用 Konva 写法，不改草图代码。二者的差异（透明背景、比例坐标、激光笔、荧光笔、无选择与变换）也说明合并收益不大；是否抽公共模块留到二期再看。
- **入口判定在主进程。** 选屏器知道用户确认的是哪个来源。它记录「当前共享为整屏且对应显示器 X」，渲染进程只能查询这个结果并请求打开标注，不能自己指定显示器 ID。
- **工具栏聚焦与标注窗口。** 标注窗口需要接收键盘（文字输入、`Esc`），所以在标注模式下可聚焦；操作模式下 `setIgnoreMouseEvents(true, { forward: true })` 并失焦，鼠标与键盘都回到下面的应用。
- **会议小窗。** 主讲人共享整屏后会议窗口通常会收成小窗；入口要出现在小窗上，否则共享期间找不到。

## Goals / Non-Goals

**Goals:**

- 整屏共享时一键进入标注；参会人在共享画面里 1 秒内看到标注，位置正确、线条清晰。
- 标注与操作两种模式随时切换；操作模式下下面的应用可正常使用。
- 任何退出路径都关闭标注窗口与工具栏，不残留窗口。
- 多显示器时只在被共享的那块屏幕上标注。

**Non-Goals:**

- 共享单个窗口或白板时标注。
- 参会人标注（二期）。
- 保存标注或标注截图。
- 改造输入框草图功能。

## Decisions

### 1. 入口与共享来源

- `meeting-screen-picker` 在 `choose` 成功时记录 `{ kind, displayId }`：`screen:` 来源取 `display_id`，并用 `screen.getAllDisplays()` 校验存在；`window:` 来源或找不到显示器时记为不可标注。请求被取消、会议窗口关闭时清空。
- 主窗口命令 `meetingAnnotationState()` 返回 `{ available, active }`；渲染进程在共享开始后查询一次，用于决定是否显示入口。共享停止时渲染进程调用 `meetingAnnotationClose()`，主进程同时清空来源记录。
- 入口只在 `available` 为真时显示，不显示禁用状态或提示。白板共享不经过选择器回调，自然不可标注。

### 2. 标注窗口

- 主进程 `meeting-annotation.mjs` 管理一个标注窗口和一个工具栏窗口，二者都加载 `annotation.html`（以 `?view=canvas` / `?view=toolbar` 区分），共用窄 preload `annotation-preload.cjs`。
- 标注窗口：覆盖目标显示器完整 `bounds`；`transparent`、`frame: false`、`hasShadow: false`、`skipTaskbar`、`resizable: false`、`movable: false`、`minimizable: false`、`fullscreenable: false`、`enableLargerThanScreen: true`；`setAlwaysOnTop(true, "screen-saver")`；`setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`。**不**设置内容保护。
- 工具栏：900×52 的小窗口（可容纳全部工具），默认在目标屏幕工作区顶部居中、位于菜单栏下方；层级比标注窗口高一级（`setAlwaysOnTop(true, "screen-saver", 1)`），`setContentProtection(true)`，可拖动。
- Windows 不区分置顶的相对层级，标注窗口获得焦点后会盖住工具栏。所以在 Windows 上，工具栏创建为标注窗口的从属窗口（`parent: canvas`）：Windows 始终把从属窗口放在所有者之上。标注窗口每次获得焦点、切换模式时再调用 `toolbar.moveTop()`。macOS 按层级排序，不设从属关系（从属窗口会跟随所有者移动和隐藏）。
- 两个窗口 `sandbox`、`contextIsolation`、无 Node；拒绝新窗口、跳转和所有权限请求；独立 partition `meeting-annotation`，与主应用的页面缩放和存储隔离。

### 3. 模式

- 标注模式：标注窗口 `setIgnoreMouseEvents(false)`、可聚焦并获得焦点。
- 操作模式：标注窗口 `setIgnoreMouseEvents(true, { forward: true })`、失焦、`setFocusable(false)`；已画内容保留。
- 模式由主进程持有；工具栏切换后主进程同步给两个窗口。

### 4. 退出与清理

- 退出路径：标注窗口内按 `Esc`（且没有正在编辑的文字）、工具栏「退出标注」、渲染进程在停止共享时调用关闭、会议窗口关闭、主窗口导航或渲染进程退出、目标显示器 `display-removed`。
- 关闭即销毁两个窗口，标注内容不保存。
- `display-metrics-changed` 时按新 `bounds` 重新铺满；标注坐标是比例值，位置不变。

### 5. 标注模型与画布

- `domains/annotation/annotation-model.ts`：元素坐标为 0–1 比例；画笔、荧光笔为折线；直线、箭头为两点；矩形、椭圆为两角点；文字为锚点加字号（相对屏幕高度）。撤销和重做历史上限 80。
- 荧光笔：半透明（约 35%）粗线，`multiply` 混合；激光笔：红色发光轨迹，抬笔后 1.2 秒淡出，不进撤销历史，淡出期间用 `requestAnimationFrame`，淡出完停止。
- 橡皮：按命中删除整个元素，一次手势算一步撤销。
- 画布：`react-konva` Stage 铺满窗口，透明背景，`pixelRatio = devicePixelRatio`；只在元素变化时重绘。
- 工具栏与画布之间的工具状态、撤销、重做、清空经主进程转发；画布是元素状态的唯一持有者，并把能否撤销或重做回报给工具栏。

### 6. 安全

- 主窗口命令 `meetingAnnotationOpen/Close/State` 只接受主窗口主框架的调用，且要求会议窗口存活、当前共享来源可标注。
- preload 只暴露：读取初始状态、订阅工具与模式变化、发送工具与命令、回报撤销状态、请求退出、拖动工具栏。所有 IPC 校验发送方是对应窗口。

## Risks

- Windows 上 `WDA_EXCLUDEFROMCAPTURE` 与 `display_id` 需实机验证；工具栏被拍到时接受并记录。
- `screen-saver` 层级能否盖住所有全屏应用需实机比较；盖不住时用户可以先退出全屏。
- 标注窗口铺满屏幕，鼠标移到工具栏外的空白处仍会被标注窗口截获；这是标注模式的预期行为，切到操作模式即可穿透。
