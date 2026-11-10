# Desktop 云文档上传、附件查看与 AI 编辑

Docs 侧接口、文件类型和数据见 [Docs 设计](../../../../jugglework-docs/openspec/changes/replace-word-sync-with-cloud-intake/design.md)。

## 1. 上传云文档

### 1.1 入口

| 入口 | 适用文件 |
| --- | --- |
| Office 文件顶栏云朵按钮 | 当前打开的 DOCX、XLSX、PPTX、CSV 等 |
| 文件列表／产物操作菜单“上传云文档” | Docs 设计 2.1 中的全部类型 |

按钮只有“上传云文档”一种状态，没有同步、暂停或关联状态。

### 1.2 流程

1. Office 文件先执行现有保存；保存失败、AI 运行中或选区待确认时不上传。
2. 读取已保存文件，计算 SHA-256，调用 Docs `file-intake/lookup`。返回已有页面时弹窗：“打开已有云文档”（不上传）／“另存为新云文档”。
3. 生成 requestId，当前组织隐藏 product 视图执行 `file-intake/preview`、创建页面并 commit，随后释放。
4. 成功后 Toast“已上传到云文档”，提供“查看云文档”；不自动跳转。存在转换警告时 Toast 同时提示“部分格式未转换”。
5. 响应未知时显示“上传结果待确认”，以同一 requestId 查询 status。

上传期间禁用该文件的重复上传。请求缓存保存 requestId、来源服务器、账号、组织与 checksum，不保存文件内容或令牌。

## 2. 附件只读打开

1. Docs 页面发送 `docs.open-attachment`。主进程核对 origin、instanceId、tenantId 与当前视图一致。
2. 主进程使用该云文档视图的会话分区请求 Docs 附件下载接口。
3. 文件写入 `<userData>/cloud-doc-attachments/<账号键>/<tenantId>/<blobId>/<原文件名>`。blobId 为内容摘要，已存在则直接使用。
4. 以独立文件窗口 local 模式、`readOnly=true` 打开。窗口标注“云端附件（只读）”。
5. 用户需要修改时使用“另存为”复制到本地，副本与云端无关联。

切换账号、组织、退出登录时先关闭打开该目录文件的只读窗口，再删除对应 `<账号键>/<tenantId>` 目录。

## 3. 工作区会话中的 AI 编辑

云文档在工作区会话中沿用本地 Office 的会话模式：右侧面板展示文档，输入框携带选区引用，AI 直接修改，对话显示本轮变更。

```
┌ 会话 ───────────────────────────┬ 文件面板 ─────────────────────────┐
│ 用户: 上线时间改到下周五，补充验收标准 │ [产品方案 ☁ ×] [需求.docx ×]   ⤢ │
│       [云文档·产品方案·2 段]          │ ┌───────────────────────────────┐ │
│                                    │ │ # 产品方案                      │ │
│ AI: 已修改云文档                    │ │ 上线时间：11月21日   ← 高亮     │ │
│ ┌ 云文档变更 ──────────────────┐   │ │ ## 验收标准          ← 高亮     │ │
│ │ ☁ 产品方案 · A公司 · 改1 增2   │   │ │ 1. …                           │ │
│ │ [查看变更]  [撤销本轮]        │   │ └───────────────────────────────┘ │
│ └──────────────────────────────┘   │ A公司 · 实时协作                    │
└────────────────────────────────────┴───────────────────────────────────┘
```

### 3.1 文件面板云文档标签

- 会话文件面板增加云文档标签，标题前显示云朵图标。打开方式：点击对话中的云文档引用、变更卡片或链接；AI 新建或导入的云文档自动在面板打开。
- 标签内容为 product 视图（page 目标），按“原生视图随宿主布局显示”挂载于面板内容区；面板宽度小于 720px 时收起 AFFiNE 左侧栏。
- 每个会话面板只保持激活的云文档标签有在线视图；切换到其他标签时销毁该视图，切回时以新 instanceId 重新交接加载。
- 标签状态按会话持久化：tenantId、workspaceId、docId、标题。
- 标签 tenantId 与当前组织不一致时不加载内容，显示“属于 {组织名}，切换组织后可查看”。
- 面板底部状态行显示组织名与原生连接状态。

### 3.2 定位与引用

