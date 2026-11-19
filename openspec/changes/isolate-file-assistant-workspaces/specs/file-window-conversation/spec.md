## MODIFIED Requirements

### Requirement: 文件窗口继续已有本地会话
从已有本地会话打开的文件窗口 SHALL 提供 AI 面板，并继续按 workspace/session 对分窗，同来源文件标签共用该会话。无归属的外部文件 SHALL 各自使用 `~/Documents/JuggleWork/FileAssistant/files/<32ASCIIhash>` 子工作区及真实会话，并统一进入 file-assistant 分组窗口。每个活标签 SHALL 持有独立 tabId 和创建时固定的 source（workspaceId、sessionId、workspaceRoot）；activeTabId 决定活动来源，顶层 workspace/session/root/path/conversation SHALL 仅作活动标签投影，不作为整个窗口的唯一归属。

#### Scenario: 主窗口切换会话
- **WHEN** 从会话 A 打开文件窗口后主窗口切到 B
- **THEN** 文件窗口仍展示和提交到 A

#### Scenario: 系统打开外部文件
- **WHEN** 文件没有已有会话归属
- **THEN** 自动登记或复用该文件的文件助手子工作区，创建或恢复该子工作区内的真实会话，允许 AI 对话；支持原生选区的 Office 文件沿用选区编辑合同，Markdown 等文本沿用共享 file-editor，预览文件保持只读，可编辑文件保存使用原文件
- **AND** 已有存活模型沿用其归属，不创建窗口副本；临时无效会话及伪造采集仍被拒绝

#### Scenario: 文件助手切换不同来源标签
- **WHEN** 外部文件 A、B 在同一个文件助手窗口中打开并切换活动标签
- **THEN** 两个标签保持各自 tabId 和固定 source，AI 面板切换到对应会话，顶层投影随 activeTabId 更新；相同路径文字不能替代标签身份
- **AND** 空窗的 activeTabId 为 null，顶层 workspace/session/root 为空且没有 conversation，不沿用最后一个已关闭来源的能力

#### Scenario: 聊天文件窗口选择工作区外原件
- **WHEN** 用户通过主窗口原生编辑区或聊天所属独立窗口的文件选择器，明确选择工作区外的本机文件
- **THEN** 按既有本机登记链路在文件助手分组或原存活模型所属窗口打开原件，不因当前工作区限制拒绝，不把原聊天窗口改绑为文件助手
- **AND** 同次选择中的工作区内文件继续按原宿主打开，取消选择不登记文件，打开失败保留原文档与草稿

### Requirement: 外部文件会话独立运行与恢复
文件助手 SHALL 使用既有消息、运行、交互、Office 原生编辑及共享文本编辑链路，不要求主窗口已有会话。每文件子工作区与原文件会话关联 SHALL 持久保存，原文件 SHALL 保留原目录，不为工作区隔离复制或移动原件。管理根目录及子工作区 SHALL 标记 fileAssistantManaged，普通工作区 UI 隐藏该分类，有效登记在正常 API 保持可见且主窗口支持精确 ID 定位；稳定文件身份、旧登记迁移、来源隔离及冷启动无效 child 的持久化保留与运行时不可访问 SHALL 遵循 file-assistant-workspaces 规范。

#### Scenario: 无用户工作区冷启动
- **WHEN** 用户直接从系统打开外部文件，应用没有用户工作区或主窗口
- **THEN** 文件助手子工作区能够启动既有引擎，文件窗口可加载可用模型、发送和停止任务；会话创建不自动发送模型请求

#### Scenario: 文件模式后首次打开零用户工作区主窗口
- **WHEN** 默认文件运行时已经就绪，用户尚无已选工作区而打开主窗口，远程访问配置与现有服务一致
- **THEN** 主窗口复用既有服务并完成启动，不重启存活文件的模型所有者；登录及策略门禁继续生效

#### Scenario: 已登录账户首次直接打开文件
- **WHEN** 当前主分区保留有效登录与偏好，但尚无文件窗口策略缓存且主窗口未打开
- **THEN** 使用同一主分区和页面来源读取已有登录、当前组织、策略、语言及主题，不挂载主窗口会话或队列消费者；文件窗口只接收非凭据策略和外观
- **AND** 登录失效清除旧策略，暂时断网可沿用同部署缓存，不以初始化失败开放默认权限

#### Scenario: 重启后再次打开文件
- **WHEN** 用户再次打开已登记原文件
- **THEN** 使用稳定文件标识，在对应子工作区恢复真实会话及历史；已有会话查询只有明确返回 404 才创建替代会话，网络错误、无响应、其他错误或身份不匹配均不创建替代会话
- **AND** v1 共享历史留在旧工作区，不将旧 sessionId 跨工作区绑定到子工作区；旧 Office owner 仍存活时优先沿用原归属并延后迁移

