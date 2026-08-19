## 1. 状态与数据层

- [x] 1.1 新增 `domains/session/files/files-panel-store.ts`：按会话保存文件标签、激活标签、目录展开集合、未保存草稿与全屏开关，持久化 key `jugglework:files-panel:v1`（草稿不写入持久化）
- [x] 1.2 新增 `domains/session/files/use-workspace-tree.ts`：用引擎 `client.file.list({ path, directory })` 按目录懒加载，react-query 缓存，单层超过 500 条截断并返回截断标记
- [x] 1.3 新增 `domains/session/files/use-session-changes.ts`：汇总会话内各条用户消息的 `summary.diffs`（`session.diff` 不传 messageID 恒返回空数组），会话状态转 idle 时失效重取，导出变更文件数供 tab 置灰判定
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
