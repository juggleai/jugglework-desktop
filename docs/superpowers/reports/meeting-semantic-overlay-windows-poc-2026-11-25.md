# Windows 原生语义 Overlay PoC 自动验证报告（2026-11-25）

## 结论

隔离的 Win32 单 HWND 安全模型 PoC 在本机完成最终二进制的结构布局、模型、full、negative 和确定性 race 验证。它取得自有窗口 E2 窄路径与自动负向证据，不接产品、不启动会议、不抓屏、不读取外部窗口标题／类名，也不证明真人输入、真实应用、Direct2D／DirectComposition 渲染或真实会议可用。

PoC 使用 GDI 加常量低 alpha layered window，仅用于让整个 HRGN 可由 `WindowFromPoint` 和真实窗口消息验证命中。渲染不是最终实现，不能作为透明视觉质量证据。最终方案仍应使用计划中的 Direct2D／DirectComposition。

## 环境与构建

- 日期：2026-11-25。
- 主机：当前交互式 Windows x64 工作区。
- 编译器：系统 `.NET Framework64 v4.0.30319 csc.exe`，`/platform:x64`，无新增依赖。
- 源码：`apps/desktop/native/MeetingSemanticOverlayWindows.cs`。
- 构建脚本：`apps/desktop/scripts/prepare-meeting-semantic-overlay-windows.ps1`。
- 自动运行器：`apps/desktop/scripts/meeting-semantic-overlay-validation.cjs`。
- 自动负向运行器：`apps/desktop/scripts/meeting-semantic-overlay-negative-validation.cjs`。
- 纯函数模型与测试：`apps/desktop/scripts/meeting-semantic-overlay-model.cjs`、`apps/desktop/scripts/meeting-semantic-overlay-model.test.cjs`。
- 临时二进制位于系统批准的临时目录，未写入产品 resources，未修改产品默认接线。

## 安全边界

- target、occluder、overlay 分别运行在独立进程；每个角色只有一个顶层窗口。短生命周期 probe 不创建窗口。
- overlay 是单一 `HWND`，带 `WS_EX_NOACTIVATE`，自动读回 `topmost:false`；从不使用 `HWND_TOPMOST`，不修改 target 样式、owner、尺寸或位置。
- 身份由十进制 HWND 字符串、PID、进程创建 FILETIME 和窗口线程共同绑定。probe 在调用 `SendInput` 前重新认证所有允许角色，并要求 `WindowFromPoint` 只返回这些自有窗口之一；命中 `other` 时拒绝发送。
- pointer 模式使用 `WS_EX_TRANSPARENT` 和 `HTTRANSPARENT` 全穿透。draw 模式移除透明扩展样式，并仅允许 HRGN 中仍可见的 target 区域返回 `HTCLIENT`。
- 每次身份／几何／遮挡快照更新前先清空 region、隐藏窗口并撤输入。提交前重读 target 身份、frame、DPI、Z-order 和完整相交 occluder 快照并要求版本一致；提交 region 后第三次认证同一事实，全部确认后才恢复 draw 输入。任何变化空 region、隐藏且不 enable。实际 resize 进入不可恢复的 terminal 状态。
- 50ms 有界轮询先在候选 GDI region 中重新分类全局 Z-order；未知结果立即撤输入、空 region 并隐藏。可信且 region／几何／前台状态不变时不扰动当前输入；可信变化才撤旧输入并提交新 epoch。枚举最多 512 个窗口，且必须在预算内遇到已认证 target。
- 遮挡只接受普通、可见、非最小化、无自定义 region、非 layered、非 cloaked 的矩形窗口。layered、自定义／空 region、cloaked、topmost、DWM／身份读取竞争或枚举超限都按未知 fail-closed，不猜类名。
- overlay 是已认证 target 的非激活 owned popup；每次提交后读回验证它实际位于 target 上方。普通遮挡存在时，overlay 插在最邻近上层窗口之后，不越过遮挡；target 首次 OS 点击激活后会撤旧输入并以新 epoch 重建。
- probe 仅用于 fixture。它在移动光标前、移动后和按下前分别执行 `WindowFromPoint` 与所有允许角色的 HWND/PID/进程创建时间/线程/root 全身份认证；按下后再次认证，不一致不继续正常输入，并在已经按下时有界发送释放。
- overlay 安装按 target PID/thread 过滤的 `EVENT_OBJECT_DESTROY` hook。目标一旦收到销毁事件，会话永久 terminal，不允许新 HWND 复活旧会话；`WM_CLOSE`、`WM_DESTROY`、`WM_QUIT` 和 45 秒总预算提供有界退出。
- stdout 的 `ready` 行确实包含 fixture 的 HWND、PID、进程创建时间，用于父进程建立身份参数；此前“stdout 不输出身份”的说法错误，现已纠正。报告聚合输出仍只记录有限事实，但原始 helper stdout 不是脱敏边界。

## 执行命令

```powershell
node --test apps/desktop/scripts/meeting-semantic-overlay-model.test.cjs
$env:MEETING_SEMANTIC_OVERLAY_EXE='C:\Users\juggl\AppData\Local\Temp\opencode\meeting-semantic-overlay\MeetingSemanticOverlayWindows.exe'; node --test apps/desktop/scripts/meeting-semantic-overlay-layout.test.cjs
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File apps/desktop/scripts/prepare-meeting-semantic-overlay-windows.ps1 -OutDir C:\Users\juggl\AppData\Local\Temp\opencode\meeting-semantic-overlay
node apps/desktop/scripts/meeting-semantic-overlay-validation.cjs --exe C:\Users\juggl\AppData\Local\Temp\opencode\meeting-semantic-overlay\MeetingSemanticOverlayWindows.exe
node apps/desktop/scripts/meeting-semantic-overlay-negative-validation.cjs --exe C:\Users\juggl\AppData\Local\Temp\opencode\meeting-semantic-overlay\MeetingSemanticOverlayWindows.exe
node apps/desktop/scripts/meeting-semantic-overlay-race-validation.cjs --exe C:\Users\juggl\AppData\Local\Temp\opencode\meeting-semantic-overlay\MeetingSemanticOverlayWindows.exe
```

