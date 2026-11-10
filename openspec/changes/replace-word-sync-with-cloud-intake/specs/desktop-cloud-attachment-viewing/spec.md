## ADDED Requirements

### Requirement: Cloud attachments open read-only in Desk
Desk SHALL 处理当前云文档视图发送的 `docs.open-attachment`，经该视图会话分区下载附件，并以独立文件窗口只读打开。来源 origin、instanceId、tenantId 与当前视图不一致的消息 MUST 丢弃。

#### Scenario: Member opens a PPTX attachment
- **WHEN** 成员点击云文档中的 PPTX 附件
- **THEN** Desk 下载原件并以只读窗口打开

#### Scenario: Message comes from an old instance
- **WHEN** 切换组织后旧实例发送打开附件消息
- **THEN** 消息被丢弃，不下载

### Requirement: Read-only copy has no cloud linkage
只读窗口 MUST NOT 回写云端。用户修改 SHALL 通过“另存为”保存为本地独立副本。

#### Scenario: User wants to edit an attachment
- **WHEN** 用户在只读窗口选择另存为
- **THEN** 生成本地副本，云端附件不变

### Requirement: Attachment cache follows identity lifecycle
附件缓存 SHALL 按账号与租户分目录。切换账号、组织或退出登录时 SHALL 删除对应目录。

#### Scenario: User leaves organization A
- **WHEN** 用户从 A 切换到 B
- **THEN** A 的附件缓存被删除
