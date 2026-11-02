# 文件窗口 AI 对话与默认工作区

## Why

用户从会话打开工作区文件后，需要在独立文件窗口继续原对话，而不必返回主窗口。两个页面必须展示和操作同一个真实会话，不复制历史、不新建镜像 session。

## What Changes

- 文件窗口为已有本地工作区会话提供 AI 面板，复用主窗口的 `SessionSurface`、会话数据加载及发送/停止/交互处理代码。
- 主窗口与独立窗口使用同一原始文件；Office 复用同一文档模型并交接编辑视图，文本共用既有编辑状态，保存写回原路径。
- AI 对话入口位于独立窗口文件工具栏更多菜单右侧，使用机器人图标和深色按钮，展开后隐藏。两种文件编辑宿主移除上传、分享入口；面板显示 JuggleWork、相邻跳转图标及关闭按钮，分栏不绘制线条，消息使用自动隐藏滚动条。
- 打开文件窗口时由 Main 固定已有 `workspaceId/sessionId`。主窗口切换会话不改变文件窗口归属；一个文件窗口只容纳同一归属的文件标签。
- 两个 renderer 使用同一组既有 Server/OpenCode session 接口和事件源。消息、运行与交互重新读取既有事实，不建立第二套消息、运行或队列存储。
- 草稿、未发送附件和面板展开状态属于当前窗口，不实时共享，不承诺窗口关闭后的新增恢复能力。文件窗口首版不自动消费 follow-up 队列，也不启用 goal continuation，避免两个 renderer 同时调度。
- 无归属的外部文件使用默认工作区 `~/Documents/JuggleWork/FileAssistant`，自动创建或恢复真实文件浏览器会话；同窗口标签共享会话。原文件保留原目录，默认工作区存放运行产物，会话历史沿用已有存储。
- Main 保管服务端凭据；新增会话桥仅允许已绑定会话的必要读取、发送、停止和交互。现有文件预览代理和来源校验保留，不给 renderer 通用 token 或任意网络/IPC 能力。
- 原生 Office 使用实际分栏布局更新 bounds，不能让 DOM 面板覆盖原生 view；不改变模型 owner、选区授权和保存流程。
- 新会话首次保存请求审批使用既有权限模式存储，保持收紧权限；打包时验证桌面入口及包内相对资源，拒绝会导致 file:// 白屏的网页构建。

## Scope

本次不新增数据库表、不升级 SQLite schema、不迁移 OpenCode 消息、不替换 coordinator 或 pending-operation 存储，不改变 runtime profile 和数据库路径。

外部文件仅增加必要的原路径及会话关联，不新增聊天库或数据库表。不包含跨窗口富草稿协同、队列重构、Release A/B 桥或 launcher 防降级。既有 Office、安全和关闭合同继续有效。

## Capabilities

### New Capabilities

- `file-window-conversation`：已有会话的文件窗口 AI 面板、固定归属和布局。
- `session-view-reuse`：同一套会话 UI/控制代码服务两个页面，复用既有历史和运行管理。
- `file-window-security-boundary`：文件窗口的来源校验、凭据隔离及有界绑定代理。

## Impact

影响 React 会话装配层、独立文件窗口、Electron Main/preload 受限桥、外部文件登记与默认工作区。复用既有工作区注册、数据库、消息存储及 Office 原路径保存协议。
