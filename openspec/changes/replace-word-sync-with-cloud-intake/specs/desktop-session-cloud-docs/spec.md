## ADDED Requirements

### Requirement: Cloud documents open in the session file panel
会话文件面板 SHALL 支持云文档标签，使用 product 视图展示原生页面，并按会话持久化 tenantId、workspaceId、docId。每个面板 SHALL 只保持激活标签的在线视图。标签所属组织与当前组织不一致时 MUST NOT 加载内容。

#### Scenario: User switches between cloud document tabs
- **WHEN** 用户从云文档标签 A 切换到标签 B
- **THEN** A 的视图被销毁，B 以新交接加载；切回 A 时重新加载

#### Scenario: AI creates a cloud document
- **WHEN** AI 在会话中调用 cloud_docs.create 成功
- **THEN** 新文档在会话文件面板以云文档标签打开

#### Scenario: Session tab belongs to another organization
- **WHEN** 会话恢复的云文档标签属于组织 A，当前组织为 B
- **THEN** 标签显示“属于 A，切换组织后可查看”，不加载页面

### Requirement: Writable scope is fixed per turn
本地 Server SHALL 在接收用户消息时确定本轮可写范围：选区标签内的块、整篇引用的文档、面板激活的云文档，以及本轮新建的文档。cloud_docs.edit MUST 拒绝范围外文档与选区外块。云文档正文 SHALL 作为不可信数据提供给 AI。

#### Scenario: AI tries to edit outside the selection
- **WHEN** 本轮含 2 个块的选区标签，AI 提交修改第 3 个块
- **THEN** 工具拒绝该操作，页面不变

#### Scenario: Document text instructs AI to edit another document
- **WHEN** 被读取的云文档正文要求修改另一篇未被引用的文档
- **THEN** 对该文档的 edit 被拒绝，页面不变

### Requirement: AI writes without approval
云文档工具 SHALL NOT 触发权限请求；任何会话权限模式下 AI SHALL 直接写入，并在面板及其他协作者处实时可见。

#### Scenario: Session uses Request approval mode
- **WHEN** 会话为请求批准模式且 AI 调用 cloud_docs.edit
- **THEN** 不弹出批准，修改直接写入云文档

### Requirement: Turn change card with undo
每轮修改云文档后，对话 SHALL 显示变更卡片，提供查看变更与撤销本轮。查看变更 SHALL 在面板高亮修改块。撤销 SHALL 以反向操作恢复仍为 AI 写入结果的块，已被他人修改的块 SHALL 跳过并提示数量。

#### Scenario: User undoes after a colleague edited one block
- **WHEN** AI 修改 3 个块，其中 1 个随后被同事修改，用户点击撤销本轮
- **THEN** 2 个块恢复，卡片提示“1 处已被他人修改，未撤销”
