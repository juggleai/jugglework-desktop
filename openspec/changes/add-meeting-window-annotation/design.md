# Design

## Context

- 一期（`add-meeting-screen-annotation`）：整屏共享时，透明标注窗口铺满屏幕，被系统整屏采集一起拍进视频。工具栏与飞书一致，设置内容保护不被采集。
- 窗口共享时，系统只采集那个窗口，盖在上面的标注窗口拍不进去，所以推出去的标注要在主讲人这端合成进视频。
- 白板已经用 canvas 的 `captureStream` 经 `startCustomShare` 推流（`domains/meeting/whiteboard/canvas-mirror.ts`），合成推流可以沿用这条链路。
- Electron 拿不到其他应用窗口的位置、层级和尺寸，需要原生辅助程序。仓库已有 `apps/desktop/native/FileWindowDock.swift` 的打包方式（`scripts/prepare-file-window-helper.mjs`）可参考。

## Goals

- 共享单个窗口时，主讲人在真实窗口上标注，参会人看到的位置和主讲人一致。
- macOS 和 Windows 不额外拦截缩放。窗口平移保留笔迹；实际宽度或高度改变时清除笔迹、退出标注但继续共享同一个窗口。
- 打开和关闭标注时，参会人看到的画面不黑屏，帧率不低于基线的 90%。

## Non-Goals

- 参会人标注（二期 B）。
- Linux。
- 系统级尺寸锁定、强制复位窗口尺寸、窗口改变尺寸后保留旧笔迹。

## Decisions

### 1. 两处渲染，同一份数据

- 标注窗口（主讲人看到并输入）和会议窗口里的合成器（推出去的画面）都渲染同一份标注模型，用同一套绘制代码。
- 标注模型以标注窗口为准，经主进程增量同步给合成器。合成器只读，不接收输入。

### 2. 原生辅助程序

- 通过标准输入输出与主进程交换 JSON 行，主进程按需启动，标注结束后退出。
- 能力：按窗口 ID 和进程身份跟踪窗口 bounds、是否在屏、是否最小化和层级；原生侧只观察，不改目标窗口的尺寸。
- macOS：用 `CGWindowListCopyWindowInfo` 读取目标位置和层级，使用 `AXUIElement` 观察窗口变化的路径需要「辅助功能」权限。画布按目标相对排序，不全局置顶。
- Windows：默认只读采样；仅在跟随延迟不达标时考虑用 WinEvent 触发复核。不回写目标位置或尺寸。

#### Windows 实验版（已确认范围）

周期只读检查若精确报告目标仍在画布下方、直接下邻为其他进程隐藏窗，允许每会话一次撤层恢复，包括绘制模式；不授权跳过夹层。双层与输入暂停，等待可信样本后走完整原生放置及最终复核；超时、恢复失败或再次失序退出标注。此候选仍需真人验证。

Windows 单窗口采用“鼠标绘制不激活画布”候选：仅 `platform === 'win32'` 且会话有 `target` 时，画布从构造起始终 `focusable:false`，包括 pen、eraser 等绘图工具，不因模式切换调用 focus/blur 或切换焦点属性。工具栏从构造起保持 `focusable:true`；不可聚焦工具栏在真人试用中未能正常切换画笔，已撤回。鼠标路由仍按模式：pointer 为 ignore true，绘图为 ignore false；完整隐藏定位、可见定位和包含已显示工具栏的最终严格只读复核成功前，两层均禁用鼠标输入。严格双向邻接、非置顶、精确矩形和既有失败撤层/恢复预算保持不变。整屏和 macOS 行为不变。

2026-11-25 独立隔离实验已用 Windows `SendInput` 在不可聚焦画布绘制，观测到工具栏保持前台且生产严格邻接通过，详见 `docs/superpowers/reports/meeting-nonfocusable-os-input-2026-11-25.md`。控制器回归验证 pen/eraser 的 ignore false 与 focusable false、pointer 的 ignore true，以及复核完成前持续禁用输入。隔离 OS 注入不是真人硬件输入或真实会议验收；此候选尚未经真人验收，不能据此认定焦点后的隐藏夹层故障根因已确定或已修复。键盘快捷键（包括画布 Esc）、普通遮挡、多屏/DPI 和真实会议输入仍需验证。

