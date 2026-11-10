## ADDED Requirements

### Requirement: Host appearance stays consistent
Desktop SHALL 将当前实例的明暗主题、界面语言、字体及语义配色传给 Docs。切换外观 SHALL 不重建编辑会话，不更新文档正文或源身份；过期实例的外观消息 SHALL 被忽略。

#### Scenario: User changes theme or language while editing
- **WHEN** Desk 在云文档打开期间切换明暗主题或中文／英文
- **THEN** Docs 跟随当前宿主显示，侧栏／背景／字体一致，页面和原生协作会话保持不变

### Requirement: Isolated native view lifecycle
Desktop SHALL 使用受限 WebContentsView 承载 Docs，账号来源与用户分区隔离，租户视图明确绑定。组织／账号切换和退出 SHALL 先停止旧可写视图及桥，再发布新身份。

#### Scenario: Old view replies after account switch
- **WHEN** 旧 instanceId 的异步 ready 或内容消息在切换后到达
- **THEN** 丢弃该消息，不能激活新账号页面或写入新账号文件

#### Scenario: Passive IM configuration refreshes
- **WHEN** IM 配置或组织展示资料刷新，但 Server、账号、组织 ID 和登录凭据没有变化
- **THEN** 保留当前原生文档与协作连接，不重新申请交接或跳回首页

### Requirement: Native editor session ownership
每个打开的关联 Word SHALL 保持唯一写入桥及原生编辑会话引用，前台导航 MUST NOT 将其导航到另一页。关闭或断开后 SHALL 释放引用；云同步仍使用原生 provider。

#### Scenario: User browses another cloud page while Word is open
- **WHEN** 前台产品页切换到另一文档
- **THEN** 已关联 Word 的原生会话仍属于原页面，不重复建立回写桥

### Requirement: Bounded host authority
远程页面 SHALL 只访问编辑桥能力，不获得通用 Node、任意文件或可执行代码接口。宿主 SHALL 验证 origin、实例、租户、工作区、页面与绑定一致。

#### Scenario: Page attempts cross-binding write
- **WHEN** 编辑消息指定其他租户或本地绑定
- **THEN** 返回 context_mismatch，执行零新模型操作

### Requirement: Existing shell overlays remain usable
宿主 SHALL 沿用现有覆盖层模式，使菜单、Dialog 和 Toast 在 Docs 视图之上可操作，并保留布局和中文输入。

#### Scenario: More or organization switcher opens over Docs
- **WHEN** 云文档显示期间用户打开宿主菜单
- **THEN** 菜单不被原生视图遮挡，关闭后恢复正确视图和焦点
