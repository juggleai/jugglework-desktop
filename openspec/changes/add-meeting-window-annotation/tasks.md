# Tasks

## 0. P0 验证与上线门槛

- [x] 0.1 P0-1：独立 AppKit 窗口的 `window:` 来源 ID 对应系统窗口（macOS）
- [x] 0.2 P0-2：Retina 有标题栏样例的采集画面和窗口 bounds 对齐（macOS）；其他窗口样式留实机验收
- [ ] 0.3 P0-3：macOS / Windows 均保留系统缩放，平移保留笔迹，实际宽高变化时清除笔迹并仅退出标注
  - [x] 验证独立 AppKit 样例的跨进程 `AXSize` 写入、通知、恢复及移除监听后的可调性
  - [x] 验证右侧近透明边框层可阻止鼠标拖拽缩放，光标保持普通箭头；移除后恢复可拉伸
  - [x] 独立 AppKit 样例：四边四角各一处拖拽对照、内容点击、标题栏移动后重新对齐、静态遮挡层级、移除后恢复拉伸
  - [x] 验证反例：启用边框拦截时，目标应用调用 `NSWindow.setFrame` 仍可改变尺寸
  - [x] 确认统一产品边界：不额外拦截系统缩放，不回写目标尺寸；仅平移保留笔迹，实际改宽或高时清笔迹并退出标注，同一窗口共享继续
  - [ ] 在双平台产品中验证鼠标模式正常缩放、连续跟随和跨屏、遮挡输入，以及本地和远端不残留旧墨
  - [ ] 用应用主动改尺寸、双击标题栏或系统平铺验证自动退出且远端继续看同一窗口；恢复原先的边框操作后可按新尺寸重开标注
- [x] 0.4 P0-4：标注层排在被共享窗口正上方、静态部分遮挡时跟着被挡住（macOS）；动态层级留实机验收
- [ ] 0.5 P0-5：`replaceTrack` 中途切换（需要真实 ZEGO 推流）
  - [x] 核对仓库 ZEGO SDK 的换轨入口与当前发布轨道所有权；完成不含 ZEGO 的本地 WebRTC 对照
