# Change: 隔离外部文件助手工作区与会话

## Why
外部文件已有独立子工作区和真实会话，需要统一文件助手、多标签来源授权及会话恢复的规范与产品说明。本机打开入口误限于 Office 的问题已修复：Markdown 和现有 FileViewer 支持的文本、预览格式也可登记，但打开格式、可写格式与安装包系统关联是不同边界，需明确原件写回与只读范围。

## What Changes
- 每个外部文件使用 `~/Documents/JuggleWork/FileAssistant/files/<32ASCIIhash>` 子工作区和独立真实会话；原件留在原目录编辑保存。
- 管理根目录及子工作区使用 `fileAssistantManaged` 分类，普通工作区 UI 隐藏，正常 API 可见，允许主窗口按精确 workspaceId/sessionId 定位。
- 已有聊天来源继续按 workspace/session 对分窗；外部文件助手统一窗口、多来源标签，每个标签固定 source 和 tabId，顶层身份只是 activeTabId 的投影。
- AI 的 model、agent、variant 和窗口局部草稿按 source 隔离；提交、Main fetch/SSE 按已登记 source 固定目标与权限，不改变 Office owner。
- 原文件以 realpath 及 Windows 身份大小写折叠稳定识别；子目录不含文件名，Windows 路径校验覆盖 ADS、设备路径、相对路径和 NUL，合法 UNC 保留，MAX_PATH 不作可用性承诺。
- 保留 v1 共享历史，不跨工作区复用旧 sessionId；存活旧 Office owner 优先，延后迁移；重开已有会话仅明确 404 才创建替代会话。
- 关闭只撤销相应 fetch/SSE，不自动 abort 已接受运行；窗口局部草稿不承诺跨 App 重启恢复。
- 原生 picker、系统 argv 与 Server 本机登记共用 `packages/types/src/file-window.ts` 的 `FILE_WINDOW_EXTENSIONS`；文本识别统一使用同模块的 `WORKSPACE_TEXT_FILE_EXTENSIONS`，Office helper 不加入 Markdown。
- Markdown 和其他可编辑 UTF-8 文本沿用共享 file-editor，通过现有 raw/content 保存接口解析登记原件；强制 `baseUpdatedAt`，外部修改返回 409，`force` 不得覆盖。Office 仍由原生模型保存，PDF、图片、视频、HTML、XLS、ODS 只读，不开放外部原件批量写入、删除或重命名。
- 安装包系统关联仍仅列 DOCX、XLSX、CSV、PPTX；运行时接受 Markdown 不代表已注册 Finder 候选项或默认打开方式。每文件空间、会话及普通 UI 分类机制保持现有合同。
- 同步当前 specs、Office 技术说明和产品指南；历史 archive 保持原样。

## Impact
- 新增能力规范：`file-assistant-workspaces`。
- 更新能力规范：`file-window-conversation`、`file-window-security-boundary`、`system-office-file-opening`；同步 `office-selection-ai-editing` 的旧默认工作区说明。
- 文档：`docs/office-document-editing-design.md`、`docs/office-selection-ai-editing-design.md`、产品指南 `packages/docs/start-here/do-work-with-it/edit-office-files.mdx` 及文档导航。
- 实现状态：本提案记录工作树中已实现合同；自动化单元回归已有通过证据，真实 Windows 与 macOS Office 全链路验收仍待完成，详见 tasks。本文档变更不包含实现代码。
