## ADDED Requirements

### Requirement: Cloud documents open in the session file panel
会话文件面板 SHALL 支持云文档标签，使用 product 视图展示原生页面，并按会话持久化 tenantId、workspaceId、docId。云文档、本地文件与变更 SHALL 共用顶部一排标签及相同选中、关闭样式，不增加独立云文档栏。已访问且未关闭的同组织云文档 SHALL 保留在线视图，仅激活标签可见；未访问标签 SHALL 按需加载。标签所属组织与当前组织不一致时 MUST NOT 加载内容。

#### Scenario: User switches between cloud document tabs
- **WHEN** 用户从云文档标签 A 切换到标签 B
- **THEN** A 的视图隐藏，B 首次访问时加载；切回 A 时直接恢复同一实例与编辑位置，不再显示加载提示

#### Scenario: AI creates a cloud document
- **WHEN** AI 在会话中调用 cloud_docs.create 成功
- **THEN** 新文档在会话文件面板以云文档标签打开

#### Scenario: Session tab belongs to another organization
- **WHEN** 会话恢复的云文档标签属于组织 A，当前组织为 B
- **THEN** 标签显示“属于 A，切换组织后可查看”，不加载页面

#### Scenario: User switches between a local file and a cloud document
- **WHEN** 用户在同一排标签中从已就绪的云文档切到本地文件，再切回云文档
- **THEN** 选中态互斥，云文档沿用原实例，不重新交接；本地 Office 选区切换检查仍生效

#### Scenario: An inactive tab finishes loading
- **WHEN** 云文档标签 A 首次加载期间用户已切到 B，随后 A 完成初始化
- **THEN** A 保持隐藏，不抢占 B；关闭 A 时释放 A，B 不受影响

### Requirement: Writable scope is fixed per turn
客户端 SHALL 在发送草稿构建或入队时固定本会话的引用与激活云文档，本地 Server SHALL 根据该快照确定本轮可写范围：选区标签内的块、整篇引用的文档、本会话面板激活的云文档，以及本轮新建的文档。cloud_docs.edit MUST 拒绝范围外文档与选区外块。云文档正文 SHALL 作为不可信数据提供给 AI。

#### Scenario: User changes session while a message is queued
- **WHEN** 会话 A 中的消息入队后，用户在会话 B 打开另一篇文档
- **THEN** A 的消息发出时仍使用入队快照，不取得 B 的激活文档

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
每轮修改云文档后，对话 SHALL 在该轮 AI 回复之后显示按 messageId 绑定的变更卡片，提供查看变更与撤销本轮；卡片 MUST NOT 显示在输入框上方。查看变更 SHALL 在面板高亮修改块。撤销 SHALL 只作用于卡片所属轮次，以反向操作恢复仍为 AI 写入结果的块，每处恢复成功即移出记录；已被修改的块 SHALL 跳过并提示数量。AI 运行中 SHALL 禁用撤销。

#### Scenario: User undoes after a colleague edited one block
- **WHEN** AI 修改 3 个块，其中 1 个随后被同事修改，用户点击撤销本轮
- **THEN** 2 个块恢复，卡片提示“1 处已被修改，未撤销”

#### Scenario: User undoes again after a partial undo
- **WHEN** 部分撤销后用户再次点击撤销本轮
- **THEN** 只重试上次冲突的块，已恢复的块不再重复写入

#### Scenario: User undoes an earlier turn
- **WHEN** 会话有两轮云文档修改，用户点击第一轮卡片的撤销
- **THEN** 只处理第一轮记录；被第二轮再次修改的块计为冲突

### Requirement: Change summaries are loaded per session
会话 SHALL 一次拉取各轮变更汇总，MUST NOT 为每张卡片分别请求汇总。轮次结束或撤销后 SHALL 刷新会话汇总；逐块详情 SHALL 仅在查看时读取。卡片和引用标签 SHALL 使用项目现有图标与组件。

#### Scenario: User opens a long session
- **WHEN** 会话包含 100 轮云文档变更
- **THEN** 使用一次会话汇总请求恢复卡片，不返回全部逐块修改正文

### Requirement: Navigation preserves the cloud document page
首次进入导航云文档后 SHALL 保留页面实例。切换其他导航后返回 SHALL 恢复原页面与位置，MUST NOT 重复交接和整页加载。账号、组织或凭据变化、撤权 SHALL 清理旧实例。会话标签与导航云文档 SHALL 各自保留且只显示当前激活区域。

#### Scenario: User returns from the workspace
- **WHEN** 用户从云文档切到本地工作区后再次点击云文档
- **THEN** 已就绪页面直接恢复，不显示“正在打开云文档”

### Requirement: Host overlays keep the document background visible
账户菜单等宿主浮窗打开时 SHALL 使用当前文档画面保留背景，MUST NOT 显示整页空白或使原生页遮挡菜单。浮窗关闭 SHALL 恢复原页面编辑，MUST NOT 重新加载。

#### Scenario: User opens the account menu
- **WHEN** 云文档已就绪，用户点击左下角账户头像
- **THEN** 菜单可操作且文档背景仍可见；关闭菜单后可继续编辑