- [x] 0.6 P0-6：1080p 与近 4K 本机窗口采集/合成帧率及 CPU 对比（macOS，不含 ZEGO 推流）
- [ ] 0.7 P0-1 至 P0-6 的 Windows 部分
  - [x] Windows x64 单样例：Electron 44.0.0 在 125% 缩放下将选中来源匹配到独立 WinForms 窗口，并收到 `displaySurface: window` 的实际视频帧。
  - [x] 同屏对照：只移动时 Win32 外框和 DWM 宽高不变，但 Electron DIP 宽高可因取整浮动 1；拖拽改尺寸后视频帧最终收敛，过渡期帧、轨道设置及原生几何可能不同步。稳定帧与 DWM 宽高的观测差为每轴 0–1 像素，仅是本夹具样例，不是通用裁剪规则。
  - [x] 夹具观察到最小化、恢复和关闭；最小化时采集轨仍为 `live`，恢复后继续收到帧。未读取画面内容，不据此判断是否黑帧或是否保留最后一帧。
  - [ ] Windows 上继续验证混合 DPI／跨屏、窗口样式与身份复用，以及真实边框拖拽、遮挡输入和相对层级；本次未开启产品标注。
  - [ ] `--overlay` 独立合成夹具候选：静态 ink、Pointer／Draw、四边输入窗与合成遮挡窗／输入计数；仅被动显示和移动自有 Electron 层。原生回读确认 HWND、物理边界、DPI、非 topmost 与相邻顺序才启用输入；不调用 `moveAbove()`，失序即撤层。计数不阻塞原生跟踪。PowerShell/C# 编译、真实 Windows 层级／输入／遮挡未验证，不接入会议或生产门控。命令与限制见 `apps/desktop/scripts/meeting-window-p0.README.md`。
  - [x] 记录脱敏历史观测：100% 缩放下，独立 Electron 探针的 `resizable:false` 和 `resizable:true` 均曾回读 **39×32 DIP**；另一次 `--overlay` Win32 回读中，请求 **8 px** 的边实际为 **39 px**。两组证据来源不同。
  - [x] 实现独立 PowerShell 5.1／Win32 隐藏几何探针：仅测合成目标和四条自有边，PMv2 下精确回读物理矩形与 DPI，清理后输出脱敏 JSON。不接入 Electron。启动：`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\apps\desktop\scripts\meeting-window-p0-edge-size-native.ps1`。
  - [x] 记录先前回报的主屏 100% 隐藏测量：五窗 DPI 均为 96，所有 `requestedPx` 与 `actualPx` 精确相等（`x,y,width,height`，单位 px）：目标 `(64,64,240,240)`、上 `(64,64,240,8)`、下 `(64,296,240,8)`、左 `(64,72,8,224)`、右 `(296,72,8,224)`。属于历史隐藏几何证据，本次未复测；不验收显示后尺寸、输入、遮挡或层级。
  - [x] 独立 Win32 可见被动阶段已实现并在 Windows x64 实机确认：同一固定合成矩形，持续读回 PMv2／DPI 96／精确物理矩形／非置顶严格相邻顺序，失败或 EOF 撤层。没有 Electron ink、不启用输入。首轮在上边条报 `order`，夹层窗口属探针自身进程懒创建的 `IME` 窗口；创建窗口前对本进程调用 `ImmDisableIME(-1)` 后连续两次 `visible-sample` + `removed`、退出码 `0`。完整混合探针及输入验收仍未完成。命令见 `apps/desktop/scripts/meeting-window-p0.README.md`。
  - [x] 2026-11-23 被动墨层与真人输入夹具实测（Windows x64、单屏 100%，x64 原生合成目标）：只读观察器先回读客户区；仅把自有透明墨层插到目标正上方并复核精确几何、非置顶、严格相邻后才算相邻可信。自有页面 `capturePage` 读到 816 个墨色像素（640×400），同一时刻目标单窗流 `inkColorPixels:0`，两轮均确认清理，说明正常相邻下本地呈现且未回灌原始窗口流。
  - [x] 同夹具确认：夹具自有遮挡窗在墨层上方并与墨层相交时墨层仍紧邻目标；目标最小化或改尺寸时立即撤层且不留残留；点击激活目标会把它抬到墨层上方，夹具重放自有层（最多 5 次）后复核。遮挡窗自身在激活后可能落到墨层下方，后续点击穿透到目标（实测目标 19 击），属必须处理的真实风险。
  - [x] 真人输入三模式通过（75 秒/轮）：穿透模式墨层 0 击/0 拖而目标收到 13 拖；绘制模式墨层 7 拖而目标 0 击；遮挡模式橙色自有遮挡窗 10 击、目标 0 击。全部确认清理。100% 映射另测得帧 642×432 与 DWM 一致、色点间距 592×352 等于客户区减 48。
  - [x] 记录未完成边界：本机 1080p 同轨合成帧计数在 1.1–28.6 fps 间跳变，抬到普通层最上仍 1.1 fps，判为夹具/隐藏渲染节流限制，不能作为性能结论；跨屏与 125%／150% 按用户选择未改系统设置，记为 BLOCKED。Win32 组合边条、持续同轨合成、真实 ZEGO 与 B 阶段仍未验证。详见 `docs/superpowers/reports/meeting-window-annotation-windows-2026-11-23.md`。
  - [x] 同一路流连续采样两轮各 5 次通过：每次 3 次视频回调、四角色点、`inkColorPixels:0`、100% 映射一致；过早取样会缺下半部色点，故预热 6 次回调后再取样。
  - [x] 组合边条夹具：独立原生助手创建四条 8px 自有边条并绕客户区外侧放置；独立观察器核对 PID、`WS_EX_LAYERED|TRANSPARENT`、非 topmost、精确矩形且不与客户区相交后才报 `strips-verified`，同轮墨层相邻与目标流无墨仍成立，两轮通过且全部 EOF 清理确认。故意声明错误厚度的对照使四边全部 `geometry` 拒绝并确认清理。
  - 历史记录（不再推进）：独立边条未收到真实点击；整窗动态切换穿透导致两边都收不到完整拖拽。详见 Windows A 阶段交接报告。取消边框拦截后，不需要继续验证上述路线或原生逐点命中。
- [ ] 0.8 按 P0 结果更新 OpenSpec
  - [x] 记录 macOS 首轮 P0-1、P0-2、P0-4、P0-6 的实测结果及限制
  - [x] Windows A 阶段夹具侧交接完成：`docs/superpowers/reports/meeting-window-annotation-windows-2026-11-23.md` 汇总 101 项回归、可支持范围、必须拒绝项、可移植夹具与需产品/B 阶段事项。未完成任务保持未勾选；A 不构成产品放行，B 未开始。

## 1. 原生辅助程序

