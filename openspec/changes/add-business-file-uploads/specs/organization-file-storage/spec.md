## ADDED Requirements

### Requirement: 活动组织管理存储设置
服务端 MUST 将 `GET/PUT /jwork/api/v1/storage/settings` 限于具有组织管理能力的活动组织 owner/admin；Web 管理台提供启用开关、桶、Access Key、Secret Key、上传和下载域设置。仅支持 `qiniu`。

#### Scenario: 首次配置与后续改动
- **WHEN** 管理员读取尚未配置的组织
- **THEN** 返回完整的禁用设置，`hasSecretKey=false`；首次 PUT 必须提供密钥。
- **WHEN** 管理员后续 PUT 省略或留空 `secretKey`
- **THEN** 保留该组织已加密存储的密钥；提供新密钥则替换。GET/PUT 均只返回密钥存在标志，不回显 Secret Key。

#### Scenario: 组织隔离
- **WHEN** 普通成员或个人工作区访问管理接口
- **THEN** 拒绝读写；管理员要管理另一组织必须先切换活动组织。

#### Scenario: 保存端点
- **WHEN** 管理员保存上传和下载地址
- **THEN** 仅接受无凭据、端口、子路径、查询、片段的 HTTPS 域名；上传仅限 `up` 或 `upload` 的 `qiniup.com` 端点，可无区域后缀或使用 `-z0`、`-z1`、`-z2`、`-cn-east-2`、`-na0`、`-as0`。

### Requirement: 签发按组织、成员和任务授权
`POST /jwork/api/v1/organizations/:organizationId/file-upload-credentials` MUST 使用已认证成员的活动组织和本人身份，且路径组织必须匹配。指定已保存任务时，必须具有该任务的 `CanEditContent` 或 `CanComment`，管理员无旁路。

#### Scenario: 只可评论与只读的区别
- **WHEN** 仅可评论的成员为该任务申请附件凭据
- **THEN** 可以签发，但不会授予修改任务描述的权限；仅能查看的成员不能签发。

#### Scenario: 组织或存储不可用
- **WHEN** 路径组织与活动组织不同
- **THEN** 拒绝签发，不使用其他组织的存储设置。
- **WHEN** 合法成员为有效用途请求签发，而本组织未配置或已禁用存储
- **THEN** 返回 `503 storage_unavailable`。

### Requirement: 单文件用途、范围与期限
服务端 MUST 校验文件名合法、大小为正且不超过下表上限。图片用途校验扩展名与声明 MIME 一致：`image/png`、`image/jpeg`、`image/webp`、`image/gif` 分别对应 `.png`、`.jpg`/`.jpeg`、`.webp`、`.gif`。

| 用途 | 允许类型 | 大小上限（含） | 对象前缀 |
|---|---|---|---|
| `avatar` | 四种图片 | 5 MiB | `avatars/`；不得指定任务 |
| `task_image` | 四种图片 | 5 MiB | `images/` |
| `task_attachment` | 任意格式，统一按 `application/octet-stream` 上传；兼容旧客户端的四种图片及 PDF | 20 MiB | `attachments/` |

#### Scenario: 新对象按业务用途命名
- **WHEN** 合法任务文件通过校验
- **THEN** 草稿与已保存任务按相同用途使用同一目录，各自以服务端 UUID 加扩展名命名，不包含组织、用户、任务 ID 或原始文件名。

#### Scenario: 使用短路径更换头像
- **WHEN** 成员提交 `avatars/` 下的新头像 URL
- **THEN** 服务端要求签名标签与活动组织、当前用户、下载基址及文件名匹配，拒绝他人的头像和未经签发的短路径；原本人头像 URL 继续兼容，已有对象及引用不迁移。

#### Scenario: 精确 key 的五分钟策略
- **WHEN** 服务端签发成功
- **THEN** 返回 `provider=qiniu`、`uploadUrl`、`token`、`key`、`fileUrl`、`expiresAt`。策略限定 `scope=bucket:key`、五分钟期限、`insertOnly=1`、`fsizeLimit=sizeBytes`。
- **AND** 通用二进制附件使用 `.bin` 对象名和 `detectMime=-1`，省略 `mimeLimit`；头像、正文插图及旧版有类型附件仍使用 `detectMime=1` 和 `mimeLimit=contentType`。

#### Scenario: 不支持的文件
- **WHEN** 文件为零字节、超过用途上限、图片用途扩展名与 MIME 不符，或请求将非白名单类型用作头像或任务图片
- **THEN** 拒绝签发；只有附件用途可以申请通用二进制上传。

### Requirement: 明示持链接读取的部署边界
管理台 MUST 告知管理员使用专用 HTTPS 下载域、持链接即可读取。`fileUrl` 是下载域加对象 key 的无签名 URL，要求桶允许非私有读取；服务不配置桶 ACL，也不为私有桶签发下载链接。

#### Scenario: 已分享文件的可读性
- **WHEN** 管理员采用支持的非私有桶及下载域，文件已上传且仍对外提供
- **THEN** 即使源于私密任务或未保存草稿，持链接者也无需登录；五分钟上传时限、退出组织、任务删除和禁用新签发均不会撤回该链接。