Windows 开发版单窗共享在当前捕获真实发布就绪后，仅一次尝试激活目标。原生程序重新校验 HWND、PID、创建时间与窗口状态，调用 `SetForegroundWindow`；不置顶、不持续抬升，失败仍保留共享。

本轮先接入未打包的 Windows x64 开发版试用，不等待完整夹具矩阵；打包版即使显式设置开关也不开放。开发启动器仅在显式开启时编译标准 helper 到独立的 `.dev-helpers/window-annotation`，不用诊断变体。主进程把身份解析、观察与画布定位接到既有的选窗、发布就绪和标注流程，不为开发模式放宽层级复核。真实双端与安装包验收仍是发布前置条件。

- 保留普通窗口共享、整屏标注和服务端行为。仅在 Windows 显式开启 `JUGGLEWORK_WINDOW_ANNOTATION=1`、来源身份可验证且标注层能可靠跟随并尊重遮挡时提供单窗口标注。复用工具栏、笔迹模型和现有同轨合成；不把 ZEGO 换轨作为前置条件。
- 先在用户的 Windows 测试机验证只读 Win32 helper：对照 Electron 选中来源与 HWND，以字符串传输句柄；同时校验 PID 和进程身份，并验证销毁与句柄复用。身份不明或跟踪失效只撤标注，确认目标关闭才停止共享。默认先采样；跟随延迟不达标时再以进程外 WinEvent 通知触发复核。
- 分开测量真实尺寸、原生边框、DWM 可见边界、Electron DIP 和采集帧像素。混合 DPI、负坐标和跨屏移动需实测；只有实际宽高变化才清笔迹并退出标注，不重新选源。
- 仅验证画布相对层级与正常工具输入，不引入原生边条或逐点边框命中。遮挡窗口应正常收到点击；鼠标模式保留点击、滚动、标题栏拖动和系统缩放。无法安全维持相对层级时撤标注，保留共享。
- 先验证手头机器上的窗口样式，再扩展兼容矩阵。真实双端会议必须证明同一 `_screen` 保持发布、开关与尺寸退出无黑帧或旧笔迹、远端帧率达到普通共享基线的 90%；Windows 打包验证独立检查助手的 PE 架构和签名。两类验收完成前保持默认关闭。

#### Windows 原生语义 Overlay 重构决策（2026-11-25）

既有 Windows Electron 外部层候选继续默认关闭。它的严格双向 HWND 直接邻接是该实现排除未知夹层、授权输入的保守临时充分条件，不是规格必要条件；旧实现仍在时不得放宽此门禁。规格真正要求的是身份可信、几何同版本、只在目标可见区域呈现和命中、服从普通窗口遮挡、非置顶，以及任一条件不可信时 fail closed。点击激活现场已证明跨进程全局 Z-order 不能稳定提供严格邻接，因此停止继续尝试排序标志、调用线程、等待、owner 和重复重排变体。

单 HWND 技术探针已证明 layered 透明像素与 draw 空白起笔冲突，DComp 透明 HWND 又无法可靠跨进程 pointer 穿透，因此隔离 PoC 改为两个本方原生顶层 HWND。visual 永久为 Direct2D premultiplied layered、`TRANSPARENT|NOACTIVATE` 且不承担输入；input 为无绘制、非 layered、`NOREDIRECTIONBITMAP|NOACTIVATE` 空窗，只在 draw 模式以可信 region 显示，pointer 模式先置空 region 再隐藏，不依赖跨进程 `HTTRANSPARENT`。同一消息循环仍须把身份、几何、遮挡、两层 Z 序、region、像素提交和 epoch 作为一个事务；任一读写或复核失败先撤 input，再隐藏 visual，禁止恢复到旧 scene 的可交互状态。adapter 和产品协议只观察语义状态，不感知两个 HWND，raw HWND 仅限 fixture 诊断。

双 HWND 不等于自动满足遮挡；实现必须依据只读 Win32/DWM 窗口元数据构造保守可见区域，并把同一版本的区域用于 visual 裁剪和 input 命中。身份、几何、遮挡或通信竞争时，先撤输入，再隐藏／销毁 overlay、清除远端旧墨并保留普通共享；不得用放宽旧邻接检查替代该语义边界。本机自有 fixture 的实际像素、OS 命中、设备恢复和资源循环已通过，下一步只授权 DPI/多屏隔离验证；真人硬件输入、外部应用、PageHeap、签名包与真实会议完成前不接产品入口。