- [ ] 1.1 macOS：按身份跟踪窗口位置、实际宽高、最小化与关闭状态，检测辅助功能权限并引导；不修改目标尺寸
- [ ] 1.2 Windows：窗口状态跟踪与画布相对层级，单独验收；历史边条和热区实验不再作为前置条件
  - [x] 选窗链路增加 Windows uint64 十进制字符串句柄与进程创建时间绑定；认证失败保留普通共享，取消后迟到身份不覆盖下一次采集。便携回归通过，未接产品 Windows 入口。
  - [ ] 新增只读 `MeetingWindowIdentityWindows.cs` 候选与 Node inspect/watch 有界适配器；初期明确只接受 DPI 96，外框实际尺寸与 DWM 画布框分离，helper 失联只返回不可用。待 Windows 编译、生命周期/平移样本与退出实测；尚不保证同进程 HWND 复用识别，不连接产品入口。
  - [ ] Windows 异步画布候选：隐藏定位与可见复核后才启用绘图，移动/关闭隔离迟到回复，静止心跳只读核层级；native `place/check` 仅操作自有画布，不改目标/全局置顶。便携控制流和协议测试已跑，Windows 编译/真实遮挡输入及性能未验证；未连接产品入口。
  - [x] 2026-11-24 窄路径验证记录：x64 native 编译及 PE Machine 0x8664；新隔离运行器两轮严格判据均确认几何、两轴改尺寸、最小化恢复、place/check 负例、关窗后存活与退出收尾。候选异步定位/check 竞争先红后绿修复，annotation 63 项通过。详见同日 Windows 验证报告。
  - [ ] 连续移动稳定性：续测历史一轮出现 1 次 unavailable，后两轮零失败不抹除历史；仍需定位 native 瞬态失败、验证动态画布跟随与普通遮挡输入。watch 取消只确认终止，不是原生 EOF；父端异常退出和产品接线未完成。
  - [x] 连续移动诊断：有限原因码不改变拒绝边界；五段合成压力运动复现 outer-changed 两次、dwm-changed 两次，默认常速单轮无失败。确认双读几何变化是本轮四次退出的直接原因；旧无原因码失败不回溯归因。仍未实现可恢复瞬态，连续跟随不勾完成。
  - [x] 后续实现有界几何待确认：仅矩形双读变化可暂停，重验同尺寸和层级后恢复；会话及无墨合成回归通过，原生压力两轮共 10/10 段恢复且清理确认。旧诊断轮次保留；动态画布跟随、真人输入、普通遮挡和远端验证仍未完成，Windows 入口未接通。
  - [ ] 全穿透动态画布跟随：两轮隔离真机均 `tracking-lost`，第二轮定位到 `place-hidden` 失败，未取得停稳后的可见复核；两轮清理确认。先区分隐藏定位拒绝原因，再安排真人验收。
  - [ ] 隐藏定位续测：有限恢复仅处理目标位置过期；连续与离散移动均另外复现 `order-topmost`，普通层备选严格读回失败且已撤回。保留层级拒绝，不进入真人输入验收。
  - [x] 最新全穿透夹具复测：避免隐藏工具栏重复写入焦点属性，并在工具栏非激活显示后再执行最终只读复核；离散一轮、连续两轮均在目标停稳后复核通过且确认清理。历史层级拒绝保留；真实焦点、真人输入、普通遮挡和屏幕闪烁仍未验收。
  - [x] 真人前置两轮：全穿透隔离候选，真实焦点属性写入，画笔/指针切换均经原生只读复核；合成目标自改宽确认 `resized` 和资源清理。仅只读尺寸拒绝等待可信实际尺寸；真人输入、普通遮挡、系统边角拖动和真实共享仍未验收。
  - [ ] 真人点击归属：画笔阶段 7 次到画布、0 次到目标。指针阶段只读层级检查拒绝并撤层，计数未取得；整轮未通过，清理确认。
  - [x] 指针恢复前置：周期只读复核遇明确宿主隐藏邻居时，每会话最多尝试一次重新定位；两轮合成拒绝后真实原生重新定位及清理通过。自然失序和真人计数仍待复测。
  - [ ] 真人指针复测仍未通过：再次出现宿主隐藏邻居，暂停后最终 `tracking-lost`，未取得计数；清理确认。保持严格层级复核。
  - [x] 自有目标激活对照：脱敏复现激活后的失序和普通层边界拒绝；更新候选后两轮零输入真实恢复及严格只读复核通过，清理确认。另有一轮非零计数拒绝保留。真人指针计数仍待复测。
  - [ ] 激活修复后真人指针仍未通过：暂停后 `place-hidden → order-readback`，按规则撤层；仅取得中断后目标计数 1，清理确认。
  - [x] 隐藏放置读回加固后的有效零输入复跑：自有目标激活后暂停并恢复，严格复核通过，两侧 0 次点击，清理确认。历史非零计数轮次保留，真人指针仍待验收。
  - [ ] 零输入复跑之后的真人指针仍未通过：隐藏放置读回拒绝后撤层，目标中断后计数 1、画布完整计数缺失，确认清理。已细分读回诊断，拒绝和通过判据未变。
  - [ ] 目标内提示真人复测：隐藏放置报 `order-readback-unchanged-anchor` 后撤层；目标诊断计数 12，画布完整计数及结束复核缺失，确认清理。先定位锚点未变而放置未取得直接相邻的原因，再安排真人复测。
  - [x] 连续普通层重排零输入对照：区分指针失序阶段，隐藏等待而非放宽相邻规则；最终两轮均暂停后恢复、严格复核和清理通过。未精确复现真人隐藏放置拒绝，真人验收保持未完成。
  - [ ] 真人续测：两次隐藏定位均报 `order-readback-unchanged-anchor-own-hidden`，等待后仍撤层；目标诊断计数 12、缺完整画布计数和最终复核，清理确认。隐藏下邻角色未确认，不按宿主进程归属放行。
  - [x] 隐藏下邻脱敏诊断已覆盖首次只读失序和隐藏定位读回失败；自动对照两轮首次失序均为未匹配类族，后续严格复核及清理通过。真人隐藏定位失败未复现，不据此推断其窗口角色或变更拒绝判据。
  - [x] 错峰重排对照：原候选恢复后再次失序；延长单次恢复前的隐藏等待后，两轮零输入对照完成严格复核及清理。原截止时间和严格相邻要求不变；真人指针仍未验收。
  - [ ] 延长等待后的真人复测仍未通过：首次失序及两次隐藏放置均见 `other-class-empty-unowned`；无法确认直接相邻后撤层，清理确认。窗口用途未确认，不放宽层级要求，不重复同一真人用例。
  - [x] 隔离首次激活的自动对照：自有目标先激活，画布恢复并通过严格复核后再开始计数；8 秒内双侧零点击、起止均为前台、最终复核和清理通过。未复现真人隐藏放置拒绝；真人对照仍待验证，不放宽层级要求或接线产品入口。
  - [x] 目标预先进入前台的真人指针对照通过：8 秒内目标 4 次、画布 0 次，起止前台，结束严格复核和清理通过。仅验证已在前台时的点击穿透；真人首次点击激活后的隐藏放置失败仍未解决。
  - [x] 首次激活诊断空跑：合成目标自身的原生消息计数确认程序激活和已在前台两条基线，均完成严格复核与清理；未观察到点击激活消息，不代替真人对照。
  - [ ] 真人首次点击诊断确认一次鼠标点击激活；两次隐藏定位读回均为 `topmost-anchor:target-above`，严格相邻未建立后撤层并确认清理。普通层顶边界的放置问题仍待隔离验证；不放宽层级检查。
  - [x] 普通层顶边界对照：两轮静态原生放置及三轮程序激活动态对照通过严格复核并确认清理；目标直接上邻为置顶窗但不是夹具创建的测试窗。不构成真人隐藏读回失败的复现或修复。
  - [x] 增加首次边界写入后的即时双向相邻诊断；静态与程序激活动态对照均读到双向相邻，最终复核和清理通过。诊断不改变拒绝策略；真人首次点击失败路径尚无此项读回。
  - [ ] 真人首次点击诊断两次即时读回均未观察到任一方向相邻，最终仍失序撤层，清理确认。尚不能区分定位未生效与即时读回前重排，保留 Windows 门控。
  - [x] 自有画布消息基线：实际边界写入时观察到位置变化消息，已相邻无需再写的对照未观察到；严格复核及清理通过。消息计数仅作诊断，不代表曾取得直接相邻。
  - [x] 独立 Win32 样本窗回调内双向同步观测区分已知不相邻和相邻，只读对照无消息，清理通过。尚未桥接到 Electron 画布，不外推至真人失败时序。
  - [x] 隔离 Electron 画布接入可选同步只读诊断，两轮程序激活恢复均在位置消息回调内读到双向相邻，最终复核和清理通过。未改产品依赖和入口，尚未观测真人失败时序。
  - [ ] 真人失败路径两次恢复均只观察到画布的 `WM_WINDOWPOSCHANGING`，无 `WM_WINDOWPOSCHANGED` 或回调内邻接样本，写后即时读回均不相邻。未确认根因，撤层和清理通过，保留门控。
  - [x] 自有 Win32 负对照复现成功返回但无层级变化与完成消息；独立 `SWP_NOSENDCHANGING` 变体通过静态及程序激活复核和清理，默认助手不变。尚未验证真人首次点击路径，不作为修复或产品放行证据。
  - [ ] 独立 `SWP_NOSENDCHANGING` 变体未通过真人首次点击：两次隐藏定位均未读到相邻，按规则撤层并确认清理。不采用此变体作为修复，保留 Windows 门控。
  - [x] 隔离夹具由画布所属线程发起隐藏边界写入，两轮程序激活对照确认实际写入、独立严格复核及清理。未验证真人首次点击，不接产品入口。
  - [ ] 画布所属线程定位变体未通过真人首次点击：两次调用返回成功，但即时读回和独立复核均未确认相邻，撤层与清理已确认。不作为修复，保留 Windows 门控。
  - [x] 可激活普通遮挡窗的静态指针命中对照两轮通过：覆盖点命中遮挡窗、露出点命中目标，隐藏后两点均命中目标；画布仍经严格相邻复核，清理确认。物理点击归属另行验证，不作为首次点击激活故障的修复。
  - [x] 真人普通遮挡窗指针点击：8 秒内遮挡窗 6 次、目标 0 次、画布 0 次；三次严格相邻复核通过，标注未退出，清理确认。仅限本次自有普通遮挡窗场景。
  - [x] 右边框真人缩放前置：两轮目标自改宽，标注均以 `resized` 退出并销毁双层，目标继续存活，清理确认。目标窗口的系统拖动消息均为零，不据此勾选真人边框或真实共享验收。
  - [x] 已在前台的合成目标真人右边框拖动：系统拖动一次，宽度增加 90 像素、高度不变；标注以 `resized` 退出，双层销毁，目标按新尺寸继续移动，清理确认。其他边角与真实会议共享仍未验收。
  - [x] 默认助手隔离夹具：目标自改宽两轮、自改宽高两轮，旧层销毁后同一目标按新尺寸重开成功，旧画布发送方的场景未被新会话接收，清理确认。未验证真人拖角或远端画面。
  - [ ] 真人右下角拖动已确认双轴缩放（704×471 → 779×550）及以 `resized` 撤层，目标继续存活，清理确认；同一目标按新尺寸重开未通过，新会话和新场景未确认。
  - [x] Windows x64 未打包开发版接入标准身份、观察与定位适配器，须显式开启；沿用当前窗口发布就绪门控。打包版禁用，两个已知故障和真实会议双端验收仍未关闭。
  - [x] 开发版画笔切换候选：Windows 单窗口工具栏保持不可聚焦，严格复核后仍接受鼠标；真实工具栏页面经按钮 DOM click → preload → IPC 的自动对照通过并确认清理。不是物理点击验收，用户报告的画笔切换故障尚待开发版验证。
  - [ ] `--native-only` 夹具只读跟踪原型已实现；待 Windows 实机核对同屏移动／缩放、最小化／恢复及不可用状态。轮询不保证识别同进程 HWND 复用；未接入产品。
