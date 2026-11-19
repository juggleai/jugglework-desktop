# Tasks

## 0. 技术验证

- [x] 0.1 macOS 26.2 / Electron 44：透明 `screen-saver` 层级窗口被整屏采集拍进画面
- [x] 0.2 macOS：`setContentProtection(true)` 的窗口不出现在整屏采集画面中
- [x] 0.3 macOS 双显示器：`desktopCapturer` 的 `display_id` 与 `screen.getAllDisplays()` 的 `id` 一一对应

## 1. Electron

- [x] 1.1 `meeting-screen-picker` 记录所选来源的类型与 `displayId`，提供查询与清空；单元测试
- [x] 1.2 `meeting-annotation.mjs`：标注窗口与工具栏的创建、铺满目标显示器、层级、内容保护、模式切换、退出路径、显示器变化；单元测试
- [x] 1.3 `annotation-preload.cjs` 与 IPC 校验；主窗口命令 `meetingAnnotationOpen/Close/State`

## 2. 渲染层

- [x] 2.1 `annotation.html` 入口与 Vite 配置
- [x] 2.2 `domains/annotation/annotation-model.ts`：比例坐标、各工具元素、撤销重做、橡皮；单元测试
- [x] 2.3 标注画布（Konva，透明背景、荧光笔、激光笔淡出、文字输入、高分辨率）
- [x] 2.4 标注工具栏页面（工具、颜色、粗细、撤销重做清空、模式、退出、拖动）
- [x] 2.5 会议工具栏与会议小窗「标注」入口；停止共享与离会时关闭

## 3. 验证

- [x] 3.1 单元测试、typecheck、构建
- [ ] 3.2 Electron 实机：整屏共享采集画面包含标注、工具栏不在画面中、操作模式穿透、Esc 与退出路径
  - [x] 标注窗口铺满目标显示器、工具栏置顶且完整显示全部工具；矩形与中文文字绘制、透明背景、撤销/重做、激光笔淡出且不进历史、橡皮、清空、操作模式、Esc 与停止共享关闭且无残留窗口
  - [x] macOS：经真实选屏器共享主屏，采集画面（3024×1964，`monitor`）中矩形四条边都在；工具栏区域深色像素占 2.6%，关闭内容保护后同一区域为 69.4%，确认工具栏被排除
  - [x] macOS：原生全屏窗口上方，`floating` 与 `screen-saver` 层级的标注窗口都出现在采集画面中
- [ ] 3.3 开发版真实会议：参会人看到标注、多显示器、全屏应用、中文输入
- [ ] 3.4 Windows：`display_id`、内容保护、置顶层级与缩放
  - [x] 修复：Windows 上标注窗口获得焦点后盖住工具栏，导致工具栏无法点击。工具栏改为标注窗口的从属窗口（Windows 始终把从属窗口放在所有者之上），并在标注窗口获得焦点、切换模式时再置顶一次；待 Windows 实机复测
