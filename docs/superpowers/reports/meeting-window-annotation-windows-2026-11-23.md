# Windows 单窗口标注验证 —— A 阶段交接报告

日期：2026-11-23。范围：夹具侧 A0–A5 中不依赖产品代码的部分。

> 后续产品决策：macOS 和 Windows 都不额外拦截边框缩放。下文关于原生逐点命中的建议仅为历史记录，不再作为实施或发布前置条件；真实遮挡点击、平移跟随和实际尺寸变化退出仍须验证。

**结论：A 阶段未完成，不构成产品支持或发布放行。** 已通过若干隔离切片；输入热区两条夹具路线均被判为方案限制（BLOCKED）；多 DPI/跨屏和稳定性能受设备或夹具限制；B 阶段未开始。

## 环境与范围

- 分支 `feat/whiteboard`。相关提交：`b086103eb`（验证计划）、`ef2c433f6`（可见窄边 IME 修复）、`f70f08213`、`24cf7fdbd`、`49db048d2`、`79f6243aa`（本阶段夹具与结论）。
- Windows 11 家庭版中文版，Build 10.0.26200；Intel Core i5-13420H、12 逻辑核、Intel UHD Graphics；x64 交互式桌面。
- 单屏 1920×1200@60、原点 `(0,0)`、100% 缩放、探针 DPI 96。未修改系统缩放或布局。
- Node v24.18.1、pnpm 12.21.0、PowerShell 5.1.26100.9818、Electron 44.0.0 / Chromium 152.0.7977.54。
- 仅创建、移动、销毁自有测试窗口；未改外部窗口、未设全局置顶、未注入输入、未采集整桌面。
- 自动化替身测试不调用真实 Win32/Electron，不是像素、输入、采集或呈现证据。

## 用例结果

状态取 `PASS / FAIL / BLOCKED / NOT_RUN`；`切片` 表示只覆盖该 case 的一条窄路径。