保留无损 HWND/PID/进程创建时间绑定、PMv2/DWM 几何、尺寸变化仅退标注、迟到会话隔离、非置顶和有界清理。保持现有窗口共享 compositor、标注模型、同一 `_screen` 发布和远端同轨合成；原生 overlay 只负责本地呈现与输入，不成为第二个媒体合成器。明确不采用输入转发／重放、跨进程注入或钩子、桌面区域捕获、全局 topmost，也不恢复边条／热区拦截。

详细证据等级、分阶段 PoC、不变量和验收矩阵见 `docs/superpowers/plans/2026-11-25-meeting-window-annotation-windows-semantic-overlay.md`。当前已有与产品隔离的 GDI 安全模型 PoC 及 v1 JSON-lines/父进程生命周期/Node adapter 窄路径证据，但尚未接 `main` 或 meeting，也没有 Direct2D/DirectComposition、真人硬件输入、真实外部应用、ZEGO 双端或签名包验收；完成这些门槛前 Windows 单窗口标注保持默认关闭，既有历史证据和未完成项继续有效。

原生输入桥接采用 JS 单一数据权威：原生层只在可信可见区域捕获带 session/epoch/inputSeq 的归一化 pointer 批次，并可即时画当前临时线；渲染侧独立会话复用现有 annotation model 纯函数维护 history、draft 和 `AnnotationElement`，同一 `WindowAnnotationScene` 供现有 compositor，已提交 history 再以有限全量 scene 回写 native。本阶段只开放 pen/highlighter、pointer、undo/clear，未实现的 eraser/laser/shape 明确禁用。该桥接保持独立、未接 main/meeting，Electron Canvas 路径不变。

2026-11-25 B1-B7 审查修复后，产品式 protocol helper 不再有 45 秒总寿命；45 秒只保留在 fixture，并允许 fixture 测试显式缩短。native 自主 epoch/state 变化通过白名单 `state(eventSeq)` 发送，adapter 同步 epoch 并通知 `onState`；`wrong-epoch` 同样安全前移 epoch 并显式返回可重试结果。protocol stdout 仅允许 `hello/ack/state/error/pointer`，race/refused 诊断仅在 fixture stdout 或 protocol stderr。stdin 使用 64 KiB 有界 UTF-8 行读取，stdout 由有界线程安全队列和专用 writer 输出，WndProc 不同步 flush；move 最多 64 点一批，背压撤输入并 cancel，up/cancel 使用预留优先容量且不删除已编号事件。

JS 会话仅在 committed history 改变时串行回写 native scene，draft move 只调用 compositor 的 `onScene`；mode/style、abort、scene 共用可观察失败的写队列。提交前校验完整 scene 结构和最坏协议 envelope 的 UTF-8 字节预算，native 与 adapter 均按 64 KiB 拒绝且不修改 scene。`inputSeq` 必须连续，gap 会 cancel；up 端点去重，零距离 click 不提交。clear/undo/tool switch/dispose 会向 native abort active stroke，draw mode 携带 color/size/highlight，输入/state/scene observer 异常均隔离。以上仍是隔离 GDI PoC 与 adapter/session 证据，不表示 Direct2D/DComp、产品接线或真人/会议验收完成。

### 3. 合成推流

- canvas 尺寸跟随窗口采集轨道的实际宽高；每帧绘制窗口画面，再叠加标注。
- 帧率以原始窗口共享为基线；候选 `requestVideoFrameCallback`，或 `MediaStreamTrackProcessor` + `MediaStreamTrackGenerator`，按 P0 实测选择。
- 打开标注时用 ZEGO `replaceTrack` 切到合成轨道，关闭后切回原始轨道；切换效果不可接受时改为窗口共享始终走合成。
- 系统不送新帧时保留最后一帧，不推黑屏。

### 4. 坐标

- 标注坐标是窗口采集画面的 0–1 比例。标注窗口要和采集画面覆盖的区域完全重合；采集画面是否包含标题栏、阴影、圆角留白，由 P0 实测确定偏移。

### 5. 双平台统一的窗口尺寸变化规则

