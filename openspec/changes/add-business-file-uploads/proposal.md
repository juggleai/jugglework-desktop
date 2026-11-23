## Why

组织成员需要从本机选择头像、任务图片和 PDF，而不必先自行托管文件再粘贴链接。组织应能选择自己的存储桶，并在启用前知道谁能上传、谁能读取。

## What Changes

- 在 Web 管理台的组织设置中配置七牛 Kodo；服务端按活动组织保存设置，默认禁用。
- 服务端按用途、文件和成员权限签发五分钟有效、仅能新增一个精确 key 的上传凭据。桌面端将文件直传七牛，校验回执后才使用 URL。
- 个人头像通过用户资料 `avatarUrl` 保存；任务描述和评论以 Markdown 引用图片或附件。新对象只按业务用途分目录，不在路径公开组织、用户或任务 ID。
- 启用条件是接受专用 HTTPS 下载域上的持链接读取。私有桶、逐次下载鉴权及链接自动撤回不在本变更内。

## Capabilities

### New Capabilities

- `organization-file-storage`：组织管理员配置、按权限签发单文件凭据、上传范围及下载边界。
- `desktop-business-file-uploads`：桌面端校验与直传、个人头像更新、任务描述和评论的 Markdown 引用。

### Modified Capabilities

无。沿用现有用户资料、任务内容编辑和评论接口及权限。

## Impact

服务端涉及 `organization_storage_settings` 迁移、control API 和 Web 管理台；桌面端涉及 Den 客户端、账户设置与任务编辑器。部署依赖组织的七牛桶、区域上传端点、CORS 和下载域名。实现与接口口径以 `jugglework-server/docs/organization-file-storage.md` 和当前代码为据；真实线上桶尚未联调通过。