## 自动观察

| 步骤 | 观察 | 结果 |
| --- | --- | --- |
| 初始 pointer | `state:active`、`input:false`、epoch 1 | 通过 |
| pointer 穿透 | `WindowFromPoint` 为 target；target 点击 +1 | 通过 |
| target 首次 OS 激活 | click 释放成功、target 成为 foreground；overlay 从 epoch 1 重建到 epoch 2，随后 draw 命中 overlay | 连续两轮通过 |
| 无遮挡 draw | overlay `input:true`、`NOACTIVATE:true`、`topmost:false`；命中 overlay；stroke +1 | 通过 |
| 局部普通遮挡 | 不发显式 refresh，50ms 周期更新自动得到 1 个 occluder；交叠点命中 occluder；stroke +0 | 通过 |
| target 移动 | DWM frame 从新位置读回；overlay bounds 跟随；epoch 增加且 draw 输入仅在新提交后恢复 | 通过 |
| 实际 resize | `state:resized`、`input:false`、`visible:false`；后续 draw 命令不能复活 | 通过 |
| 第一 overlay 退出 | 正常 code 0，窗口销毁确认 | 通过 |
| 新 overlay 会话 | 从 epoch 1 建立独立新会话 | 通过 |
| 最小化 | `state:minimized`、隐藏、撤输入 | 通过 |
| 恢复 | 有界等待可信 active；若旧普通层顺序未恢复则清理旧 overlay 并建立新会话／epoch；pointer 仍穿透 target | 通过 |
| target 关闭 | target 与第二 overlay 均正常 code 0，窗口销毁确认 | 通过 |
| 最终 cleanup | target、occluder、两次 overlay 均 closed、未强杀、destroyed | 通过 |

## 自动负向观察

| 场景 | 必须观察 | 最终结果 |
| --- | --- | --- |
| topmost occluder | `unknown`、`input:false`、`visible:false`、stroke +0；移除后新 epoch 恢复并可 stroke | 连续两轮通过 |
| `WS_EX_LAYERED` occluder | 同上，不按类名或 owner 放行 | 连续两轮通过 |
| 椭圆自定义 HRGN occluder | 同上，任何显式 region 都未知 | 连续两轮通过 |
| DWM cloaked occluder | 本机 `DWMWA_CLOAK` 构造和读回成功；同上 | 连续两轮通过，未跳过 |
| target 异常退出 | target 非零退出；OS 清 HWND/PID；overlay 观察 closed 后正常 cleanup | 连续两轮通过 |
| overlay helper 异常退出 | helper 非零退出；OS 清 HWND/PID；target 保持存活，随后正常 cleanup | 连续两轮通过 |
| 总清理 | 每轮 18 个进程、2 个预期异常退出、0 强杀 | 连续两轮通过 |

纯函数测试 3/3 通过，覆盖矩形差集面积／完全遮挡／不相交，epoch 更新先撤输入、最小化撤输入、未知遮挡撤输入与隐藏、恢复新 epoch、resize terminal 不可复活，以及 topmost／layered／cloaked／未知 cloaked 状态／自定义和空 region 的纯分类 fail-closed。

x64 结构布局测试确认指针 8 字节、`PAINTSTRUCT` 72 字节、`INPUT` 40 字节；`BeginPaint`/`EndPaint` 使用准确的 `[StructLayout(LayoutKind.Sequential)]` 结构和 `ref` 签名。确定性 race fixture 在 enumerate 与 commit 之间设置屏障，覆盖 target 移动、occluder 移动、occluder 关闭，全部观察 `input:false`、`visible:false`；target 销毁重建使旧 overlay 正常终止，所有进程 0 强杀。

## 本轮发现并修复

- 原实现只在 target 几何或状态变化时重扫遮挡，新出现但不改变几何的窗口可能不被发现。现每个有界轮次都构造候选 region 并重分类；未知立即撤层，可信未变化不制造输入闪断。
- 原实现相信 `SetWindowPos` 成功，未验证 overlay 实际仍在 target 上方。现提交后读回 Z-order，失败进入 unknown 并撤层。
- target fixture 原先使用 `WS_EX_NOACTIVATE`／`MA_NOACTIVATE`，无法覆盖真实 OS 首次激活。现 target 可激活，overlay 用 target-owned non-activating popup 保持语义层级并以 foreground 变化触发新 epoch。
- 原遮挡枚举从 target 向前走，在 owned popup／topmost 组合下会漏掉全局上层窗口。现从桌面顶端向下有界枚举，必须遇到 target 才可信。
- 原 overlay 每次以 `HWND_TOP` 提交会越过已识别普通遮挡。现记录最邻近上层 HWND，将 overlay 插在其后、target 之前。
- probe 原来一次 `SendInput(2)`，没有单独证明鼠标释放。现按下和释放分开，释放有界重试并输出 `released:true`。
- 原实现 snapshot 后直接 `SetWindowPos`/`SetWindowRgn`，存在 TOCTOU。现更新开始即撤输入，提交前双快照一致、提交后再认证 target/frame/DPI/Z-order/occluder，确认后才 enable；确定性屏障覆盖移动和关闭竞争。
- `GetWindowRgn`、DWM frame/cloak 和相交窗口 style 读取不再以 `continue` 放过；相交层任一读取失败整层 unknown。`SetWindowLong`/`SetWindowPos` 检查返回值并读回扩展样式，FRAMECHANGED 不再意外改变 Z-order。
- x64 `PAINTSTRUCT` 从错误的 64 字节数组改为 72 字节准确布局；增加原生布局测试。
- 修复了负向 fixture 的类型参数切片和不稳定 Z-order：负向窗均绑定已认证 target 为 owner，只改变待测 topmost／layered／region／cloaked 属性；普通遮挡 fixture 用短暂 topmost、认证 OS 点击、再降回普通 band 的受控流程建立可重复顺序。

## 未覆盖与限制

