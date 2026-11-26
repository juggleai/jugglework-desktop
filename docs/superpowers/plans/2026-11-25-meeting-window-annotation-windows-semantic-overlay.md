# Windows 单窗口标注：原生语义 Overlay 重构计划

> 本计划基于 2026-11-23 至 2026-11-25 的既有报告和 OpenSpec 架构结论。它定义下一轮重构与验收，不追认旧实现通过，也不删除、覆盖或降级历史失败证据。

## 目标与边界

- Windows 单窗口标注改为一个本方原生顶层 HWND 承载全部本地语义 overlay：透明 Direct2D 绘制面、可交互工具栏和命中区域由同一 HWND 内部实现；优先使用 DirectComposition 管理视觉树、裁剪和合成。
- 保持现有窗口共享 compositor：原始窗口采集、标注模型、同一 `_screen` 发布及远端叠加链路不改架构。原生 overlay 只负责主讲人本地呈现与输入，不进入被共享窗口的原始采集帧；远端仍由现有 compositor 将同一份标注模型合成一次。
- 旧 Electron 双窗口／外部 HWND 排层候选继续默认关闭。新架构完成 PoC、产品接线、真人硬件输入和真实双端会议验收前，Windows 单窗口标注不得默认开启，也不得宣称重构已通过。
- 不修改普通窗口共享、整屏标注、白板、服务端或 macOS 路径；不以本计划勾销既有 Windows 未完成项。

## 证据等级

从弱到强使用以下等级；低等级不能替代高等级：

| 等级 | 证据 | 能证明 | 不能证明 |
| --- | --- | --- | --- |
| E0 | 设计推理、API 文档、代码审查 | 候选可实现、约束无明显矛盾 | OS 行为、像素、输入或会议可用性 |
| E1 | 单元测试、协议测试、静态检查、编译 | 状态机、序列化、失败关断和构建约束 | 真实 HWND、DWM、硬件输入或遮挡行为 |
| E2 | 隔离原生 PoC 自动观测 | 原生身份、几何、命中、DWM 裁剪及清理的窄路径 | 真人操作、外部应用兼容性或真实会议 |
| E3 | 交互桌面真人验收 | 硬件鼠标／笔、焦点、遮挡、移动和缩放的实际体验 | 远端发布连续性及签名安装包 |
| E4 | 真实 ZEGO 双端与签名包验收 | 同轨远端效果、性能、安装后行为及发布门槛 | 未覆盖环境的泛化支持 |

证据记录必须注明环境、构建、操作、预期、观察、退出与清理。API 成功、窗口可见、自动注入输入、截图或 compositor 单测均不得单独升级为 E3/E4。当前结论最高只到旧路线的 E2/E3 局部证据；推荐重构尚无 E2，且未经真人验收。

## 保留项与停止项

### 保留

- 保留窗口来源的无损字符串 HWND、PID、进程创建时间和会话代际绑定；身份不可信时只退出标注，普通窗口共享继续。
- 保留只读窗口状态观察、PMv2 物理像素、DWM 可见边界、最小化／关闭区分、尺寸变化退出、迟到消息隔离和有界清理。
- 保留标注模型、工具语义、坐标归一化、现有窗口共享 compositor、同一 `_screen` 发布、最后一帧与旧墨清理规则。
- 保留默认关闭、显式实验门控、失败撤层、非置顶、不得修改外部目标窗口的安全边界。
- 保留旧报告、旧夹具和失败结果作为回归证据；只冻结旧路线的功能演进，不改写历史。

### 停止

- 停止继续尝试 `SetWindowPos` 标志、调用线程、等待、owner、重复重排或隐藏窗口分类等旧 Electron 外部层排布变体。
- 停止把画布与工具栏作为多个跨 HWND 层组，并停止以它们和外部目标的严格直接邻接作为新架构授权条件。
- 停止把 `SendInput`、DOM click、程序激活或自有夹具成功外推为真人硬件输入和真实应用通过。
- 停止边条／热区拦截路线；系统缩放保持可用，真实宽高变化后退出标注并继续共享。

