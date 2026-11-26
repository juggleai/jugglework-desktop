# Windows 非聚焦画布 OS 输入隔离实验

## 结论

2026-11-25，Windows x64、Electron 44.0.0 / Chromium 152.0.7977.54、单屏 DPI96：独立 `focusable:false` 透明画布收到 `SendInput` 鼠标按下、拖动、释放并绘制，前台保持在自有、可聚焦工具栏。未改产品默认行为，未启动产品入口、连接会议、重启现有应用或读取凭据。

## 实现与边界

复用 `apps/desktop/scripts/meeting-nonfocusable-os-input.cjs`、验证生命周期工具，以及生产 `meeting-window-identity-windows.mjs` / `meeting-window-placement-windows.mjs` 和当前标准 C# helper。实验使用独立临时 profile、data URL 页面及三个自有窗口，不依赖开发服务器。没有 DOM click、`webContents.sendInputEvent` 或跳过生产严格邻接。

本轮补充：DWM 目标精确边框映射、输入点实际光标读回、画布原生矩形核验、激活消息期间的前台检查、完整实验 PID / helper 清理记录。输入前核验 HWND 属于本进程且为顶层窗口，命中点属于自有画布，所有窗口可见，画布具有 `WS_EX_NOACTIVATE`，工具栏为前台，无其他鼠标键或修饰键按下。逐点发送前执行生产只读双向邻接检查；拒绝即停止。`executeJavaScript` 仅安装/读取事件与像素观测，没有合成输入。

## 运行记录

1. 首轮未发送鼠标输入：严格隐藏放置报 `target-size`，退出 1。发现 Electron 请求矩形与 DWM frame 不同，修正夹具使用实测 frame；未放宽适配器。
2. 修正后退出 0：实测 frame `{x:99,y:160,width:482,height:281}`。
   - 隐藏放置、显示放置全部通过。
   - 14/14 stationary 严格复核通过。
   - 9/9 输入前严格复核、输入后严格复核通过。
   - 1 次 `pointerdown`、9 次 `buttons:1` 的 `pointermove`、1 次 `pointerup`；所有记录 `isTrusted:true`。
   - 墨迹像素 1,736；画布 `isFocused:false`，工具栏 `isFocusable:true`。
   - 所有输入检查点前台为自有工具栏，激活消息检查记录 `foregroundViolations:0`。
3. 最小回归：身份、放置及生命周期测试共 72 项通过；脚本语法检查通过。

证据文件位于获准临时目录：

- `C:\Users\juggl\AppData\Local\Temp\opencode\nonfocusable-os-input-20261125.json`（首轮拒绝）
- `C:\Users\juggl\AppData\Local\Temp\opencode\nonfocusable-os-input-20261125-frame.json`（成功轮）

## 清理确认

两轮全部自有窗口销毁、注入左键释放；成功轮 27 个 helper 全部正常退出 0，无强杀。启动器确认两轮 Electron 主进程实际退出；随后按证据中的 41 个 PID 查询，无任何实验进程存活。Electron 退出前 profile 仍有文件占用，因此在进程退出后删除两个精确 profile 路径，并用 `Test-Path` 确认均不存在。未操作其他进程。

## 解释限制

结果证明此环境下“不可聚焦画布仍能接收 OS 鼠标绘制，工具栏保持可聚焦及前台”可行。这里的前台不变指实验工具栏已主动成为前台之后的绘制阶段，不是实验开始前桌面前台从未变化。

OS 输入是 Windows `SendInput` 注入，非真人硬件输入；`isTrusted` 不证明硬件来源。窗口核验与注入之间仍非原子事务；检查点及激活消息观测不能证明任意极短时间段的全局前台状态。只测试短程单次拖动、单屏 DPI96 和隔离页面，未覆盖多屏/缩放、真实标注 UI、跨进程目标、长时间运行或真人会议。

旧轮当时引用了“canvas-focus 后 hidden-other”的诊断。用户最新真人证据已更新为 **toolbar-focus 后 hidden-other，canvas 无 focus**；旧实验没有真实点击 toolbar，不能用旧通过结果解释或否定最新证据，不能据此宣称根因确定或产品问题已解决。

## 补证：toolbar owner 两臂（2026-11-25）

### 实现及固定范围

新增独立入口 `apps/desktop/scripts/meeting-toolbar-owner-os-input.cjs`，沿用旧脚本的 Win64 `SendInput` 布局、DWM 精确 frame、身份/命中/原生矩形安全检查、生产 identity/place/check 适配器，以及 `meeting-window-validation-lifetime.cjs`。没有修改旧实验脚本或产品实现、默认配置、现有会议。保留原有全部未提交修改，没有提交或 push，没有读取凭据。

唯一实验变量为 toolbar 构造时是否提供 `{parent: canvas}`：

- `detached`：`GetWindow(toolbar, GW_OWNER)` 原生读回为 0。
- `parent-canvas`：同一 API 原生读回精确等于本轮 canvas HWND。

两臂都使用独立 profile、三个自建 Electron 窗口和静态 data URL；canvas 从构造起不可聚焦，toolbar 可聚焦。没有调用 `show()/focus()/SetForegroundWindow`，显示使用 `showInactive()`。不读取外部窗口标题、内容或会议身份。前台只记录 `target / toolbar / other`，不枚举外部窗口。

固定上限为每臂两轮，每轮新进程。标准 helper 由当前 `MeetingWindowIdentityWindows.cs` 单独编译至临时目录，参数为 `/nologo /optimize+ /target:exe /platform:x64`，没有 `FIXTURE_NO_SEND_CHANGING`，不重复 NOSENDCHANGING 变体。

入口实现的预定顺序：初始 pointer 放置 → OS 点击 target 成为前台 → OS 点击 toolbar 的真实 Pen 按钮 → 产品式双层隐藏、hidden place、canvas showInactive、visible place、toolbar showInactive、最终只读严格检查 → canvas OS 拖动 → OS 点击 Pointer 按钮并完成同样放置 → OS 穿透点击 target。工具状态只由按钮收到的 `isTrusted` click 更新，`executeJavaScript` 仅读取按钮几何、工具状态、事件、墨迹；没有 DOM click。输入前核验自有顶层 HWND/PID、owner、窗口可见性、三个原生矩形、canvas NOACTIVATE、输入命中、修饰键/鼠标状态及标准严格检查；移动后读回真实光标位置。按下和释放连续同步执行，激活后的严格检查拒绝即停止该臂，不重排、不补点击。

