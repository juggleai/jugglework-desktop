## ADDED Requirements

### Requirement: Cloud document reference binds a stable identity
`@云文档`、粘贴链接与“交给 Desk AI” SHALL 生成绑定 tenantId、workspaceId、docId 的引用。文档改名后引用 SHALL 继续有效。链接 MUST NOT 授予访问权。

#### Scenario: User pastes a cloud document link
- **WHEN** 用户在输入框粘贴当前组织云文档链接
- **THEN** 校验可读后显示为引用卡片

#### Scenario: Reference belongs to another organization
- **WHEN** 引用的 tenantId 不是当前组织
- **THEN** 工具返回需切换组织，不读取或修改该文档

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
