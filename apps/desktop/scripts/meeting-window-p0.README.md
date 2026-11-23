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

两种方式任选一种。Electron 探针会自行启动一个新夹具；不要给它传外部 HWND 或手动选窗。它仅枚举窗口来源（无缩略图、无图标），通过十进制字符串精确比对来源 ID 中的 HWND，再核对夹具的随机标题。只有唯一匹配才请求采集。标题和原始 ID 仅用于进程间核对，终端输出只有匹配结果；探针不会记录其他窗口的标题或内容，也不会读取像素或保存截图、帧文件。关闭夹具即结束；脚本默认只输出到终端。

## 操作与预期输出

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
- 如需保存证据，仅保留脱敏的 JSON 行（含 Windows 构建号、进程架构、Electron/Chromium 版本和夹具所在显示器缩放），并附操作步骤。Windows 原生运行、混合 DPI、Snap、实际应用和标注输入均待实机验证。