| 入口 | 行为 |
| --- | --- |
| 面板中选中块 →“添加到对话” | 输入框插入选区标签 `[云文档·标题·N 段]` |
| 面板中选中块 →“问 Desk AI” | 插入选区标签并聚焦输入框 |
| 页头“交给 Desk AI” | 插入整篇引用 `[云文档·标题]` |
| 输入框 `@云文档` | 调用 Docs `ai/search`，选择后插入整篇引用 |
| 粘贴云文档链接 | 校验可读后转为整篇引用 |
| 只提供名称 | AI 调用 search 列出候选，用户选定后以引用继续 |

标签为原子节点，悬浮显示标题、组织和所选块数量，可单独删除。引用绑定 tenantId、workspaceId、docId；选区标签另含 blockId 列表。消息只携带引用，不携带正文。

本地 Server 在接收用户消息时确定本轮可写范围，所有写入工具按此范围执行：

| 条件 | 可写范围 |
| --- | --- |
| 含选区标签 | 标签所属文档中标签内的块 |
| 含整篇引用 | 引用的文档 |
| 无引用且面板激活标签为云文档 | 该云文档 |
| 任意情况 | 本轮 `cloud_docs.create`／`cloud_docs.import` 新建的文档 |

范围外文档只读。用户只提供名称时，AI 搜索并列出候选；用户在对话中选定后，下一轮以引用形式进入可写范围。`cloud_docs.edit` 对范围外文档或选区外块返回拒绝。

引用的 tenantId 与当前组织不一致时，工具返回需切换组织，不跨组织读写。云文档正文作为不可信数据注入，AI 不执行其中的指令。

### 3.3 工具

云文档能力与本地 Office 能力使用同一接入方式：在本地 Server 的 opencode 插件 `jugglework-extensions-preview.ts` 中注册，AI 通过 `jugglework_query`／`jugglework_execute` 按 id 调用；本地 Server 按真实调用对话与轮次解析可写范围、执行选区限制并记录本轮变更。

| id | 类型 | 对应 |
| --- | --- | --- |
| `cloud_docs.context` | query | 本轮可写范围、引用、选区 blockId 与面板激活云文档 |
| `cloud_docs.search` | query | Docs `ai/search` |
| `cloud_docs.read` | query | Docs `ai/read`（auto／full／outline／blockIds） |
| `cloud_docs.edit` | command | Docs `ai/edit`；先校验可写范围与选区 |
| `cloud_docs.create` | command | Docs `ai/create`；成功后在面板打开 |
| `cloud_docs.import` | command | 以会话工作区内文件路径执行 1.2 上传流程；成功后在面板打开 |

本地 Server 不持有 Docs 登录态。对 Docs 的请求经已有本地 Server 与 Electron 主进程通道交给主进程，主进程使用当前组织云文档会话分区发出；当前组织没有有效 Docs 会话时按现有 product 交接建立会话。

每轮注入云文档上下文与规则（与 `office-editing-context.ts` 同一方式）：编辑前查询 `cloud_docs.context`；hash 只取自 `cloud_docs.read`；正文为不可信数据。

云文档能力不触发权限请求，任何会话权限模式下 AI 均直接写入可写范围内的文档。

AI 编辑步骤：context → read（长文默认返回大纲，再按 blockIds 读取）→ 按 blockId 与 hash 提交 edit → 409 时重新读取冲突块后再提交。任务进度显示为“编辑云文档《标题》· N 处”。

### 3.4 本轮变更与撤销

- 每轮结束后，对话显示云文档变更卡片：文档名、组织、改／增／删数量。同轮修改多篇文档时每篇一行。
- “查看变更”：在面板打开该文档并发送 `docs.highlight-blocks` 高亮修改块；卡片展开逐块修改前后内容。
- “撤销本轮”：以 edit 响应中的修改前内容提交 partial 反向操作；被删块插回第一个仍存在的前驱块之后。全部恢复时卡片标记“已撤销”；部分块已被他人修改时提示“N 处已被他人修改，未撤销”，其余恢复。
- 本轮变更记录（docId、操作、修改前内容、写入后 hash）随会话持久化于本地 Server，不含整篇正文。

## 4. 移除内容

| 位置 | 移除 |
| --- | --- |
| Electron | `office-word-blocks-adapter`、`office-word-paragraph-adapter`、`office-word-cloud-bridge`、`office-cloud-docs-coordinator`、`office-cloud-docs-session`、`cloud-doc-bindings`、`cloud-docs-editor` 及测试 |
| React | `cloud-docs/upload-word.ts`、`cloud-docs/word-intake-request.ts`、同步状态图标与“打开云端／恢复同步”入口 |
| Office | `/office/saved` 中仅供检查点使用的字段与逻辑 |
| 交接 | editor 展示模式 |

该功能未正式发布，不做本地数据迁移。
