# Windows 单窗口标注：P0 测试夹具

本夹具用于准备 Windows 实机取证。它创建一个可调整大小的合成 WinForms 窗口，客户端区域有 `TL`、`TR`、`BL`、`BR` 和 `C` 五个标记。所有移动、缩放和 Snap 均由测试者操作该窗口。

## 启动

在交互式 Windows 10（1703 或更新版本）或 Windows 11 会话中，从仓库根目录运行。无需管理员权限。

**只测 Win32（系统自带的 Windows PowerShell 5.1 / .NET Framework）：**

```powershell
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File .\apps\desktop\scripts\meeting-window-p0.ps1
```

**同时测 Chromium 选窗、Electron DIP 和视频帧**（`apps/desktop` 的开发依赖已安装；使用仓库固定的 Electron 版本）：

```powershell
pnpm --dir apps/desktop exec electron ./scripts/meeting-window-p0.cjs
```

**独立 Win32 只读跟踪（不启动采集）**：

```powershell
pnpm --dir apps/desktop exec electron ./scripts/meeting-window-p0.cjs --native-only
```

**独立 Electron 相对层级／输入候选（不采集，只有合成夹具）**：

```powershell
pnpm --dir apps/desktop exec electron ./scripts/meeting-window-p0.cjs --overlay
```

Electron 探针会自行启动一个新夹具；不要给它传外部 HWND 或手动选窗。采集模式仅枚举窗口来源（无缩略图、无图标），通过十进制字符串精确比对来源 ID 中的 HWND，再核对夹具的随机标题。只有唯一匹配才请求采集。采集模式的终端输出只有匹配结果，不含标题和原始 ID；探针不会记录其他窗口的标题或内容，也不会读取像素或保存截图、帧文件。关闭夹具即结束；脚本默认只输出到终端。

## 独立跟踪操作与判读

1. 等待 `type:"native", change:"baseline"`。独立的 Windows PowerShell 5.1 观察进程只接收启动时的 HWND、随机标题和 Electron 启动的子进程 PID；后续不使用夹具自报的 `geometry`。观察进程持有只查询／等待权限的进程句柄，读取创建时间，并在每次成功采样前后核对窗口归属、随机标题及进程存活状态。
2. 在同一显示器内分别拖动标题栏、右边、下边和右下角。同 DPI、同状态时，只有 `GetWindowRect` 的 `outerPx` 宽或高变化才算 `resize`。外框仅平移且 DWM 边框同步平移时记为 `move`；外框尺寸不变、但 DWM 边框尺寸或相对外框的偏移发生变化时记为 `mapping-change`。判定使用 Per-Monitor V2 线程读取的物理像素。先前 Windows x64、Electron 44.0.0、125% 同屏样例中，纯移动时 Electron DIP 宽高可浮动 1，稳定帧与 DWM 每轴相差 0–1 像素；后者仅是该样例的观察，不是裁剪规则或通用容差。
3. 测试贴靠、最大化、最小化、恢复及跨屏。状态变化记为 `state-change`，同状态下 DPI 变化记为 `dpi-change`；两者都不归为同 DPI 的 `resize`。最小化时两个矩形均为 `null`。每步停约两秒；尝试每 100 ms 发起一次采样，同一时间最多一个请求，且各 Win32 查询不是原子操作。
4. `unavailable` 表示身份或几何暂不可验证；下一次有效样本重新建立基线。它不等于窗口或应用关闭。夹具私有管道里的 `closed` 只是关闭意图：探针立即停止轮询并丢弃迟到回复，只有夹具在 5 秒内以状态码 `0` 退出才对外输出 `closed`。非零退出或超时会报错。轮询可能漏掉两次采样之间的同进程 HWND 复用，尤其是新窗口沿用同一标题时。

清理时，探针先关闭所启动子进程的 stdin。观察进程在 EOF 时退出；WinForms 夹具仅在 `-Probe` 模式下把 EOF 当作退出请求。探针等待 2 秒，仍在运行时尝试终止所启动的子进程，最多再等待 1 秒。超时会报错，不能据此确认进程已退出。

`native` 记录中的 `hwnd` 和进程创建时间 `processCreated`（Win32 FILETIME）是精确十进制字符串，`pid` 是数字。随机标题只走私有管道；分享日志时请去掉这三个身份字段。独立观察进程及混合 DPI 等场景仍待 Windows 实机验证。

## `--overlay`：合成目标上的相对层级／输入实验

