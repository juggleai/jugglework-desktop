## MODIFIED Requirements

### Requirement: 系统 Office 候选应用
安装包 SHALL 将 JuggleWork 注册为 DOCX、XLSX、CSV、PPTX 的候选打开应用，且 SHALL NOT 主动修改用户默认应用。当前安装关联清单未加入 Markdown；运行时支持 Markdown SHALL NOT 被描述为已注册 Markdown 的 Finder 候选项或默认打开方式。

#### Scenario: 从系统选择 JuggleWork
- **WHEN** 用户通过“打开方式”选择 JuggleWork 打开受支持文件
- **THEN** 文件在现有“JuggleWork 文件浏览器”独立文件窗口中打开

### Requirement: 本机文件上下文
系统入口 SHALL 只登记明确选择的文件，使用原路径编辑保存，不为隔离复制或移动原件，且 SHALL NOT 将原件父目录加入工作区。没有存活 Office owner 的外部文件 SHALL 登记或复用自己的文件助手子工作区与真实会话；会话创建本身 SHALL NOT 自动发送模型请求。已有存活模型 SHALL 优先沿用原 workspace/session/文档身份，不因新登记或迁移改变 owner。

#### Scenario: 工作区外的文件
- **WHEN** 用户打开任意本机目录中的受支持文件
- **THEN** 文件在对应文件助手来源中使用共享 FileViewer 和 AI 会话，Office 走原生编辑器、Markdown 及可编辑文本走共享 file-editor、预览格式保持只读；可编辑文件保存写回原件，父目录中的其他文件不因此获得访问入口

#### Scenario: 规范化外部路径
- **WHEN** 宿主登记原文件路径
- **THEN** 以 realpath 解析后的路径计算稳定文件身份，Windows 身份额外规范化并折叠大小写，POSIX 保留大小写；子工作区目录仅使用固定长度 32 位 ASCII 十六进制 hash，不拼接原文件名
- **AND** Windows 仅接受经过正常组件校验的盘符绝对路径或 UNC 文件路径；拒绝 ADS、设备命名空间、设备名、盘符相对路径、根相对路径及 NUL，不承诺 MAX_PATH 或超长路径可用

#### Scenario: 重复打开
- **WHEN** 同一文件通过原路径、符号链接或硬链接再次打开且已有存活模型
- **THEN** 系统复用已有模型及标签，禁止建立第二个写模型

#### Scenario: 打开失败或迟到结果的模型回滚
- **WHEN** Office open 返回后本次打开失败或来源已注销
- **THEN** open 的 created 位区分该次调用新建与复用模型；仅对本次打开已确认新建且尚未交给标签接管的模型，可请求带 owner sessionId 的 discard/onlyIfClean 自动关闭，Server 拒绝错误 owner、dirty 或无法确认安全清理的模型
- **AND** created 为 false 且模型不是本次打开的预检所新建时，不自动关闭或清理该既有 reused owner；回滚不改绑 owner，不恢复已注销来源

#### Scenario: 预检新建模型直到标签接管
- **WHEN** 同一次打开的预检新建了 clean 模型，但目标标签尚未成功接管该模型
- **THEN** 本次打开持续持有该模型的清理责任及原 owner 身份，不能因预检返回或后续 open 返回 created 为 false 而提前释放；后续复用同一预检模型不等于复用请求之前已存在的 owner
- **AND** 标签接管前失败或取消时，仅对本次新建且 owner 匹配的 clean 模型执行 onlyIfClean 回滚；标签接管后不再由预检自动清理，既有 reused owner 始终不属于本次新建模型清理范围

#### Scenario: 已打开文件的原位置异常
- **WHEN** 已打开文件的父目录失效、访问被拒绝或设备暂不可用，用户请求打开无关文件或导出副本
- **THEN** 无关文件的操作不受旧位置查询失败影响；保留旧模型最后可靠身份，目标可能指向该模型的硬链接时要求先关闭相关文档，不能另建写模型或覆盖目标；零 inode 不作为共享身份

#### Scenario: Office 原件没有写入权限
- **WHEN** 首次打开或选区切换预检发现 Office 原件为只读或当前进程没有写入权限
- **THEN** 在建立可写模型前以固定错误码拒绝编辑并提示确认原件写入权限，不试写、不改权限、不复制原件，且不把 DOCX／PPTX 送入工作簿专用只读预览
- **AND** 失败保留原标签、草稿和 AI 活动文档目标

#### Scenario: 关闭时原件变为只读或本地服务不可用
- **WHEN** 已打开 Office 文档保存关闭失败，或请求超时无法确认结果
- **THEN** 展示固定且可操作的错误提示，不透传任意服务端错误正文，不自动改为放弃修改；未确认关闭时保留原模型宿主及标签
- **AND** 权限恢复后允许用户重试保存关闭，只有用户明确选择放弃修改时才走既有 discard 流程

