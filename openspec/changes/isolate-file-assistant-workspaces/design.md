# 外部文件助手隔离设计

## 目标与边界

每个外部文件拥有独立的 Agent 工作目录、会话历史和文件助手状态；多个外部文件仍可在同一个文件浏览器中使用标签页。原件继续在原位置编辑保存。工作区、窗口分组、标签、聊天来源与 Office 模型 owner 是不同身份，不相互替代。

本设计记录已实现行为及明确待验证的合同；P2 预检模型 handoff 尚未验证通过。窗口局部草稿只描述窗口内切换与面板收放行为，不承诺跨 App 重启恢复。Windows/macOS 原生 Office 全链路验收仍是独立未完成项；已有其他 Office 功能的实测记录不代表本次隔离验收完成。

## 身份与存储

| 身份 | 当前合同 |
| --- | --- |
| 文件助手根目录 | 默认 `~/Documents/JuggleWork/FileAssistant`，保留旧历史和版本化登记，不再作为新外部文件共享执行目录 |
| 文件身份 | 宿主先校验绝对路径并取得 realpath；Windows 对身份路径作 win32 规范化、大小写折叠，POSIX 不折叠；SHA-256 的前 32 个小写十六进制 ASCII 字符作为标识 |
| 子工作区 | `<FileAssistant>/files/<fileId>`；目录组件只接受 `[a-f0-9]{32}`，不把文件名拼进目录 |
| 登记文件键 | `external-files/<fileId>/<原文件名>` 是登记查找键，不是子工作区磁盘路径；必须由登记映射解析原绝对路径 |
| 会话 | 在对应子工作区创建、保存和恢复真实 sessionId；不因创建会话自动提交模型请求 |
| Office owner | 保留文档原 workspaceId、ownerSessionId、documentId 与实际引擎模型；窗口分组或活动投影不迁移 owner |

同一路径及符号链接通过 realpath 复用稳定登记。Windows 身份大小写折叠不改变展示路径或访问原件时的路径。硬链接的唯一写模型保护继续由现有 Office 文档实际文件身份检查负责，不承诺不同硬链接路径在模型关闭后永远使用同一文件助手 hash。重命名或移动导致真实路径改变时，不承诺按内容恢复旧来源。

原件不复制、不移动；保存、交付回读、定位文件夹和另存为准备仍从登记映射解析原件。新生成产物归对应来源子工作区。Server 只对文件助手管理命名空间将 `external-files/` 作为外部原件登记键：其中未登记键不能回退普通磁盘路径，文件 A 的工作区也不能解析文件 B 的登记键。普通工作区的同名 `external-files/` 磁盘目录仍按普通路径正常读写，但请求已登记的其他来源原件键仍拒绝，不回退为本地同名文件。原件父目录不因打开文件获得工作区授权。

用户文档目录或文件助手根本身可为正常链接，保留登记路径及已有 ID；内部 `files` 和 hash 子目录必须为独立真实目录，不接受 symlink/junction。初始化前后校验 canonical 位置，拒绝目录逃逸或两个标识共享 cwd。工作区持久化失败时撤销本次新增的内存登记、授权及分类变动，重试必须重新写盘，不以仅存在于内存的记录返回成功。

冷启动在路由、watcher 和引擎使用工作区前，对已持久登记的 child 执行不创建、不修复目录的校验，包括路径匹配、内部 `files`/child 链接和目录缺失。无效条目进入 `quarantinedWorkspaces`，保留原 ID、路径、displayName、hidden、fileAssistantManaged 等持久化元数据及文件/会话登记，不进入运行时可访问工作区列表；会话和文件路由不可访问，也不能使用该 cwd 启动引擎或 watcher。启动校验本身不改写配置或文件登记，在服务只读模式下同样生效；其他有效工作区继续可用。

普通工作区改名、新增文件助手 child 及其他正常配置持久化会合并保留隔离登记，不因它已从运行时列表移除而删除原元数据。目录修复并通过下一次冷启动校验后，恢复相同 ID 和原元数据。显式删除隔离工作区登记不访问无效 cwd，后续持久化和冷启动不复活被删除条目。

