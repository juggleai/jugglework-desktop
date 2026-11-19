## ADDED Requirements

### Requirement: 每个外部文件独立工作区及真实会话
系统 SHALL 为每个没有存活 Office owner 的明确登记外部文件建立或复用自己的 `FileAssistant/files/<32ASCIIhash>` 工作区及该工作区内的真实会话，不共享新文件的执行目录或会话。原件 SHALL 留在原位置，不为隔离复制或移动；文件打开和会话创建 SHALL NOT 自动提交模型请求。

#### Scenario: 多个外部文件独立运行
- **WHEN** 用户打开外部文件 A 和 B
- **THEN** A、B 分别具有自己的工作区及真实会话，原件路径保持不变；新产物进入对应来源工作区，保存及交付回读使用各自原件

#### Scenario: 未登记键与跨来源读取
- **WHEN** 在文件助手管理命名空间请求未登记 external-files 键，或在 A 的子工作区请求 B 的登记键
- **THEN** 拒绝读取或写入，不回退为普通工作区路径，也不将原件父目录加入授权工作区

#### Scenario: 普通工作区的同名磁盘目录
- **WHEN** 普通工作区读写其真实 external-files 目录，且请求路径不是已登记的其他来源原件键
- **THEN** 按普通工作区磁盘路径规则正常处理，不因目录名而全局启用文件助手映射；已登记原件键仍受来源校验，不可跨工作区回退

### Requirement: 文件身份与子目录稳定规则
系统 SHALL 在绝对路径校验与 realpath 后计算文件身份；Windows 身份 SHALL 规范化并折叠大小写，POSIX SHALL 保留大小写。文件 ID SHALL 为 SHA-256 前 32 个小写十六进制 ASCII 字符，子目录 SHALL 只由固定 `files` 与该 ID 组成，不将原文件名拼为磁盘目录。实际文件唯一写模型及硬链接占用检查 SHALL 继续使用既有 Office 身份规则。

#### Scenario: 符号链接和 Windows 大小写
- **WHEN** 同一原件通过符号链接或 Windows 路径大小写变体再次登记
- **THEN** realpath 及平台身份规则解析到相同登记和子工作区；展示及磁盘访问保留原件实际路径，POSIX 不全局转小写

#### Scenario: 文件名只作为登记键数据
- **WHEN** 文件名包含中文、空格或长名称
- **THEN** 子工作区的最后一层仍只有 32 位 ASCII hash，带文件名的 external-files 键仅用于登记映射；不承诺原路径或总路径突破平台长度限制

### Requirement: Windows 外部文件路径校验
Windows 登记 SHALL 只接受经过组件校验且实际可访问的盘符绝对路径或正常 UNC 文件路径，拒绝 NUL、ADS、设备命名空间、保留设备名、盘符相对及根相对路径。系统 SHALL NOT 承诺 MAX_PATH 或任意超长路径可用。

#### Scenario: 拒绝特殊命名空间及相对路径
- **WHEN** 输入包含 ADS、设备路径或设备名、`C:foo.docx`、根相对路径或 NUL
- **THEN** 登记被拒绝，不构造子工作区或打开文档

#### Scenario: 正常 UNC 文件
- **WHEN** 输入是包含有效 server/share/文件组件、通过正常组件校验且可访问的 UNC 路径
- **THEN** 使用正常登记及 realpath 身份流程，不因 UNC 分类而一概拒绝；可移植规则单测不替代 Windows 实机验收

### Requirement: 内部分类与精确寻址
文件助手管理根目录和子工作区 SHALL 持久标记 fileAssistantManaged。普通工作区入口和默认恢复 SHALL 排除该分类，正常 API SHALL 保留有效登记的可见记录；精确 workspaceId/sessionId 的主窗口导航 SHALL 能定位有效来源，不因普通 UI 隐藏而改投其他会话。冷启动校验失败的 child SHALL 遵循隔离合同，不因保留持久化登记而获得运行时访问。