| case | 动作 | observed | exit | cleanup | status |
|---|---|---|---|---|---|
| A0-visible | `meeting-window-p0-edge-visible-native.cjs` 两轮 | 五窗 DPI96/PMv2/可见/穿透/非置顶、四条严格相邻；两次 `visible-sample`→`removed` | 0、0 | 两次 `removed` 确认 | PASS |
| A0-tests | `node --test apps/desktop/scripts/meeting-window-p0*.test.cjs` | 7 个文件 101 项通过 | 0 | 替身断言 | PASS |
| A1-native-only | `electron scripts/meeting-window-p0.cjs --native-only` | 取得字符串 HWND、进程/创建时间、PMv2、DPI96、outerPx/dwmPx；未做视频捕获 | 超时 | 无优雅清理记录 | FAIL（收尾） |
| A1-sigint | 临时 wrapper 请求 SIGINT | 退化为硬终止，无确认记录 | SIGINT | 未确认 | FAIL |
| A1-preflight | 初版混合入口三轮 | 三轮 `source-missing`（窗口源 5 个，无目标） | 1、1、1 | 初版只等 close，不足确认 | FAIL |
| A1-hidden-start | `--diagnose-hidden-start` 一次 | 60 秒无输出；入口 `require.main` 守卫与 Electron 默认 loader 不兼容（已修复） | 工具超时 | 无当轮清理消息 | FAIL |
| A1-stream-static | 静态目标两轮 | 定位为 `frame-wait`：1 次回调，`displaySurface:window`，642×432 | 1、1 | EOF 确认 | FAIL（3 帧判据） |
| A1-stream-animated | 目标局部动画两轮 | `displaySurface:window`、642×432、3 次回调、四角色各 208 像素 | 0、0 | EOF 确认 | PASS |
| A1-rest | 其他窗型、同名/复用、完整生命周期 | 未覆盖 | — | — | NOT_RUN |
| A2-100 | `--native-target --passive-ink` + `a2-mapping` | 帧 642×432 与 DWM 一致；色点间距 592×352 = 客户区 640×400 − 48；两轴对齐 | 0 | 确认 | PASS（100% 静态） |
| A2-matrix | 125%/150%/双屏/负坐标/跨屏 | 用户选择不改系统设置；无第二屏 | — | — | BLOCKED（按选择） |
| A3-order | 初版 `--passive-ink` 三轮 | 墨层精确对齐但不相邻；夹层属目标进程，角色未识别 | 1、1、1 | 确认 | FAIL（层级） |
| A3-neighbor | 只读诊断两轮 | 夹层 `target-process`、目标在下方、`GW_OWNER≠target`、不可见、有面积不与墨层相交 | 1、1 | 确认 | FAIL（层级） |
| A3-native-target | 无 WinForms 合成目标两轮 | 642×432、3 帧、四角色 208、`inkColorPixels:0` | 0、0 | EOF 确认 | PASS |
| A3-ink-placed | `--native-target --passive-ink` 两轮 | 自有层插到目标正上方后 `adjacent:true`；`capturePage` 816 墨色像素/640×400；目标流 `inkColorPixels:0` | 0、0 | 确认 | PASS（切片） |
| A3-occlusion | `--occlude-after` 两轮 | 自有遮挡窗 240×160 在墨层上方且相交，墨层仍 `adjacent:true`；目标流无墨 | 0、0 | 确认 | PASS（切片） |
| A3-minimize | 目标自最小化 | 撤层并报 `ink-native-unavailable`，无残留 | 1 | 确认 | PASS（撤层） |
| A3-resize | 目标自增宽 48px | 撤层并报 `ink-geometry`，不把旧墨画到新尺寸 | 1 | 确认 | PASS（撤层） |
| A3-continuous | `--samples 5 --sample-gap-ms 800` 两轮 | 5/5 采样通过：3 次回调、四角色、无墨、映射一致 | 0、0 | 确认 | PASS（切片） |
| A3-strips | `--strips` 两轮 | 观察器核对 4 条 8px 边条 PID/穿透样式/非置顶/精确矩形/不覆盖客户区；同轮墨层与目标流仍成立 | 0、0 | 三进程 EOF 确认 | PASS（切片） |
| A3-strips-negative | `--strips --strips-wrong` | 四边全部 `geometry` 拒绝，未进入采样 | 1 | 确认 | PASS（失败对照） |
| A3-strips-input | `--a4-strips` 30 秒真人点击 | 边条可见且校验通过，但 18 次点击全部落到目标、边条 0 次；`WindowFromPoint` 四边中心均为目标 | 1 | 确认 | BLOCKED（方案限制） |
| A3-hotzone | `--hotzone` 75 秒真人操作 | 目标 8 次 mousedown、0 拖拽；墨层 0 击/0 拖 | 1 | 确认 | BLOCKED（方案限制） |
| A3-occlusion-note | 遮挡期间标记完整性 | BR 色点两轮为 0、其余 208；原因未定 | — | 已清理 | OPEN |
| A4-passive | `--a4-passive` 75 秒 | 墨层 0/0；目标 18 击、13 拖；目标被激活 1 次后夹具重放自有层并复核 | 0 | 确认 | PASS |
| A4-draw | `--a4-draw` 75 秒 | 墨层 12 击、7 拖；目标 0 | 0 | 确认 | PASS |
| A4-geometry-fail | 真人误拖边框 | 约 10.7 秒撤层 | 1 | 确认 | PASS（撤层） |
| A4-occluded-fail | 遮挡块同色/未置顶时点击 | 遮挡窗落到墨层下方，目标 19 击、遮挡窗 8 击 | 1 | 确认 | FAIL（暴露风险） |
| A4-occluded-click | 橙色遮挡块 + 持续置顶，75 秒 | 遮挡窗 10 击、目标 0、墨层 0 | 0 | 确认 | PASS |
| A5-local | `--perf`，1902×1112 实际帧 | 同参数 1.1–28.6 fps 跳变；抬到普通层最上仍 1.1 fps | 0 | 确认 | BLOCKED（夹具限制） |
| A5-build | 正式原生 helper 构建/PE 检查 | 未建立；PowerShell 内嵌 C# 仅属夹具 | — | — | NOT_RUN |
| B1–B3 | 产品候选、真实 ZEGO 双端、签名安装包 | 未接入，未执行 | — | — | NOT_RUN |

### A0 精确物理矩形

| role | x | y | width | height |
|---|---:|---:|---:|---:|
| target | 64 | 64 | 240 | 240 |
| top | 64 | 64 | 240 | 8 |
| bottom | 64 | 296 | 240 | 8 |
| left | 64 | 72 | 8 | 224 |
| right | 296 | 72 | 8 | 224 |