## 架构结论：严格双向 HWND 邻接的地位

旧实现要求 `GetWindow(canvas, GW_HWNDNEXT) == target` 且 `GetWindow(target, GW_HWNDPREV) == canvas`。在“独立 Electron overlay HWND 位于跨进程外部目标正上方”这一实现中，它是一个保守的、临时的充分条件：读回成立时，可以排除采样瞬间存在未知 HWND 夹层，从而避免错误遮挡和输入覆盖。

它不是规格必要条件。产品规格需要的是可观察语义：overlay 只在目标可见区域呈现、被更高普通窗口遮住、输入归属正确、不越过 topmost 边界、身份或几何不可信时 fail closed。规格并不要求本方画布必须成为目标的物理直接相邻 HWND，更不要求跨进程全局 Z-order 在所有隐藏系统窗和宿主窗存在时持续满足一个瞬时拓扑。

既有点击激活失败证据表明，即使只移动自有隐藏画布、`SetWindowPos` 返回成功且 LastError 为 0，也不能保证严格双向直接相邻；重复排序参数、调用线程和 owner 变体没有解决该可靠性限制。因此：

- 旧实现未移除前仍必须保持原严格门禁，不能忽略隐藏夹层放行。
- 新实现不得把放宽旧门禁当作重构；它必须通过不同的呈现边界直接满足语义不变量。
- 新架构的验收依据是下述身份、几何、遮挡、输入和 fail-closed 不变量，而不是复制旧 HWND 拓扑。

## 推荐架构：原生单 HWND Direct2D / DirectComposition 语义 Overlay

创建一个非 topmost、PMv2、每像素透明的本方原生顶层 HWND。该 HWND 内部以 Direct2D 绘制墨迹和工具栏，以 DirectComposition 组织视觉树、裁剪与透明合成；一个原生消息循环统一处理窗口生命周期、命中测试、指针输入、焦点策略和渲染提交。

单 HWND 消除本方 canvas／toolbar 多窗口之间的 owner、焦点和排序事务，但不声称 Windows 会自动提供正确的外部遮挡语义。PoC 必须验证：目标与 overlay 的普通层相对位置、目标激活后的恢复、外部普通窗口覆盖区域的视觉裁剪及输入命中。若单 HWND 仅靠全局矩形窗口无法在部分遮挡时同时满足绘制和输入语义，应在本方进程内依据只读窗口可见区域计算 HRGN／DirectComposition clip；计算不完整或竞争时立即隐藏／撤输入，而不是捕获桌面像素或转发输入。

原生层向主进程只交换版本化的身份、可信几何、工具命令、归一化指针事件、状态和有限诊断。渲染进程继续维护共享标注模型；同一事件驱动本地原生绘制和现有 compositor 的远端绘制。新原生层不得成为第二个媒体合成器。

## 不变量

### 身份

- 每个 overlay 会话绑定无损 HWND 字符串、PID、进程创建时间和本方会话代际；不得从标题猜测，不得经 JS `Number` 传递 HWND。
- 每次建立、恢复、改变输入区域或提交新可信几何前重新验证身份。HWND 消失、归属变化、进程信息竞争或 helper 失联均为不可信。
- `unavailable` 不等于目标关闭。只有受信进程生命周期或等价的明确关闭证据才能停止共享；其他失败只撤 overlay，保留普通共享。

### 几何

- 原生内部统一使用 PMv2 物理像素；DWM 可见边界、外框、客户区、捕获帧尺寸和显示 DPI 分字段记录，不用单一经验偏移混用。
- 仅可信的同尺寸位置变化允许移动 overlay 并保留笔迹。最小化、动画、跨屏/DPI 过渡和非原子读回期间隐藏 overlay、撤输入，等待稳定样本。
- 真实宽或高变化立即停止新输入、销毁本地可交互面、清除远端旧墨并仅退出标注；原始采集和同一 `_screen` 共享继续。重新开启从空白场景开始。
- overlay 的可绘制区域和输入区域必须来自同一版本的身份、几何与遮挡快照；版本不一致不得提交。

