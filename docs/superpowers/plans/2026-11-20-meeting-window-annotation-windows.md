# Windows 单窗口标注实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**目标：**先在用户手头的 Windows 测试机跑通单窗口标注实验版，再扩展窗口和设备兼容范围。

**架构：**新增 Win32 来源观察适配器，复用 Electron 标注会话、本地工具栏与同轨远端合成。只在实机证明 Electron 局部命中不可用时，增加原生输入层。

**技术栈：**Win32、Electron、Node 测试、Canvas 2D、ZEGO。

## 全局约束

沿用 `openspec/changes/add-meeting-window-annotation/design.md` 的「Windows 实验版」与该变更的正式规格。在当前 `feat/whiteboard` 分支推进；不修改普通窗口共享、整屏标注和服务端，不复位目标尺寸、不全局置顶。默认不开启；没有 Windows 或双端证据时不得勾选对应验收项。

### 1. 先测 Windows 来源、坐标和输入

- [ ] 用原生可调整窗口作为基准夹具：显示中心和四角定位标记，记录窗口的移动、调整宽高、Snap、最小化、恢复和关闭。用 Electron 当前选窗对照 Chromium 来源与 HWND，不记录窗口标题或内容；落盘仅保留脱敏结果及版本、架构、显示缩放。
- [ ] 同时记录物理像素矩形、DWM 可见边界、Electron DIP 和视频帧宽高；验证 100%／150% 混合 DPI、负坐标显示器、跨屏仅改变像素分辨率和实际改变宽高，不能把二者混为一谈。
- [ ] 对照普通 Win32 窗口、Chromium 和用户实际测试的应用；在画笔及鼠标模式检查四边四角真实拖拽，另测点击激活、滚动、拖标题栏、外部局部遮挡及同应用弹窗。若 Electron 无法同时保护可见热区和放行遮挡窗口，改为只验证 Win32 局部输入窗；未通过前不开放该情形。

### 2. 接入原生观察与标注会话

**文件：**`apps/desktop/electron/meeting-screen-picker.mjs`、`meeting-window-tracker.mjs`、`meeting-annotation.mjs`、`main.mjs` 及对应 `*.test.mjs`；Windows helper 源码放在 `apps/desktop/native/`。

- [ ] 先添回归：Windows 来源不能经 JS `Number` 传递 HWND；映射失败、身份变化或不可信不影响普通共享；过期来源不能覆盖新请求。沿用选择器白名单和确认时重新枚举。句柄留在主进程，以无损字符串传给 helper，不改渲染端捕获会话契约。
- [ ] 先添回归：移动、单纯采集像素改变不退出；最小化暂停且保留场景；真实改尺寸清笔迹并退出；身份不确定或 helper 失联仅退出标注；确认目标关闭才停止共享；旧会话迟到消息无效。先跑红，再按 Windows 观察结果实现，用现有受信 `captureId` / `annotationId` 绑定。
- [ ] 验证窗口前后顺序和输入保护后再连接 Windows 开关。普通共享或不可信来源不创建标注层；关注退出时释放所有自有窗口、监听和 helper。运行 `node --test apps/desktop/electron/meeting-{screen-picker,window-tracker,annotation}.test.mjs`（PowerShell 分别传三个完整文件名）。

### 3. 同轨发布与 Windows 打包

- [ ] 运行 `node --test apps/app/tests/meeting-runtime.test.mjs` 及 `bun --conditions=development test --isolate apps/app/tests/window-share-compositor.test.ts apps/app/tests/window-annotation-events.test.ts`，覆盖发布就绪、暂停、尺寸不匹配时不绘制旧笔迹和同一发布轨。不要用模拟回调替代实际 ZEGO 验收。
- [ ] 在 `apps/desktop/scripts/prepare-meeting-window-tracker.mjs`、`apps/desktop/electron-builder.yml`、`apps/desktop/scripts/verify-packaged-windows.mjs` 接入 Windows helper 构建和验包。按现有 Windows x64 / arm64 目标核验 PE 架构和助手 Authenticode，安装器签名不能替代助手验签。
- [ ] 双端对照普通共享与同轨合成：记录 1080p／近 4K 远端帧率、黑帧、旧笔迹、CPU；验收同一 `_screen` 保持发布且远端帧率达到基线 90%，以及最小化、恢复和确认目标关闭。只记录真机结果，不把同轨方案记作换轨通过。