- 自动输入不是 E3。现已覆盖自有 target 的真实 OS 首次激活和新 epoch 重建，但没有操作任何外部真实应用，不能泛化到其 owner／popup／系统 UI 组合。
- 最小化恢复后的普通层顺序在连续运行中仍可能不恢复。验证器不重排 target，也不继续使用旧输入面：预算内未取得可信 active 时正常销毁旧 overlay，重新建立完整身份／几何／遮挡快照和新会话 epoch。该降级证明 fail-closed 恢复，不证明旧 HWND 能稳定原位恢复。
- 没有真人硬件鼠标、触控笔、橡皮、拖动、滚轮、标题栏或系统边角缩放证据。
- 已构造 topmost、layered、自定义非矩形 region 和 cloaked 的独立自有负向场景；仍未覆盖空 region、popup／菜单、系统 UI、超过 512 窗口、DWM／身份并发竞争和系统强制 topmost 变化。空 region 已由同一纯分类分支覆盖，但没有独立 OS fixture。
- 只验证当前显示环境中的 PMv2/DWM frame；未覆盖 125%／150%、负坐标、跨屏、混合 DPI 或 DWM 动画。
- GDI 常量 alpha 画面不是透明 overlay 最终视觉，未验证像素裁剪、Direct2D、DirectComposition、设备丢失或性能。
- 未连接现有标注模型、compositor、Electron、会议发布、ZEGO 双端或安装／签名流程。
- 已覆盖 target 与 overlay helper 的自有异常退出和 OS HWND/PID 清理；未覆盖 runner／父进程被强杀、系统注销、桌面切换或整个进程树同时崩溃。
- WinEvent destroy latch 缩小了 HWND 复用风险，自有 fixture 已覆盖 destroy/recreate 且旧会话终止；本轮重建得到不同 HWND，未强制制造同值句柄复用。WinEvent 是异步通知，本 PoC 未证明“销毁到回调锁存之间绝无同线程同进程句柄复用竞态”，因此该情况仍是产品化阻断，不以类名白名单放行。
- 原报告阶段尚未实现父进程死亡和正式版本化协议；该缺口由下述“协议边界追加验证”关闭，不再把旧 stdin EOF/45 秒预算描述为完整父端生命周期协议。
- 本轮未启用或验证 PageHeap，不声称 PageHeap 证据。

## 协议边界追加验证

同日后续在同一隔离 PoC 上完成了可接 Electron、尚未接产品入口的 v1 JSON-lines 边界：

- 产品式 `overlay` 启动参数绑定目标 HWND/PID/创建时间、父 PID/创建时间和 16–64 字符 `sessionId`。stdout 的 `hello`、`ack`、`state`、`error` 只含版本、会话、序号、epoch 和白名单状态，不含 HWND、PID、进程创建时间；旧 `ready` 身份只由显式 `overlay-fixture` 使用。
- 每条命令必须有严格字段集合、`version:1`、匹配的 `sessionId`、递增 `seq` 和当前 `expectedEpoch`。支持 `mode:pointer|draw`、`scene:stroke|clear`、`state` 和 `close`；未知字段和未知命令 fail closed。
- scene 最多 128 笔、每笔 256 点、总计 4096 点；每个坐标必须是有限数值且在 `0..1`。GDI 只绘制基础折线。scene 更新不改变 mode、不授权 input；错误版本、session、epoch、旧 seq 和超限 scene 的自动负测确认 scene/input 状态不变。
- helper 打开父进程同步 handle。父进程结束或 stdin EOF 后，循环先调用撤 input/透明命中、空 region 和隐藏，再销毁窗口。独立 launcher 强杀测试在 2 秒预算内观察 helper 已退出，并清理独立 target；正常 EOF 退出码为 0。
- 独立 adapter `apps/desktop/electron/meeting-semantic-overlay-windows.mjs` 固定从 desktop root 推导 `.dev-helpers/semantic-overlay/MeetingSemanticOverlayWindows.exe`，不接收 renderer exe 路径；严格验证 hello/ack/state/error 白名单，使用 generation 隔离快速重开，限制一个 pending 请求，并对超时、helper crash、输出过大、非法 JSON、迟到和旧 generation fail closed。
- 开发构建仅在 `JUGGLEWORK_SEMANTIC_OVERLAY_POC=1` 时输出上述独立 helper 路径；测试仍可构建到批准的临时目录。未修改 `electron/main.mjs`，未连接 meeting 产品，也未启动或重启会议。

追加执行结果：adapter 5/5、协议验证、父进程强杀、模型 3/3、x64 layout 1/1、Electron typecheck、`git diff --check` 全部通过；原 full、negative、race 串行回归各一轮通过，所有运行器报告 0 非预期强杀。最终测试二进制位于 `C:\Users\juggl\AppData\Local\Temp\opencode\meeting-semantic-overlay-protocol\MeetingSemanticOverlayWindows.exe`，不在产品 resources。

仍未解决：同值 HWND 强制复用及 destroy 回调竞态、Direct2D/DirectComposition 和设备丢失、PageHeap、真实外部应用、真人硬件鼠标/笔、混合 DPI/多屏、ZEGO 双端、签名与安装包。父强杀测试同时会关闭继承的 stdin 管道，因此能证明父端消失后有界退出，不单独归因 handle signal 与 EOF 中哪一个先被观察。

因此该结果只支持继续推进计划 P1/P2，不授权产品接线、默认开启或对外宣称 Windows 单窗口标注已完成。

## 原生输入到现有标注模型桥接追加验证

同日继续在独立路径实现模型桥接，仍未修改 `electron/main.mjs`，未连接 meeting，也未启动或重启应用：