### 遮挡

- overlay 只能在目标当前可见区域显示；普通非置顶窗口、同应用 popup、菜单和系统 UI 位于目标之上时，对应区域不得出现本地墨迹或接收 overlay 输入。
- overlay 不得进入 topmost band，不持续抬升目标或自身，不修改目标样式、owner、位置或尺寸。
- 不通过桌面区域捕获推断遮挡。只允许使用只读 Win32/DWM 窗口元数据和区域运算；遇到枚举竞争、未知窗口、受限窗口或无法构造保守可见区域时隐藏整个 overlay 或保守扣除区域。
- 遮挡区域改变时，先撤输入，再提交新裁剪，读回／确认后才恢复输入；不得出现旧区域短暂可点击。

### 输入

- pointer 模式全部穿透给系统正常命中；pen／eraser 只在已验证的目标可见区域内由本方 HWND 接收。工具栏只命中其当前可见按钮区域。
- 使用真实 Windows 指针／鼠标消息和显式命中测试；不向目标转发、重放或合成输入，不用 `PostMessage`、`SendInput` 或跨进程钩子实现产品行为。
- overlay 不抢占目标的非必要键盘焦点。键盘快捷键没有明确、安全的焦点归属前不得作为 Windows 发布要求；Esc 等行为需另有可验证入口。
- 每个输入事件携带会话代际和几何／遮挡版本；迟到、越界、版本过期或状态切换中的事件直接丢弃，不同步到 compositor。

### Fail Closed

- 身份、几何、遮挡、输入区域或原生通信任一不可信时，顺序为：立即撤输入，停止新墨同步，隐藏／销毁 overlay，清除远端旧墨，保留普通共享并输出有限诊断。
- 不以重试维持一个可能错误的可交互层。恢复必须取得新的完整可信快照并重新执行全部门禁；预算有界，过期会话不能复活。
- 进程崩溃、父端退出、目标关闭、快速重开和卸载均须证明自有 HWND、设备资源、监听与子进程清理；不能仅以终端关闭或强杀充当通过。

## 明确不采用

- **输入转发：**不截获后把鼠标、滚轮、键盘或指针事件转发／重放给目标应用。
- **跨进程注入：**不注入 DLL、线程、窗口过程、钩子或代码到目标进程，不提升权限绕过目标边界。
- **桌面区域捕获：**不截取整桌面或目标周边像素来重建本地 overlay、遮挡或命中区域；窗口原始媒体仍由现有合法单窗共享链路取得。
- **全局 topmost：**不使用 `HWND_TOPMOST`、置顶窗口或周期性全局抬升维持显示；overlay 必须服从正常桌面遮挡。

## 分阶段 PoC

### P0：契约与空壳（E0/E1）

- 定义版本化协议、会话代际、身份／几何／遮挡快照和 fail-closed 状态机；原生进程只创建透明单 HWND，不接产品入口。
- 编译 x64 原生空壳，验证 PMv2、非 topmost、无激活显示、父端 EOF／崩溃清理和设备丢失恢复；所有错误默认不显示、不接收输入。
- 为旧 Electron 路线加冻结说明；新 PoC 使用独立开关和独立 helper 名称，不覆盖已运行过的证据二进制。

### P1：Direct2D / DComp 呈现与几何（E2）

- 在单 HWND 内绘制固定标记、墨迹和工具栏视觉；验证透明背景、DWM 边界、100%／125%／150%、负坐标、跨屏及设备重建。
- 绑定只读身份和稳定几何。移动保留墨迹；真实单轴／双轴尺寸变化撤层并发出 `resized`；最小化与不可信过渡不悬浮。
- 此阶段保持全部输入穿透，不做自动输入注入，不连接真实会议。

### P2：遮挡与命中（E2）

