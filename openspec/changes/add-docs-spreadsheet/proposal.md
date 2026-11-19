## Why

云表格改为 Docs 内置 FortuneSheet 模块。Desktop 需要复用现有云文档视图、文件页签、上传与退出保护，不在本机再运行一套云端 Office 服务。[Docs 主合同](../../../../jugglework-docs/openspec/changes/add-docs-spreadsheet/design.md)定义正文、协作和格式，本项目只记录宿主差异。

## What Changes

- 从同一 Docs 页面打开 `contentKind=spreadsheet`，复用当前来源/账号/租户分区、主窗口、统一文件页签和独立 File Browser。
- 本地 XLSX/CSV 先保存后上传，返回独立云表格；成功不跳转，分享按钮复制链接，再次另存上传创建新资源，不恢复双向同步。
- 表格保存使用实例最后 opId 的数据库确认；原生文档及本地 Office 保持各自既有保存规则。
- XLSX、CSV 和 PDF 均复用既有下载及保存位置交互。菜单按服务端真实能力显示。
- 本地 Word/Excel/PPT 编辑器保持，云端 Word 沿用原生文档；云端幻灯片列为后续 TODO，不显示可点击新建入口。

## Capabilities

### New Capabilities

- `desktop-spreadsheet`：类型化云表格、一次上传、统一页签、保存关闭与格式交换。

## Impact

现有 `domains/cloud-docs`、上传/分享、Electron `cloud-docs-panel.mjs`、下载按资源类型扩展；Local Server 原生 Office 引擎不替换。Work 无新增正文/分类接口，Desktop 不配置独立表格地址。

## Status

设计完成，FortuneSheet 宿主适配尚未实施、未验证或部署；[tasks](tasks.md)区分设计与开发。
