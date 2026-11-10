## Why

云文档采用单一正文来源：本地文件由 Desk 本地 Office 编辑，云文档由 AFFiNE 原生协作编辑，Desk AI 直接编辑选定的云文档。整体设计见 [Docs 变更设计](../../../../jugglework-docs/openspec/changes/replace-word-sync-with-cloud-intake/design.md)。

## What Changes

- 文件操作与 Office 顶栏提供“上传云文档”：一次性上传，成功后留在当前页面，通过提示打开结果。
- 云文档页面中的 Office 附件由 Desk 下载并用本地 Office 引擎只读打开。
- 工作区会话中，云文档在右侧文件面板打开；AI 通过选区标签、`@云文档`、粘贴链接、“交给 Desk AI”或名称定位云文档并直接修改，对话显示本轮变更并支持撤销。
- 移除 Word 与云文档的双向同步：页面桥、后台云文档编辑器、对象适配器、关联记录与检查点。

## Capabilities

### New Capabilities

- `desktop-cloud-upload`：上传云文档入口、重复上传选择与结果反馈。
- `desktop-cloud-attachment-viewing`：云端附件下载与本地只读打开。
- `desktop-ai-cloud-docs`：云文档引用与 AI 文档工具。
- `desktop-session-cloud-docs`：会话文件面板云文档标签、本轮变更与撤销。

## Impact

- React：`domains/cloud-docs`、`session/office`、`session/surface/composer`、会话文件面板、文件操作。
- Electron：`cloud-docs-panel`、`cloud-docs-preload`、Docs 请求代理、文件窗口。
- 本地 Server：opencode 插件 `jugglework-extensions-preview.ts` 注册 `cloud_docs.*` 能力，并注入每轮云文档上下文。