- 依据只读窗口元数据计算目标保守可见区域，并将同一版本同时用于 DComp clip／HRGN 与 `WM_NCHITTEST`。
- 覆盖无外部遮挡、局部／全部普通遮挡、popup／菜单、目标激活、Alt+Tab、topmost 边界、枚举竞争和受限窗口。不能确定时整层隐藏或扣除不确定区域。
- 仅使用程序化只读观测验证区域、命中和清理；不以截图内容或注入点击作为通过依据。

### P3：真人输入与产品式事件（E3）

- 在隔离夹具先由真人使用硬件鼠标和可用的笔设备验证 pointer、pen、eraser、工具栏、滚动、标题栏移动、系统边角缩放与遮挡点击归属。
- 接入现有标注模型事件但仍不接真实发布；验证归一化坐标、本地墨迹与 compositor 测试渲染一致、迟到事件丢弃、尺寸退出清旧墨和快速重开空白。
- 至少两轮连续移动、遮挡进出、焦点切换和故障关断；任何误命中、悬浮旧墨或清理不明均阻断下一阶段。

### P4：产品接线与真实会议（E3/E4）

- 仅在 Windows 显式实验开关、真实单窗发布就绪和全部原生门禁满足时启用；保持旧实现关闭，不做运行时静默回退到旧多 HWND 路线。
- 主讲人与独立接收端验证同一 `_screen`、现有 compositor 仅叠一次、源静止新增笔迹、移动、遮挡、最小化、尺寸退出、快速重开和失败撤层。
- 1080p 与近 4K 分别对普通共享基线、同轨无墨和持续有墨做至少三组对照；远端帧率须达到对应普通共享基线的 90%，且无黑帧、旧墨或重选源。

### P5：签名包与放行（E4）

- 验证计划支持架构的 helper PE、生产签名、安装路径、普通权限、路径含空格／非 ASCII、SmartScreen／安全软件结果、卸载和异常清理。
- 在代表性真实应用、支持的 DPI／多屏矩阵完成真人验收。未覆盖组合明确拒绝或保持关闭，不从单机 PoC 泛化。
- 所有发布门槛通过后另行决策是否扩大实验范围；本计划本身不授权默认开启。

## 验收矩阵

| 维度 | 最小场景 | 必须观察 | 失败结果 | 最低证据 |
| --- | --- | --- | --- | --- |
| 身份 | 同名窗、同进程多窗、关闭／重建、迟到会话 | HWND 字符串、PID、创建时间、代际一致 | 撤 overlay，普通共享继续 | E2；发布 E4 |
| 几何 | 100/125/150%、负坐标、跨屏、平移、单轴／双轴改尺寸 | 同版本物理矩形；平移保墨；改尺寸退标注 | 撤输入与旧墨，不重选源 | E2 + E3 |
| 最小化 | 最小化、同尺寸恢复、恢复时改尺寸 | 最小化不悬浮；可信恢复；改尺寸不恢复旧墨 | 保持共享、overlay 关闭 | E2 + E3 |
| 遮挡 | 普通窗局部／全部、popup、菜单、Alt+Tab、topmost 边界 | 墨迹和命中只存在于目标可见区域 | 不确定区域扣除或整层隐藏 | E2 + E3 |
| Pointer | 内容点击、滚轮、标题栏、边角缩放 | 系统自然命中，overlay 零输入 | 立即撤 overlay | E3 |
| Pen/Eraser | 目标可见区绘制、越界、跨遮挡拖动 | 仅可信可见区产生本地及模型事件 | 丢弃越界／过期事件并撤输入 | E3 |
| 工具栏 | 切换工具、焦点变化、遮挡工具栏 | 仅按钮区域命中，不破坏目标语义 | 撤输入或关闭 overlay | E3 |
| Fail closed | helper 失联、设备丢失、快照竞争、父端退出 | 先撤输入，后隐藏／清理；无旧墨和残留 | 阻断发布 | E2；发布 E4 |
| Compositor | 无墨／有墨、源静止新增墨、快速开关 | 现有同轨只叠一次，同一 `_screen` 连续 | Windows 功能保持关闭 | E1 + E4 |
| 性能 | 1080p、近 4K，各三组基线对照 | 远端帧率 ≥ 基线 90%，无黑帧／旧墨 | 不放行 | E4 |
| 发行 | x64／计划支持架构、签名安装、异常退出／卸载 | helper 正确签名、可启动且完整清理 | 不放行 | E4 |

