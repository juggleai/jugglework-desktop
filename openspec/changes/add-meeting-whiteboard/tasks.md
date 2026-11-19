# Tasks

## 0. 技术验证

- [x] 0.1 Excalidraw 0.18.1 事件绑定核查：拖拽与快捷键依赖全局 window/document，不能直接 Portal 进会议窗口 → 以同源 iframe 承载独立页面
- [x] 0.2 Electron 44 验证 `about:blank` 弹窗内同源 iframe：桥接对象可读、iframe 内 `captureStream` 轨道可在父页面发布、iframe 移除后轨道 ended

## 1. Electron

- [x] 1.1 `whiteboard-store.mjs`：标识校验、原子写入、大小上限、当前 whiteboardId 记录；单元测试
- [x] 1.2 主窗口专用命令 `meetingWhiteboardOpen/Save/Export`（`whiteboard-ipc.mjs`）：调用方校验、导出格式与大小校验、对话框以会议窗口为父窗口；单元测试
- [x] 1.3 移除独立白板窗口、白板 preload 与选屏器白板意图，`meeting-screen-picker` 恢复原状

## 2. 渲染层

- [x] 2.1 `whiteboard.html` 入口、字体资源 Vite 插件、`EXCALIDRAW_ASSET_PATH`；页面经 `frameElement` 读取桥接
- [x] 2.2 `domains/meeting/whiteboard/`：`MeetingWhiteboard` 适配组件、页面外壳（导出、自动保存、卸载前保存）、画布镜像 `canvas-mirror.ts`
- [x] 2.3 会议窗口共享区域内嵌白板 iframe（`MeetingWhiteboardStage`）；`MeetingMedia.startCustomShare` 与屏幕共享共用发布函数；store 的 `shareWhiteboard/publishWhiteboard/closeWhiteboard`
- [x] 2.4 选择器筛选栏「全部 / 桌面 / 白板 / 窗口」与「会议白板」卡片；去掉工具栏白板按钮与切换确认；共享中按钮为「停止共享」
- [x] 2.5 `shareKind` 信令与参会人标签
- [x] 2.6 仅 `whiteboard/` 目录可引用 `@excalidraw/excalidraw` 的测试

## 3. 验证

- [x] 3.1 单元测试、typecheck、构建
- [x] 3.2 选择器夹具在 Chromium 中通过（1000×820 与 720×540）：筛选栏顺序、白板卡片位置、选择白板不选择系统来源
- [x] 3.3 与会议窗口同构的 Electron 环境：iframe 内绘制矩形与中文、自动保存、镜像流有画面、移除 iframe 后轨道结束
- [ ] 3.4 开发版真实会议：选择器选白板、参会人回显与「白板共享」标签、停止共享后重选、重开恢复、离线字体
- [ ] 3.5 macOS/Windows 打包版：`file://` 下 iframe 加载与字体、无外部请求、共享画质、中文输入