- 移除 macOS 已有的四个边框输入窗；Windows 不实现边框输入窗。「鼠标」模式画布穿透；绘图模式维持原有画布输入。保留对画布相对 Z 序和遮挡安全的检查。
- 开启标注时记录有效的目标窗口实际宽高。仅位置变化时更新画布位置；只有采集像素尺寸或显示缩放比例变化、系统窗口实际宽高不变时，重新计算画布映射，不误退。最小化或目标暂不可见时隐藏画布与工具栏，不把缺失或零尺寸当作改尺寸；恢复后先校验有效宽高。同一窗口恢复但尺寸已变时，按尺寸变化退出标注后恢复共享。窗口关闭仍按停止共享的独立路径处理。
- 检测到有效宽高变化时，停止接受新笔迹，释放画布和工具栏，通知共享渲染端清旧场景并停止叠加。共享渲染端保持同一来源、原始采集和 `_screen` 发布，不停止共享、不重选来源。重新开启标注时以新尺寸开始空白标注。
- 退出及清理按当前共享与标注会话绑定，防止上一会话的迟到事件关闭下一会话。跟踪或画布层级无法可靠建立时，不打开标注，窗口共享继续。

## P0 验证

| # | 项 | 不通过时 |
|---|---|---|
| P0-1 | `window:` 来源 ID 能对应到系统窗口（macOS CGWindowID / Windows HWND） | 窗口共享不显示标注入口 |
| P0-2 | 窗口采集画面和窗口 bounds 的对应关系（标题栏、阴影、Retina） | 按实测偏移校准 |
| P0-3 | 鼠标模式可正常缩放；平移保留标注；实际宽高变化时清笔迹、退出标注并继续同源共享 | 跟踪不可靠时不启用窗口标注，不影响普通共享 |
| P0-4 | 标注层排在被共享窗口正上方（不全局置顶），被其他窗口挡住时跟着被挡住 | 被共享窗口不在最前时隐藏本地标注层 |
| P0-5 | `replaceTrack` 中途切换无黑屏、无明显卡顿 | 窗口共享始终走合成 |
| P0-6 | 合成帧率和 CPU 占用（1080p、4K 窗口） | 降低合成分辨率或帧率 |

### macOS 首轮实测（26.2 / Electron 44.0.0）

- **P0-1，样例通过。** 独立 AppKit 测试窗口的 Electron `window:<id>:0` 与 `CGWindowListCopyWindowInfo` 中同一进程的 `CGWindowID` 一致。刚显示的窗口可能还没入列或 bounds 正在变化；实现时在确认共享和开启标注时重新校验 ID 与 PID，并等待有效、稳定的尺寸，不按名称猜测。
- **P0-2，Retina 样例通过。** 外接 2× 屏上的有标题栏窗口稳定 bounds 为 540×362 pt，`getDisplayMedia` 产出 1080×724 px，`displaySurface` 为 `window`。32 pt 标题栏占前 64 px，画面尺寸没有额外的外部阴影边距。坐标以捕获区域为准，不按内容区起点对齐；仍需覆盖其他应用样式和跨屏移动。近 4K 测试中首帧为 3836×2156，后续稳定到 3840×2160，合成器不能只读一次视频尺寸。
- **P0-4，静态部分遮挡通过。** 同一普通窗口层级下，`BrowserWindow.moveAbove(source.id)` 将前到后的顺序从「标注层、遮挡窗口、目标窗口」修正为「遮挡窗口、标注层、目标窗口」。整屏缩略图采样确认遮挡区域里只有遮挡窗口；单窗口视频在同一点仍然只有原窗口内容，不含遮挡窗口或标注层。macOS 优先用 Electron 接口做相对排序，原生程序用于读取目标窗口状态。持续移动、切换焦点、跨桌面空间及最小化/恢复尚未验收。
- **P0-6，本机链路通过。** 真实采集持续变化的 AppKit 测试窗口，目标 30fps；以不合成为基线，两种模式各测两次，每次预热 1.5 秒、计量约 5 秒。合成原型用 `requestVideoFrameCallback`、Canvas 2D 和 `captureStream(0)` / `requestFrame()`，叠加一个矩形：

  | 窗口规格 | 不合成（fps） | 合成（fps） | Electron 进程 CPU 指标中位数（不合成 → 合成） |
  |---|---:|---:|---:|
  | 1080p | 29.35–29.44 | 29.35–29.39 | 0.8% → 1.4% |
  | 4K（合成用首帧 3836×2156） | 29.21–29.31 | 29.22–29.30 | 0.8% → 1.4% |

  CPU 为 Electron `app.getAppMetrics()` 各进程 `percentCPUUsage` 之和，不是整机负载；不含 ZEGO 编码、网络和参会人端播放，不能替代会议验收。短测支持先选 Canvas 2D；正式合成器还要在输入静止但有新笔迹时请求一帧，不能只等视频帧回调。