- `apps/app/src/react-app/domains/meeting/meeting-semantic-annotation-session.ts` 持有 `AnnotationHistory`、已提交 scene 和 draft，直接复用 `createDrawElement`、`updateDrawElement`、`isMeaningful`、`commitAnnotation`、`undoAnnotation`，不复制标注提交语义。它输出既有 `WindowAnnotationScene`，可直接供 `createWindowAnnotationReceiver`/现有 compositor 的 `drawScene` 路径消费。
- 原生协议输出 `pointer` 白名单事件：`sessionId`、`epoch`、严格递增 `inputSeq`、`phase:down|move|up|cancel`、归一化 points。单批 64 点、单笔 256 点；模式/epoch/遮挡/unknown/capture 变化先 cancel active stroke，撤输入后不发新点。
- native 只即时画当前临时线；JS draft 进入 compositor scene，但回写 native 的受限全量 scene 只包含已提交 history，因此本地不会重复描边。`up` 后 JS 提交现有 `AnnotationStroke` 并用权威 scene 替换临时线。native scene 最多 128 笔、每笔 256 点、总计 4096 点，携带 color/size/highlight；scene 更新不授权 input。
- 当前支持 pen/highlighter、pointer 模式、undo/clear。eraser 需要命中测试语义，laser/shape 需要额外生命周期或图元协议，均明确返回 `unsupported-tool`，没有映射成 pen。Electron Canvas 路径未改。
- `apps/desktop/scripts/meeting-semantic-overlay-protocol-validation.cjs` 使用自有 target/overlay fixture，经命中 HWND、PID 和创建时间重新认证后才用 `SendInput` 生成真实 down/up，验证 pointer 批次再由 JS 式全量 scene 回写；该自动输入仍不构成真人硬件输入证据。

追加结果：桥接 Bun 6/6、adapter Node 6/6、app tsc、Electron typecheck、C# x64 编译、protocol、full、negative（18 进程、2 个预期异常、0 强杀）、race（4 进程、0 强杀）均通过。OpenSpec strict 与 `git diff --check` 见本轮最终验证。仍未覆盖真实硬件拖动的高频批处理、笔压/触控笔、eraser 命中、Direct2D/DComp、设备丢失、真实外部应用、混合 DPI/多屏、ZEGO 双端和签名包。

## B1-B7 审查修复追加（2026-11-25）

- protocol 模式移除原 45 秒总寿命，fixture 保留默认 45 秒及显式测试时长；真实 protocol 验证在 47 秒后继续 query 成功。
- native 自主 epoch/state 变化发送白名单 `state(eventSeq)`；adapter 更新 epoch、隔离调用 `onState`。`wrong-epoch` error 也更新 epoch 并返回 `retryable:true`，调用方不会永久停在旧 epoch。
- protocol stdout 只允许 `hello/ack/state/error/pointer`。refused/race 诊断在 fixture 仍走 stdout，在 protocol 走 stderr；adapter 继续把 helper stderr 设为 ignore，真实协议验证检查了完整 stdout 类型集合。
- stdin 改为 64 KiB 有界字节 reader。stdout 改为 256 项有界队列和 writer 线程，普通 pointer 输出预留 64 个优先槽；WndProc 不再直接 flush。move 最多 64 点一批，队列背压会撤输入并 cancel，不阻塞窗口线程；已编号事件不会为腾位而删除。
- renderer session 的 draft 只触发 `onScene`，committed history 变化才在 mode/abort/scene 单一串行队列回写 native；写失败由 `flush()` 和 `onFailure` 可观察。提交前按完整最坏 envelope 校验结构与 UTF-8 64 KiB 预算，失败不修改 history；native scene 仍先完整解析到临时列表再替换。
- inputSeq 现在要求连续；gap、点数溢出、epoch 变化均取消 draft。native up 去重末点；annotation model 按首点最大像素距离判定 stroke，零距离 click 不提交。clear/undo/tool switch/dispose 发 abort；draw mode 携带 color/size/highlight，native draft 使用该样式。
- 新增/更新 adapter 与 session 测试覆盖自主 epoch、wrong-epoch 恢复、listener 异常、UTF-8 字节行、style/abort、gap、zero click、clear midstroke、写失败和 1000 move fail-closed。最终数字以本轮命令输出为准。

仍未关闭的接线阻断保持不变：未接 `main`/meeting，未实现 Direct2D/DirectComposition 和设备恢复；未完成同值 HWND 复用竞态证明、真实硬件高频拖动/笔设备、代表性外部应用、混合 DPI/多屏、ZEGO 双端、签名安装包及安全软件验收。

## 双 HWND Direct2D semantic overlay PoC

在单 HWND 反证后，隔离 helper 改为两个本方顶层 HWND，未接 `main`、meeting 或发布资源：

- visual HWND 永久使用 `WS_EX_LAYERED|WS_EX_TRANSPARENT|WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW`，不承担输入。Direct2D DC render target 在 32-bit top-down DIB 上以 premultiplied alpha 绘制，再由 `UpdateLayeredWindow(ULW_ALPHA)` 提交。
- input HWND 使用 `WS_EX_NOREDIRECTIONBITMAP|WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW`，不 layered、不刷背景、不处理 `WM_PAINT` 绘制。draw 模式才安装可信 HRGN 并显示；pointer 模式先安装空 HRGN 再隐藏，因此目标点击不依赖跨进程 `HTTRANSPARENT`。
- 提交事务先撤 input 并隐藏两层，再二次认证 target/occluder 快照，复制同一 region，隐藏排层，提交 visual 像素，按模式显示 input，最后复核 `target → visual → input` 直接层级、样式、身份、几何和 occluder。任一步失败保持 input 空 region/隐藏且 visual 隐藏，不恢复旧 scene 的交互面。
- v1 `hello/state/ack/error/pointer` 产品式 stdout 不增加 raw HWND、PID 或双层角色。fixture-only `fixture-layers` 才可读回 visual/input HWND；Node adapter 无需知道双层实现。

实际自有 fixture 结果：

| 验证 | 结果 |
|---|---|
| visual 透明背景 | 同一点 target 基线 RGB `32,80,160`，visual active 后仍为 `32,80,160` |
| pen | 红色 12px 线中心 RGB `255,0,0` |
| highlighter | 黄色 35% alpha、32px 线中心合成 RGB `110,141,104`，符合 premultiplied 混色而非不透明覆盖 |
| clear | 清空 scene 后同点恢复 `32,80,160` |
| pointer 命中 | input 空 region 且隐藏，同点命中 target，target 点击计数 `+1` |
| draw 空白起笔 | 同点命中 input/overlay，stroke/pointer 批次增长 |
| input 空窗视觉 | draw 空白点显示 input 后仍为 target RGB `32,80,160`，未观察到 DWM 背景染色 |
| 遮挡洞 | 普通 occluder 覆盖点命中 occluder；跨洞红线提交后覆盖点仍为 occluder RGB `224,96,32`，无红色笔迹 |
| 设备丢失注入 | 仅 fixture 环境变量和私有 stdin 命令可触发；失败期间 `state:unknown,input:false,visible:false`，显式恢复后新 epoch `4→5` |
| 资源长循环 | 300 次非空/clear scene 交替前后 GDI `8→8`、USER `5→5`；阈值分别 `<=4`、`<=2` |
| 清理 | full、negative、race、双层专测均 0 非预期强杀；target close、父死、helper/target 异常和 EOF 路径通过 |