## 打开格式与原件保存

独立文件浏览器复用现有 `FileViewer` 的格式分流。原生 picker、系统 argv 与 Server 本机登记共用 `packages/types/src/file-window.ts` 的 `FILE_WINDOW_EXTENSIONS`；`WORKSPACE_TEXT_FILE_EXTENSIONS` 是文本识别的单一来源，Electron 使用构建出的同源 runtime。登记同时检查用户输入路径和 realpath 的格式，不能用 `.md` 链接绕过真实目标格式限制。

| 文件 | 编辑与保存合同 |
| --- | --- |
| DOCX、CSV、XLSX、PPTX | `getOfficeDocumentKind` 保持原有四格式，只进入原生 Office 模型、保存和 owner 生命周期；不加入 Markdown，也不走文本写回 |
| Markdown（MD、MDX、MARKDOWN）、TSV 及名单内其他可编辑文本 | 使用现有 FileViewer、共享 file-editor 草稿及保存按钮/快捷键；通过登记键写回真实原件，不生成影子文件 |
| PDF、图片、视频、HTML/HTM、XLS、ODS | 保持现有只读预览，不开放外部原件 raw/content 写回 |

非 Office 的名单内文本登记与文本写入验证完整 UTF-8、无 NUL，最大 5,000,000 字节；扩展名不等于内容验证通过。HTML/HTM 虽属于文本识别名单，外部原件仍只读。Office 优先分流，因此 CSV 不使用文本编辑保存。

外部文本保存沿用 `fileEditor.save` → `/workspace/:id/files/raw`；现有 `/files/content` 也仅对同一登记来源的可编辑文本开放。Server 从 `external-files/` 映射解析实际原路径，强制读取时的有限数值 `baseUpdatedAt`；缺失返回 400，原件 mtime 改变返回 409 `conflict`，即使传入 `force: true` 也不能覆盖。审批继续作用于真实原路径，审批后和临时文件替换前再次核对原件；失败保留草稿，临时文件清理，不回退写入子工作区同名路径。

raw/content 保存使用 `r+` 打开原件验证实际可写性，不创建或截断原件；审批后及替换前的复核仍检查可写性。EACCES/EPERM 返回 403 `file_access_denied`，不能仅凭父目录可写就通过 rename 覆盖只读原件。POSIX 临时文件在替换前显式 `chmod` 为原件的 `mode & 0o777`，避免创建时的 umask 丢失组写等权限位；不将该权限位保证扩大为 Windows ACL 保真。

这一保存例外不开放外部原件的批量 write-batch、delete 或 rename，也不放宽 renderer 通用 fetch 的写权限；独立窗口文本保存仍经过 Main 已登记来源与文件集合校验的 file-editor。父目录授权、每文件工作区、会话、标签固定 source 及普通 UI 分类不变。

安装包系统关联清单仍只有 DOCX、XLSX、CSV、PPTX。picker/argv 接受 Markdown 只证明运行时打开入口可用，不证明已注册 Markdown 的 Finder“打开方式”候选项或默认打开方式；应用不主动更改系统默认应用。

## 分类与主窗口导航

管理根目录及每文件子工作区持久标记 `fileAssistantManaged: true`。这是一种内部工作区分类，不是 API 删除、全局不可见或路径名推断规则。有效登记在正常工作区 API 中保留可见记录；无效 child 的隔离另按冷启动校验合同处理，不对运行时开放。普通工作区选择器、侧栏组、命令面板会话发现、设置选择及自动化工作区入口按分类隐藏，默认/上次工作区恢复只在普通可见工作区中选择。

文件 AI 面板的主窗口跳转由 Main 按目标 tabId 取得登记 source，再按精确 workspaceId/sessionId 打开。精确定位允许进入被普通 UI 隐藏的文件助手来源，不能因为列表过滤而改投其他工作区或创建副本。

