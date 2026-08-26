## 1. 状态与数据层

- [x] 1.1 新增 `domains/session/files/files-panel-store.ts`：按会话保存文件标签、激活标签、目录展开集合、未保存草稿与全屏开关，持久化 key `jugglework:files-panel:v1`（草稿不写入持久化）
- [x] 1.2 新增 `domains/session/files/use-workspace-tree.ts`：用引擎 `client.file.list({ path, directory })` 按目录懒加载，react-query 缓存，单层超过 500 条截断并返回截断标记
- [x] 1.3 新增 `domains/session/files/use-workspace-changes.ts`：用引擎 `client.vcs.diff({ directory, mode: "git" })` 取 git 工作区未提交改动，过滤增删均为 0 的文件；空列表或请求失败时用 `client.vcs.get()` 的 `branch` 判定 git 是否可用；重取由 `session-sync` 转发的引擎事件（250ms 合并）、会话转空闲、窗口聚焦与手动刷新触发，不轮询
- [x] 1.4 新增 `domains/session/files/file-content.ts`：`/files/raw` + `/files/stat` 读、`/files/raw` 写的封装，含文本/二进制嗅探、413/409 错误归一化
- [x] 1.5 新增 `domains/session/files/parse-unified-diff.ts` 与单测：把 `SnapshotFileDiff.patch` 解析为 hunk/行结构（新增/删除/上下文/行号）

## 2. 面板 UI

- [x] 2.1 新增 `domains/session/files/file-tree.tsx`：目录在前名称升序、展开懒加载与加载态、失败重试、被 ignore 条目弱化、点击文件回调
- [x] 2.2 新增 `domains/session/files/file-tabs.tsx`：文件标签栏，支持激活、关闭、脏标记与加号再开文件，重复打开同一路径不新增标签
- [x] 2.3 新增 `domains/session/files/file-viewer.tsx`：复用 `artifacts/preview.tsx` 与 `artifact-text-editor.tsx` 渲染文件，文本可编辑并保存，草稿写入 store，内容区无常驻工具栏，保存冲突在提示内提供「重新加载」
- [x] 2.4 新增 `domains/session/files/changes-view.tsx`：变更文件列表（状态 + 增删行数）与选中文件的逐行 diff，超长 patch 折叠，提供「打开文件」跳回文件 tab
- [x] 2.5 新增 `domains/session/files/files-panel.tsx`：组合两个 tab、顶部只保留全屏切换按钮，无改动时「变更」tab 置灰

## 3. 接入会话页

- [x] 3.1 `shell/ui-state-store.ts` 的 `SIDE_PANEL_ITEMS` 增加 `"files"`
- [x] 3.2 `session-page.tsx` 图标栏：Artifacts 按钮替换为【文件】按钮（FolderTree 图标），本地工作区恒可点击，远程工作区不渲染；移除 `openArtifactRailPane` 相关逻辑
- [x] 3.3 `session-page.tsx` 右侧 `ResizablePanel` 增加 `files` 分支渲染 `FilesPanel`
- [x] 3.4 `session-page.tsx` 的 `openTarget`：文件类目标改为在文件面板打开对应路径并展开面板，URL 目标维持浏览器标签
- [x] 3.5 全屏渲染：全屏时在 `SidebarProvider` 内以覆盖层渲染面板（左留 72px 应用导航栏、右留 44px 图标栏、macOS 下从标题栏下方开始），退出后恢复分栏；接入 Esc 退出（焦点在输入控件内时不响应）

## 4. 文案与收尾

- [x] 4.1 在 `i18n/locales/zh.ts` 与 `en.ts` 补齐 `session_files.*` 文案键（入口、两个 tab、空态、加载/错误、冲突提示、全屏按钮、截断提示等）
- [x] 4.2 为新增对外组件与 hook 补中文接口文档注释，关键逻辑（懒加载、冲突处理、全屏重挂载恢复）加 TIPS 注释
- [x] 4.3 运行 `pnpm typecheck`、`pnpm test`、`pnpm build`（仓库无 lint 脚本），确认无新增失败
- [x] 4.4 启动应用验证：目录树懒加载、多文件打开与编辑保存（含 409 冲突拒绝写入）、变更 tab 置灰与 diff 渲染、全屏进出与状态记忆

## 5. 变更视图改用 git 工作区口径

- [x] 5.1 `domains/session/sync/session-sync.ts` 增加 `subscribeWorkspaceFileChanges(workspaceId, listener)`，在既有事件流中转发 `session.diff` / `file.edited` / `file.watcher.updated`（文件面板不在 `GlobalSDKProvider` 作用域内，无法复用 kernel 的事件总线）
- [x] 5.2 `changes-view.tsx`：diff 行底色固定为增 `#e6f4e7` / 删 `#fce6e2` 并同步固定深色文字与行号；列表增删计数改用绿/红文字色（`#1a7f37` / `#cf222e`，暗色主题用亮版），为 0 的一侧不显示
- [x] 5.3 `changes-view.tsx`：列表上方增加文件数与刷新按钮；git 不可用时给出说明文案而非加载失败
- [x] 5.4 目录树、变更列表与 diff 正文改用与会话正文一致的 `subtle-scrollbar`
- [x] 5.5 `i18n/locales/zh.ts` 与 `en.ts` 更新 `session_files.no_changes`（改为工作区口径），新增 `session_files.changed_files`、`session_files.refresh_changes`、`session_files.no_vcs`
- [x] 5.6 运行 `pnpm typecheck`；在 dev 实例上验证变更列表来源、配色计算值、刷新按钮与非 git 目录的接口行为

## 6. 聚焦变更内容

- [x] 6.1 `vcs.diff` 固定请求 3 行上下文，单文件 diff 仅展示变更块及其前后上下文
- [x] 6.2 解析 hunk 起始行并在相隔较远的 hunk 之间展示未变化行折叠占位
- [x] 6.3 补齐解析测试、类型检查并验证 OpenSpec

## 7. Markdown 文件预览优化

- [x] 7.1 Markdown 文件默认展示渲染预览，并提供源码编辑/保存后返回预览的入口
- [x] 7.2 GFM 表格增加窄面板横向滚动与对齐渲染测试
- [x] 7.3 Mermaid 围栏按需加载并渲染 SVG，语法错误局部降级为提示与源码
- [x] 7.4 运行 Markdown 单测、类型检查、构建与 OpenSpec 校验

## 8. 代码复制与文件树右键菜单

- [x] 8.1 Markdown 普通代码块增加复制图标、剪贴板交互与成功反馈，Mermaid 图形保持无复制按钮
- [x] 8.2 文件和目录右键菜单增加复制相对路径、复制原生绝对路径与文件管理器定位
- [x] 8.3 按 macOS Finder、Windows Explorer、Linux 通用文件管理器区分文案与定位行为
- [x] 8.4 补充测试并运行类型检查、构建与 OpenSpec 校验