- [ ] 1.3 打包、签名与公证

## 1A. Windows 原生语义 Overlay 重构（全部未完成）

- [ ] 1A.1 冻结旧 Electron 多 HWND 排层路线：保持默认关闭和严格双向邻接门禁，不删除历史夹具、失败证据或未完成项；记录停止继续排序标志、调用线程、等待、owner 与重复重排变体
- [ ] 1A.2 P0 契约与空壳：定义原生单 HWND 的版本化协议、会话代际、身份／几何／遮挡快照和 fail-closed 状态机；完成 x64 PMv2、非 topmost、无激活显示、EOF／崩溃清理与设备丢失回归，不接产品入口
- [ ] 1A.3 P1 Direct2D / DirectComposition 呈现：单一原生 HWND 内绘制透明墨迹和工具栏视觉，覆盖 100%／125%／150%、负坐标、跨屏、DWM 边界与设备重建；此阶段保持全部输入穿透
- [ ] 1A.4 P1 身份与几何：复用无损 HWND、PID、进程创建时间和会话代际；同尺寸平移保留笔迹，最小化／动画／不可信过渡隐藏，真实单轴或双轴尺寸变化撤层、清旧墨并仅退出标注
- [ ] 1A.5 P2 语义遮挡：仅用只读 Win32/DWM 元数据计算保守可见区域，把同一版本用于 DirectComposition clip／窗口区域和命中；覆盖普通窗局部／全部遮挡、popup／菜单、Alt+Tab、topmost 边界、枚举竞争与受限窗口，不确定时整层隐藏或扣除区域
- [ ] 1A.6 P2 输入门禁：pointer 全穿透，pen／eraser 仅命中可信目标可见区，工具栏仅命中可见按钮；版本过期、越界或切换中的事件直接丢弃。不得使用输入转发／重放、`PostMessage`、`SendInput`、跨进程注入／钩子、桌面区域捕获或全局 topmost 实现产品行为
- [ ] 1A.7 P3 真人隔离验收：用硬件鼠标及可用的笔设备验证绘制、擦除、工具栏、点击、滚动、标题栏移动、系统边角缩放、遮挡进出、焦点切换和故障关断；至少两轮，无误命中、悬浮旧墨或清理不明
- [ ] 1A.8 P3 模型与 compositor 接口：保持现有窗口共享 compositor 和同一 `_screen` 发布；同一标注事件驱动本地原生绘制与远端合成且只叠一次，覆盖源静止新增墨、迟到事件、尺寸退出清旧墨和快速重开空白，不新增第二媒体合成器
  - [x] 未打包开发路径已接 renderer scene/history owner、typed IPC、main scene 校验、native `setScene` 与现有 `jugglework:meeting:window-annotation` compositor 事件；媒体运行时 35/35 回归确认没有新增采集或发布调用。真实远端“只叠一次”、静止源新增墨与快速重开仍待双端验收。