回归结果：adapter 单测 8/8、模型 3/3、x64 layout 1/1、full、protocol（含 47 秒存活）、negative（18 进程、2 个预期异常退出）、race、backpressure（1024 个有限 OS 事件、108ms EOF 退出）、adapter state、parent kill、Electron typecheck、OpenSpec strict 和 `git diff --check` 通过。最终二进制位于 `C:\Users\juggl\AppData\Local\Temp\opencode\meeting-semantic-overlay-dual\MeetingSemanticOverlayWindows.exe`；固定 adapter helper 另由现有 prepare 脚本生成到忽略目录，未进入产品 resources。

结论：双层层级和无绘制 input 空窗在本机自有 fixture 中未观察到视觉副作用且可稳定复核，可进入下一阶段的 100%/125%/150%、负坐标和混合 DPI 隔离验证。它仍不是产品放行：未覆盖真人硬件鼠标/笔、代表性外部应用、PageHeap、同值 HWND 复用竞态、真实多屏、ZEGO 双端、签名安装包和安全软件；在这些门槛前继续不接 `main`/meeting。

## 最后两项协议自动证据追加（2026-11-25）

- 新增 `meeting-semantic-overlay-backpressure-validation.cjs`。它只从 desktop root 使用固定 `.dev-helpers/semantic-overlay/MeetingSemanticOverlayWindows.exe`，创建自有 target 和 protocol overlay，进入 draw 后真正暂停父端 stdout 消费；`probe burst` 每次发送固定 256 次 down/up，最多 8 批，且每次发送前按 HWND/PID/创建时间重新认证命中必须为自有 overlay。实测第 2 批触发 native 256 队列背压，共 1024 个有限 OS 鼠标事件，没有无限写。
- 背压实测发现周期 refresh 会在撤层后自动重新授权 draw。helper 已增加 `pointerBackpressureLatched`：队列背压先 cancel、撤 input、空 region、隐藏并锁存 unknown，周期刷新不能恢复；只有新的、带当前 epoch 的显式 mode 命令才能解除锁存并重新认证。测试在 stdout 仍暂停时确认 target 可命中并可移动/点击，点击计数只增加于 target，最终观察到 pointer cancel 和 unsolicited unknown state；mouse-up 已由固定成对输入及 probe 兜底释放。stdin EOF 后 140ms 退出，清理 0 强杀。
- 新增 `meeting-semantic-overlay-adapter-state-validation.mjs`。它不接受 `--exe` 或 renderer 路径，只通过 `meeting-semantic-overlay-windows.mjs` 推导固定 helper；target/occluder 身份均来自 helper fixture。自有 topmost occluder 触发 adapter 收到 unsolicited `state(eventSeq)`：unknown epoch 3、`input:false`、`visible:false`；移除后收到 active epoch 4、`input:true`、`visible:true`，随后 adapter query 成功，未永久停在 wrong epoch。本轮首个并发 query 已直接使用更新后的 epoch，因此返回 `ok`；adapter 单测仍覆盖真实 wrong-epoch reply 后重试恢复。
- 本轮通过：adapter 8/8、annotation session 9/9、semantic model 3/3、x64 layout 1/1、app 与 Electron typecheck、C# x64 编译、protocol、backpressure、adapter state、full、negative（18 进程、2 个预期异常、0 强杀）、race（4 进程、0 强杀）、OpenSpec strict、`git diff --check`。所有 validation 串行运行并完成清理；未启动会议、未修改产品入口、未提交。

这两项关闭的是专门的真实 helper stdout 背压证据和 adapter 驱动自主 epoch/state 证据，不是产品放行。Direct2D/DirectComposition、设备恢复、同值 HWND 复用竞态、真人硬件输入、代表性外部应用、混合 DPI/多屏、ZEGO 双端以及签名安装包仍未完成，因此当前仍不允许进入 dev 产品接线。

## Direct2D / DirectComposition 接线阻断（2026-11-25）

本轮实际实现并编译运行了两条无第三方依赖的候选，但没有保留未满足语义的代码，也没有用 GDI 或低非零 alpha 冒充完成：

- Direct2D DC render target 绘制 premultiplied BGRA DIB，再用 `UpdateLayeredWindow(ULW_ALPHA)` 提交。alpha=0 背景像素视觉上透明，但 Windows 在 `WindowFromPoint` 阶段跳过这些像素，draw 模式的空白区域无法命中 overlay、无法开始第一笔；现有 `SetWindowRgn` 和 `WM_NCHITTEST` 没有机会改变该结果。增加 alpha=1 或整窗常量 alpha 会恢复命中，但违反“非绘制区域真正透明”，未采用。
- Direct2D 绘制 `IDCompositionSurface` 并挂到单一 `WS_EX_NOREDIRECTIONBITMAP` HWND。透明 visual 与 HWND 命中解耦，draw 空白区可以命中；但 pointer 模式下，即使设置 `WS_EX_TRANSPARENT`、返回 `HTTRANSPARENT`，真实跨进程 OS 点击仍被该顶层 HWND 吞掉。把 HWND disabled 也未恢复 target 的点击计数。
- 尝试在同一 HWND 上按模式切换 `WS_EX_LAYERED` 与 `WS_EX_NOREDIRECTIONBITMAP`，系统拒绝样式转换／后续呈现，不能作为可靠恢复路径。保留两个 HWND 会违反当前“单一 HWND”架构前提，也会重新引入本计划明确停止的跨 HWND 排层事务，因此本轮未继续。

