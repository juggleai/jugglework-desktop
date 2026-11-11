## ADDED Requirements

### Requirement: Cloud document reference binds a stable identity
`@云文档`、粘贴链接与“交给 Desk AI” SHALL 生成绑定 tenantId、workspaceId、docId 的引用。文档改名后引用 SHALL 继续有效。链接 MUST NOT 授予访问权。

#### Scenario: User pastes a cloud document link
- **WHEN** 用户在输入框粘贴当前组织云文档链接
- **THEN** 校验可读后显示为引用卡片

#### Scenario: Reference belongs to another organization
- **WHEN** 引用的 tenantId 不是当前组织
- **THEN** 工具返回需切换组织，不读取或修改该文档

### Requirement: References live only in the composer
云文档引用 SHALL 以输入框编辑器中的 `cloud-doc` 标签节点存在，与现有提及节点同一机制；输入框上方区域 MUST NOT 增加云文档按钮、引用条或搜索框。删除节点 SHALL 删除引用。同一文档 SHALL 只保留一个标签：整篇与选区合并为整篇，选区之间合并 blockId。单条消息 MUST NOT 超过 32 个引用，每个选区 MUST NOT 超过 200 个块。

#### Scenario: User adds a selection of an already referenced document
- **WHEN** 输入框已有文档 A 的整篇引用，用户再从面板添加 A 的选区
- **THEN** 不新增标签，A 仍为整篇引用

#### Scenario: User deletes a reference chip
- **WHEN** 用户在输入框删除云文档标签后发送
- **THEN** 本轮引用不包含该文档

### Requirement: @ menu searches cloud documents
`@` 菜单 SHALL 在主窗口本机工作区会话且已登录组织时提供“云文档”分组，输入至少 1 个字符后防抖检索，最多 8 条。远程工作区、独立文件窗口与未登录组织 MUST NOT 显示该分组。无结果或请求失败 SHALL 显示不可选状态，MUST NOT 影响其他分组。

#### Scenario: Docs is unavailable
- **WHEN** 用户输入 `@方案` 且 Docs 请求失败
- **THEN** 云文档分组显示“云文档暂不可用”，agent、文件、应用分组照常可用

### Requirement: Pasted link becomes a reference only when readable
整段粘贴内容为当前组织 Docs 页面链接时 SHALL 校验可读，成功后替换为整篇引用标签；其他内容 SHALL 按普通文本粘贴。无权限、不存在、Docs 不可用或属于其他组织时 SHALL 保留文本并提示原因。

#### Scenario: Link from another organization
- **WHEN** 用户粘贴组织 B 的云文档链接，当前组织为 A
- **THEN** 保留链接文本，提示切换到 B 后可引用

### Requirement: Name lookup requires user choice
用户只提供名称时，AI SHALL 搜索并列出候选，由用户选定后以引用进入可写范围。搜索结果 MUST NOT 直接成为写入目标。

#### Scenario: Two documents share a title
- **WHEN** 用户要求修改“产品方案”且存在两个同名文档
- **THEN** AI 展示两个候选并等待选择，不修改任何文档

### Requirement: AI edits use host cloud document capabilities
云文档能力 SHALL 在本地 Server 的 opencode 插件中注册，经 `jugglework_query`／`jugglework_execute` 按真实对话与轮次执行。AI SHALL 先查询 `cloud_docs.context`，再以 `cloud_docs.read` 获取块与 hash，以 `cloud_docs.edit` 提交块级修改。409 冲突 SHALL 重新读取后再提交。编辑完成 SHALL 返回云文档链接。

#### Scenario: Target block changes while AI is working
- **WHEN** edit 返回 409
- **THEN** AI 重新读取冲突块并基于最新内容重新提交

### Requirement: Model input contains readable references
本地 Server SHALL 将内部编码标签转换为可读标题与选区数量后派发模型请求。原始编码标签 SHALL 仅供消息展示元数据使用，MUST NOT 进入模型消息正文。引用身份和选区 SHALL 通过本轮 context 提供。

#### Scenario: User sends a selection reference
- **WHEN** 消息包含产品方案的两个块引用
- **THEN** 模型正文显示 `[云文档《产品方案》·选区 2 段]`，历史消息仍显示可点击标签

### Requirement: Background operations reuse an organization product view
检索、链接校验、上传和 AI 请求 SHALL 共用当前来源、账号与组织的后台产品页，空闲 120 秒后释放。切换登录范围或凭据、撤权、退出时 SHALL 清理旧页。组织域名前缀 SHALL 本地计算，MUST NOT 为识别粘贴链接而创建交接凭据。

#### Scenario: User searches repeatedly without an open cloud document
- **WHEN** 用户在同一组织连续检索并粘贴链接
- **THEN** 各请求复用已就绪或正在初始化的同一后台产品页
