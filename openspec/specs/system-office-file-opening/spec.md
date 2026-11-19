# system-office-file-opening Specification

## Purpose
Define system file associations and runtime launch behavior for supported file-browser formats, including Office, Markdown, text and read-only previews.

## Requirements

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

#### Scenario: 已打开文件的原位置异常
- **WHEN** 已打开文件的父目录失效、访问被拒绝或设备暂不可用，用户请求打开无关文件或导出副本
- **THEN** 无关文件的操作不受旧位置查询失败影响；保留旧模型最后可靠身份，目标可能指向该模型的硬链接时要求先关闭相关文档，不能另建写模型或覆盖目标；零 inode 不作为共享身份

### Requirement: 通用文件入口共用格式名单
原生 picker、系统 argv 与 Server 本机登记 SHALL 共用 `packages/types/src/file-window.ts` 的 `FILE_WINDOW_EXTENSIONS`，文本识别 SHALL 使用同模块的 `WORKSPACE_TEXT_FILE_EXTENSIONS` 单一来源，Electron runtime SHALL 来自该共享模块的构建。打开入口 SHALL NOT 仅以 Office 可编辑格式限制通用 FileViewer；Office helper SHALL 保持 DOCX、CSV、XLSX、PPTX 四格式，不加入 Markdown。

#### Scenario: 选择或传入 Markdown
- **WHEN** 用户通过原生 picker 选择 Markdown，或通过 argv 传入名单内 Markdown 路径
- **THEN** 沿用本机文件登记及每文件工作区/会话链路，在通用独立文件窗口打开，不创建 Office 模型；该运行时行为不扩大安装包系统关联清单

#### Scenario: 登记路径与真实目标格式
- **WHEN** 输入路径或 realpath 目标不在共享格式名单，或非 Office 文本不是有效 UTF-8、包含 NUL、超过 5,000,000 字节
- **THEN** 拒绝登记，不因伪装文本扩展名而打开真实的不支持目标

### Requirement: 文档与运行时生命周期
系统 MUST 在替换或停止存活 Server 前完成文件保存确认，且 SHALL 将文档登记和实际页面加载分开计时。

#### Scenario: 重启取消或保存失败
- **WHEN** 服务重启、远程访问切换、引擎重启、强制重建或停止运行时需要处理未保存文件，用户取消或保存失败
- **THEN** 不停止原 Server，不改变原连接信息，保留未关闭的编辑页面和模型；已经关闭的模型同步移除两处标签

#### Scenario: 确认重启
- **WHEN** 所有文本草稿和 Office 文档已完成保存或放弃确认
- **THEN** 释放旧文件窗口与页面后才停止原 Server，不沿用旧本机文件上下文及凭据

#### Scenario: 未访问的后台标签
- **WHEN** 批量打开的文件标签尚未挂载页面，且没有原生模型开始导入
- **THEN** 不开始加载超时，关闭该标签不写盘；首次挂载或开始导入后计时，重复打开不延长实际加载期限，故障恢复使用新页面重新计时

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

### Requirement: 云文档文件浏览器

支持独立标签的 Desk SHALL 通过同一组织的授权在现有文件浏览器打开云文档。

#### Scenario: 在独立文件浏览器打开云文档新标签

- **WHEN** 用户从 Desk 云文档页头选择「在新标签页打开」
- **THEN** Desk 使用当前账号及组织的新授权，在独立文件浏览器打开同一份云文档并保留原视图
- **AND** 从独立窗口触发时，新标签加入当前窗口
- **AND** 独立窗口的加号始终可打开文件选择器，保留云文档标签

#### Scenario: 从云文档标签打开本地文件
- **WHEN** 文件浏览器当前选中云文档，用户从加号菜单打开文件或选择最近文件
- **THEN** 文件浏览器按已登记的窗口来源处理打开请求，工作区内文件显示在同一窗口的本地标签，云文档标签保留
- **AND** 取消选择保留活动云文档，工作区外文件遵循本机文件已有的来源与分窗规则
