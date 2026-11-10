## ADDED Requirements

### Requirement: Tenant scoped More entry
Desktop SHALL 在 More 提供带“云朵＋文档页”专用图标的云文档入口，使用当前明确 Personal／团队租户，通过现有登录和一次性 Docs 交接进入原生产品页。入口 MUST 与本地项目 workspaceId 分开识别，并 SHALL 支持与其他 More 应用一致的固定、取消固定及本机持久化；固定后显示在左侧导航栏，当前云文档路由显示选中态。

#### Scenario: Personal owner opens cloud documents
- **WHEN** 有效 Personal 用户点击 More 的云文档
- **THEN** 打开本人 Docs Workspace，不出现第二次登录或组织成员邀请

#### Scenario: Link belongs to another organization
- **WHEN** 用户打开不同租户的文档链接
- **THEN** 明确提示切换并验证该租户成员，不能把 pageId 放进当前租户写入

#### Scenario: User pins Cloud Docs
- **WHEN** 用户在 More 中固定云文档
- **THEN** 左侧导航栏显示云文档专用图标，点击后进入当前已进入组织的 Docs，重启 Desktop 后仍保留

#### Scenario: User unpins Cloud Docs
- **WHEN** 用户在 More 中取消固定云文档
- **THEN** 左侧固定入口消失，More 中的云文档入口和当前组织访问能力保持不变

### Requirement: Entered organization gates every Docs surface
全局账号登录 MUST NOT 自动显示全部组织云文档。Desktop SHALL 先成功进入目标组织，再为当前上下文装载 Docs；目录、搜索、最近访问、通知、附件预览及上传空间 SHALL 各自固定组织。新打开／重启／切回时 SHALL 在授权确认前隐藏旧原生缓存正文。

#### Scenario: User has valid memberships in A and B
- **WHEN** Desktop 已进入 A
- **THEN** 只显示 A 的 Docs 资源；打开 B 必须明确进入 B，不聚合两个组织的目录或搜索

#### Scenario: Old native cache is available after restart
- **WHEN** 尚未确认当前源登录与目标组织成员
- **THEN** 不先展示缓存正文、通知或附件预览后再等待授权拒绝

### Requirement: Visible entry failure recovery
入口 SHALL 显示 loading、ready、unavailable、unauthorized 与 forbidden 状态。15 秒未收到当前实例 ready SHALL 显示重试，重新打开必须申请新凭据。

#### Scenario: Docs deployment is disabled
- **WHEN** Server 返回 docs_disabled
- **THEN** 显示云文档尚未启用，不展示空白页面或无效登录表单
### Requirement: Source built document surface
云文档集成 SHALL 使用自行构建的 AFFiNE 源码服务与页面。正常页面 MUST NOT 增加“组织名·云文档”标题栏或“重新打开”按钮；现有 Desk 主导航和原生文档工具栏 SHALL 保留。加载失败 SHALL 保留重试。

#### Scenario: Ready document surface
- **WHEN** 当前组织的原生云文档页面就绪
- **THEN** 原生视图填满内容区域，不显示额外标题或重新打开栏，也不保留其布局占位

