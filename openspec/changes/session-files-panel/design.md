## Context

会话右侧图标栏当前有 4 个入口：Browser / Voice / Artifacts / Extensions（`domains/session/chat/session-page.tsx:1673-1740`），右侧面板由 `SIDE_PANEL_ITEMS = ["panel","extensions","voice"]`（`shell/ui-state-store.ts:17`）切换。其中 `panel` 承载 `SidePanel`，内部用 `panel-tab-store` 管理 `browser` / `artifact` 两类标签，`artifact` 标签由聊天文本推断出的产物（`artifacts/open-target.ts`）驱动，`ArtifactPanel` 负责预览与保存。

本变更把 Artifacts 入口替换为【文件】面板：目录树 + 多文件标签 + 会话变更 diff + 全屏。相关既有能力可复用：`artifacts/preview.tsx`（markdown/图片/PDF/HTML/纯文本预览）、`artifacts/artifact-text-editor.tsx`（CodeMirror 编辑器）、JuggleWork Server 文件读写路由、引擎 SDK 的 `file.list` 与 `session.diff`。

## Goals / Non-Goals

**Goals:**

- 本地工作区会话内可浏览完整目录树、打开任意文件查看与编辑、审阅本会话累计改动。
- 面板状态（打开的文件、展开的目录、草稿、全屏）在收起/展开、全屏切换、会话切换之间稳定。
- 不新增第三方依赖，不改动主进程 IPC 与服务端路由。

**Non-Goals:**

- 远程工作区的目录树与变更视图。
- 文件的新建/重命名/删除/拖拽移动等文件管理操作。
- git 暂存、提交、撤销 hunk 等版本控制操作。
- 语法高亮按语言细分（沿用现有编辑器的 markdown / 纯文本两档）。
- 全局文件搜索（截图中的 Find tab 不在本次范围）。

## Decisions

### 目录树用引擎 `file.list` 懒加载，而不是服务端 catalog 快照

引擎 SDK 提供 `client.file.list({ path, directory })`，返回单层 `FileNode { name, path, absolute, type, ignored }`，天然适配「展开时才请求」。

替代方案 `GET /files/sessions/:id/catalog/snapshot`（`apps/server/src/routes/files.ts:713`）是一次性递归遍历整个工作区且不跳过 `.git`/`node_modules`，在大仓上会长时间阻塞并返回上万条目，与「全部显示 + 懒加载」的要求正好相反，故不采用。

`FileNode.ignored` 不用于过滤（需求要求全部显示），仅用于把被忽略的条目以低对比度呈现。

### 文件读写走 `/files/raw`，而不是 `/files/content`

`GET/POST /workspace/:id/files/content` 有扩展名白名单 `isSupportedWorkspaceTextFilePath`（`apps/server/src/routes/files.ts:81`），`.py`、`.kt`、`.gradle`、`Dockerfile` 等常见文件会直接 400。目录树可以打开任意文件，因此：

- 读：`client.downloadWorkspaceFile`（`GET /files/raw`，无白名单）取字节 + `client.statWorkspaceFile` 取 `updatedAt`/`size`。
- 写：`client.writeWorkspaceBinaryFile`（`POST /files/raw`，带 `baseUpdatedAt`，冲突返回 409）。

文本/二进制判定在前端做：先按扩展名走 `classifyOpenTarget` 决定预览形态（markdown/image/pdf/html/sheet/text），扩展名未知时嗅探字节内容（含 NUL 或不可解码 UTF-8 视为二进制），二进制走既有预览或「不可预览」空态。5MB 以上由服务端返回 413，前端转成明确提示。

### 面板状态集中放 store，容忍全屏切换时的重挂载

全屏时面板需要覆盖左侧边栏，而边栏在 `SidebarProvider` 内、聊天区在 `SidebarInset` 内（`session-page.tsx:1096-1160`），面板本体又在右侧 `ResizablePanel` 里。让同一个 React 节点在「分栏」和「覆盖层」两个位置之间移动必然重挂载（portal 换容器同样会重挂载）。

因此不追求节点复用，改为把全部可变状态放进 `files-panel-store`（zustand + persist）：打开的文件标签、激活标签、目录展开集合、未保存草稿、全屏开关。组件重挂载后从 store 恢复，用户无感知；草稿保留也正好满足「脏标记 + 关闭前确认」的需求。目录树数据与文件内容由 react-query 缓存兜底，重挂载不会重新打网络。

全屏覆盖层渲染在 `SidebarProvider`（已是 `relative`）内：右侧留出 44px 入口图标栏，左侧留出 72px 应用导航栏，其余（工作区标题、会话列表、会话页头）全部盖住。顶部不留空白：面板头部自己就贴着窗口顶端，全屏时整行设为 `titlebar-drag`（`titleBarStyle: hiddenInset` 下这条就是系统标题栏区域，可拖窗口），行内的 tab 与全屏按钮各自标 `titlebar-no-drag`，因此既不用留空白条，按钮也点得动。

