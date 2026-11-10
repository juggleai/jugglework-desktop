## ADDED Requirements

### Requirement: Docs IM card uses existing chat extension points
Desktop SHALL 在现有自定义消息注册、气泡、会话列表预览及未知类型兜底中支持 jw:docs-notification。卡片 SHALL 使用通用文案和打开按钮，MUST NOT 展示原始载荷或执行 AI／任意 URL。同一来源＋租户＋事件 SHALL 去重展示，站内未读 SHALL 独立维护。

#### Scenario: Unsupported card version arrives
- **WHEN** 消息 contractVersion 未支持或定位字段不合法
- **THEN** 显示云文档通知兜底，不执行导航、不展示敏感原始 JSON

### Requirement: Notification navigation reuses tenant-bound launch
卡片打开 SHALL 根据当前 IM 连接来源匹配 Server 及账号，以新 instanceId、product/page、可选 commentId 重新申请登录交接。同租户直接定位，跨租户 SHALL 先提示切换；无成员／空间权限 MUST 拒绝。

#### Scenario: Card belongs to another organization
- **WHEN** 用户正在 A 中点击 B 的文档通知
- **THEN** 明确确认切换并重新授权，不把 A 的 Word 绑定或会话带入 B

#### Scenario: Recipient no longer has document access
- **WHEN** 点击已失权或已删除页面的历史通知
- **THEN** 显示不可访问，不能依赖历史群成员或旧卡片恢复权限

### Requirement: Card navigation is a fixed organization-bound action
卡片 SHALL 使用 card-navigation.md 的固定模板和结构化打开动作，校验真实会话／助手映射与租户，MUST NOT 接收任意 URL、远程 HTML 或仅凭同名消息启用动作。消息来源 SHALL 在接收时绑定 Server、用户、组织和凭据代次，系统通知点击 MUST NOT 用当前全局设置改写旧来源。

#### Scenario: System notification is clicked after switching organizations
- **WHEN** 用户在 B 合法接收卡片后切到 A，再点击旧系统通知
- **THEN** 保留 B 的原始来源，确认并真实切回 B 后才重新授权，取消不改变 A

#### Scenario: Card is forwarded into another organization group
- **WHEN** 真实 conversationId／助手与卡片组织映射不匹配
- **THEN** 显示无跳转兜底，不因 payload 中存在 B 的 pageId 就启用跨组织动作

### Requirement: Shared IM applications do not merge Docs organization views
同 AppKey／IM 用户可对应多个组织，Desktop SHALL 同时按 Server、用户、已进入组织及实际会话识别云文档消息。其他组织的云文档群／助手、卡片、预览、未读和系统提示 MUST NOT 进入当前组织展示，也不得清空其未读。

#### Scenario: Two organizations share one IM application
- **WHEN** A 的 SDK 历史包含 B 的云文档群或助手消息
- **THEN** 不进入 A 的云文档会话展示和提示，切到 B 后再按原 IM 历史加载

### Requirement: Committed organization switch survives IM failure
跨组织点击 SHALL 复用现有 switchOrganization 并等待真实组织状态后才申请 Docs grant。Server 已切换但 im=null 时 SHALL 保持新组织，IM 和 Docs 状态分开。结果未知 SHALL 先刷新权威状态；迟到异步结果 MUST NOT 覆盖新上下文或重绑 Word。

#### Scenario: IM bootstrap fails after the switch commits
- **WHEN** Server 返回 activeOrgId=B、im=null
- **THEN** 当前组织为 B，允许独立打开 B 的 Docs，不在 B 外壳下恢复 A 的内容

#### Scenario: User switches again before the first card opens
- **WHEN** A→B 的交接未完成时用户已进入 C
- **THEN** B 的 grant／ready 被丢弃，C 的页面和 Word 关联不受影响

#### Scenario: Target comment was deleted
- **WHEN** 页面仍可读但 commentId 不再存在
- **THEN** 打开原页面并提示评论不存在，不定位另一评论或同名页面