实际自动观察不是只看 API 返回：layered 候选在 draw 命令后，认证 probe 观察命中 `target` 且 overlay stroke delta 为 0；DComp 候选在 pointer 命令后，认证 probe 虽按透明样式把候选分类到 target，但 target 实际点击 delta 为 0，证明点击被 overlay 吞掉。恢复原 PoC 后，同一 full 运行器重新观察 pointer 的 target delta 为 1、draw 的 overlay stroke delta 为 1，并完成遮挡、移动、resize、最小化／恢复、关闭和全部 cleanup。

因此本轮停在明确技术阻断，不生成或接受以下证据：目标背景／pen／highlighter／region 洞／clear 的合格像素 fixture、fixture-only 设备丢失恢复、长循环 GDI/USER 阈值。候选 DComp 确实能提交透明 Direct2D surface，但在 pointer 输入不变量失败后，继续把像素、设备恢复和资源计数标成通过没有意义。`MeetingSemanticOverlayWindows.cs` 最终保持原 GDI 低 alpha PoC，仍不得用于开发接线。

解除阻断至少需要先批准并验证一种架构变化：使用两个本方 HWND 并重新证明严格层级／遮挡／清理；使用单 HWND 的局部动态 HRGN（仅当前可绘制交互区域命中，但空白起笔与 retained scene 需另行设计）；或引入经过验证的原生输入/合成宿主，使 pointer 穿透不依赖跨进程 `HTTRANSPARENT`。在此之前 1A.2/1A.3/1A.6 均保持未完成。

阻断确认后的最终回归：C# x64 编译、model 3/3、layout 1/1、adapter 8/8、annotation session 9/9、protocol（含 47 秒寿命）、backpressure、adapter state、full、negative（18 进程、2 个预期异常、0 强杀）、race（4 进程、0 强杀）、app/Electron typecheck、OpenSpec strict 和 `git diff --check` 均通过。最终检查不存在 `MeetingSemanticOverlayWindows` 残留进程。OpenSpec CLI 在输出 valid 后出现 PostHog 遥测网络超时，但命令退出成功；不影响 strict 结果。未提交，未接 main/meeting。

## DPI / 坐标隔离验证（2026-11-25）

本轮先用 `EnumDisplayMonitors`/`GetDpiForMonitor` 只读查询拓扑，未修改系统缩放：仅一块显示器，物理矩形 `(0,0)-(1920,1200)`，scaleFactor `1`，即 DPI96。由此明确以下证据边界：

- 实际 HWND：PMv2 target 的 DWM frame `(87,80,626,413)`，双 overlay 的 visual/input DWM frame 与其逐项相等；target 外框另为 `(80,80,640,420)`，未把不可见 resize border 混入映射。平移 `(+40,+30)` 后稳定 frame 为 `(127,110,626,413)`，尺寸不变，旧事务撤销，最终 active epoch `2→4`，input 在 pointer 模式保持关闭。
- awareness 对照：通过 `SetThreadDpiAwarenessContext` 分别创建 system-aware 和 unaware 自有 target，PMv2 helper 读回有效物理 DWM frame；三种 target 的 `GetDpiForWindow` 都是 96。该结果只证明 helper 在当前 DPI96 环境不受 fixture awareness API 视图误导，不声称测过真实 125%/150%。
- 环境缺口：单屏没有可见负坐标，也没有跨屏或不同 DPI 显示器，因此逐屏覆盖、负坐标可见窗口、跨屏移动、混合 DPI 和真实 `WM_DPICHANGED` 均未验收。新增纯函数测试覆盖大/负虚拟坐标、32 位边界与溢出拒绝、零尺寸拒绝、相交 region 的局部坐标转换及归一化边界，只算模型证据。
- `WM_DPICHANGED` 审查与实现：收到消息先 cancel/撤 input、清空 region 并隐藏，再采用建议 rect；周期读回目标新 DWM frame 和 `GetDpiForWindow`，重建物理 surface 后按可信快照提交新 epoch。当前机器不能触发真实 DPI 迁移，双 HWND 消息顺序和捕获帧到 DWM frame 的映射仍须产品接线后联合确认。

新增 `meeting-semantic-overlay-geometry.{cjs,test.cjs}` 与 `meeting-semantic-overlay-dpi-validation.cjs`。本轮实际通过：相关 Node 单测/layout/adapter 17/17、C# x64 编译、DPI validation（PMv2/system/unaware、三 HWND DWM frame、一轮同 DPI 移动、0 强杀）、dual（像素/设备恢复/300 次资源循环，GDI `8→8`、USER `5→5`）、full、negative（18 进程、2 个预期异常、0 强杀）、race（4 进程、0 强杀）、protocol、backpressure（1024 个有限事件、139ms EOF）、adapter state、app/Electron typecheck、OpenSpec strict 和 `git diff --check`。最终不存在 `MeetingSemanticOverlayWindows` 残留进程。没有启动会议、没有接产品入口、没有提交。

## 未打包开发接线追加（2026-11-25）

本轮将已经隔离验证的 semantic helper 接入会议开发路径，但继续默认关闭，未启动或重启应用，也未执行真人测试：