- [ ] 1A.9 P4 产品接线：仅在 Windows 显式实验开关、真实单窗发布就绪及全部原生门禁满足时启用；不得静默回退旧多 HWND 路线。真人复测代表性真实应用、混合 DPI／多屏、最小化恢复、遮挡和失败撤层
  - [x] 已接未打包 Windows x64 严格子集：`JUGGLEWORK_SEMANTIC_OVERLAY_POC=1`、单屏、DPI96、固定 helper、可信 HWND/PID/创建时间、发布就绪像素与原生 `actualSize` 一致；semantic 被选择后 helper 缺失或失败保持 `available:false`，不回退 legacy。单窗仅创建 content-protected toolbar，整屏与旧模式保持 legacy。
  - [x] typed IPC 与生命周期自动接线完成：`captureId`/`annotationId`/`nativeSessionId`/`generation`/`seq` 隔离；minimized/unknown 撤本地交互并暂停或清远端状态，可信 restore 使用 native 新 epoch；resize 只退标注，受信 target close 经既有 compositor close 路径停止共享；helper exit fail closed。
- [ ] 1A.10 P4 真实 ZEGO 双端：1080p 与近 4K 各至少三组普通共享基线／同轨无墨／持续有墨对照；验证同一 `_screen`、无黑帧／旧墨／重选源，远端帧率达到对应普通共享基线 90%
- [ ] 1A.11 P5 签名包与放行：验证计划支持架构的 helper PE、生产签名、普通权限安装、空格／非 ASCII 路径、安全软件结果、异常退出和卸载清理；未覆盖组合明确拒绝或继续默认关闭
- [ ] 1A.12 汇总 E0-E4 证据矩阵并逐项记录环境、构建、操作、观察、退出和清理；自动测试、API 成功、`SendInput`、DOM click 或截图不得替代真人硬件输入和真实会议验收。重构未经真人验收前不得标记完成或默认开启
  - [x] 隔离 GDI 安全模型 PoC 已完成 x64 结构布局、周期遮挡、提交前后认证、确定性 target/occluder 移动与关闭 race、destroy/recreate 旧会话终止负测；不接产品，不代表 1A.2/1A.5/1A.6 完成
  - [x] 隔离 PoC 已完成 v1 JSON-lines 边界、目标与父进程身份/session/seq/epoch 绑定、有限 scene、父进程或 EOF 有界清理，以及固定 helper 路径/白名单/generation/超时的独立 Node adapter；协议、父强杀、helper crash、scene 上限和快速重开隔离自动测试通过，未接 main/meeting
  - [x] 独立原生输入→现有 annotation model 桥接已完成：JS 持有 scene/history 权威，native 只发 session/epoch/inputSeq/phase/normalized points；支持 laser/pen/highlighter/rectangle/ellipse/arrow/eraser、pointer、undo/clear。shape 复用既有 model/history/compositor；eraser 用 epoch/revision 绑定的 hidden-ID preview；laser 用独立 epoch/revision 的最多 32 条全量 transient 状态，1200ms 线性淡出且不进入 history/sceneRevision，clear/tool switch/cancel/input gap/epoch/unknown/close 立即清。桥接、adapter、真实 helper protocol/full/negative/race 自动回归通过，不代表 1A.6/1A.8 整体完成
  - [x] B1-B7 审查修复：移除 protocol 45 秒寿命，增加自主 epoch `state(eventSeq)`、wrong-epoch 恢复、protocol stdout 白名单、有界异步 writer/move 批处理与背压撤输入、committed-only scene 串行写、64 KiB UTF-8 原子校验、连续 inputSeq/零点击丢弃、abort/style 命令和 listener 隔离。真实 protocol 在 47 秒后继续应答，full/negative/race 串行回归通过；仍未做产品接线
  - [x] 协议最后两项隔离自动证据：真实 helper 暂停 stdout 消费后，以有限、自有且逐次身份认证的 OS 输入触发 256 队列背压，确认 cancel、撤 input/隐藏、target 可命中、capture 释放及 EOF 140ms 有界退出；adapter 固定 helper 路径配合自有 topmost occluder，确认 unsolicited unknown/new epoch、`input:false`/`visible:false`、移除后新 epoch 恢复且命令不永久 wrong-epoch。未接 main/meeting
  - [x] Direct2D/DComp 技术探针已实际编译运行并形成反证：premultiplied layered 的 alpha=0 空白区无法命中开始 draw；DComp 单 HWND 的透明 visual 在 pointer 模式吞掉跨进程真实点击；同 HWND 动态切换 layered/NOREDIRECTIONBITMAP 不可靠。未保留失败实现，未用 alpha=1／常量 alpha／GDI 冒充完成，原 full 回归恢复通过
  - [x] 已选择并验证隔离双 HWND PoC 解除单 HWND 透明像素与双模式命中冲突：Direct2D premultiplied layered visual 与无绘制、非 layered input 使用同版事务快照/region/epoch；pointer 隐藏 input，draw 空白可起笔，实际像素、遮挡命中、fixture-only 设备丢失新 epoch 和 300 次资源循环通过。产品协议/adapter 不暴露双层细节，未接 main/meeting；不代表 1A.2/1A.3/1A.6 完成
  - [x] 单屏 DPI96 隔离几何验证：实际 PMv2 target/visual/input DWM frame 完全一致，同 DPI 平移以新 epoch 恢复；system-aware/unaware 自有 fixture 仅证明 PMv2 helper 在当前 DPI96 下物理 frame 读回有效。纯函数覆盖负/大坐标、整数溢出、防零尺寸、region 局部转换和输入归一化边界；不得记作真实负坐标、多屏或 125%/150% 证据。`WM_DPICHANGED` 已实现先撤 input、建议 rect、可信新 DPI/frame 后新 epoch，但真实混合 DPI 和捕获帧映射仍待产品接线后确认
  - [ ] 同值 HWND 复用无竞态证明、PageHeap、Direct2D/DComp、设备丢失、真人输入与真实会议仍未完成；父强杀测试会同时关闭 stdin，只证明父端消失后的有界清理，不区分首先观察到的 handle/EOF 信号