Desktop 恢复保留 `hidden` 及 `fileAssistantManaged`。两端原始列表先合并分类再过滤，不能提前删除唯一分类证据。非活动聊天路由不控制设置等页面的 fallback 导航；同一精确会话进入设置及关闭返回时保留 `exact=1`，不转存其他 query。

## 窗口分组、标签与活动投影

- 已有聊天来源使用 `conversation(workspaceId, sessionId)` 分组；同对来源复用窗口，不同对来源分窗。
- 可信本机登记返回的外部文件助手来源使用统一 `file-assistant` 分组；renderer 不能指定分组以扩大归属。
- 活标签由唯一 tabId 标识，保存创建时冻结的 `source = { workspaceId, sessionId, workspaceRoot }`。文件路径不作为全窗口标签身份，同一路径文字不能跨来源选中或关闭标签。
- activeTabId 选择活动标签；顶层 workspaceId/sessionId/workspaceRoot/activePath/conversation 仅用于当前视图兼容投影。空窗 activeTabId 为 null、顶层三个身份为空且无 conversation，不保留旧来源能力。
- 每个窗口内同一 workspace 只登记唯一 session，使按 workspace 路由的受限请求能唯一定位 source；不同文件助手 workspace 可共存。

已有 Office 模型优先于新文件助手绑定。系统再次打开已有聊天文件时，回到原聊天来源窗口；已有旧文件助手 owner 仍在时继续使用其原来源，不能强迁移模型或给新子工作区绑定旧会话。

主窗口再次打开已登记文件时优先复用其真实窗口分组。窗口初始化由复用请求共享；单次打开失败或取消仅回滚该次新增标签与来源，不销毁其他文件已使用的窗口，不绕过 dirty 关闭确认。打开请求跨异步等待保留原 entry/context 的有效性检查，原来源或窗口注销后，迟到请求不能恢复它或创建替代窗口。

Office open 返回 `{ document, created }`，`created` 表示该次 open 调用是否新建模型。迟到或失败打开的自动回滚只对本次打开新建且尚未由 tab 接管的模型发送带 owner sessionId 的 `decision: "discard", onlyIfClean: true` 关闭请求；Server 核验 owner 和 clean 状态，dirty 或无法确认可安全清理时拒绝。打开请求之前已存在的 reused owner 不自动关闭、不清理，也不因回滚改绑或恢复已注销来源。

P2 预检模型 handoff 合同要求：同一次打开的预检新建 clean 模型后，本次打开持续持有其清理责任及原 owner 身份，直到目标 tab 成功接管。预检返回或后续 open 对同一模型返回 `created: false` 不解除这份责任，也不把本次新建模型当作请求之前已存在的 reused owner。tab 接管前失败或取消，仅按 owner/onlyIfClean 合同回滚；接管后转由标签正常生命周期管理，预检不再自动清理。此 handoff 合同尚未验证通过。

只读文本的 clean `prepare`/`close` 是允许的生命周期操作，真实 Main/文件窗口仍须通过来源和文件登记校验；只读限制继续作用于 `update`、`save`、`external` 等写入口。同 key 的可编辑标签不能绕过仍存在的只读写保护；存在未保存草稿时，不借 clean 例外保存或丢弃草稿。此处不扩大 Office 关闭接口或服务只读模式的写权限。

## AI 面板与窗口局部草稿

model、agent、variant 以及未发送草稿按固定 source 保存；同来源标签共用来源状态，不同来源互不串用。首次来源 seed 只接受可信主窗口顶层给出的白名单选项；已有来源再次开文件、窗口激活或刷新策略不覆盖当前选择。模型可用性与组织策略在提交时继续校验。

切到其他来源再返回时恢复自己的窗口局部草稿与选项，不改写主窗口草稿。原生选区添加/发送按文档固定 owner 和 source 定位标签，通过既有 selectionRef 验证；普通文件上下文不等于选区编辑权限。发送时捕获 source 与文件上下文；切标签不能改绑已经接受的运行。持久化会话历史与窗口局部草稿是不同保证，后者不承诺 App 重启恢复。

## Main 请求和事件 authority