- `electron/main.mjs` 通过独立 router 在 Windows x64、unpackaged、`JUGGLEWORK_SEMANTIC_OVERLAY_POC=1` 时优先选择 semantic。semantic 被选择但 helper、identity 或后续门禁失败时保持 `selected:true, available:false`，不会静默回退 `JUGGLEWORK_WINDOW_ANNOTATION` 的 Electron canvas 路线。整屏、macOS 和未选择 semantic 的路径保持 legacy。
- picker 使用固定 `.dev-helpers/window-annotation` identity helper 认证 HWND/PID/进程创建 FILETIME；main 自身创建时间也由 helper `GetProcessTimes` 取得。semantic executable 固定在 `.dev-helpers/semantic-overlay`，renderer 不能指定路径或身份。
- main controller 仅创建一个 content-protected、无 parent 的 toolbar BrowserWindow；本地 visual/input 均由 native helper 拥有。toolbar 只显示 pointer、pen、highlighter、undo、clear、exit，legacy toolbar 能力不变。
- compositor 发布就绪携带真实 video pixel size；只有 identity watcher 的可信 `actualSize` 与该尺寸逐轴相等后才开放入口。typed IPC 和 native 事件以 `captureId`、`annotationId`、`nativeSessionId`、`generation`、`seq` 隔离，并校验 main sender/main frame、scene 结构、尺寸和上限。
- renderer 持有 scene/history，native 只提供可信 pointer/state；main 同步有限 scene 给 native，并复用既有 `jugglework:meeting:window-annotation` scene 事件给现有 compositor。不增加 RTC、`getDisplayMedia`、ZEGO publish 或第二媒体合成器。
- 生命周期接线：minimized 隐藏 toolbar、暂停 compositor；unknown 隐藏 toolbar并撤远端旧墨可见性；可信 active/新 epoch 恢复。resize 发 `closed:resized`，清 scene且共享继续；受信 target close 发 `closed:target-closed`，复用既有 receiver 停止共享；helper exit 以 `tracking-lost` fail closed。修复了 teardown 先清 current 导致 closed 事件无法发送的问题，并增加双事件断言。

接线文件包括 `meeting-semantic-overlay-dev.mjs`、`meeting-semantic-annotation.mjs`、`meeting-annotation-router.mjs`、`semantic-annotation-preload.cjs`、`main.mjs`、`preload.mjs`、`desktop-ipc.ts`、`desktop.ts`、`meeting-semantic-annotation-controller.ts`、`meeting-semantic-annotation-events.ts`、`store.ts`、`window-share-compositor.ts` 与 toolbar capability 文件。

本轮自动结果：媒体运行时 35/35；Electron semantic/legacy/identity/picker 定向 176/176，router 2/2；app 与 Electron typecheck 通过；`git diff --check` 通过。OpenSpec strict 在文档更新后重新执行。媒体运行时 harness 改为在系统临时目录加载编译模块，并由 `t.after` 删除，避免 Bun 大型嵌套 data URL 解码限制；断言已包含新 `pixelSize` 协议。

真人测试前仍未完成且不得由自动测试替代：代表性真实应用的硬件 pointer/pen/highlighter 与工具栏操作、普通遮挡和菜单/popup、最小化恢复与系统边角缩放、125%/150% 和混合 DPI/多屏、同值 HWND 复用竞态与 PageHeap、真实 ZEGO 双端 1080p/近 4K 基线、签名安装包/路径/安全软件/卸载清理。开发开关继续默认关闭，不构成产品放行。

## 开发接线端到端自动 smoke 追加（2026-11-25）

在不启动开发 app、不创建真实会议、不操作用户窗口的条件下，新增 `apps/app/scripts/meeting-semantic-wiring-smoke.ts`。它使用固定 `.dev-helpers/semantic-overlay/MeetingSemanticOverlayWindows.exe`，每个故障场景创建独立自有 target，真实调用 `createMeetingAnnotationRouter`、`createMeetingSemanticAnnotation`、`createWindowsSemanticOverlay`、`attachMeetingSemanticAnnotation` 和 `createWindowAnnotationReceiver`；Electron 窗口仅使用 fake toolbar BrowserWindow，main sender/frame 和 renderer DOM 事件链保持受信边界。

实际结果：8 次 toolbar-only 会话，17 次 compositor callback，16 个 target/helper/occluder 子进程全部自然关闭，0 强杀。覆盖 semantic flag 只选 identity target、单屏与 DPI96 gate、helper hello、OS 自有输入到 renderer session/scene/main/native retained scene/compositor callback、pointer 目标点击、topmost unknown 与恢复、minimize/restore、resize 仅退出标注、受信 target close 触发一次 stop-share、helper crash、manual close及快速重开旧消息隔离。媒体哨兵最终为 `startShare:1`、`publish:1`、`stopShare:1`，其中 stop 只来自 target close；没有第二次 start/publish。

本轮发现并修复：

- preload 原先把 semantic native 事件转发到 compositor 的 `jugglework:meeting:window-annotation` DOM channel。两类事件各自独立递增 `seq`，可能让 receiver 将后续 scene/closed 当成迟到消息。现 semantic 使用独立 `jugglework:meeting:semantic-annotation` channel，并新增 renderer 回归。
- helper 在最小化恢复动画中会把首个瞬态不同 DWM 尺寸立即锁为 terminal resize。现尺寸候选期间先撤 input、隐藏双层并保持 unknown，连续三次读到同一新尺寸才确认 `resized`；回到 baseline 则清候选并按完整门禁恢复。真实 full 验证重新通过 minimize/restore 与 resize terminal，DPI 验证保持通过。

最终验证：wiring smoke 通过；Electron 定向 15/15；Bun semantic/session/compositor/runtime 65/65；模型/几何 8/8 与 x64 layout 1/1；原生 full、DPI validation；app/Electron typecheck；显式 semantic flag 的 desktop build；OpenSpec strict；`git diff --check`。构建只有既有大 chunk 和 `DEP0190` 警告。未提交、未推送。

剩余真人事项不变：真实外部应用的硬件 pointer/pen/highlighter 与工具栏；普通遮挡、菜单/popup、系统边角缩放和真实移动观感；125%/150%、负坐标、多屏/混合 DPI；真实 ZEGO 双端同轨与 1080p/近 4K 性能；PageHeap、同值 HWND 复用竞态；签名安装包、非 ASCII 路径、安全软件与卸载清理。
## 2026-11-26 semantic 接线审查自动修复