#### Scenario: 普通发现与精确跳转
- **WHEN** 用户查看普通工作区选择、侧栏、命令面板、设置或自动化入口，再通过文件 AI 面板定位主窗口
- **THEN** 普通入口不列出文件助手分类，主窗口跳转仍按目标标签的精确来源成功定位同一会话，不创建副本或改变 Office owner

#### Scenario: 主窗口默认恢复
- **WHEN** 记忆的默认或上次工作区是 fileAssistantManaged
- **THEN** 普通恢复只选择普通可见工作区，无普通工作区则保持空选择；精确文件来源跳转仍可用

### Requirement: 冷启动校验隔离无效子工作区并保留登记
Server SHALL 在路由、watcher 和引擎使用已持久登记 child 前执行不创建、不修复目录的校验，拒绝路径不匹配、内部 files/child 链接或目录缺失的工作区。无效条目 SHALL 保留在隔离登记中，持久化原 ID、路径、displayName、hidden、fileAssistantManaged 等元数据及既有文件/会话关联，且 SHALL NOT 进入运行时可访问工作区列表。启动校验本身 SHALL NOT 改写配置或文件登记，服务只读模式 SHALL 同样执行；普通配置写入 SHALL 保留隔离登记，不将运行时移除等同于持久化删除。

#### Scenario: 冷启动发现无效 child
- **WHEN** 已登记 child 在重启前被替换为 symlink/junction、内部 files 成为链接、目录缺失或路径与登记不符
- **THEN** 该工作区的会话与文件路由不可访问，不为其启动 watcher 或引擎，不自动重建目录；原配置和登记保留，其他有效工作区继续可用，服务只读模式仍保留写入门禁

#### Scenario: 普通配置持久化与修复后恢复
- **WHEN** child 已隔离，普通工作区改名、新增其他 child 或其他正常配置写入后，修复该目录并再次冷启动
- **THEN** 普通写配置期间原隔离登记及元数据不丢失；修复并通过校验后恢复相同 workspaceId、原元数据及既有文件/会话关联

#### Scenario: 显式删除隔离工作区登记
- **WHEN** 用户明确删除隔离工作区登记
- **THEN** 不访问其无效 cwd，后续配置持久化与冷启动不复活已删除条目；保留隔离项的逻辑不撤销普通工作区的显式删除

### Requirement: v1 历史保留与旧 owner 优先
v1 登记迁移 SHALL 保留旧共享工作区及会话历史，并保存每文件 legacy workspace/session 信息，不跨工作区把旧 sessionId 绑定给新子工作区。存在存活旧 Office owner 时 SHALL 返回既有文档来源并延后迁移，不复制、重开或改绑该模型。

#### Scenario: 无存活模型的旧文件迁移
- **WHEN** v1 文件记录重开且没有存活 Office owner
- **THEN** 使用该文件子工作区的新绑定，旧共享历史保留在旧根工作区，旧 sessionId 不作为新子工作区 sessionId

#### Scenario: 存活旧 owner 阻止立即迁移
- **WHEN** 重开原件时旧根工作区或已有聊天仍持有其 Office 模型
- **THEN** 沿用原 workspace/session/文档及模型身份；模型释放后重开才进入子工作区创建或恢复流程

### Requirement: 重开只在明确不存在时创建替代会话
已持久登记 sessionId 的文件重开 SHALL 在其绑定工作区查询并恢复相同 ID，只有明确 404 才创建替代会话。网络错误、无响应、其他错误状态或返回身份不匹配 SHALL 保留原关联并报告不可用，不能创建替代会话。

#### Scenario: 会话存在或明确删除
- **WHEN** 已有会话查询精确匹配或明确返回 404
- **THEN** 匹配时恢复原会话和历史；404 时才创建并持久绑定新的真实会话

#### Scenario: 查询结果不可靠
- **WHEN** 已有会话查询超时、断网、无响应、返回其他错误或错误 sessionId
- **THEN** 打开报告会话暂不可用，不创建新会话、不覆盖旧绑定