### Requirement: 启动与文件窗口名称
系统 SHALL 在运行时就绪后按顺序处理冷启动及第二实例文件请求，单个失败 SHALL NOT 丢失后续请求。

#### Scenario: 多文件冷启动
- **WHEN** 应用尚未运行且收到多个文件打开请求
- **THEN** 就绪后将无已有聊天归属的外部文件放入同一 file-assistant 分组窗口，各标签持有自己的固定来源；已有聊天来源继续按 workspace/session 对分窗，不强制激活聊天窗口

#### Scenario: Windows 第二实例文件请求
- **WHEN** 应用已经运行，用户通过资源管理器“打开方式”再次选择受支持的 Office 文件
- **THEN** 启动实例按自身工作目录解析原始文件列表，通过单实例锁的版本化 additionalData 传给主实例；主实例校验绝对路径和支持格式并优先使用该列表，不依赖 Electron 可能重排的 argv，缺失或无效载荷才回退到来源 argv 和工作目录
- **AND** 有效空列表不触发回退；无值或未知 Chromium 开关不得吞掉其后位置文件，已知有值选项的配置路径不得作为文档打开
- **AND** 文件请求进入现有文件浏览器队列，仅文件打开不强制激活聊天窗口；单个文件失败有错误提示且后续文件仍可打开

#### Scenario: 有值启动开关不产生文档请求
- **WHEN** 启动参数包含 `--log-net-log`、`--crash-dumps-dir`、`--diagnostic-dir`、`--user-agent`、`--host-rules`、`--host-resolver-rules`、`--proxy-pac-url` 等明确有值开关，其配置值恰好以 Office 扩展名结尾
- **THEN** 独立值和 `--key=value` 两种形式均不把配置值登记为文档，后续真实位置文件仍按启动实例工作目录解析
- **AND** 解析列表经版本化 additionalData 序列化、接收和排队后仅打开真实文档；只有配置值时传递有效空列表，不因接收方 argv 重排而误开配置值；缺失 additionalData 的回退解析也排除配置值
- **AND** 无值、未知开关仍不吞其后文档，`--` 后以连字符开头的文档继续作为位置参数处理

#### Scenario: macOS 活动独立窗口
- **WHEN** Office 独立窗口获得焦点
- **THEN** macOS 应用菜单显示“JuggleWork 文件浏览器”，切回 Desktop 聊天主窗口恢复主应用显示名

#### Scenario: 文件浏览器空白主页
- **WHEN** 独立窗口的全部文档 tab 已关闭，显示打开文件或新建 Word 文档的主页
- **THEN** 保留同一个文件浏览器窗口，窗口标题和 macOS 应用菜单仍显示“JuggleWork 文件浏览器”，再次打开文件复用该窗口

#### Scenario: 从云文档标签打开本地文件
- **WHEN** 文件浏览器当前选中云文档，用户从加号菜单打开文件或选择最近文件
- **THEN** 文件浏览器按已登记的窗口来源处理打开请求，工作区内文件显示在同一窗口的本地标签，云文档标签保留
- **AND** 取消选择保留活动云文档，工作区外文件遵循本机文件已有的来源与分窗规则

#### Scenario: 云文档从菜单打开新标签
- **WHEN** 用户在 Desk 的云文档页头选择「在新标签页打开」
- **THEN** 使用当前账号及组织的新授权，在独立文件浏览器打开同一云文档的新标签，保留原视图
- **AND** 普通文档在目录和正文完成同步后申请新授权
- **AND** 从独立文件浏览器触发时，新标签加入当前窗口；普通 Web 保留 Docs 的页签行为

## ADDED Requirements

### Requirement: 通用文件入口共用格式名单
原生 picker、系统 argv 与 Server 本机登记 SHALL 共用 `packages/types/src/file-window.ts` 的 `FILE_WINDOW_EXTENSIONS`，文本识别 SHALL 使用同模块的 `WORKSPACE_TEXT_FILE_EXTENSIONS` 单一来源，Electron runtime SHALL 来自该共享模块的构建。打开入口 SHALL NOT 仅以 Office 可编辑格式限制通用 FileViewer；Office helper SHALL 保持 DOCX、CSV、XLSX、PPTX 四格式，不加入 Markdown。

#### Scenario: 选择或传入 Markdown
- **WHEN** 用户通过原生 picker 选择 Markdown，或通过 argv 传入名单内 Markdown 路径
- **THEN** 沿用本机文件登记及每文件工作区/会话链路，在通用独立文件窗口打开，不创建 Office 模型；该运行时行为不扩大安装包系统关联清单

#### Scenario: 登记路径与真实目标格式
- **WHEN** 输入路径或 realpath 目标不在共享格式名单，或非 Office 文本不是有效 UTF-8、包含 NUL、超过 5,000,000 字节
- **THEN** 拒绝登记，不因伪装文本扩展名而打开真实的不支持目标