#### Scenario: 无主窗口时 provider 失败
- **WHEN** 本轮最新 assistant 持久化明确错误，且引擎与委派任务均已空闲
- **THEN** 服务端释放本轮运行并保留 failed 或 aborted 终态，用户可直接发送新请求，无需先手动停止；旧错误、工具错误及仍忙碌的引擎不能触发收尾

#### Scenario: 无主窗口时拒绝权限
- **WHEN** 固定版本引擎为本轮最新 assistant 持久化精确的用户拒绝权限工具错误，全部工具已结束，且根任务与委派任务均已空闲
- **THEN** 服务端以 aborted 收尾，原文件未被拒绝的工具写入，下一次请求无需手动停止；普通工具错误、旧消息和仍运行的工具不触发该收尾

#### Scenario: 新会话首次保存请求审批
- **WHEN** 真实会话尚无权限模式记录，用户首次明确保存请求审批且权限版本为 0
- **THEN** 在既有存储创建请求审批记录并返回版本 1，持久回读保持相同模式，不创建授权；旧版本覆盖仍被拒绝

#### Scenario: 原文件另存为或定位
- **WHEN** 主窗口对文件助手工作区的已登记外部文件另存为或打开文件夹
- **THEN** 从文件登记解析原路径，另存为取消不产生副本且不改变草稿；管理命名空间未登记键拒绝，普通工作区同名磁盘目录继续使用普通路径规则，已登记其他来源原件键不回退

#### Scenario: 原文件写回与交付
- **WHEN** AI 修改已登记外部文件并保存
- **THEN** 修改回执、交付回读和保存均指向相同原路径；新产物进入该来源的子工作区，管理命名空间未登记键不可回退到工作区路径读写

### Requirement: 首次开窗继承目标会话选项
主 App 打开独立文件窗口 SHALL 通过既有 open 参数传入目标 workspace/session 的 model、agent、variant 快照。模型及档位 SHALL 复用会话覆盖与全局默认的既有解析规则；未选择 agent 时 SHALL 显式传入 null，不能被历史消息的 agent 替代。Main SHALL 仅接受可信主窗口顶层发送的来源首次 seed，并校验字段白名单。文件窗口 SHALL 按 source 保留 model、agent、variant 及窗口局部草稿；后续开文件、主窗口重新激活及策略刷新 SHALL 不覆盖该来源 seed 或 renderer 当前选择，也不得把其他来源选项带入当前面板。策略与模型可用性 SHALL 仍由 Main 在提交时实时验证，不随 seed 授权。窗口局部草稿 SHALL 不承诺跨 App 重启恢复。

#### Scenario: 首次打开与窗口内独立选择
- **WHEN** 主 App 已选择模型、agent 和推理档位后首次从该会话开窗
- **THEN** 文件 AI 面板首次展示和发送使用该快照，优先于历史消息及 provider 默认；后续窗口内选择不被主窗口变化覆盖

#### Scenario: 文件宿主尝试覆盖选项
- **WHEN** 已登记文件窗口通过 open 参数携带其他 conversationOptions
- **THEN** Main 忽略该选项并只沿用已登记 source 的选项；关闭窗口后从主 App 新开才获取新快照

#### Scenario: 切换来源保留局部输入
- **WHEN** 用户在来源 A 选择模型、agent、variant 并输入未发送草稿，切到 B 后再返回 A
- **THEN** A 恢复自己的选项和窗口局部草稿，B 保持自己的状态；同来源标签共用同一份来源状态，不改写主窗口草稿

#### Scenario: 独立启动恢复含推理档位的历史
- **WHEN** 历史用户消息的 model 同时包含 providerID、modelID 和 variant，且本窗口没有首次选项快照
- **THEN** 使用历史模型与档位初始化面板，将 model 的两项身份和独立 variant 分别提交，不因历史额外字段触发受限桥拒绝

### Requirement: 文件上下文在提交时确定
切文件标签 SHALL 仅切当前上下文，不改已接受任务目标。提交 SHALL 捕获当时标签的固定 source 和文件上下文，后续切换活动投影不得改绑已接受任务。选区操作 SHALL 沿用既有 selectionRef 校验，无有效选区能力时不得用历史引用或路径代替授权。

#### Scenario: 发送后切标签
- **WHEN** 用户对文件 A 提交任务后切到 B
- **THEN** 已接受任务保持 A 的上下文，不静默操作 B

### Requirement: 两种宿主共用 AI 选区编辑操作
原生“AI 编辑”的采集、添加、发送、标签定位和移除 SHALL 复用已有选区合同。独立窗口 SHALL 使用按固定 source 隔离的窗口局部草稿并展开 AI 面板，保持文档原 workspace/session；Main SHALL 仅允许从真实原生页面采集并投递到该窗口对应来源、且文档仍登记的引用。关闭共享模型 SHALL 同时核对两端未发送的草稿引用，不改变 Office owner。

#### Scenario: 独立窗口添加或发送选区要求
- **WHEN** 用户在独立文件窗口选择普通正文，点击 AI 编辑并添加或发送修改要求
- **THEN** 当前窗口的 AI 面板展开，展示相同选区标签及要求；发送沿用既有校验与即时 admission，不改写主窗口局部草稿

