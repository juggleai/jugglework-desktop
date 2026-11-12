## ADDED Requirements

### Requirement: Cloud document tabs extend the existing File Browser
云文档独立打开 SHALL 扩展现有 File Browser 标签与受限桥，不新增应用包或窗口管理器。正文、保存及多窗口协作 SHALL 复用 AFFiNE；AI 复用实际所属会话。

#### Scenario: A cloud document is opened beside local Office
- **WHEN** 用户在 File Browser 打开云文档，随后重复打开同范围文档
- **THEN** 复用已有标签与 Dock 入口，不伪造本地路径、不改变本地文件保存或只读原件行为

#### Scenario: A cloud tab has unconfirmed edits during organization change
- **WHEN** 云端尚有待同步数据或用户切换组织
- **THEN** 不误报已保存、不丢弃未确认内容；撤下旧云端范围，不删除本地文件

### Requirement: Successful helper builds remove the legacy duplicate name
构建 SHALL 在现有 File Browser helper 成功签名后清理旧 Documents 名称，保留 Bundle ID。

#### Scenario: A legacy helper exists in development resources
- **WHEN** 新 helper 构建签名成功
- **THEN** 旧名称不再残留，不改动用户正式安装应用

### Requirement: Closing uses native persistence confirmation
主动关闭或切组织 SHALL 确认原生服务端同步或本地持久化完成后再销毁视图；未确认本地写入时可取消。强制撤权 SHALL 立即撤下内容并保留受原身份约束的恢复数据。

#### Scenario: A view closes while native local persistence is pending
- **WHEN** 服务端离线且本地原生写入尚未确认
- **THEN** 不能直接销毁视图并标记已保存；允许取消，或待原生持久化确认后保留待同步关闭