这是可独立运行的 **fixture-only 候选实现**，不加载会议应用、不改生产开关、不枚举采集来源、不调用屏幕采集、不注入鼠标或键盘。新增一个静态洋红笔迹窗和四个可见浅黄色边缘输入窗，均为无焦点、非全局置顶的 Electron 自有窗口。`Draw` 仅切换输入归属，不创建可编辑笔迹模型。目标客户区顶部 80 DIP 留给原生按钮及计数显示，不属于笔迹输入区域；标题栏中部仍可拖动。

### 原生证据和失败策略

- 目标位置只来自独立观察进程：Per-Monitor V2 下的 `GetWindowRect`、DWM 边界、`GetClientRect` / `ClientToScreen`；四条边的候选宽度由 `GetSystemMetricsForDpi(SM_CXSIZEFRAME/SM_CYSIZEFRAME) + SM_CXPADDEDBORDER` 得到，不以夹具自报 `geometry` 驱动。此宽度不是所有 Windows 窗口缩放热区的证明，必须做四边四角真实拖拽。
- 初次创建和每次跟随后，自有层保持鼠标穿透；待下一次原生回读确认五个 HWND 的精确十进制字符串、Electron PID、随机完整标题、物理边界、DPI、可见性、`WS_EX_TOPMOST == 0`，以及 `GetWindow(own, GW_HWNDNEXT)` 精确等于下一层／目标，才启用输入。顺序自下而上为目标、ink、top、bottom、left、right。日志中的 `native-verified` 仅表示这些采样条件满足，**不表示真实输入、画面或 Windows 验收通过**。
- 自有层按顺序 `showInactive()`；不主动重排。Electron 44.0.0 的 `moveAbove()` 以 `GW_HWNDPREV` 作为 `SetWindowPos` 插入位置，可能在普通窗口与 topmost 的边界进入置顶层，因此本实验不调用它。原生 helper 仍只读；探针不设置目标样式、位置或尺寸，overlay 模式也不执行原夹具的 DPI 建议矩形写入分支，不移动或激活其他应用窗口。
- 首次建议在 **100% 单屏** 测试。目标须完整处于初始显示器，原生 DPI 与 Electron 缩放一致，所有候选矩形须通过物理像素→整数 DIP→物理像素的**精确**往返，并在创建后通过原生物理边界回读。125%／150% 等缩放可能因整数表示失败；不加 1 像素容差掩盖失败。即使相同 DPI，换显示器或跨屏也停止；DPI 变化优先于状态变化报 `overlay-dpi-change`，不能据此宣称混合 DPI 可用。
- 若报 `overlay-mapping`，前一条 `stage:"mapping-mismatch"` 会列出未精确往返的矩形：`role`（`outer` 是目标外框，其余为标注层）、原始 `px`、转换后的 `dip` 和转回的 `roundTripPx`。这条诊断不含窗口或进程身份字段，可单独分享；启动时发生此错误不会创建输入层。125% 实机已观察到此保护退出，未进入层级／输入验证。
- 若报 `overlay-geometry`，请回传前一条 `stage:"geometry-mismatch"`。`source:"target"` 会列出失败的校验和目标几何；`source:"layer"` 会列出首个失败层的 `role`、`plannedPx`、`plannedDip` 和 Win32 回读的 `actualPx`。这条诊断不含窗口或进程身份。100% 实机已观察到初始映射通过、创建标注层后在首次回读阶段退出，尚未启用输入。
- 同尺寸平移：先穿透全部输入，再移动自有层，等下一次回读后恢复。真实宽高变化、最小化／最大化、DWM／客户区映射变化、身份不可验证、topmost、几何回读不一致或协议错误，均移除全部自有层、关闭子进程并以非零状态退出。首次回读发现顺序不连续即报 `overlay-order`，不尝试重排，也不识别或跳过未知夹层。
- 首次层验证最多 20 秒；层创建和已有目标样本后的观察回复分别有 5 秒期限。输入计数独立读取（约 500 ms、同一时间最多一批、每批最多 5 秒），不阻塞原生跟踪。超时走相同输入移除和有界清理。轮询约 100 ms，Win32 查询非原子，两个样本间仍存在错位或层级竞争窗口；移动时等待回读会暂时放行边缘。因此本实验不能证明连续跟随期间零输入泄漏。不要快速操作来替代停稳后逐项验收。