顶部只有一行工具栏，高度 56px，与会话页头（`.session-header`，`styles/custom.css`）齐平：左侧目录树入口、中间标签栏（`min-w-0 flex-1 overflow-hidden`，内部横向滚动，因此标签再多也不会顶到两侧按钮）、右侧全屏开关。会话变更不再是分区 tab，而是标签栏里的第一个标签（带变更文件数、不可关闭），和打开的文件标签并列，由 `activeKey` 决定内容区显示 diff 还是文件。

全屏与分栏用的是同一个组件，只按 `fullscreen` 切换排布：全屏宽度足够，目录树常驻左栏（256px）并可用工具栏左侧的按钮折叠（`treeCollapsed` 按会话记忆）；分栏最窄只有 320px，塞不下两栏，因此还没打开任何内容时目录树占满面板，打开之后目录树收进标签栏左侧的悬浮菜单（☰）与右侧加号里。

悬浮菜单用受控的 Popover 自己接管 open：base-ui 这版没有 `openOnHover`。关闭走 220ms 延时，指针从按钮移到弹层的路上不会被收掉；展开目录不关闭弹层，只有真正打开文件才关闭（`children` 以回调形式拿到 close）。

### 变更视图从消息列表汇总，前端自解析 unified patch

引擎的 `GET /session/:id/diff` 在不传 `messageID` 时**恒定返回空数组**（实现里第一行就是 `if (!messageID) return []`），它只用于查单条用户消息的改动。会话累计改动的真实来源是消息列表：每条用户消息的 `info.summary.diffs` 是那一轮（step-start 快照 → step-finish 快照）产生的 `SnapshotFileDiff[]`（`file`、`patch`、`additions`、`deletions`、`status`），与 git 仓库状态无关，非 git 目录同样可用。

因此 `useSessionChanges` 调 `client.session.messages({ sessionID })`，按文件合并各轮改动：增删行数相加，状态按「首轮 added / 末轮 deleted / 否则 modified」判定，patch 按轮次顺序拼接——各轮 patch 的行号分属不同快照，强行合并成一份会得到错误的行号。

`patch` 是标准 unified diff，前端用一个约 60 行的解析函数拆成 hunk/行，渲染增删行底色即可，不引入 diff 库。刷新时机：面板可见且选中「变更」tab 时按 `sessionId` 查询，会话状态从 busy 转 idle 时使查询失效重取；tab 上的数字与置灰态由同一份查询驱动（`enabled` 始终为真但 `staleTime` 较长，保证 tab 置灰判定在面板未打开时也正确）。

### 入口替换与产物路径收敛

- `SIDE_PANEL_ITEMS` 增加 `"files"`；图标栏第三个按钮从 Artifacts 改为【文件】（`FolderTree` 图标），本地工作区恒可点击，远程工作区不渲染。
- `openTarget` 中命中文件的分支不再创建 `artifact` 标签，改为在文件面板打开对应路径；URL 分支维持浏览器标签不变。
- `panel-tab-store` 的 `artifact` 标签类型与 `SidePanel` 中的渲染分支保留：老版本持久化数据里可能仍有 artifact 标签，保留渲染路径可以让它们继续正常显示直到被关闭；新逻辑不再创建这类标签。

## Risks / Trade-offs

- [超大目录（如 `node_modules` 根层数千条目）渲染卡顿] → 单层超过 500 条时截断展示并提示「仅显示前 500 项」，配合虚拟滚动前的最小成本方案。
- [全屏切换重挂载导致滚动位置丢失] → 只保证标签、草稿、展开状态不丢；滚动位置丢失可接受，必要时后续再存。
- [`session.diff` 依赖引擎快照，会话极长时 patch 体积大] → 列表与 diff 分开渲染，只有选中文件才渲染其 patch；单文件 patch 超过 2000 行时折叠并提供「仍要展示」。
- [编辑器仅有 markdown/纯文本两档高亮，代码文件观感弱于 IDE] → 本次接受，语法高亮扩展作为后续独立变更。
- [写入任意扩展名文件绕过了 `/files/content` 的白名单] → `/files/raw` 已有路径穿越校验、5MB 上限、审批与审计记录，安全边界不变；白名单本身面向的是「内联文本产物」，不是安全控制。

## Migration Plan

纯前端渲染层变更，随版本发布即可生效，无数据迁移。回滚方式为还原提交：`panel-tab-store` 结构未变，`files-panel-store` 的持久化 key 独立（`jugglework:files-panel:v1`），回滚后不会影响原有面板行为。

## Open Questions

无。
