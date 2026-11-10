## ADDED Requirements

### Requirement: Common checkpoint gates attachment and reopening
绑定 SHALL 按 word-recovery.md 保存真实已保存文件摘要、原生检查点、稳定对象映射及版本，并在首次关联和重开时核验。仅有 pageId／模型代次／状态向量 MUST NOT 证明内容一致。检查点 SHALL 通过不可变资源加原子关联指针保存，失败保留上一完整检查点。

#### Scenario: Cloud changes while Desktop is closed
- **WHEN** 本地文件未变且云端出现已支持变化
- **THEN** 通过原生恢复与已验证映射回写同一 Word 模型，保存并形成新检查点后再开放双向

#### Scenario: Local file and cloud both change independently
- **WHEN** 重开检测到本地实际对象与共同版本不一致或映射无法恢复
- **THEN** 暂停并保留双方，提供打开云文档和本地副本操作，不自动覆盖或推断 DOCX 合并

#### Scenario: DOCX container changes without supported content changes
- **WHEN** 文件字节摘要变化，但当前有序段落身份、文本、类型和已支持样式与不可变共同快照一致
- **THEN** 原生恢复 SHALL 允许接续云端变化，保存后推进新检查点；缺少 `baselineValidated=true` 的旧服务回执 MUST NOT 开启回写

#### Scenario: Process exits while checkpoint resources are written
- **WHEN** 新检查点未全部写完
- **THEN** 不将半成品指针设为有效，仍使用上一完整检查点或暂停

### Requirement: Bidirectional native operation adaptation
关联 Word 的人工及 AI 修改 SHALL 通过 Desk 对象适配进入 AFFiNE 原生事务，远端原生变化 SHALL 回写同一活跃 SDK 模型并经现有保存落盘。适配 MUST NOT 通过整页覆盖、文件互换或新合并算法完成。

#### Scenario: Cloud member edits linked Word content
- **WHEN** 云端成员修改已支持对象
- **THEN** 当前 Word 模型及保存重开后的文件包含该修改，其他内容与评论锚点按样例验证

#### Scenario: Only file conversion is available
- **WHEN** SDK 只能导入导出完整 DOCX，未证明操作映射与回写
- **THEN** 双向需求保持技术阻塞，不能标记为已实现

### Requirement: Single tenant file binding
本地文件 SHALL 只保留一个生效云关联，持久身份包括源账号、租户、页面与本地文件。当前模型 ID MUST NOT 作为持久身份；切换组织 MUST NOT 自动重绑。

#### Scenario: User switches from Personal to team
- **WHEN** 同一文件仍关联 Personal 页面
- **THEN** 原绑定暂停，不能将其修改发送到团队；跨租户需副本或明确断开后重关联

### Requirement: Source tracking and unsupported mappings
远端回写 SHALL 被识别为已应用来源而不再次发布；未验证对象、失效目标或未知结果 SHALL 暂停适配并保留两端内容。只读权限 MUST NOT 建立双向可写关联。

#### Scenario: SDK emits an event caused by cloud writeback
- **WHEN** 远端操作回写触发本地模型事件
- **THEN** 不形成回环，后续真实人工变化仍可发布

#### Scenario: Unsupported object arrives
- **WHEN** 云端含 Word 映射不能表示的对象
- **THEN** 显示暂停原因并保留内容，不静默删除或重建整页

### Requirement: Real proof for feature and platform claims
双向支持 SHALL 通过 word-adapter.md 的真实场景、SDK 对象事件和多客户端持久化验证。平台支持 SHALL 按真实 SDK 与安装包分别声明。

#### Scenario: macOS PoC succeeds but Windows is untested
- **WHEN** 只有 macOS 真实模型验证完成
- **THEN** 不得据此声明 Windows 或全部复杂 Word 对象受支持