## 2. Electron

- [ ] 2.1 选屏器记录 `window:` 来源并解析系统窗口
- [ ] 2.2 `meeting-annotation.mjs` 支持窗口目标：跟随、遮挡、最小化、关闭；移除 macOS 的边框窗及专用层级/遮挡处理，Windows 不创建边框窗；仅保留画布层级检查和工具输入
- [ ] 2.3 增加仅退出标注的尺寸变化路径；覆盖仅移动、仅像素尺寸变化、最小化恢复、快速重开与上一会话迟到事件

## 3. 渲染层

- [ ] 3.1 合成器与推流轨道切换、保留最后一帧
- [ ] 3.2 标注模型同步到合成器
- [ ] 3.3 会议工具栏与小窗在窗口共享时显示「标注」
- [ ] 3.4 尺寸变化时停止渲染旧笔迹并清理标注状态；保持原始采集及 `_screen` 发布，验证回切失败时仍继续无笔迹共享

## 4. 验证

- [ ] 4.1 单元测试、typecheck、构建
  - [x] macOS 开发路径：会议与验包目标回归（Node 87 项、Bun 17 项）、Electron 桥接和两套类型检查、桌面构建、OpenSpec strict 校验
  - [x] Windows semantic 开发接线：Electron 定向回归 178/178（含路由优先级）、媒体运行时 35/35、semantic renderer/session 与 compositor 定向测试、app/Electron typecheck、`git diff --check` 和 OpenSpec strict；未启动应用，未执行真人或真实会议测试。
  - [x] Windows semantic 隔离接线 smoke：真实固定 helper、自有跨进程 target/occluder 与 OS 输入，串联 router/main controller、fake toolbar BrowserWindow、受信 renderer semantic channel、scene/native/compositor；覆盖 gate、unknown/恢复、minimize/restore、resize、target close、helper crash、manual close和快速重开，16 个进程自然清理且媒体 start/publish 保持 1。修复 semantic/compositor channel 序号冲突和恢复瞬态尺寸误判；仍不替代真人外部应用或真实会议。
  - [x] 2026-11-26 semantic 接线审查自动项：native DPI96 启动/运行/`WM_DPICHANGED` 终态硬门禁；`apply-scene(sceneRevision)` native ACK 后原子发布 compositor/history；renderer single-inflight/coalesce committed scene；toolbar/main renderer 生命周期 teardown；旧 revision/迟到 ACK 隔离；adapter 有界 dispose/replacement、hung/stdout 背压；share stop readiness 立即取消。两轮 wiring smoke 均 16 个进程自然退出、0 强杀。fixture 的 120 DPI 仅为模拟，不是实机缩放证据。
  - [x] 2026-11-26 semantic shape 自动项：rectangle/ellipse/arrow 端到端接入 typed IPC、session/model/history、main exact schema、Node adapter、native retained ID union 和 Direct2D；真实双 HWND 像素确认矩形四边、椭圆四极点、箭头轴线/头部、clear、occluder 洞、device loss 恢复，300 次混合 scene 后 GDI `8→8`、USER `5→5`。toolbar 恢复三按钮并按 6 工具实际宽度计算；legacy 不变。真人/真实会议仍未完成。
  - [x] 2026-11-26 semantic eraser 自动项：纯函数像素 hit 覆盖 stroke 折线段、rectangle 四边、ellipse 边界、arrow shaft/head 边与填充，含反向、退化和极端 size 有界向量；down/move 累计 hidden IDs 并以独立 preview revision/epoch 同步 native/compositor，不改 retained committed/history，up 经 native scene ACK 后正式发布，cancel/undo/unknown/device loss/tool switch/close 清预览。严格 schema、ID 上限/重复、旧 revision/session/epoch 拒绝已覆盖；toolbar 按 7 工具宽度。stroke hit 不展开 Konva tension Bezier，ellipse 使用径向边界距离，因此与 Konva 抗锯齿逐像素结果不保证完全等价。
