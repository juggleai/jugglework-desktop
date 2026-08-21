## Why

会话右侧只有「Artifacts（会话产物）」入口：仅列出从对话里推断出的产物文件，无产物时按钮置灰，用户无法浏览工作区目录、无法主动打开任意文件，也看不到本次会话到底改了哪些文件。用户需要在不离开会话的前提下浏览工作区、打开并编辑文件、审阅本会话产生的改动。

## What Changes

- 右侧图标栏原 Artifacts 按钮改造为【文件】入口，本地工作区始终可点击（不再因无产物置灰）。
- 【文件】面板顶部提供两个 tab：
  - **文件**：工作区目录树，按需懒加载单层目录，完整展示包括 `.git`、`node_modules`、隐藏文件在内的全部条目；点击文件在面板内打开。
  - **变更**：展示工作区当前未提交的改动（每文件状态、增删行数、逐行 diff），数据取自引擎的 git 工作区 diff，外部编辑器/终端与其它会话的改动同等可见；工作区无改动、非 git 仓库或未安装 git 时该 tab 不出现。
- 面板内维护自己的一组文件标签页，可同时打开多个文件，支持关闭、切换、拖动排序与按会话持久化；与浏览器/产物标签互不干扰。
- 打开的文件可编辑并保存，复用现有产物编辑器与 `updatedAt` 乐观并发校验；存在未保存修改时标签显示脏标记，关闭前提示。
- **BREAKING**：移除独立的「会话产物列表」视图，聊天中点击文件/产物改为在【文件】面板中以文件标签打开。
- 面板右上角新增全屏（双箭头）按钮：全屏后面板覆盖聊天区与左侧会话边栏，再次点击或 Esc 恢复；全屏状态按会话记忆。
- 中英文文案补齐；远程工作区维持现有行为，不提供目录树与变更 tab。

## Capabilities

### New Capabilities

- `session-files-panel`: 会话右侧【文件】面板的入口、目录树浏览、多文件标签打开与编辑、会话变更 diff 展示、全屏切换的完整行为契约。

### Modified Capabilities

无。（`openspec/specs/` 下现有 `desktop-sandbox-runtime`、`orchestrator-retirement`、`server-owned-runtime` 的需求不变。）

## Impact

- 渲染层：`domains/session/panel/`（side-panel、panel-tab-store）、`domains/session/artifacts/`（artifact-panel 复用为文件查看/编辑视图）、`domains/session/chat/session-page.tsx`（右侧图标栏、面板布局、全屏覆盖）、`shell/ui-state-store.ts`（侧栏项与全屏状态）。
- 数据来源：引擎 SDK `file.list`（目录懒加载）与 `vcs.diff` / `vcs.get`（git 工作区改动与 git 可用性）；文件读写继续走 JuggleWork Server `/workspace/:id/files/content`。变更列表的重取由 `session-sync` 转发的引擎事件、会话转空闲与窗口聚焦驱动，不使用轮询。
- 新增文件树、diff 视图组件与相应状态存储；新增中英文文案键。
- 不新增第三方依赖，不改动主进程 IPC，不改动服务端路由。
