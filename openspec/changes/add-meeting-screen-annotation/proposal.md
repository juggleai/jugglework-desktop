# Proposal

## Why

主讲人共享整个屏幕讲解时，无法在画面上圈点重点，只能靠鼠标指来指去。会议需要让主讲人直接在被共享的屏幕上标注，参会人在共享画面里看到标注，不增加服务端改动。

方案来源：`白板/docs/meeting-screen-annotation-design.md`（方案 A：标注画进视频）。本变更实现其中一期，并按评审结论修正若干细节（见 design.md「评审修正」）。

## What Changes

- 共享整个屏幕（`screen:` 来源）时，会议工具栏和会议小窗出现「标注」入口；共享单个窗口或白板时不显示。
- 点击「标注」后，在被共享的那块屏幕上盖一层透明、置顶的标注窗口，覆盖该屏幕完整 `bounds`。系统整屏采集会把标注一起拍进视频，推流链路不改。
- 单独的标注工具栏窗口，工具与飞书会议一致：鼠标（默认）、激光、笔、荧光笔、椭圆形、矩形、箭头；红、黄、绿、蓝、紫 5 种颜色；橡皮擦、撤销、清除；最右端「关闭」。工具栏设置 `setContentProtection(true)`，尽量不被采集。
- 选「鼠标」时标注窗口鼠标穿透，已画内容保留；选其他工具时接收鼠标。
- 标注窗口内按 `Esc` 切回「鼠标」，标注保留。
- 点「关闭」、停止共享、离会、会议窗口关闭、被共享的屏幕被拔掉时，关闭标注并清空内容。
- 标注坐标存为相对屏幕的 0–1 比例。

## Capabilities

### New Capabilities

- `meeting-screen-annotation`：整屏共享标注入口、标注窗口与工具栏、鼠标工具、退出与清理、多显示器对应、离线与安全约束。

### Modified Capabilities

无。`desktop-meetings` 的显式选屏合同不变；选屏器只额外记录所选整屏来源对应的显示器。

## Impact

- 依赖：复用 `apps/app` 已有的 `konva`、`react-konva`，不新增依赖。
- Electron：新增标注窗口模块与窄 preload；`meeting-screen-picker` 记录所选来源的类型与 `display_id`。
- 渲染层：新增 `annotation.html` 入口与 `domains/annotation/`；会议工具栏与小窗增加入口。
- 不修改服务端，不修改会议 API，不修改输入框草图功能。