- [ ] 4.2 macOS 实机与真实会议（含不同窗口样式、移动/跨屏、焦点切换、最小化/恢复及真实编码推流负载）
- [ ] 4.3 Windows 实机与真实会议

### macOS 开发版进展

- 窗口来源身份、只读跟踪、边框拦截、尺寸变化退出和同轨合成已接入 `JUGGLEWORK_WINDOW_ANNOTATION=1` 开关；默认不启用。开发路径在启动窗口共享时创建合成轨，开关标注只增删叠加内容，不进行 ZEGO 换轨。此路径能否默认启用仍取决于真实会议连续性与性能。
- 自动化覆盖尺寸变化后保留发布轨和原始采集、移窗不退出、不可见与最小化分开处理、过期会话及层级失败清理。前端构建、Electron 桥接和类型检查、Swift 辅助程序编译与本机签名检查已通过。
- 独立 AppKit 窗口验证原生助手能读到正确 PID、移动时尺寸不变、主动加宽 45 pt、最小化、恢复及关闭。发现最小化和恢复动画会变形 CG bounds；修正后首个恢复样本为真实尺寸，不再把动画帧作为 resize。此项不代表 Electron 或打包版的授权与端到端行为已验收。
- 审查回归覆盖宿主销毁时移除全部拦截层、最小化后仅在首个可信的同尺寸样本恢复、首样本确认关闭、等 ZEGO `PUBLISHING` 后才开放入口、采集尺寸暂不匹配时先输出纯原画，以及荧光笔在深色画面上可见。帧与原生几何消息没有共同的版本；未确认的尺寸变化后若没有新几何事件，可能持续输出纯原画。ZEGO 的发布回调也不区分同一 `_screen` ID 的不同发布尝试，仍需实测快速重开。
- 本地 arm64 目录包已用仓库固定的 pnpm 12.21.0 和经哈希校验的官方 Bun 1.3.14 构建。包内 `Contents/Resources/helpers/MeetingWindowTracker` 存在、可执行，通过 `codesign --verify --strict`，架构为 arm64。整个应用未做 Developer ID 签名或公证，正式验包脚本停在主应用签名验证；不能作为发布包。
- 本地层级修复历史验证：原生助手曾观察画布与四个边框窗的顺序。现已按统一规则改为仅注册和观察画布，保留相对排序、有限倒序重试和会话清理；新版真实鼠标点击和各应用组合仍需验收。
- 微信窗口复现：三次标注开启约 0.8 秒后自动结束，目标实际宽高不变，一个同进程小窗口夹在标注层与目标之间。独立 AppKit 子窗口夹具确认旧版会反复重排并误退出。修复后将这种未经确认的夹层与真正倒序分开，只尽力重排，不单凭夹层关闭标注；未按 PID 推断所有窗口的归属。真实微信上的修复后复测尚未确认。
- **统一交互代码已调整、实机待验：** 已移除 macOS 边框拦截窗及其原生注册/遮挡处理，只保留画布与工具栏。平移保留、实际改尺寸仅退标注由自动化覆盖；画布被遮挡时不得抢点击，仍须真机验收。开发开关保持默认关闭，Windows 产品主入口尚未接线。
- 尚未完成：开发版和打包版辅助功能授权实测、代表性应用的正常缩放、遮挡点击与连续跟随、跨屏映射、真实会议远端无旧笔迹/无黑帧及帧率验收。不以自动化替代这些实机项目。