#### Scenario: Word 含有摘要省略的软换行
- **WHEN** 普通正文文档包含原生结构预览和查找省略的段内软换行
- **THEN** 系统从同一页面、对应版本和有界原生范围读取完整文字，保留真实软换行和未选内容；版本、长度、页面身份或完整性不符时拒绝，不猜测缺失字符

#### Scenario: 主窗口导航不打断独立窗口选区请求
- **WHEN** 独立窗口已开始准备选区草稿，而主窗口发生导航或关闭
- **THEN** 只取消主窗口的待处理草稿请求及旧代次，独立窗口仍可向自己的局部草稿追加已准备的要求

### Requirement: 主窗口定位同一会话
面板 SHALL 能按目标 tabId 请求主窗口打开该标签固定 source 的相同 workspace/session，通过精确 ID 定位被普通 UI 隐藏的文件助手工作区，不创建副本或迁移文档。普通默认工作区恢复 SHALL 不自动选择 fileAssistantManaged 工作区。

#### Scenario: 在主窗口打开
- **WHEN** 用户选择定位原会话
- **THEN** 主窗口按该标签固定来源的精确 workspaceId/sessionId 显示同一会话，即使该工作区不在普通列表中；文件窗口和 Office 模型保持不变

## ADDED Requirements

### Requirement: 外部文本通过共享编辑器保存登记原件
Markdown 和共享文本名单内其他可编辑 UTF-8 外部文本 SHALL 使用现有 FileViewer 与共享 file-editor；保存 SHALL 通过已有 raw/content 接口按来源登记键解析真实原件，不创建影子副本。Server SHALL 强制有效有限数值 `baseUpdatedAt`、UTF-8、无 NUL 和 5,000,000 字节上限，保留真实原路径审批并在审批后及替换前复核原件；mtime 冲突 SHALL 返回 409，`force` SHALL NOT 绕过。Office 原件 SHALL 继续仅用原生模型保存；PDF、图片、视频、HTML/HTM、XLS、ODS 外部原件 SHALL 保持只读。此保存例外 SHALL NOT 开放外部原件批量写入、删除、重命名或 renderer 通用 fetch 写入，也不改变每文件空间、会话及 UI 分类。

raw/content 保存 SHALL 使用不创建、不截断原件的 `r+` 验证实际可写性，审批后及替换前 SHALL 继续验证；EACCES/EPERM SHALL 返回 403 `file_access_denied`，不得仅凭父目录可写就替换只读原件。POSIX 临时文件 SHALL 在替换前显式 `chmod` 保留原件 `mode & 0o777`，不因 umask 丢失权限位。只读文本在没有未保存草稿时 SHALL 允许真实 Main/文件窗口通过原有来源及文件校验执行 clean prepare/close；该生命周期例外 SHALL NOT 放宽 update/save/external 写保护，也不扩大 Office 关闭或服务只读模式的写权限。

#### Scenario: 共享草稿保存真实原件
- **WHEN** 用户在任一宿主编辑已登记 Markdown 并通过共享 file-editor 保存
- **THEN** 写回相同真实原路径，广播新内容与时间基准，其他来源原件不变，子工作区不生成同名影子文件

#### Scenario: 缺失基准或外部修改
- **WHEN** 保存未携带有效 baseUpdatedAt，或原件在读取后、审批等待期间发生 mtime 修改
- **THEN** 缺失基准返回 400，mtime 冲突返回 409；即使 force 为 true 也不覆盖，失败保留草稿并清理临时文件

#### Scenario: 原件不可写或审批期间变为只读
- **WHEN** raw/content 保存的 r+ 打开因 EACCES/EPERM 失败，包括审批通过后原件已不可写
- **THEN** 返回 403 file_access_denied，原件内容、mtime 和权限位不变，保留草稿并清理临时文件，不借可写父目录完成替换

#### Scenario: POSIX 保存保留原权限位
- **WHEN** POSIX 原件权限为 0664 且进程 umask 为 022，通过 raw 或 content 保存
- **THEN** 原子替换前显式 chmod 临时文件，保存后原件仍为 0664，不丢失组写权限，不生成影子副本或残留临时文件

#### Scenario: 只读 clean 文本准备关闭
- **WHEN** 已登记只读文本没有未保存草稿，真实 Main 或文件窗口执行 prepare/close
- **THEN** 通过来源和文件校验后允许完成且不写盘；update/save/external 仍被拒绝，同 key 的可编辑标签不能绕过仍存在的只读写保护，有未保存草稿时不能借 clean 例外保存或丢弃

#### Scenario: 写入不属于文本保存例外
- **WHEN** 请求直接写 Office、只读预览原件、跨来源或管理命名空间未登记键，或对外部原件执行批量写入、删除、重命名
- **THEN** 拒绝对应操作，Office 仍通过其原生模型保存，不回退为工作区路径写入；独立窗口通用 fetch 不因此获得写权限