## 当前状态

- 旧 Windows Electron overlay 实现默认关闭；其严格双向邻接门禁不得放宽。
- 已新增与产品完全隔离的 Win32/GDI 单 HWND 安全模型 PoC：`apps/desktop/native/MeetingSemanticOverlayWindows.cs`。它只用于自有 target／occluder／overlay 夹具，不接 meeting-annotation 默认路径；GDI 常量低 alpha 渲染不是 Direct2D／DirectComposition 最终实现，也不是产品视觉证据。
- 2026-11-25 本机最终二进制已增加准确 x64 `PAINTSTRUCT`/`INPUT` 布局、周期遮挡更新、提交前双快照与提交后身份/frame/DPI/Z-order/occluder 认证、style 写入读回、target destroy WinEvent 永久锁存及确定性 race 屏障。full/negative/race 需串行运行，避免自有 GUI fixture 坐标互相污染。完整命令与观察见 `docs/superpowers/reports/meeting-semantic-overlay-windows-poc-2026-11-25.md`。
- 自动点击只针对父进程创建并以 HWND/PID/进程创建时间重新认证的夹具窗口；target fixture 现允许真实 OS 激活，overlay 是 target-owned、`WS_EX_NOACTIVATE` 的 popup，并以 foreground 变化触发先撤输入再重建。该结果仍只覆盖自有 Win32 fixture，不覆盖外部真实应用，不能升级为 E3。
- topmost、layered、自定义非矩形 region、cloaked 已分别构造自动负向夹具，均证明 unknown 时先撤输入／隐藏、stroke 不增长，移除后新 epoch 才恢复。target／helper 异常退出的 HWND/PID 清理也已覆盖；每轮 18 个进程、2 个预期异常退出、0 强杀。空 region 仅覆盖纯分类，popup／菜单、系统 UI、枚举／DWM 竞争、混合 DPI、多屏、真人硬件鼠标／笔、Direct2D／DirectComposition、真实应用、ZEGO 双端和签名包仍未覆盖。
- 重构未经真人硬件输入、真实外部应用、真实 ZEGO 双端或签名安装包验收；所有阶段当前均为未完成。
- destroy/recreate 自有负测确认旧会话终止，但未强制得到同值 HWND 复用；WinEvent 异步通知尚不能证明消除所有同进程同线程复用竞态。父进程死亡与正式版本协议由下述追加工作关闭；PageHeap、Direct2D/DComp 和产品接线仍未完成。
- 2026-11-25 已推进到可由 Electron 主进程消费、但尚未接线的协议边界：`overlay` 使用 v1 JSON-lines，启动时绑定目标 HWND/PID/创建时间、父 PID/创建时间和随机 `sessionId`；命令绑定递增 `seq` 与 `expectedEpoch`，覆盖 pointer/draw、有限 stroke/clear scene、state/query 和 close。错误版本、未知字段、错误 session/epoch、旧 seq、越界或超限 scene 均拒绝且对应负测确认状态未变化；scene 本身不授权 input。旧身份输出只留在显式 `overlay-fixture`。
- helper 持有父进程 `SYNCHRONIZE` handle，父进程结束或 stdin EOF 时在消息循环小预算内先撤 input、清空 region 并隐藏，再销毁 HWND。独立 launcher 强杀验证在 2 秒预算内观察 helper 退出；正常 EOF、helper crash、协议错误、scene 上限、快速重开旧 generation 隔离均有自动测试。Node adapter 为独立 `apps/desktop/electron/meeting-semantic-overlay-windows.mjs`，固定 `.dev-helpers/semantic-overlay/MeetingSemanticOverlayWindows.exe`，不接受 renderer 指定 exe；严格解析输出白名单并有 generation、单请求超时和迟到拒绝。
- P0 整体仍未完成：本轮没有 main/meeting 接线，没有启动或重启会议。父强杀测试证明进程级清理预算，不证明同值 HWND 复用无竞态；Direct2D/DirectComposition、设备丢失、PageHeap、真实应用、真人硬件输入、混合 DPI/多屏、ZEGO 双端及签名包仍未完成。
- 2026-11-25 已新增独立 `meeting-semantic-annotation-session.ts` 模型桥接，但仍未接 `main` 或会议入口：原生 overlay 只在可信 draw region 捕获归一化 `down|move|up|cancel` 批次并即时绘制临时线；JS 以现有 `AnnotationHistory`/`AnnotationElement` 为 scene/history 唯一权威，draft 同步给现有 compositor scene，已提交 history 以受限全量 scene 回写 native。当前明确只支持 pen/highlighter、undo/clear；pointer 为模式，eraser/laser/shape 明确返回 unsupported，不伪装成功。
- 输入批次绑定 session/epoch/单调 inputSeq，单批最多 64 点、单笔最多 256 点；scene 最多 128 笔/4096 点。native 在模式、epoch、遮挡 unknown、capture 丢失、隐藏或关闭前先发 cancel（存在 active stroke 时）并撤输入；unknown 期间没有新点。Node adapter 仅接受白名单 pointer 输出，重复、迟到、跨会话、越界或超限输出 fail closed。
- 新增桥接单测覆盖 down/move/up/cancel、epoch 变化、重复/迟到序号、遮挡空窗、scene/批次限制、undo/clear、归一化坐标与尺寸、工具禁用和快速会话重开；真实 protocol helper 通过仅限自有 fixture 且重新认证 HWND/PID/创建时间的 `SendInput` 自动绘制验证。app/electron typecheck、adapter、protocol/full/negative/race、diffcheck 与 OpenSpec strict 的本轮结果记录在同日报告；这仍只是 E1/E2 窄证据，不是 E3 真人输入或产品接线完成。
- 2026-11-25 补齐两项隔离协议证据：真实 helper stdout 暂停消费后，以固定批数、逐次身份认证的自有 overlay OS 输入填满 256 队列，确认 cancel、撤 input/隐藏、target 命中和 EOF 140ms 退出；背压 unknown 现锁存到新的 epoch-bound mode 命令，不能被周期 refresh 自动解除。独立 adapter 使用固定 helper 路径，自有 topmost occluder 验证 unsolicited unknown epoch 3 与恢复 epoch 4，恢复后 query 不会永久 wrong-epoch。两项均未接 `main`/meeting，不替代 P1-P5 门禁。
- 2026-11-25 实际编译运行 Direct2D premultiplied layered 与 Direct2D/DirectComposition 单 HWND 候选后确认架构阻断：layered 的 alpha=0 空白像素无法在 draw 模式命中；DComp 透明 visual 的 HWND 在 pointer 模式会吞跨进程真实点击；同 HWND 动态切换 layered/NOREDIRECTIONBITMAP 不可靠。未用 alpha=1、整窗常量 alpha 或 GDI 冒充透明完成，实验代码已撤回并重新通过原 full 回归。像素 fixture、设备丢失和资源长循环因核心输入不变量未成立而未验收；下一步须先决策是否允许双 HWND、动态交互 HRGN 或其他原生宿主架构。
- 2026-11-25 已批准并在同一隔离 helper 内实现双 HWND PoC：visual HWND 永久 `WS_EX_LAYERED|WS_EX_TRANSPARENT|WS_EX_NOACTIVATE`，由 Direct2D DC render target 绘制 premultiplied BGRA DIB 并用 `UpdateLayeredWindow` 提交；input HWND 为 `WS_EX_NOREDIRECTIONBITMAP|WS_EX_NOACTIVATE` 的非 layered、无绘制窗口，只在 draw 模式以同版可信 HRGN 显示和命中，pointer 模式先空 region 再隐藏。两层、target 与普通 occluder 的身份／几何／Z 序、region 和 epoch 作为单次事务，任一步失败先撤 input 再隐藏 visual，不恢复旧 scene 可交互状态。产品 v1 协议和 adapter 输出未暴露 raw HWND，只有 fixture 可读回两层角色。
- 本机自有 fixture 已取得实际桌面像素与 OS 输入证据：透明点 target RGB `32,80,160` 前后不变；pen 中心为 `255,0,0`；35% 黄色 highlighter 合成后为 `110,141,104`；clear 恢复 `32,80,160`。draw 空白点命中 input，pointer 同点命中 target，遮挡点命中 occluder。fixture-only 设备丢失使两层撤销，重建成功后 epoch `4→5`；300 次 scene 交替前后 helper GDI `8→8`、USER `5→5`。这些只关闭双层技术 PoC 的本机自有样例，不覆盖混合 DPI、多屏、真人硬件输入、外部应用、PageHeap、签名包或真实会议，因此下一阶段仅可进入 DPI 隔离验证，不可接 main/meeting。
- 2026-11-25 DPI 隔离验证环境只有一块 `(0,0)-(1920,1200)`、scaleFactor `1` 的 DPI96 显示器，未修改系统缩放。实际 HWND 读回确认 PMv2 target、visual HWND、input HWND 的物理 DWM frame 均为 `(87,80,626,413)`；同 DPI 平移到 `(127,110,626,413)` 后旧状态先撤，最终以新 epoch active。另以 `SetThreadDpiAwarenessContext` 创建 system-aware/unaware 自有 target，对照确认 PMv2 helper 仍读到有效 DWM frame 和 DPI96；这不是 125%/150% 真实缩放证据。单屏无法把负坐标作为可见窗口验收，多屏逐屏、负坐标、跨屏和混合 DPI 均保持未完成；负坐标、大坐标、溢出、防零尺寸、局部 region 转换和归一化边界只由纯函数模型覆盖。
- helper 已显式处理 `WM_DPICHANGED`：先撤 input/清 region/隐藏两层，再按系统建议 rect 放置收到消息的 HWND；后续可信 target frame/DPI 读回重建 surface，并只在事务提交后进入新 epoch。由于本机只有 DPI96，真实消息序列、双 HWND 收敛以及捕获帧映射仍未得到 OS 证据，产品接线后还必须联合采集链路确认。
- 2026-11-25 已完成未打包开发接线的严格子集，不改变默认关闭结论。`main.mjs` 在 Windows x64 且 `JUGGLEWORK_SEMANTIC_OVERLAY_POC=1` 时优先选择 semantic backend；即使旧开关同时开启也不进入 legacy 单窗 canvas。helper/identity 缺失、单屏/DPI96/发布就绪/像素映射任一门禁失败时只返回 `available:false`，普通共享继续。
- semantic 单窗只创建独立 content-protected toolbar，不创建 Electron canvas，也不设置 canvas parent。工具栏能力固定为 pointer、pen、highlighter、undo、clear、exit；renderer 不提供 exe、HWND 或 PID。picker/main 继续建立可信 target，main 自身创建时间由 identity helper 的 `GetProcessTimes` 提供。
- renderer 继续拥有 scene/history；typed IPC 以 `captureId`、`annotationId`、`nativeSessionId`、`generation`、`seq` 隔离。main 校验完整 scene 与捕获像素尺寸后写 native，并复用现有 compositor scene 事件；没有新增 RTC、`getDisplayMedia`、ZEGO publish 或第二合成器。target close 走现有 receiver 停止共享，resize/helper 失联只退出标注并清 scene，minimize/unknown 撤交互和远端显示，restore 依赖 native 新 epoch。
- 自动接线证据包括 backend 优先级与 unavailable 不回退、toolbar-only/content protection、sender/main-frame 校验、旧 generation 拒绝、可信像素映射、resize/unknown/minimize/helper exit、closed 事件清理，以及媒体运行时原调用次数回归。E3/E4 仍全部未满足：未启动应用，未做真人硬件输入、代表性外部应用、混合 DPI/多屏、真实 ZEGO 双端、PageHeap、签名安装包或安全软件验收。
- 2026-11-25 新增隔离跨进程开发接线 smoke：真实固定 helper、自有 target/occluder、真实 OS `SendInput`、真实 router/main controller、fake toolbar BrowserWindow、受信 renderer DOM 事件、真实 semantic session 与 compositor receiver 串联。单轮矩阵覆盖 flag-only identity target、单屏 DPI96 gate、toolbar-only、helper hello、draw scene、pointer 穿透、unknown/恢复、minimize/restore、resize、target close、helper crash、manual close和快速重开隔离；媒体哨兵保持一次 start/publish。该证据仍是自有窗口 E2，不是 E3/E4。
- smoke 发现并修复两项接线缺陷：semantic native 与 compositor 原先共用 DOM channel 且各自独立 `seq`，可能互相压掉 scene/closed；现使用专用 semantic channel。helper 对最小化恢复动画的首个瞬态 DWM 尺寸曾误锁永久 `resized`；现保持撤输入/隐藏并要求连续三次稳定新尺寸才确认 resize。原生 full 与 DPI 验证重新通过。
- 2026-11-26 接线审查收口将目标 DPI96 改为原生全会话硬门禁：启动读回非 96 在创建双层和 `hello` 前拒绝；运行轮询或任一 overlay `WM_DPICHANGED` 先 cancel、撤 input、清 region、隐藏，再以 `unsupported-dpi` 终态退出，禁止重建 surface 后恢复。当前机器实际仍为 DPI96；120 DPI 只由显式 fixture 环境变量模拟状态机，不能记作真实 125%/150% 证据。
- renderer 到 main 的 scene/history 改为单一 `apply-scene(sceneRevision)` 事务。renderer 每会话单 in-flight、合并最新 committed scene；draft 只保留本地原生临时线，不旁路发布 compositor。main 严格校验 key、schema 和递增 revision，串行等待 native `setScene` ACK 后才以同 revision 发布 compositor scene 和 toolbar history；失败由 main 统一关闭。旧/重复 revision、旧会话迟到 ACK、toolbar close/crash/navigation、main renderer gone 均不能发布或影响新会话。
- adapter replacement 先有界等待旧 child EOF，超时 kill 并公开 `{exited,killed,timedOut}`；dispose 主动 drain stdout，覆盖 helper hung/stdout 背压。readiness watcher 在任何 teardown/share stop 入口立即停止。两轮 wiring smoke 均 16 个进程自然退出、0 强杀，并保留独立 semantic DOM channel 与 minimize/resize stabilization 回归。
- 2026-11-26 semantic shape 增量已实现 rectangle/ellipse/arrow 全链路。共享类型、main↔native JSON-lines 与 C# retained scene 均改为带唯一 ID 的 stroke/shape union，并在 renderer/main/adapter/native 四层校验 exact keys、颜色、尺寸、归一化坐标、元素/点数/总复杂度/64 KiB 和重复 ID。native mode 携带 tool kind；shape draft 只保留 down 起点与最新点，up 仍由 JS 复用 `createDrawElement`/`updateDrawElement`/`isMeaningful`/history 权威提交，native ACK 后 compositor 以同 revision 发布且不新增媒体。
- Direct2D retained/draft shape 使用 rectangle/ellipse primitive；arrow 头尺寸与 compositor 的 `max(12, strokeWidth*3.5)` 一致。真实 dual fixture 已确认矩形四边、椭圆四极点、箭头轴线/头部、clear/authoritative replacement、occluder 洞、device loss retained 重绘，以及 300 次四类混合 scene 后 GDI `8→8`、USER `5→5`。semantic toolbar 恢复三个 shape 按钮并按实际 6 工具内容计算宽度，legacy toolbar 未改。上述仍为自有 fixture 自动证据，不替代真人硬件、外部应用、混合 DPI、多屏或真实 ZEGO 双端。