- native 目标 DPI96 改为启动至退出的硬门禁。启动模拟 120 在 hello 前拒绝；运行模拟 DPI change 输出 `unsupported-dpi,input:false,visible:false` 后终态退出。模拟通过显式 fixture 注入，当前实际显示器仍为 DPI96，不构成真实 120/125% 证据。
- renderer/main scene 改为单一 revision 事务：committed scene single-inflight/coalesce latest，main 等 native ACK 后才发布同 revision compositor 与 toolbar history。native setScene 故障、旧/重复 revision、迟到 ACK、toolbar close/crash/navigation、main renderer gone 均有定向回归。
- adapter dispose/replacement 有界等待 child，超时 kill 并公开结果；覆盖 hung helper 和 stdout drain。所有 teardown/shareStopped 入口先停止 readiness watcher。
- 两轮跨进程 wiring smoke 均通过：每轮 16 个进程全部自然关闭、0 强杀，媒体 start/publish 各 1，target close 仅一次 stopShare。原生 protocol/full/negative/race/backpressure/adapter-state/DPI 回归成功；app build、app/Electron typecheck、semantic 定向 Bun 66 项和 Electron 定向测试通过。
- 全量基线仍有与 semantic 无关的并发工作树失败：Desktop pretest 的 macOS signer fixture 1 项；App 3026 通过、20 失败、3 个环境/未处理错误，涉及品牌导航、managed config、文件 MIME、登录文案、marketplace 结构和无 `localStorage`。本轮未修改或回退这些文件。
- 自动可修的 semantic 真人前阻断已收口。剩余均需真人/环境证据：真实 125%/150% 与混合 DPI/多屏、硬件 mouse/pen/highlighter、代表性外部应用、PageHeap/同值 HWND 复用、真实 ZEGO 双端性能、签名安装包/安全软件/非 ASCII 路径与卸载清理。

## 2026-11-26 rectangle / ellipse / arrow 增量

- typed `MeetingSemanticScene`、main↔native adapter 和 C# protocol 统一为带 `id` 的 `stroke|shape` union。shape exact schema 为 `type,id,kind,color,size,x1,y1,x2,y2`；四层拒绝未知字段、重复/非法 ID、非法颜色/尺寸/归一化坐标、超过 128 elements、256 points/stroke、4096 总复杂度或 64 KiB 的输入。旧 revision/迟到 ACK 行为不变。
- renderer session 开放 rectangle/ellipse/arrow，并继续复用既有 annotation model/history。native mode 携带 tool kind；shape draft 只取起点与最新点，不按自由线绘制；pointer up 批次仍回到 JS 权威提交。main 只在 native retained scene ACK 后向 compositor 发布同 revision，没有第二媒体或重复 publish。
- native retained `SceneElement` 保存 ID。Direct2D rectangle/ellipse 使用对应 primitive，arrow 轴线与两条头边使用与 `annotationArrowHeadSize` 相同的 `max(12,size*3.5)`。surface/device 重建从 retained union 重绘。
- semantic toolbar 能力恢复 ellipse/rectangle/arrow；窗口宽度由 grip、6 工具、5 色、分隔、undo/clear/close 的实际固定尺寸计算，不再固定 480。legacy controller/tool capability 未改。
- 实际自动证据：C# x64 编译；session/compositor 定向 34/34；main/adapter 19/19（malformed/duplicate/limits/late ACK）；真实 protocol union；dual 像素矩形四边、椭圆四极点、箭头轴线/头部、clear、occluder 洞、device loss；300 次 stroke/rectangle/ellipse/arrow 混合 scene 后 GDI `8→8`、USER `5→5`。full、negative（18 进程/0 强杀）、race（4 进程/0 强杀）、backpressure、DPI、adapter-state 和 shape wiring smoke 均通过；smoke 为 8 个 toolbar 会话、17 次 compositor callback、16/16 进程自然退出，媒体 `startShare:1,publish:1,stopShare:1`。app build、app/Electron typecheck、OpenSpec strict、diffcheck 通过；app 全量基线为 3033 pass/18 fail/3 errors，Desktop pretest 有既有 macOS signer fixture 1 项失败，均与 semantic 无关且未改动。未启动或重启 app，未提交。

## 2026-11-26 semantic laser transient

- semantic session 现复用 `AnnotationStroke` 生成 laser，但不提交 history；renderer 注入单调 clock/scheduler，release 后按 `LASER_FADE_MS=1200` 线性淡出，并持续向现有 `WindowAnnotationScene.lasers` 发布直至空列表。
- renderer→main→native 使用独立 `laserRevision + epoch` 的最多 32 条全量 transient 状态，不修改 committed scene、history 或 `sceneRevision`。main、adapter 和 native 均执行 exact schema、点数/字节/数量、session、epoch 和旧 revision 校验。
- native retained laser 使用红色三层 Direct2D 线条近似 `annotationLaserStyle` 的主体和 glow；device loss、unknown、epoch、backpressure、abort、mode switch、close 均清空，恢复不复活旧 laser。toolbar capability 为准确 8 工具并按工具数计算宽度。

## 2026-11-26 semantic eraser 增量

- annotation model 增加纯函数像素 hit：stroke 按存储折线段和实际 stroke width，rectangle 只测四边，ellipse 测径向边界距离，arrow 测 shaft、两条 head 边和填充三角形；提前包围盒并钳制 viewport、stroke 与容差，覆盖反向、退化、非有限输入和极端尺寸。
- renderer session 在 down/move 累计命中 ID，draft scene 立即过滤但不改 history；cancel 恢复，up 仅一次 commit，undo 可恢复。laser 尚未进入 semantic history，不能被擦除。工具切换、输入缺口和新 epoch 都撤销 preview。
- 本地 native 协议新增严格 `preview(previewRevision,epoch,hiddenElementIds)`；retained committed scene 不变，`RenderVisual` 仅跳过本 epoch 隐藏 ID。scene ACK、abort/mode、unknown/device loss/epoch 和 close 清 preview。main 以独立 revision 把过滤 scene 发给既有 compositor，不触碰 toolbar history；committed scene 仍须 native ACK 后发布，旧 preview/session/epoch 不能覆盖提交或新会话。
- toolbar capability 恢复 eraser，并按 7 个工具计算宽度。legacy toolbar 未改，不新增采集、发布或第二媒体。
- 几何偏差：Konva stroke 使用 `tension:0.35` 的曲线路径，而 semantic hit 有意按有限的存储折线段计算；ellipse 采用解析径向边界距离；两者都不模拟 Konva/Canvas 的抗锯齿 coverage、line cap/join 栅格化。因此语义和 stroke width/tolerance 对齐，但不承诺逐像素完全相等。