### 100% 映射样例

两轮 `outerPx=(632,356,656,439)`、`dwmPx=(639,356,642,432)`；帧尺寸等于 DWM。色点中心 TL `(25.08,55.08)`、TR `(617.08,55.08)`、BL `(25.08,407.08)`、BR `(617.08,407.08)`；横向 592、纵向 352，符合 640×400 客户区每边内缩 24。不是同步回读或通用原点规则。

## 已识别的真实风险

1. 点击会激活目标窗口，把它抬到标注层上方；必须重放自有层并复核（夹具最多 5 次，已实现并实测）。
2. 遮挡窗在激活顺序变化后会落到墨层下方，后续点击穿透到目标（实测目标 19 击）；产品必须重放并复核遮挡关系。
3. 遮挡期间目标流 BR 色点连续两轮缺失，原因未定；不能据此判断遮挡可见性，需单独隔离实验。
4. PowerShell 承载的目标进程会带一个不可见、零面积窗口进入 Z 序；不能按进程归属放行夹层，也不能只靠严格相邻推断可见性。

## 交接：四类结论

### 1. 目前可支持的范围

Windows x64、单屏 100%、合成窗口条件下，以下为可复现证据：

- 纯 Win32 被动几何、可见性与严格相邻（两轮）。
- 单窗视频来源匹配与短时标记帧（多轮）；100% 帧尺寸与色点间距映射一致。
- 被动透明墨层精确贴到目标正上方、自有页面确实呈现墨迹（816 px）、目标单窗流不含本地墨（两轮）。
- 同流连续 5 次采样均无墨、映射一致（两轮）。
- 自有遮挡窗的层级关系、最小化/改尺寸时的撤层与清理。
- 真人输入：穿透、绘制、遮挡点击三种模式计数符合预期。

**这些不能作为开放产品单窗标注的依据。**

### 2. 必须拒绝或尚未认证

- 未通过可靠来源/生命周期认证、几何或 DPI 不精确、topmost、失序或读回不可信时，不得启用标注输入。
- 不得按 PID 放行夹层、用容差吞差值、整边放行或复位目标尺寸来“通过”。
- 跨屏、125%/150%、负坐标、窗口样式、同名复用、最小化恢复行为、真实遮挡外观均无足够证据。
- 不透明位图“只叠一次”无法由像素结果证明；不要把 compositor 绿测当作合成次数证据。

### 3. 可移植的夹具实现

- 原生被动探针（含 `ImmDisableIME(-1)`，仅限该专用进程）、严格 HWND/标题匹配、迟到回复拒绝、有界清理与 101 项回归。
- 合成原生目标（自最小化/改宽/遮挡/固定尺寸/真实鼠标计数）、只读原生观察器、自有墨层放置与复核、同流多次采样、边条几何/样式校验及失败对照。
- 运行方式与限制见 `apps/desktop/scripts/meeting-window-p0.README.md`。
- 不可移植结论：拆分原生边条窗口、整窗 `setIgnoreMouseEvents` 切换都不能作为输入热区方案。

### 4. 需要产品原型或 B 阶段

- **输入热区**：必须在标注窗口内实现原生逐点命中（`WM_NCHITTEST` 返回 `HTTRANSPARENT` 或等效），并重新做 A4 真人矩阵；现有两条夹具路线已 BLOCKED。
- **产品入口**：门控、会话隔离、与共享窗口/采集合成的真实接线。
- **B 阶段**：真实 ZEGO 双端、远端性能门（如 90% 帧率）、生产签名安装包与安装/卸载。
- **设备依赖**：多 DPI/跨屏需授权改缩放或第二屏；近 4K 需 4K 屏；ARM 需对应硬件。

## 建议下一步

1. 产品侧先做一个最小原型：标注窗口内原生命中测试，用现有 A4 流程复测穿透/绘制/热区。
2. 性能改为可见窗口或原生侧计时，替换当前隐藏渲染帧计数。
3. 设备条件具备后再补 A2 矩阵与 A5 近 4K；B 阶段需产品候选后才能启动。

## 隐私与合规

报告不含真实窗口标题、完整 HWND/PID、画面、凭据或原始日志；临时日志仅在本机，不作为交付附件。本阶段未修改生产功能、未改动外部窗口、未注入输入、未采集整桌面。