### 真实运行结果

环境仍为 Windows x64、Electron 44.0.0 / Chromium 152.0.7977.54、单屏 DPI96；实测 frame `{x:99,y:160,width:482,height:281}`。

| 轮次 | toolbar owner 原生读回 | 初始 hidden / visible / final | target 点击前两次严格检查 | OS 点击后的前台 / canvas focus | 点击后严格检查 | 退出码 |
| --- | --- | --- | --- | --- | --- | --- |
| detached 1 | none，核验通过 | 全通过 | 全通过 | target / false | 拒绝 | 1 |
| parent-canvas 1 | canvas，核验通过 | 全通过 | 全通过 | target / false | 拒绝 | 1 |
| detached 2 | none，核验通过 | 全通过 | 全通过 | target / false | 拒绝 | 1 |
| parent-canvas 2 | canvas，核验通过 | 全通过 | 全通过 | target / false | 拒绝 | 1 |

四次相同的首个拒绝：

```text
stage: target-activation-post-activation
result: hidden-host-target-not-below
reason: order-check-own-hidden-target-not-below:other-class-empty-unowned
foreground: target
canvasFocused: false
```

每次只向已核验命中自有 target 的点发送一次 OS 点击。target 成为前台已有原生观测；**激活后的严格邻接前置条件未通过**，因此 `completed` 仅含 `initial-placement`，`target-activation` 未记为完整通过。不能把此拒绝写成最新真人的 `target-below:hidden-other`：本轮是宿主自身隐藏邻居、且 target 不在预期下方的诊断，两者不是同一失败分类。

### 明确未覆盖

四次均在 target 激活后的第一条严格检查立即停止，未绕过失败。以下全部未执行：真实 Pen 点击、toolbar-focus 后检查、Pen 工具状态/可信 DOM 点击验证、Pen 隐藏/显示/最终复核、canvas 拖动/墨迹验证、Pointer 点击及状态、Pointer 放置和最终穿透 target。真实按钮和对应取证路径已实现，但本轮没有到达，不能声称验证通过。没有取得 owner 对 toolbar-focus 路径是否有效的证据，也没有复现或解释最新真人 hidden-other。

### 清理、测试与证据路径

- 四次各 7 个标准 helper 共 28 个均收到实际 `close`：每次 6 个正常退出 0、最后一个因严格拒绝退出 1；无 signal、无强杀。拒绝 helper 的 `graceful:false` 表示非零退出，不是存活或清理失败。
- 四次全部自有窗口销毁，注入左键已释放；启动器等待各 Electron 主进程实际 close，按每轮记录的 Electron/helper PID 查询，`remainingPids:[]`，再删除该轮精确 profile，确认不存在。
- `node --check apps/desktop/scripts/meeting-toolbar-owner-os-input.cjs` 通过；identity、placement、lifetime 三文件最小回归 **72/72 通过**；标准 helper 编译通过。
- 环境准备曾遇到失效的临时 Electron 路径（启动 `ENOENT`，未启动实验），随后临时 koffi 依赖不存在导致四次入口准备退出（未创建窗口、未输入，均确认进程/profile 清理）。这些准备失败保存在无 `live` 前缀的 JSON；不算两臂有效运行。之后仅在临时目录安装固定 `koffi@3.3.8`，禁用安装脚本，使用仓库已有 Electron。有效运行仍严格为每臂两轮，无第三轮。