API 依据：[Electron moveAbove](https://www.electronjs.org/docs/latest/api/base-window#winmoveabovemediasourceid)、[固定 v44.0.0 Windows 实现](https://github.com/electron/electron/blob/v44.0.0/shell/browser/native_window_views.cc)、[GetWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindow)、[SetWindowPos](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos)。

### 手工操作与判据（每步停约两秒）

1. 等到 `overlay` 的 `stage:"native-verified"`；肉眼确认静态洋红笔迹和四边黄条可见。若只有 `awaiting-native-layers` 或任何 `error`，该次不通过。
2. 默认 `Pointer`：在笔迹覆盖的客户区分别点击、按住拖动。预期 `fixture-input, role:"target"` 的 `clicks`（左键按下数）和 `drags` 增加，`overlay-input, role:"ink"` 不增；原生按钮点击不计入目标正文计数。笔迹仍显示。
3. 点击夹具 `Draw` 按钮，在同一区域点击、拖动。预期 ink 的 `overlay-input` 增加、目标正文计数不增。点 `Pointer` 切回并重复。`drags` 在松开且位移超过阈值时计数；这不是笔迹编辑或输入设备兼容性验证。
4. 两种模式分别在四边、四角按下并向外拖动；观察对应 `top/bottom/left/right` 的输入计数，目标原生外框宽高应保持不变。顶／底条包括角落，左右条不重叠角落。如果尺寸变了，探针报错退出，该次边缘保护失败；重新启动后再做对照，不回写目标尺寸。退出后重启原始夹具，确认正常可缩放。
5. 拖标题栏中部，保持完整处于原显示器。若相邻顺序保持，预期 `following-awaiting-readback` 后再次 `native-verified`，停稳后笔迹和四边对齐且输入恢复；目标大小不变。若目标激活后顺序丢失，应报 `overlay-order` 并撤层；记录触发动作，不算跟随通过。如果首次显示就报 `overlay-order`，结束该次测试，后续输入判据记为未测。
6. 点击夹具 `Occluder`，它创建一个独立、非 topmost 的 WinForms 遮挡窗。将其放到笔迹或边缘的一部分上，肉眼确认笔迹／黄条被挡住，正文点击／拖动增加 `fixture-input, role:"occluder"`，而对应下层计数不增；再拖动遮挡窗标题栏。探针不读取遮挡窗图像、不枚举其他窗口，也不以原生样本自动认证遮挡窗顺序；遮挡正确性须结合肉眼与计数人工记录。若出现未知夹层导致失败，保留失败日志，不能将“层已被清理”误写成遮挡输入通过。
7. 分别重启探针测试改尺寸、最小化、最大化及跨 DPI／跨显示器，确认报错后自有输入层确实消失。它们是失败退出检查，不是这些场景受支持。关闭按钮导致的正常退出码 0 也只说明本次至少达到过层验证并完成清理，不自动认证以上手工步骤。

`overlay-input` 为页面计数，`fixture-input` 为 WinForms 真实事件计数；均只在变化时输出。`native-verified` 附计划物理／DIP 矩形及原生层证据；发布日志请同时移除目标和层的全部 `hwnd`、`pid`、`processCreated`。不输出随机标题，不保存截图、帧或其他应用内容。

**证据状态（2026-11-23）：**本机 macOS 上只有便携策略／生命周期测试结果；未启动 Electron 夹具，未在 Windows 编译或运行两个 PowerShell 内嵌 C# 程序。透明窗输入、非激活点击、四边四角热区、遮挡、Z 序及整数缩放映射仍需 Windows 实测；没有新增 Windows 通过结论。

## 独立 Electron 8 像素边缘尺寸探针

在交互式 Windows 会话中将主屏缩放设为 **100%**（建议单屏），从仓库根目录运行：

```powershell
pnpm --dir apps/desktop exec electron ./scripts/meeting-window-p0-edge-size.cjs
```

探针在主屏工作区内逐个创建并销毁四个自有小窗，对比当前的 `resizable:false` 和候选 `resizable:true`，各测横条 `240×8` 和竖条 `8×240`。窗口始终鼠标穿透，以 `showInactive()` 显示，不全局置顶，不使用输入钩子。每组输出 `requestedDip`，以及显示前的 `beforeShowDip` 和显示约 200 ms 后的 `afterShowDip`，不含窗口或进程标识。运行完自动退出；退出码 0 表示测量完成，不表示尺寸符合请求。

先前 **100% 缩放下的 `--overlay` Win32 回读**曾观察到：一条边请求厚度 **8 px**，实际回读 **39 px**。这是脱敏的历史观测，不是本探针的结果。新探针只读 Electron `getBounds()`（DIP）；即使薄边仍为 8，也必须用现有 `--overlay` 的 Win32 回读确认物理像素尺寸。此探针也不验证层级或输入行为。

## 无界面回归测试

从仓库根目录逐文件运行；测试使用真实解析／策略／运行时代码，在 Electron／进程／管道边界提供替身，不启动 Electron 或 WinForms：

```sh
node apps/desktop/scripts/meeting-window-p0-native.test.cjs
node apps/desktop/scripts/meeting-window-p0-overlay.test.cjs
node apps/desktop/scripts/meeting-window-p0.test.cjs
node --test apps/desktop/scripts/meeting-window-p0-edge-size.test.cjs
```

回归覆盖被动显示与失序撤层、计数挂起时仍继续跟踪，以及实际模拟页面加载挂起时清理已创建的窗口。原生编译、Win32 API 调用及真实输入均不在便携测试覆盖范围内。

## 原夹具自报与采集模式：操作与预期输出

1. 等到出现 `fixture`、初始 `geometry`；Electron 模式还应出现 `electron`、`source` 的 `matched:true`，以及 `capture` 的非空 `frame`。`matched:false` 或 `type:error` 表示该次探测未通过相应阶段，不能据此认定 Windows 映射或帧采集已验证。
2. 在同一显示器内拖动标题栏，再分别拖右边、下边和右下角。纯移动比较 `x/y` 与不变的宽高；实际调整尺寸应改变宽或高。贴靠屏幕边缘触发 Snap，再解除贴靠。Snap 记录为几何变化，没有独立的 Snap 事件；最大化会显示 `state:"maximized"`。
3. 准备 100% 和 150% 两块屏，将其中一块放在主屏左侧或上方。将未贴靠的夹具拖到另一块屏并停稳，不拖调整边框。核对负的 `x` 或 `y`、`dpi`（96 或 144）与像素尺寸变化。夹具采用系统建议的 DPI 矩形；应比较拖动前后稳定的 DIP 宽高（允许取整和窗口边框差异），再与同屏实际改宽高对照。不要用帧像素变化单独判定窗口被调整了尺寸。
4. 最小化，等几秒，再恢复并等几秒，最后用窗口的关闭按钮退出。预期看到 `state:"minimized"` 且矩形为 `null`，恢复后的几何记录，以及最后的 `closed`。采集在最小化期间是否继续、暂停或恢复，要以实测为准。

每步停约两秒，让几何（100 ms）与帧（500 ms）采样收敛。以下是字段示例，不是实机记录：

```jsonl
{"type":"geometry","seq":1,"state":"normal","dpi":96,"scalePercent":100,"outerPx":{"x":100,"y":100,"width":656,"height":439},"dwmPx":{"x":107,"y":100,"width":642,"height":432},"dwmHresult":0,"outerDip":{"x":100,"y":100,"width":656,"height":439},"dwmDip":{"x":107,"y":100,"width":642,"height":432}}
{"type":"source","matched":true}
{"type":"capture","geometrySeq":1,"frameAdvanced":true,"trackState":"live","settings":{"width":642,"height":432,"displaySurface":"window"},"intrinsic":{"width":642,"height":432},"frame":{"width":642,"height":432}}
{"type":"closed"}
```

- `outerPx` 是 Per-Monitor V2 线程读取的 `GetWindowRect`，可含不可见缩放边框；`dwmPx` 是 DWM 扩展边框，调用失败时为 `null` 并保留 `dwmHresult`。DIP 由 Electron `screenToDipRect(null, …)` 转换，跨屏停稳后再比较。
- `settings` 是视频轨道公布的设置，`intrinsic` 是视频元素的固有尺寸，`frame` 是最近一次 `requestVideoFrameCallback` 回报的媒体像素宽高。三者不保证相等，也不保证等于 DWM 尺寸。`geometrySeq` 仅关联采样时最近一次几何记录；`frameAdvanced:false` 时 `frame` 可能是旧值，`true` 也不证明内容正确或没有黑帧。
- 如需保存证据，仅保留脱敏的 JSON 行（含 Windows 构建号、进程架构、Electron/Chromium 版本和夹具所在显示器缩放），并附操作步骤。混合 DPI、Snap、实际应用和标注输入仍待实机验证。
