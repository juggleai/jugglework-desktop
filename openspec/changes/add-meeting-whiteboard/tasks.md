# Tasks

## 0. 技术验证

- [x] 0.1 Excalidraw 0.18.1 事件绑定核查：拖拽与快捷键依赖全局 window/document，Portal 子窗口不可用 → 改为独立页面入口
- [x] 0.2 Electron 44 实测 `setDisplayMediaRequestHandler` 回调 `{ video: WebFrameMain }`：live 轨道、窗口隐藏后有画面、窗口销毁后轨道 ended

## 1. Electron

- [x] 1.1 `whiteboard-store.mjs`：标识校验、原子写入、大小上限、当前 whiteboardId 记录；单元测试
- [x] 1.2 `meeting-whiteboard-window.mjs`：唯一窗口、页面加载、拒绝新窗口/跳转/权限、随会议窗口关闭；单元测试
- [x] 1.3 `meeting-screen-picker` 内部来源分支：一次性意图、主框架与手势校验、过期回落；单元测试
- [x] 1.4 `whiteboard-preload.cjs` 与 IPC：上下文读取、保存、导出；主窗口侧 `meetingWhiteboardOpen/Close/ArmShare`

## 2. 渲染层

- [x] 2.1 `whiteboard.html` 入口、字体资源 Vite 插件、`EXCALIDRAW_ASSET_PATH`
- [x] 2.2 `domains/meeting/whiteboard/`：`MeetingWhiteboard` 适配组件（懒加载 Excalidraw、中文、主题、关闭外部入口）与页面外壳（工具条、导出、自动保存）
- [x] 2.3 会议工具栏「白板」入口、共享互斥确认、`shareKind` 信令与参会人标签
- [x] 2.4 仅 `whiteboard/` 目录可引用 `@excalidraw/excalidraw` 的测试

## 3. 验证

- [x] 3.1 单元测试、typecheck、构建
- [ ] 3.2 开发版实机：打开白板、绘制、共享画面回显、切换互斥、关闭停止共享、重开恢复、离线字体
  - [x] 独立 Electron 44 验收：白板页渲染、矩形与中文文本绘制、自动保存、关闭前 flush、Excalifont/Xiaolai 本地加载且无外部请求、WebFrameMain 采集有画面
  - [ ] 真实会议链路：IPC 往返后 `getDisplayMedia` 是否仍有用户手势、参会人端回显与 `shareKind` 标签、互斥与重开恢复
- [ ] 3.3 macOS/Windows 打包版：字体与无外部请求、共享画质、中文输入
