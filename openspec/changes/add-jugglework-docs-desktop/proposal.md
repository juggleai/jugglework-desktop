## Why

用户需要从 Desktop 内进入自己的个人文档或当前组织云文档并与同事协作。Desktop 承载 AFFiNE 原生页面和同步，不替换现有本地 Office 引擎，不引入第二套协作协议。

## What Changes

- More 增加云文档，使用现有账号和明确 Personal／团队租户免重复登录。
- 增加 Electron 页面容器、受限宿主桥与账号／租户生命周期处理。
- 接入云文档 IM 自定义消息、气泡、会话预览和跨组织／评论定位，原生站内通知同时保留。
- 文件上传、附件查看与 AI 编辑见 [replace-word-sync-with-cloud-intake](../replace-word-sync-with-cloud-intake/proposal.md)。

## Capabilities

### New Capabilities

- `desktop-cloud-docs`：More、免登录、租户导航与产品交互。
- `cloud-docs-host-bridge`：Electron 容器、受限消息、原生会话存活和身份隔离。
- `cloud-docs-im-notifications`：云文档 IM 卡片、导航与组织隔离。

## Impact

- React：`shell`、`domains/cloud`、`domains/cloud-docs`、`domains/jugglechat`。
- Electron：云文档宿主与受限桥，复用原有 WebContentsView 布局和覆盖层模式。
- 依赖 [Server 身份契约](../../../../jugglework-server/openspec/changes/add-jugglework-docs-integration/api-contract.md)和 [Docs 宿主桥契约](../../../../jugglework-docs/openspec/changes/add-jugglework-docs-adaptation/host-bridge.md)。