### macOS 第二轮实测：尺寸与换轨

- **P0-3，事后复位方案淘汰。** 本机独立测试程序的 `AXIsProcessTrusted()` 为 `true`（不代表打包版已授权）。对另一进程的 AppKit 窗口，`AXSize` 可写：监听 `kAXResizedNotification` 时请求从 540×362 改为 640×432 pt，写入成功、立即读回为新尺寸；通知回调随后看到新尺寸并恢复到 540×362 pt。移除监听后可以正常改尺寸。该测试说明能观察到尺寸变化，不能阻止变化；实现只消费观察结果，不写回旧尺寸。
- **P0-5，本地对照通过，ZEGO 仍待测。** 两个本地 `RTCPeerConnection`，720p / 30fps 的两条测试轨道，在同一 sender 上做原轨 → 合成示意轨 → 原轨。接收端采样 179 帧，0 黑帧、接收轨道未重建，两次首个新画面分别约 27 / 24ms，切换附近最大采样间隔 75 / 50ms。此实验不经过 ZEGO SDK、服务端或会议网络，不能勾选真实换轨验收。
- **ZEGO 3.12.0 接入核对。** `engine.replaceTrack(stream, track)` 的 `stream` 必须是 `createStream` 返回的同一 SDK 流对象（`this.share`），`track` 为同 renderer 中已出帧的 `MediaStreamTrack`。校验非零返回码和 Promise 拒绝，不能假定失败自动回滚；原始采集、合成输出和发布轨分别管理生命周期。真实 P0 应等同一 `_screen` 进入 `PUBLISHING`、接收端有稳定首帧，再在不停推、不重拉的情况下验证两次切换。SDK 返回成功不等同于接收端已换画面。
- **当时尚未验证：** 目标实际改尺寸时的产品退出、真实 ZEGO 连续性及 Windows P0；后续状态见 `tasks.md`。

### 历史记录：macOS 窗口边框拦截原型（不再是产品要求）

- 在另一进程的可缩放 AppKit 窗口上，用系统鼠标事件从右边框内侧 2 pt 向右拖 70 pt。基线窗口宽度从 540 增至 610 pt，悬停光标与内容区的普通箭头不同。
- 把一条 18 pt 宽的近透明、无边框、不可缩放、不可聚焦 Electron 窗口放在目标右边框上方（相对排序，不全局置顶）。同样拖拽时，边框光标与内容区普通箭头一致，目标窗口 bounds 完全不变，宽度仍为 610 pt。移除拦截条后，同样拖拽又能把窗口增宽到 680 pt。是否拦截以窗口尺寸为准，不只看光标，也不依赖网页层收到 `pointerdown`。
- **四边四角对照（单屏 AppKit 样例，Electron 44.0.0）：** 四条近透明窗口覆盖边界内外各 9 pt。四边和四角各在距边界内侧 2 pt 处测试：无遮罩的 8 次拖动均让对应尺寸增加 24 pt；加遮罩后 8 处的窗口位置和尺寸均不变，采样光标均与内容区的普通箭头一致。移除遮罩后，右边框再次可拉宽 24 pt。未扫描完整热区，不能据此确定 18 pt 是合适的产品拦截宽度。
- **「鼠标」模式原型：** 无全窗口输入层时，内容区点击到达目标，标题栏拖动使窗口移动 `(64, 50) pt`，尺寸不变；测试脚本在移动结束后重新对齐边框层，右边框再次拦住拖拽。另一窗口覆盖右边框时，系统窗口列表确认「遮挡窗口 → 边框层 → 目标窗口」的相对顺序。连续跟随、滚动、不同窗口样式、遮挡时的实际输入与跨屏仍待验证。
- **反例：** 边框层处于启用状态时，目标应用从内容区点击处理程序调用 `NSWindow.setFrame`，窗口宽度仍增加 45 pt。边框层不是系统级尺寸锁定；因此已确认按「拦截边框拖拽，其他途径改变实际尺寸时退出标注、共享继续」实施。双击标题栏、窗口菜单和系统平铺等入口尚未实机验证，P0-3 产品验收仍不勾选。