所有机器证据位于 `C:\Users\juggl\AppData\Local\Temp\opencode\`：

- `toolbar-owner-live-detached-round1.json` / `.json.log`
- `toolbar-owner-live-parent-canvas-round1.json` / `.json.log`
- `toolbar-owner-live-detached-round2.json` / `.json.log`
- `toolbar-owner-live-parent-canvas-round2.json` / `.json.log`
- `toolbar-owner-live-summary.json`（实际退出、存活 PID 和 profile 删除读回）
- `run-toolbar-owner.cjs`（固定两轮启动器，只检查记录内 PID、只删除本次自建 profile）
- `MeetingWindowIdentityWindows.toolbar-owner-standard.exe`（本次标准编译）

结论：两种 owner 构造均可通过初始严格放置，但本环境中先 OS 激活自有 target 会先于 toolbar 路径触发同一严格拒绝。补证提供了这个前置阻断的两轮对照；没有证据支持“添加 owner 能解决真人 toolbar-focus 后失序”，也不能由本轮拒绝排除该方案。

## 单次 watcher 恢复实验（2026-11-25，后续任务）

### 实现

仅修改隔离入口，新增 `meeting-toolbar-owner-recovery.cjs` 与对应测试，未修改产品默认、生产控制器或原生严格邻接适配器。参考 `meeting-annotation.mjs` 的 pointer 分支：只允许 `hidden-host-target-not-below` 消耗一次恢复预算；立即双层撤输入并隐藏，经真实 `createWindowsWindowIdentity().watchWindow` 校验 HWND/PID/进程创建时间，跳过十个可信 visible 样本，使用第十一个新样本精确几何执行原有完整 hidden / visible / final 路径。`geometry-pending` 不计数。单个 2500ms 截止时间同时覆盖观察与放置，不被样本或 helper 回复续期；到期撤层，每个异步阶段之后再次检查期限，最终成功前不开放输入。没有 sleep 后重试，没有降低严格邻接，也没有添加第二次恢复。保留输入前全部身份、owner、原生矩形、可见性、NOACTIVATE、命中及按键状态核验。阶段记录新增 owner 原生读回与双窗口 focus。

### 实际运行与实验错误

本次严格为 detached / parent-canvas **各一轮**，第一臂完成实际退出、PID 与 profile 清理后才启动第二臂。两臂均初始 hidden / visible / final 通过，OS 点击自有 target 后 foreground=target、canvasFocused=false、toolbarFocused=false，owner 核验始终通过，随后同样得到 `hidden-host-target-not-below` 并撤层。真实 watcher 均交付 11 个可信 visible 样本：

| 臂 | 第一个样本 | 第十个样本 | 第十一个样本 | 停止耗时 | 结果 |
| --- | --- | --- | --- | --- | --- |
| detached | 48ms | 1035ms | 1145ms | 1145ms | `recovery-target-size-or-identity`，退出 1 |
| parent-canvas | 65ms | 1055ms | 1164ms | 1165ms | `recovery-target-size-or-identity`，退出 1 |

**此处是夹具新增校验的实现错误，不能归因于产品恢复失败。** watcher 的 `bounds={x:99,y:160,width:482,height:281}` 是 DWM 映射区域，`actualSize={width:496,height:288}` 是 GetWindowRect 外框；执行版本误将 actualSize 与 bounds 尺寸相等作为前置条件。原生 helper 源码明确分开输出两者。两臂因此都未调用恢复 hidden / visible / final，不能评价恢复严格邻接能否通过。运行后已把该校验修正为与初始 `GetWindowRect` 外框尺寸比较；修正版**未做 OS 重跑**，遵守本次两臂各一轮上限，不以修错追加预算。

每轮仅一次经过身份/命中核验的 target OS 点击；本轮停止发生在读取 target DOM 可信事件之前，因此只有 OS 注入成功、命中与前台证据，没有本轮 target `isTrusted` DOM 事件证据。Pen 点击、toolbar-focus 后检查、canvas drag、墨迹、Pointer 点击与穿透均未执行。两臂没有到 toolbar，不能声称 owner 有效、复现真人 hidden-other 或产品问题已解决。当前代码的完整恢复路径仍需另一次明确授权的运行验证。

### 清理与证据

- 每轮三个窗口全部销毁、左键释放、8 个 helper 全部收到实际 close；其中 6 个退出 0、1 个严格拒绝退出 1、1 个持续 watcher 在 stop 时 SIGTERM。没有清理超时后的强杀（所有 `forced:false`）；watcher 的 SIGTERM 是生产 watcher 取消接口的正常停止方式，不称其为退出 0。
- 两轮 Electron 主进程实际退出，记录 PID 查询均 `remainingPids:[]`；两个精确临时 profile 删除后确认不存在。parent-canvas 的 cleanup 行中 owner=false 是窗口销毁之后的读回，运行阶段 owner 全通过。
- 启动器仅运行两个固定臂，拒绝覆盖既有证据；未重启、关闭或操作现有产品/会议，没有提交。
- 证据根目录：`C:\Users\juggl\AppData\Local\Temp\opencode\`。
  - `toolbar-owner-recovery-detached-round1.json` / `.json.log`
  - `toolbar-owner-recovery-parent-canvas-round1.json` / `.json.log`
  - `toolbar-owner-recovery-summary.json`：逐轮实际退出、窗口/helper/PID/profile 清理读回。
  - `run-toolbar-owner-recovery.cjs`：固定每臂一轮启动器。
- 最小测试：identity / placement / lifetime 原有 72 项，加恢复 4 项，共 **76/76 通过**。恢复测试覆盖跳过十样本及第十一个新几何、pending 不计数、终止样本拒绝、原期限覆盖 placement、拒绝不再次放置。入口与恢复模块 `node --check` 通过。该测试通过不代表 OS 完整恢复已验证。

## 修正版单次恢复：新授权两臂各一轮（2026-11-25）

### 审阅与执行范围

执行前重新审阅 `meeting-toolbar-owner-os-input.cjs`、`meeting-toolbar-owner-recovery.cjs` 和临时 `run-toolbar-owner-recovery.cjs`。确认 actualSize 已比较初始 GetWindowRect 外框尺寸，DWM bounds 独立用于映射；每会话仍只有一次恢复、固定 2500ms 原期限，无续期。没有修改产品代码或默认，没有操作现有会议或重启产品，全部 OS 输入仅命中自有 fixture。

本次仅修改临时启动器的输出命名与启动前存在性检查：使用 `toolbar-owner-recovery-fixed-*`，同时预检两臂 JSON / log 及新 summary，任一已存在即拒绝启动。旧 `toolbar-owner-recovery-*` 失败证据保留。每臂各一轮，第一臂窗口/helper/主进程/PID/profile 清理确认后才启动第二臂，没有失败重跑或追加恢复预算。

### 真实结果

环境：Windows x64，Electron 44.0.0 / Chromium 152.0.7977.54，单屏 DPI96。两臂 watcher 均确认 DWM bounds `{x:99,y:160,width:482,height:281}`、actualSize `{width:496,height:288}`。

| 阶段 | detached | parent-canvas |
| --- | --- | --- |
| owner 原生读回及运行期核验 | none，全通过 | canvas，全通过 |
| 初始 hidden / visible / final | 全通过 | 全通过 |
| target OS 激活后的首次严格拒绝 | `hidden-host-target-not-below` | 同左 |
| watcher 第十个 / 第十一个可信 visible 样本 | 1032ms / 1141ms | 1031ms / 1140ms |
| 恢复 hidden / visible / final | 全通过 | 全通过 |
| 恢复完成耗时（含观察及三阶段） | **1355ms** | **1346ms** |
| Pen OS 点击、可信 click、工具状态 | 全通过 | 全通过 |
| Pen hidden / visible / final | 全通过 | 全通过 |
| canvas OS 拖动 / 墨迹 | 通过，1736 像素 | 通过，1736 像素 |
| Pointer OS 点击、可信 click、工具状态 | 全通过 | 全通过 |
| Pointer hidden / visible / final | 全通过 | 全通过 |
| 最终 target-through 点击后严格复核 | 再次拒绝，停止 | 再次拒绝，停止 |
| Electron 退出码 / 总体 pass | **1 / false** | **1 / false** |

首次拒绝诊断两臂均为 `order-check-own-hidden-target-not-below:other-class-empty-unowned`。恢复确由生产 identity watcher 交付的样本推进：前十个仅观察，第十一个用于新几何，随后全部三个生产严格阶段 result=true，未用延时替代 watcher。没有触发 2500ms 超时。

初次 target 可信 pointerdown / pointerup / click 已读回。Pen 与 Pointer 两次按钮点击都记录目标 id 对应的 `trusted:true` pointerdown / pointerup / click；点击后 foreground=toolbar、toolbarFocused=true、canvasFocused=false，点击后只读严格检查通过。工具切换隐藏/显示后 foreground 仍为 toolbar，但 Electron `toolbarFocused=false`，因此不能把“原生前台保持 toolbar”写成“工具栏 Electron focus 全程保持 true”。

两臂 canvas 拖动均为 1 次 pointerdown、8 次 buttons=1 pointermove、1 次 pointerup，所有 canvas 事件 trusted=true；墨迹 1736 像素，target pointerdown 数量未增加。拖动所有检查点 foreground=toolbar、canvasFocused=false、ownerVerified=true，输入前严格邻接检查全通过。

最终 Pointer 穿透点击前两次严格检查通过，输入命中自有 target、SendInput 成功，前台变为 target。点击后的严格检查再次返回：

```text
stage: target-through-post-activation
result: hidden-host-target-not-below
reason: order-check-own-hidden-target-not-below:chromium-unowned
stopReason: target-through-post-activation:strict-adjacency-refused
```

恢复预算已在首次 target 激活时使用，因此两臂都未二次恢复、未再点击、未加预算，立即进入清理。`completed` 为 initial-placement、target-activation、pen-click、pen-placement、canvas-drag、pointer-click、pointer-placement；`notCovered=["target-through"]`。这里 target-through 实际已发送 OS 点击，但该阶段未完整通过，且停止发生在最终 DOM 事件/穿透数量读回之前，故没有最终穿透成功证据。

### 清理、测试与文件

- detached 主 PID 13404，parent-canvas 主 PID 25956，均实际退出；每轮 `remainingPids:[]`，精确 profile 删除后 `profileRemoved:true`。每轮 `windowsDestroyed:true`、`buttonReleased:true`、`helpersClosed:true`。
- 每轮 38 个 helper 均实际 close：35 个退出 0、2 个严格拒绝退出 1、1 个 watcher 取消后 SIGTERM；全部 `forced:false`。不把 SIGTERM 或非零拒绝写成正常退出 0。parent-canvas cleanup 时 ownerVerified=false 是销毁后的读回，运行中全部 owner 核验通过。
- 最小回归再次 **76/76 通过**（identity / placement / lifetime / recovery）；入口、恢复模块、临时启动器三个语法检查通过。没有提交。
- 证据根目录 `C:\Users\juggl\AppData\Local\Temp\opencode\`：
  - `toolbar-owner-recovery-fixed-detached-round1.json` / `.json.log`
  - `toolbar-owner-recovery-fixed-parent-canvas-round1.json` / `.json.log`
  - `toolbar-owner-recovery-fixed-summary.json`（逐轮退出码及完整清理确认）
  - `run-toolbar-owner-recovery.cjs`（此次使用的启动器）

**结论与限制：**修正版已取得真实 watcher 单次恢复的完整严格 hidden/visible/final 及 OS toolbar Pen→canvas drag→Pointer 证据；两臂在这些阶段结果相同，没有 owner 优势的证据。最终再次激活 target 会在两臂触发同一严格拒绝，整个流程仍失败。实验是单屏 DPI96、自有单进程静态页面、每臂单次短拖动；`isTrusted` 表示浏览器可信输入事件，不代表真人硬件输入。不能由此宣布真实会议 UI 或真人 toolbar-focus 后 hidden-other 已复现、已定位或已修复。严格邻接检查仍是分阶段读回，不证明所有瞬时状态。

## 跨进程原生目标：单次 parent-canvas 对照（2026-11-25）

### 范围与实现

本次授权实际执行 **一个跨进程目标实验**，没有追加同进程轮次、没有失败重试。复用已有 `meeting-window-validation-target.ps1`：审阅确认它是 PowerShell Add-Type 承载的独立 **Win32 原生窗口**，并非 WinForms。它提供真实顶层 HWND、独立 PID、消息循环、原生点击计数、stdin exit 与 finally 销毁回执；没有替换为 Electron 模拟目标。

`meeting-toolbar-owner-os-input.cjs` 新增 `--cross-process-target`，该模式固定要求 parent-canvas。target 身份由标准 helper 解析并绑定本次直系子进程 PID，生产 scoped identity 继续包含进程创建时间；canvas/toolbar 仍绑定 Electron PID。OS 输入继续要求各自顶层身份、owner、可见性、矩形、NOACTIVATE、原生命中、按键状态和生产严格邻接全部通过。未跳过隐藏邻居。目标脚本只增加可选 InitialX/InitialY（默认不变），让原生目标位于既有输入区域并为 toolbar 留出屏内空间。native 目标使用自身消息计数，不能将其说成浏览器 trusted DOM click。

toolbar 仍 parent=canvas、focusable=true，canvas 从构造起 focusable=false。恢复模块未改：仅一次、跳过十个可信 visible 样本、第十一个用于完整放置，单一原始 2500ms 不续期。新增 toolbar DOM 事件在 post-activation 严格检查前读回，以便该阶段若拒绝仍保留点击是否真正达到的证据；本轮没有到达此代码。继续使用既有 `MeetingWindowIdentityWindows.toolbar-owner-standard.exe`，没有编译或切换实验变体。

### 实际结果：恢复 hidden 阶段拒绝

环境 Windows x64、Electron 44.0.0 / Chromium 152.0.7977.54、单屏 DPI96。主 PID **29516**，目标 PID **28984**，确认不同进程；owner 原生读回为 canvas，运行期核验通过。目标 DWM frame `{x:107,y:160,width:642,height:432}`，原生外框 `656×439`。

| 阶段 | 本轮结果 |
| --- | --- |
| 初始 hidden / visible / final | 全通过 |
| target OS 点击前 pre-move / pre-down 严格检查 | 全通过 |
| target OS 点击 | 自有原生命中通过、SendInput 成功，foreground=target，canvasFocused=false |
| 激活后首次检查 | `hidden-host-target-not-below` |
| 首次诊断 | `order-check-own-hidden-target-not-below:other-class-empty-unowned` |
| watcher 第十 / 十一可信 visible 样本 | 1024ms / 1131ms，实际外框及身份核验通过 |
| 恢复 hidden 放置 | **`placement-order-unconfirmed`** |
| 恢复 hidden 诊断 | **`order-readback-unchanged-anchor-own-hidden-other-class-empty-unowned`** |
| 停止 | 1183ms，`recovery-pointer-hidden:strict-adjacency-refused` |
| Electron 退出码 / 总体 pass | **1 / false** |

拒绝时 foreground=target、canvasFocused=false、toolbarFocused=false、ownerVerified=true。没有超时，没有续期，没有第二次恢复，没有跳过隐藏窗口后继续。恢复 hidden 失败后立即保持双层隐藏/撤输入并清理，没有执行 recovery visible / final。

**toolbar 点击实际未发送、未达到。** `completed=["initial-placement"]`；target-activation 虽已注入且前台读回成功，但在其最终 native 计数读回之前停止，故该完整阶段未通过，也没有本轮目标 WM_LBUTTONDOWN 数量证据。Pen 点击及 toolbar-focus 后 stationary 检查、Pen 放置、canvas drag/墨迹、Pointer 点击/放置、target-through 全未覆盖。没有复现真人 `order-check-other` + `target-below:hidden-other`；本轮出现的 `own-hidden-other-class-empty-unowned` 是恢复放置诊断的一部分，不得混同真人失败码。

相对已有同进程 parent-canvas 轮，首次拒绝相同，但本轮单次恢复在 hidden 阶段被拒绝，而旧轮恢复三阶段通过。此对照还改变了目标窗口实现、外框风格及尺寸；不能据单轮将差异唯一归因于跨进程，也不能评价 toolbar-focus 根因或宣称产品修复。

### 清理与最小验证

- 两个 Electron 层窗口均销毁；原生目标通过 stdin exit 自行退出 **0**，finally `destroyed:true`，实际 close 确认，无强杀。
- 9 个标准 helper 均实际 close：6 个退出 0、2 个严格拒绝退出 1、1 个 watcher 在生产 stop 后 SIGTERM；全部 `forced:false`。watcher SIGTERM 不记为正常退出 0。
- `buttonReleased:true`，原生 GetAsyncKeyState 读回 `nativeLeftButtonDown:false`。主进程实际退出，按全部记录 PID 查询 `remainingPids:[]`；精确临时 profile 删除后 `profileRemoved:true`。cleanup 行 owner=false 是销毁后读回。
- identity / placement / lifetime / recovery 最小回归 **76/76 通过**；入口及新启动器 `node --check` 通过；PowerShell AST 语法解析通过；`git diff --check` 通过。首次嵌套 PowerShell 解析命令因外层变量展开失败，修正为当前 shell 直接 AST 解析后通过；该准备检查未启动窗口或输入。
- 保全仓库其他未提交工作，没有 commit/push，没有读取凭据，没有重启或操作当前会议。所有 OS 输入仅一次点击已核验的自有原生 target。

本次仓库改动路径：

- `apps/desktop/scripts/meeting-toolbar-owner-os-input.cjs`
- `apps/desktop/scripts/meeting-window-validation-target.ps1`
- 本报告（仅追加，旧证据保留）

新增临时启动器及独立证据（根目录 `C:\Users\juggl\AppData\Local\Temp\opencode\`，启动前检查不存在，未覆盖旧文件）：

- `run-toolbar-cross-process-20261125.cjs`（单次固定入口、退出与 PID/profile/鼠标/目标销毁清理门禁）
- `toolbar-cross-process-parent-canvas-20261125.json`
- `toolbar-cross-process-parent-canvas-20261125.json.log`
- `toolbar-cross-process-parent-canvas-20261125.json.summary.json`

## 跨进程夹具有界 order defer 对齐：仅一次 parent-canvas（2026-11-25）

### 夹具差异修正

审阅产品 `meeting-annotation.mjs:deferUnconfirmedOrder` 确认：pointer、retriedHiddenNeighbor、geometryRecovery、已有 placementDeadline 且尚未 deferredRecoveryOrder 时，hidden / visible 的 `placement-order-unconfirmed` 可以仅一次跳过两个额外可信 visible 样本，再以其后新样本执行完整 hidden / visible / final；原 2500ms 期限不续期。final 只读拒绝不适用此分支。这是既有产品恢复预算，不是新加恢复次数。

旧隔离 `meeting-toolbar-owner-recovery.cjs` 在第十一个样本放置拒绝后直接退出，缺少上述分支，因此上一轮 1183ms 的退出不能代表已耗尽产品预算。本次仅对齐隔离 recovery 和入口的错误传递：保留同一个生产身份 watcher、一个原始定时器和一次 defer 标志；placement 期间的样本不授权下一轮，pending 不计数，终止状态及迟到回复拒绝，截止前完整 final 成功才开放输入。入口只在恢复 hidden/visible 标记可 defer，final 不标记。原 actualSize 与初始 GetWindowRect 比较、DWM bounds 独立映射保持生效。未修改产品控制器、原生适配器或严格身份/命中/邻接判据。

### 唯一一次实际运行

只运行跨进程 parent-canvas 一轮，未再做 owner 两臂，未失败重跑。使用原标准 helper、自有原生 Win32 target 和两个 Electron 层；没有启动产品入口或重启/操作现有会议。主 PID **12056**、目标 PID **27656**；owner=canvas，运行期身份与 owner 核验通过。环境 Electron 44.0.0 / Chromium 152.0.7977.54，单屏 DPI96，DWM bounds `{x:107,y:160,width:642,height:432}`，actualSize `656×439`。

| 阶段 | 实际结果 |
| --- | --- |
| 初始 hidden / visible / final | 全通过 |
| target 点击前两次严格检查 | 全通过 |
| target OS click | 仅自有目标命中，SendInput 成功，foreground=target、canvasFocused=false |
| target 激活后严格检查 | `hidden-host-target-not-below`，撤层恢复 |
| 第 10 / 11 个可信 visible 样本 | 1029ms / 1137ms |
| 首次 recovery hidden | `placement-order-unconfirmed` |
| 产品预算对应的一次 defer | 1206ms，原 timeoutMs=2500，未续期 |
| 额外跳过第 12 / 13 样本 | 1246ms / 1356ms |
| 第 14 个新样本 | 1466ms，身份及外框核验通过 |
| 第二次 recovery hidden | 再次 `placement-order-unconfirmed`，立即停止 |
| 恢复停止时间 / 总体结果 | **1545ms / pass=false，Electron exit 1** |

两次 hidden 拒绝诊断均为 `order-readback-unchanged-anchor-own-hidden-other-class-empty-unowned`；最终 stopReason 为 `recovery-pointer-hidden:strict-adjacency-refused`。未超时，未再次 defer，未绕过失败或补点击。第二次完整放置入口也在 hidden 阶段被拒绝，所以两次均未达到 visible/final。

`completed=["initial-placement"]`。target-activation 已实际发送 OS 点击并有前台读回，但未到原生点击计数读取，完整阶段未通过。**未发送 toolbar Pen/Pointer OS click，未绘制，未覆盖 toolbar-focus、墨迹或最终穿透。** 本轮补齐了夹具与产品这一有界分支的差异，但实际仍提前失败；不能据此声称复现真人 `target-below:hidden-other`、定位 toolbar-focus 根因或修复产品。原生目标实现/风格/尺寸与历史同进程 Electron 目标不同，不能将差异唯一归因于跨进程。

### 清理与验证

- 两个 Electron 层窗口 `windowsDestroyed:true`；原生 target 收到 exit，自行退出 0、销毁回执 `targetDestroyed:true`，实际 close 确认。
- 10 个标准 helper 全部实际 close：6 个 exit 0、3 个严格拒绝 exit 1、1 个 watcher 取消后 SIGTERM；全部 `forced:false`。非零拒绝和 SIGTERM 未记作正常 exit 0。
- 左键 `buttonReleased:true`，原生 `nativeLeftButtonDown:false`。Electron 主进程实际退出，全部证据 PID `remainingPids:[]`；仅删除本轮精确临时 profile，`profileRemoved:true`。cleanup 时 owner=false 为窗口销毁后读回，运行期 owner 全通过。
- recovery / annotation / placement 最小相关测试 **152/152 通过**（recovery 10、annotation 122、placement 20）。新增覆盖一次 defer、额外两样本跳过及新几何、原期限不续、超时/迟到样本及 placement 拒绝、pen/final 不适用。入口、恢复模块和新启动器 `node --check` 通过；`git diff --check` 通过。
- 保全其他未提交工作，无 commit/push。旧报告及旧证据保留；新启动器启动前拒绝既有输出路径，没有覆盖旧文件。

本次仓库修改：

- `apps/desktop/scripts/meeting-toolbar-owner-recovery.cjs`
- `apps/desktop/scripts/meeting-toolbar-owner-recovery.test.cjs`
- `apps/desktop/scripts/meeting-toolbar-owner-os-input.cjs`
- 本报告（追加）

新证据根目录 `C:\Users\juggl\AppData\Local\Temp\opencode\`：

- `run-toolbar-cross-process-bounded-20261125.cjs`
- `toolbar-cross-process-bounded-parent-canvas-20261125.json`
- `toolbar-cross-process-bounded-parent-canvas-20261125.json.log`
- `toolbar-cross-process-bounded-parent-canvas-20261125.json.summary.json`

## 起点前移：先激活原生 target 再严格建层（2026-11-25）

### 起点差异及固定范围

本次仅运行 **parent-canvas 一轮**，新增入口参数 `--scenario target-before-layers`（默认旧场景保持原顺序）。仍复用独立原生 Win32 target、标准 `MeetingWindowIdentityWindows.toolbar-owner-standard.exe`、生产 identity/place/check 适配器和原有 recovery 模块。canvas 从构造起 focusable=false，toolbar focusable=true、parent=canvas，原生 owner 读回核验。

与上一轮“先严格建层，再 OS 激活 target，触发恢复及一次 defer”不同：本轮先对 canvas/toolbar 明确撤输入并隐藏，在尚无标注邻接关系时 OS 点击自有 target。准备点击仍逐次核验顶层 HWND/PID、owner、目标可见/双层原生及 Electron 隐藏状态、全部原生矩形、NOACTIVATE、命中、按键状态和真实光标位置；点击前原生计数必须为 0，点击后必须为 1 且前台为 target。这个阶段没有已建立的严格邻接可检查，不将它记作标注层检查通过。随后按原 hidden / visible / toolbar / final 严格流程建层，任一初始失败即终止，不恢复、不跳过隐藏邻居。正式层建立后没有额外准备激活；后续 Pen→drag→Pointer 及最终穿透的既有门禁、可信 DOM click、各阶段最终检查和单次恢复/一次 defer/原 2500ms 不续期预算代码保留。本轮没有进入这些后续路径。

仅修改隔离入口及追加报告；产品代码、recovery 模块和目标脚本未改。保全其他未提交工作，无 commit/push；未重启或操作当前会议，OS 输入仅自有 fixture。启动器预检新 JSON/log/summary 不存在，无自动重试，旧证据未覆盖。

### 唯一一次实际结果

环境 Windows x64、Electron 44.0.0 / Chromium 152.0.7977.54、单屏 DPI96。主 PID **13392**，原生目标 PID **14104**，DWM bounds `{x:107,y:160,width:642,height:432}`。

| 阶段 | 结果 |
| --- | --- |
| 跨进程身份 / owner | 通过，owner=canvas |
| 准备点击时双层 | 未显示、已撤输入，canvasFocused=false |
| target OS 点击 | 自有命中、SendInput、光标读回及输入门禁通过 |
| 点击后核验 | foreground=target，原生 nativeMouseDowns=1 |
| 首次 initial-hidden | **placement-order-unconfirmed** |
| 诊断 | **order-readback-unchanged-anchor-own-hidden-other-class-empty-unowned** |
| 停止原因 | **initial-hidden:strict-adjacency-refused** |
| 整体结果 | **pass=false，Electron exit 1** |

首次严格定位即失败，按授权立即终止，未尝试 initial-visible/final，没有 watcher 恢复、defer、补点击或第二轮。`completed=["target-activation"]`；`notCovered` 为 initial-placement、pen-click、pen-placement、canvas-drag、pointer-click、pointer-placement、target-through。

**没有真正覆盖 toolbar-focus**：未发送 Pen/Pointer OS 点击，未产生本轮工具栏可信 DOM click 或 canvas 拖动/墨迹证据。**没有复现真人 hidden-other**：本轮是初始 hidden 放置的上述 order-readback 诊断，不是 toolbar-focus 后的 `order-check-other` / `target-below:hidden-other`。改变起点后仍在工具栏之前被严格前置条件阻断，不能据此定位真人根因或宣称产品修复。

### 清理、验证与独立证据

- 两个 Electron 层窗口均销毁；原生 target 收到 exit，自行退出 0、finally 销毁回执 true，实际 close 确认。
- 两个标准 helper 均实际 close：身份 helper exit 0，初始严格拒绝 helper exit 1；所有 child `forced:false`，没有 watcher。
- `buttonReleased:true`、`nativeLeftButtonDown:false`；Electron 主进程实际退出，全部记录 PID 查询 `remainingPids:[]`；仅删除本轮精确临时 profile，`profileRemoved:true`。cleanup owner=false 是窗口销毁后的读回，运行期 owner 核验通过。
- identity / placement / lifetime / recovery 最小相关测试 **82/82 通过**；入口和新启动器 `node --check` 通过；`git diff --check` 通过。
- 独立证据根目录 `C:\Users\juggl\AppData\Local\Temp\opencode\`：
  - `run-toolbar-target-before-layers-20261125.cjs`
  - `toolbar-target-before-layers-parent-canvas-20261125.json`
  - `toolbar-target-before-layers-parent-canvas-20261125.json.log`
  - `toolbar-target-before-layers-parent-canvas-20261125.json.summary.json`

## 锚点角色及实际 API：一次无输入隔离诊断（2026-11-25）

### 审阅发现与本轮范围

审阅 native `Place`：初读以及每次写前均取 `GetWindow(target, GW_HWNDPREV)`；等于 canvas 时不写，继续全部精确复核。普通层上邻若为 toolbar 或 own-other，目前仍直接成为插入锚点，没有层组角色判断；置顶上邻仅在 hidden 分支转换为 `HWND_TOP`。因此“代码可能选择 owned toolbar”是尚待失败现场验证的候选，不是已发现的运行事实；canvas 本身不会进入实际自锚点写入。`ownerPid` 表示宿主进程身份，不能当作 Win32 `GW_OWNER` 关系。

已有历史报告明确：topmost-boundary 静态及程序激活对照曾通过；真人 `NOSENDCHANGING` 仍失败；真人 host-thread 写入返回成功但无完成通知、即时 neither，仍失败。本轮未重跑这些变体，也未增加恢复或等待预算。旧失败码 `own-hidden-other-class-empty-unowned` 分类的是**写后 canvas 下邻**，不是最初 target 上邻或实际插入锚点；不能从该码推导自锚点。

仅新增 `FIXTURE_ANCHOR_ROLES` 条件编译诊断，编译到临时 `MeetingWindowIdentityWindows.anchor-roles.exe`：记录 initial-read、before-api、after-api 的有限角色 canvas/toolbar/own-other/target/foreign，另有 none/unknown 哨兵、可见/置顶布尔值、直接 owner 角色、API bool 和立即捕获的 LastError。诊断不输出原始 HWND、标题、PID 或类名；既有私有身份协议不变。`SetLastError=true` 和调用前清零仅在此独立编译分支启用，默认构建保持原 P/Invoke 及放置分支。成功调用的 LastError 不解释为 Windows 的成功证明；授权仍只来自全部严格读回。

隔离入口新增 `anchor-roles-no-input`：复用跨进程原生 Win32 target、不可聚焦 canvas、可聚焦 parent=canvas toolbar；目标在自身消息循环处理一次 `activate`（SetForegroundWindow），不发送鼠标/键盘输入、不移动光标。之后只执行原 hidden / visible / toolbar / final；失败即停止，无 recovery/defer、无后续工具点击或绘制。没有操作当前产品窗口、重启应用或连接会议。只运行一次，未重试。

### 新证据

Windows x64、Electron 44.0.0 / Chromium 152.0.7977.54、单屏 DPI96，DWM bounds `{x:107,y:160,width:642,height:432}`。

| 检查点 | 实际读回 |
| --- | --- |
| 程序激活 | foreground=target，canvasFocused=false，nativeMouseDowns=0 |
| 最初 target 上邻 | **foreign、hidden、topmost**；直接 owner=foreign |
| 写前实际插入锚点 | **none（此处为 HWND_TOP）**，不是 canvas/toolbar/own-other |
| owner 关系 | canvasOwner=none，toolbarOwner=canvas，运行期 ownerVerified=true |
| 写前 canvas 下邻 | own-other；本轮未进一步分类尺寸/类，也未跳过它 |
| SetWindowPos | **true**；调用前清零，立即捕获 LastError=0 |
| 写后读回 | targetPrev=canvas，canvasNext=target |
| 生产严格 hidden / visible / final | **全部 true** |
| 总体退出 | Electron exit 0；没有任何 OS 输入注入 |

本轮否定“已有 parent=canvas owner 关系 + 隐藏外部置顶上邻必然导致失败”这一充分条件；没有观察到自有层组锚点写入。它**没有复现 OS 点击激活后的失败**，不能推论旧失败现场的最初上邻也是 foreign，不能把程序激活与鼠标激活等同，也不能证明 toolbar-focus 或真人 hidden-other 的根因。多次 GetWindow 是非原子诊断；未采集完整 owner 链、原生消息参数或同步回调时序。

### 根因、边界及下一最小候选

**根因未确认，未作产品修复。** 本轮无法把阻断归因于自锚点、owned 约束或 API 显式报错；本轮实际调用及严格结果均成功。代码可确认 canvas 自锚点分支已免写；toolbar/own-other 插入候选尚无失败现场证据，不据此改排层策略。

若继续取得新授权，下一项最小候选仅是在**已有跨进程 target-before-layers 点击失败路径**使用同一有限角色诊断（包含写前/后 API 读回），保持原有身份/命中/隐藏/严格邻接及一次运行上限；先辨别真实失败锚点，不能先“跳过自有层”、改 owner 或再跑 NOSENDCHANGING/host-thread/增加重试。当前轮预算已耗尽，没有执行此候选。

已明确的架构边界仍是：跨进程外部目标的全局 Z-order 不能由本方 owner 关系持续约束，API 成功或可见像素贴合不等于所有隐藏 HWND 的严格直接相邻。现有产品判据要求真实双向直接相邻，读不到必须撤层；不能以忽略隐藏窗口放行。已有失败与本轮成功不足以证明这一架构在所有场景绝对不可行，也不足以放行 Windows 入口。若失败现场同样为 HWND_TOP 且成功返回但严格失败，应停止无差异排层变体，转向不依赖外部 HWND 严格邻接的呈现架构评估。

### 清理、验证及证据

- 两个 Electron 层已销毁；原生 target stdin exit 后自行 exit 0，finally destroyed=true；四个 helper（身份一个、placement/check 三个）全部实际 close、exit 0。全部 forced=false，无 watcher。
- Electron 主进程实际 close，记录内全部进程 PID 查询 `remainingPids:[]`；临时 profile 精确路径删除并读回 `profileRemoved:true`。`buttonReleased:true`、`nativeLeftButtonDown:false`；本轮从未注入或按住按键。
- identity / placement / lifetime / recovery 最小相关测试 **82/82 通过**。入口及新启动器语法检查通过；fixture 与默认两种 C# 编译通过；`git diff --check` 通过。首次 fixture 编译因 PowerShell 对未引用的源路径参数解析错误失败，改为绝对路径后通过；发生在运行前，不计诊断轮次。
- 保全所有原有未提交改动；没有 commit/push。产品安全/默认分支及已运行的 helper 未替换。新增诊断只在独立条件编译二进制启用。
- 证据根目录 `C:\Users\juggl\AppData\Local\Temp\opencode\`：
  - `run-anchor-roles-20261125.cjs`
  - `MeetingWindowIdentityWindows.anchor-roles.exe`
  - `anchor-roles-no-input-20261125.json`
  - `anchor-roles-no-input-20261125.json.log`
  - `anchor-roles-no-input-20261125.json.summary.json`

## 点击路径锚点取证：一次 target-before-layers（2026-11-25）

### 执行与修改范围

本轮实际运行一次既有跨进程 `target-before-layers` / parent-canvas fixture。入口增加显式 `--fixture-anchor-roles`，沿用 `FIXTURE_ANCHOR_ROLES` 独立编译 helper，stderr 只采有限角色/API 诊断；另补 `targetNext`，以记录写前后 target 两侧邻居。未修改默认产品放置、安全分支或已运行 helper。诊断初读的 `anchor` 字段表示候选上邻，只有 `before-api.anchor` 才是实际传给 SetWindowPos 的值；此处 none 是数值 0 的 HWND_TOP 哨兵。

保留准备点击的自有顶层身份、owner、隐藏/撤输入、精确矩形、NOACTIVATE、原生命中、按键状态和光标读回门禁。只向自有原生 target 发送一次 OS 点击，原生计数从 0 到 1，foreground=target；随后执行原 strict initial placement。诊断模式即使 initial 全通过也会结束，不进入工具栏点击或绘制。本轮 initial-hidden 拒绝，立即停止，没有恢复、defer、第二次调用或自动重试。未重启或操作会议。

### 实际失败证据

环境仍为 Windows x64、Electron 44.0.0 / Chromium 152.0.7977.54、单屏 DPI96，DWM bounds `{x:107,y:160,width:642,height:432}`。

| 项目 | initial-read / before-api | after-api |
| --- | --- | --- |
| target 上邻 | **foreign、hidden、topmost** | **foreign、hidden、topmost** |
| target 下邻 | own-other | own-other |
| canvas 下邻 | own-other | own-other |
| 实际写入 anchor | **HWND_TOP**（before-api.anchor=none） | 同一次调用，无第二次写入 |
| canvas owner | none | none |
| toolbar owner | canvas | canvas |
| API 返回 | 调用前 LastError 清零 | **SetWindowPos=true，立即捕获 LastError=0** |

角色相同不证明各次 own-other/foreign 是同一个 HWND，不能据此宣称整个栈完全未移动。实际 anchor 是 HWND_TOP 而不是 toolbar、canvas 或其他自有 HWND；ownerVerified 在运行阶段始终 true，canvasFocused=false、toolbarFocused=false。

生产结果为 `placement-order-unconfirmed`，原生拒绝 `order-readback-unchanged-anchor-own-hidden-other-class-empty-unowned`，停止原因为 `initial-hidden:strict-adjacency-refused`，Electron exit 1。没有达到 initial-visible/final，`completed=["target-activation"]`。没有 toolbar-focus、Pen/Pointer 点击、canvas 拖动、墨迹或最终穿透证据。标准真实检查仍决定拒绝，诊断未授予放置。

### 结论与架构含义

**可排除本次隔离失败由“选中 canvas/toolbar/own-other 作为实际插入锚点”直接造成。** 初读 target 上邻已是外部隐藏置顶窗，实际写入是 HWND_TOP；不能将该拒绝归因于自锚点。canvas 无 owner、toolbar owned by canvas 的关系与上一无输入成功轮一致，这削弱“该 owner 结构本身必然阻止放置”的解释，但不排除 Windows owner/激活排序机制在不同交互状态下参与故障。

**根因仍未确认。** 本轮排除了 API 显式返回 false 的失败形式，却没有证明成功返回后曾经相邻，也无法区分调用内部没有产生所需层级结果与首次读回前再次重排。LastError=0 在成功返回时不是层级正确性证明。有限角色读回非原子，没有同步消息参数或完整排序时间线。

与上一轮程序激活成功相比，本次一次 OS 点击后在同类边界、同 owner 结构下失败，说明程序激活通过不能替代点击路径；但跨轮窗口、时序和桌面状态并非同一快照，不能把差异唯一归因于某个 Windows/Electron 内部机制。此次 OS 点击来自 SendInput、自有 Win32 fixture，不是真人硬件点击或真实会议 toolbar-focus，不能声称真人同根因已复现。

**证据支持当前架构的可靠性限制，而不是证明任何外部 overlay 架构绝对不可行：**即便只写自有隐藏 canvas、API 报成功，也不能据此保证它在外部目标旁满足全局 HWND 双向直接相邻。已有 NOSENDCHANGING 和 host-thread 真人对照均未解决失败；本轮补上实际非自有锚点证据后，不再建议重复排序标志、调用线程、等待或 owner 变体。下一最小方向是评估不依赖外部 HWND 严格直接相邻的呈现边界（例如应用自有共享内容承载面）；这是架构评估，未在本轮实施，也不构成忽略隐藏邻居或放宽现有门禁的理由。

### 清理与最小验证

- 两个 Electron 窗口均销毁；原生 target 通过 stdin exit 自行 exit 0，finally destroyed=true；身份 helper exit 0，拒绝 helper exit 1，二者均实际 close。全部 forced=false，无 watcher。拒绝 helper 的 graceful=false 是非零拒绝，不是残留或强杀。
- Electron 主进程实际 close；全部记录 PID `remainingPids:[]`，profile 精确删除后 `profileRemoved:true`；`buttonReleased:true`、原生 `nativeLeftButtonDown:false`。未留下按键、窗口或实验进程。
- identity / placement / lifetime / recovery 最小相关测试 **82/82 通过**；入口及新启动器 `node --check` 通过；fixture 与默认 C# 构建通过；`git diff --check` 通过。没有为了该诊断新增镜像实现的单元测试。
- 保全所有既有未提交改动，无 commit/push；使用全新输出路径，旧无输入及旧点击证据未覆盖。新增独立 helper 名称也未覆盖上一轮二进制。
- 证据根目录 `C:\Users\juggl\AppData\Local\Temp\opencode\`：
  - `run-anchor-roles-click-20261125.cjs`
  - `MeetingWindowIdentityWindows.anchor-roles-click.exe`
  - `anchor-roles-click-20261125.json`
  - `anchor-roles-click-20261125.json.log`
  - `anchor-roles-click-20261125.json.summary.json`