Main 核验真实 webContents、顶层 frame、窗口存活以及注册来源。fetch 按请求 workspace 找到唯一登记 source，捕获其文件集合、会话及请求上下文；SSE 订阅绑定对应来源。读取连接、异步响应及重连后再次确认该来源仍已登记。切活动标签不撤销仍存在的来源，也不能让可变顶层投影变成 authority。

文件路径、documentId、会话、run、交互回复和已验证子会话均继续受对应来源既有白名单/归属校验。文件窗口没有通用服务端凭据；同窗口其他来源的文件登记不提供本来源权限。

来源最后一个标签移除时撤销其 fetch/SSE，其他来源保留；窗口销毁则撤销全部来源请求，迟到数据不能回到 renderer。传输取消不转换为 run/session abort，Server 已接受运行继续使用提交来源。明确停止仍走已有 run 归属确认与草稿清理；Office dirty、保存、运行等待和关闭确认沿用原文档生命周期，不由传输清理绕过。

## Windows 路径合同

Windows 入口仅接受正常盘符绝对路径或包含 server/share/文件组件的合法 UNC；输入、持久登记加载和原件解析保持相同命名空间约束。拒绝 NUL、ADS 冒号、设备命名空间（如 `\\?\`、`\\.\`）、保留设备名、盘符相对路径（`C:foo.docx`）、根相对路径（`\foo.docx`）以及不合法组件。UNC 不是一概拒绝；经正常组件校验并实际可访问的 UNC 文件可以登记。

路径规则的可移植单元测试可以在非 Windows 宿主运行，但不证明 Windows SDK/文件系统实机可用。MAX_PATH、扩展长度命名空间和任意超长路径均不作可用性承诺；32 位 ASCII 子目录只限制生成目录组件，不消除原路径或平台长度限制。

## v1 兼容与重开

版本化登记由 v1 升为 v2，每文件记录新子工作区身份及新的可选 sessionId，并保留旧根 workspace/session 的 legacy 信息。旧共享会话及历史留在旧根，不复制历史、不删除旧记录、不把旧 sessionId 当成新子工作区会话。旧 legacy 工作区只接受保留登记范围，不因此获得其他子工作区文件访问。

若原件仍由旧 Office owner 持有，打开入口直接返回该文档既有来源并延后迁移。模型释放后再次打开，才使用新子工作区并创建或恢复自己的真实会话。该行为不改变存活文档 owner，也不跨 workspace 绑定 session。

新文件尚无会话时创建；已登记 sessionId 重开时在它的子工作区查询：精确匹配则恢复，仅明确 404 才创建替代会话。网络错误、无响应、其他状态错误和返回 ID 不匹配均报告不可用并保留关联，不能用新会话掩盖故障。

## 验证与证据边界

合并后已提供的自动化结果：App 225 pass；Server 157 pass、2 skip；file-windows 140 pass；Desktop preload/system/workspace 43 pass、fetch/office 84 pass、runtime 2 pass。测试组有 overlap，不合计为独立用例总数；skip 不计为验收完成，不代表全仓测试通过，也不证明 P2 预检模型 handoff 已验证。

App、Server typecheck 及 Server build/check 通过。Electron 完整 typecheck 被 `native-actions-api.test` 的 5 个错误阻塞；使用同一 config 仅排除该 test 后，208 个 root files 的检查为 0 diagnostics。该限定检查不等于 Electron 完整 typecheck 通过。

Markdown 入口与原件保存的自动化回归已有通过结果：共享格式 helper/runtime、系统 argv、Main picker 到真实 Server 登记、共享 file-editor 写回、最近文件及会话恢复、raw/content 冲突与权限边界均有覆盖；具体测试文件见 tasks，不以自动化结果代替实机验收。

桌面最终 verify 保留为真实 manual 未完成项：Windows 以及 macOS Office 的多文件 AI、原生选区、保存、关闭/重开和旧 owner 延后迁移仍待验收，不能由 focused 自动化、mock、路径规则单测或旧 Office 基础验收替代。