## Risks

## Windows Semantic 开发接线状态（2026-11-25）

- 双 HWND Direct2D helper、v1 JSON-lines adapter、toolbar-only main controller、typed IPC、renderer scene/history owner 和现有 compositor 已接入未打包开发路径。该路径仅在 `JUGGLEWORK_SEMANTIC_OVERLAY_POC=1`、Windows x64、单屏 DPI96、固定 helper 与 identity 可用、真实单窗发布就绪且捕获像素尺寸等于可信原生 `actualSize` 时可用。
- semantic 被选择但任一条件失败时保持 `selected:true, available:false`，不静默回退旧 Electron 多 HWND 路线。Windows semantic 单窗口只创建 content-protected toolbar，不创建 Electron canvas；整屏、macOS 和未选择 semantic 的路径仍使用 legacy controller。
- picker/main 继续认证 target；main 自身创建时间由 identity helper 的 `GetProcessTimes` 获取。renderer 不提供 executable、HWND 或 PID。IPC 以 `captureId`、`annotationId`、`nativeSessionId`、`generation`、`seq` 隔离，main 校验 scene 后分别写 native 并复用既有 compositor scene 事件。
- 当前开放 pointer、laser、pen、highlighter、rectangle、ellipse、arrow、eraser、undo、clear、exit；shape/eraser 复用现有 annotation model/history/compositor。laser 使用独立于 committed scene/history/sceneRevision 的 epoch 绑定、单调 revision、有界全量 transient 列表；down/move 可见，up 后 1200ms 线性淡出，clear/tool switch/cancel/input gap/epoch/unknown/close 立即清空。native retained laser 不进入 scene ACK/history，恢复和迟到写不能复活旧 laser。legacy UI 不变，未新增 RTC、`getDisplayMedia`、ZEGO publish 或第二媒体合成器。
- 目标 DPI96 是 native 全会话硬门禁，不只是 Electron display 预检：启动读回非 96 必须在双层和 hello 前拒绝；运行中目标 DPI 非 96 或 overlay 收到 `WM_DPICHANGED`，必须先 cancel/撤 input/清 region/隐藏并终态退出，不得重建恢复。fixture 可模拟非 96 拒绝和运行变化，但当前 DPI96 主机不得把模拟记作真实 125%/150% 证据。
- scene/history 使用 renderer 到 main 的单一 `apply-scene(sceneRevision)`。renderer 同会话保持一个 in-flight 并合并最新 committed scene；main 校验会话 key、exact schema 和严格递增 revision，串行等待 native ACK 后才向 compositor 与 toolbar 发布同 revision。native 失败、toolbar/main renderer 生命周期结束均由 main teardown；旧/重复 revision 和迟到 ACK 不发布。draft 仅作本地原生实时线，不改变 committed scene 一致性。
- adapter close/dispose/replacement 必须先有界等待 child，超时 kill 并返回明确结果；teardown/share stop 立即停止 readiness watcher。toolbar closed/render-process-gone/navigation 与 main renderer destroyed/render-process-gone/navigation 都关闭当前 owned session，旧 toolbar 事件不能命中新 session。
- 自动接线不等于 P4/P5 放行。真人硬件输入、代表性外部应用、125%/150% 与混合 DPI/多屏、PageHeap/同值 HWND 复用、真实 ZEGO 双端、签名安装包与安全软件验收仍未完成，开关继续默认关闭。

- macOS「辅助功能」权限：首次使用多一步授权；开发版授权对象是 Electron，打包版是 JuggleWork。
- 应用窗口的层级行为可能不同：不能可靠跟踪或安全展示画布的来源不启用窗口标注，普通窗口共享不受影响。
- 原生辅助程序的签名、公证和 Windows 杀毒误报。
- 合成推流增加 CPU 开销。
