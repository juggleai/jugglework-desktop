# 双平台窗口标注：移除边框拦截与接入顺序

> 执行时逐项测试；Windows 真机验收按同目录的 Windows 验证计划进行。

**目标：**鼠标模式保留系统缩放；平移保留标注；实际宽或高改变后清墨并退出标注，同源共享继续。

- [x] `apps/desktop/electron/meeting-annotation.{mjs,test.mjs}`：会话仅创建画布和工具栏。自动化覆盖画布穿透、移动保持会话、尺寸变化发 `closed/resized`、宿主关闭释放两窗。macOS 只向 `meeting-window-tracker.mjs` / `apps/desktop/native/MeetingWindowTracker.swift` 注册画布；删除边框遮挡协议的生产者，忽略旧的边框事件。已跑 Swift 类型检查和 Electron 对应 Node 测试，不等同于真机 UI 验收。
- [ ] Windows 选窗认证先在 `meeting-screen-picker.mjs` 回归测试中覆盖无损 HWND、重新校验身份及普通共享降级；不能把 macOS 数值窗口标识直接作为 Windows 句柄。正式原生观察必须区分失联和确认关闭，并提供与画布坐标分开的可信实际尺寸。位置变化、映射变化和真实改尺寸分别测试。
- [ ] Windows 画布只接经过验证的原生相对放置。目前已有异步隐藏放置/显示后复核与迟到结果隔离的控制流、独立 Node 适配器及候选 native `place/check` 命令，尚未在 Windows 验证或连接 `main.mjs`。不得在 Electron 主线程同步启动 PowerShell；画布默认不接收输入，先确认本次会话的几何/层级，再允许交互。失序或遮挡不可信则撤标注，不停普通共享；不回退到全局置顶或 `moveAbove()`。
- [ ] 默认不开 Windows 入口。先在 Windows x64、单屏 100% 跑连续平移、实际改宽/改高、正常非置顶遮挡的两种工具模式、最小化/恢复和清理。最后用双端确认同源同轨、无旧墨/黑帧，再验性能与安装包。macOS 复跑系统缩放与遮挡；整屏标注不改。

## 来源认证与只读观察的当前切片

- 已完成选窗的 Windows 字符串句柄路径与 `processStartedAt`（FILETIME 十进制字符串）绑定，覆盖超范围、认证失败继续普通共享、取消后的迟到结果。macOS 仍用原有 CGWindowID 数值协议。
- `apps/desktop/electron/meeting-window-identity-windows.{mjs,test.mjs}`：原生 inspect 和 watch 的有界协议适配器；分离实际外框尺寸和 DWM 映射框，检测超时、身份不符、无效几何和非 96 DPI 时返回不可用。不把 helper 退出当目标关闭。
- `apps/desktop/native/MeetingWindowIdentityWindows.cs`：候选只读 inspector/observer；目标进程创建时间、主窗口和线程复核。仅目标进程句柄确认退出才报告 `closed`；单个 HWND 消失只报告不可用。不能保证识别同进程同线程 HWND 复用，不据此开放入口。非原子矩形双读不一致即拒绝；此安全拒绝策略是否会在正常平移时过度撤层，必须真机测量。
- `apps/desktop/scripts/prepare-meeting-window-identity-windows.ps1`：独立 Windows x64 开发编译入口，不签名、不接默认构建；arm64 明确拒绝，不生成伪 arm64 包。当前开发机无 Windows C# 编译器，native 编译与系统行为未验证。
- `main.mjs` 仍只创建 macOS tracker；上述 Windows 适配器未接入产品，避免把只读身份样例当作完整认证、画布层级和输入安全证据。

## 异步画布候选实现（待 Windows 运行）

- `meeting-window-placement-windows.{mjs,test.mjs}` 用原生窗口 Buffer 解码无损句柄，异步启动 helper，限制回复大小/时间，逐项校验目标身份、画布 PID/句柄、请求几何和可见性。不是同步 PowerShell 调用。
- 会话先隐藏且穿透，`place` 隐藏定位通过后被动显示，第二次可见复核通过后才发布 opened/geometry、显示工具栏和允许画笔。Windows 窗口工具栏不设置 topmost；整屏路径不变。移动中的过期结果不能重新显示旧画布；关闭后迟到成功不会复活。静止心跳用 `check` 只读复核，不反复 hide/show；失败只退标注。
- native 仅对调用方自有画布使用 `SetWindowPos`，目标不修改。拒绝 topmost 目标/画布/插入点，回读严格相邻、PMv2 物理矩形和 DPI96。仍非原子、仍可能竞争和过度拒绝，不是持续遮挡/输入保证。
- 当前每次定位/检查启动短生命周期进程；真机需量化启动时延、静置 CPU 和持续平移闪烁。若不达标，再改成长驻受控协议，不能用开启入口掩盖缺陷。
- 尚缺产品完整接线、实际目标关闭但宿主仍存活时的可信关闭证据、同进程 HWND 复用防护、Windows 原生编译与真实点击。不得勾选产品完成。

### Windows 下一次最小验证

```powershell
# 在仓库根目录，Windows x64 PowerShell 5.1：
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\apps\desktop\scripts\prepare-meeting-window-identity-windows.ps1
node --test .\apps\desktop\electron\meeting-window-identity-windows.test.mjs .\apps\desktop\electron\meeting-screen-picker.test.mjs
```

编译通过后，用现有 P0 自有目标窗口的内存 HWND 调用 `MeetingWindowIdentityWindows.exe inspect <hwnd>`，将返回的 PID/FILETIME 原样送进 `watch <hwnd> <pid> <FILETIME>`；只交回脱敏结果，不提交原始身份。按顺序记录初始可见、平移、只改宽、只改高、最小化/恢复、窗口关闭但进程仍活、进程退出，以及父端停止后的 helper 退出。观察命令会持续输出心跳；测试运行器须限定总时长并负责取消和退出确认，不能让自动化终端靠工具超时硬杀来冒充清理成功。
