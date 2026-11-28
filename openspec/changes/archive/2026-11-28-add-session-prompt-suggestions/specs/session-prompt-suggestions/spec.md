## ADDED Requirements

### Requirement: 成功的新回合可生成一条下一轮输入建议

Desktop SHALL 仅在功能开启且当前活动可见的主窗口工作区会话新回合明确成功完成后，非阻塞地尝试生成最多一条下一轮用户输入建议。初次触发及实际派发前 SHALL 均检查真实用户 turnKey、最终正文、无运行/等待/压缩/提交准备、无排队 follow-up，以及完全空白且可编辑的输入栏；空白 SHALL 同时检查 surface 与真实 composer 内容，包含文字、附件、mentions、粘贴对象、Office 引用和能力标签。初始历史快照、非活动 pane 中结束的回合、失败、停止、未知终态 SHALL NOT 触发生成。请求实际派发后，普通编辑 SHALL NOT 取消请求或删除 ready 内容，但全空 SHALL 仍是展示和接受建议的必要条件。

#### Scenario: 当前回合成功完成
- **WHEN** renderer 已建立历史基线，观察到 turnKey 变化且用户创建时间戳严格高于该 scope 高水位的新轮，随后得到明确成功终态，且其余资格均满足
- **THEN** Desktop 为本轮最多发起一次建议请求，不阻塞输入
- **AND** 没有明确自然下一步时可以不显示建议

#### Scenario: 队列或失败状态优先
- **WHEN** 会话为空闲但本轮失败/停止/终态未知，或有 follow-up 等待发送
- **THEN** Desktop 不生成建议，也不延迟既有队列处理

#### Scenario: 恢复已有完成会话
- **WHEN** 用户初次打开历史会话或在旧回合完成后才开启功能
- **THEN** Desktop 不为已完成的历史回合补生成建议

#### Scenario: 初次触发或实际派发前输入栏非空
- **WHEN** 成功完成时输入栏已非空，或完成后至实际调用 transport 前出现文字、附件、粘贴对象、mention、chip 或 Office 引用
- **THEN** Desktop 跳过本轮建议，不派发请求，保留原稿
- **AND** 随后清空输入栏不为本轮补生成，过期的 empty prop 不能绕过真实 composer 检查

#### Scenario: 运行期间编辑但完成前已清空
- **WHEN** 用户在本轮运行期间编辑输入栏，在明确成功完成前已恢复完全空白，且其余资格均满足
- **THEN** Desktop 仍可为本轮发起一次建议请求，不因已结束的编辑提前取消资格

#### Scenario: 回退、重放或不完整的轮次时间戳
- **WHEN** 可见轮次因 revert、前向重放或暂时空投影变化，或当前用户时间戳缺失、相同或延迟到达
- **THEN** Desktop 不将 turnKey 变化或运行快照本身视为新输入，不追溯赋予该轮资格
- **AND** scope 的用户创建时间戳高水位只增不减，初始及淘汰后基线包含持久化/live 历史中被 revert 隐藏的用户尾部

### Requirement: 灰字与真实草稿分离

建议 SHALL 与真实草稿分离，仅在真实编辑器与 composer 全部为空时以占位灰字显示，SHALL NOT 在编辑区下方另起一行或附加 `Tab 应用` 等可见操作提示。任何文字（包括空格、换行）、附件、mentions、粘贴对象、Office 引用和能力标签 SHALL 隐藏建议。建议 SHALL NOT 成为 draft、输入历史或聊天消息，不因建议本身激活发送按钮、不改变焦点或光标；真实草稿仍按既有发送规则处理。建议 SHALL NOT 自动发送、排队、steer、授权或启动后续工作。无障碍呈现 SHALL 区分建议与真实输入，并提供简短的建议可用说明和 Tab 快捷键信息；隐藏时 SHALL 移除建议可用说明及快捷键提示。

#### Scenario: 建议到达
- **WHEN** 合格的空白输入栏收到仍有效的建议
- **THEN** 用户只看见灰字建议，无可见 `Tab 应用` 文案，真实草稿保持为空
- **AND** 编辑器不自动获得焦点，Enter 不发送该灰字

#### Scenario: 非空输入隐藏而清空恢复
- **WHEN** pending 请求发出后用户编辑成非空草稿并收到有效结果，或 ready 建议存在时用户编辑、粘贴、恢复历史草稿或添加附件/引用/chips
- **THEN** 建议隐藏，不出现下方独立行，真实草稿及已有内容完整保留
- **AND** 清空或撤销到全部为空且其他展示条件满足后，恢复同一条灰字占位建议，不发起新请求

#### Scenario: 真实编辑器非空但外部草稿状态滞后
- **WHEN** 真实编辑器已有输入，而外部 draft prop 仍为空
- **THEN** 建议仍隐藏，不显示快捷键提示，不允许 Tab 接受，不覆盖真实输入

### Requirement: 普通 Tab 接受但不发送

仅当焦点在实际编辑区、没有活动菜单或 IME composition、建议仍有效且真实编辑器与 composer 内容全部为空时，Desktop SHALL 将无修饰且非 repeat 的 Tab 解释为接受建议。接受 SHALL 将建议全文写为可编辑草稿，光标位于文字末尾，独立为一次可撤销的正常草稿编辑，不与先前手动编辑合并。接受 SHALL 仅隐藏占位，不删除或终结 ready 内容；一次 undo 或清空输入恢复原建议，redo 后因草稿非空再次隐藏，均不重新请求。用户随后通过既有发送方式提交。IME、加号和 slash/mention 菜单 SHALL 优先，Shift+Tab、控件上的 Tab 和无可接受建议时的 Tab SHALL 保留原行为。

#### Scenario: 用户应用建议
- **WHEN** 用户在空编辑区按普通 Tab
- **THEN** 建议全文成为可编辑草稿，光标位于末尾
- **AND** 不发生 send/queue/steer；用户可修改后另行发送

#### Scenario: 非空草稿或引用禁止接受
- **WHEN** 用户在非空编辑区按普通 Tab，或 composer 含附件、mention、chip、粘贴对象或 Office 引用
- **THEN** 建议不消费 Tab，不插入或追加文字，不修改已有文字、selection、chips、附件及引用
- **AND** 无论 selection 为正向、反向、折叠、跨段或不可用，均不绕过全空条件

#### Scenario: 存在输入法或菜单
- **WHEN** 用户处于 IME composition，或加号/slash/mention 菜单活动中
- **THEN** 建议不消费按键，保留原有输入法与菜单交互

#### Scenario: 用户进行焦点导航
- **WHEN** 用户按 Shift+Tab，或在模型/附件等非编辑控件上按 Tab
- **THEN** 建议不阻止原有焦点移动

#### Scenario: 用户撤销接受
- **WHEN** 用户接受建议后撤销本次编辑
- **THEN** 一次 undo 恢复接受前的空草稿，不撤销先前手动编辑，并重新显示原建议
- **AND** redo 后草稿非空，建议再次隐藏，不重新请求

#### Scenario: 用户清空已接受的草稿
- **WHEN** 用户接受建议后编辑或保留草稿，随后清空全部输入
- **THEN** 恢复同一条原建议，不重新请求，也不自动发送

### Requirement: ready 内容保留且展示状态与 pending 取消分离

Desktop SHALL 将 ready 内容与视图展示分离。普通输入、编辑、粘贴、附件/mention/chip/Office 引用/标签变化或历史草稿恢复 SHALL 保留已派发请求与 ready 内容，SHALL NOT 覆盖草稿；非空只隐藏。Esc、发送/提交准备、queue、新轮次、目标会话/工作区、模型、账号/组织/策略变化、readiness 失效、活动 pane/页面可见性丢失、卸载或关闭功能 SHALL 取消 pending，取消后的迟到响应 SHALL 被丢弃；pending SHALL NOT 持久化或同轮重试。除真实新用户轮次与 session 删除外，这些变化 SHALL NOT 删除 ready 内容。每轮 SHALL 最多尝试一次，完成、取消、无建议、失败或跳过后 SHALL NOT 自动重新生成；恢复已有 ready 内容不属于重新生成。

#### Scenario: pending 请求期间编辑
- **WHEN** 请求实际发出但尚未完成时，用户输入、编辑、粘贴、恢复历史草稿或添加附件/mention/chip/Office 引用
- **THEN** 请求不因普通编辑取消，有效结果保留但非空时隐藏，用户草稿完整保留且不被结果写入
- **AND** 后续清空或撤销到全空显示同一结果，不额外请求本轮建议

#### Scenario: ready 建议期间编辑
- **WHEN** 本轮已有 ready 建议，用户编辑、粘贴、恢复历史草稿或改变附件/引用/chips
- **THEN** 同一建议保留但隐藏，既有内容不变，不出现下方独立行
- **AND** 仅在全部清空且其他展示条件满足时重新显示和接受，不因编辑重新推理

#### Scenario: Esc 仅隐藏 ready 视图
- **WHEN** 用户在编辑区按 Esc，且没有活动菜单或 IME composition
- **THEN** 当前视图中的 ready 建议隐藏，不改变草稿或删除已生成内容
- **AND** 重开会话或清空输入后可以恢复原建议，不重新请求

#### Scenario: pending 取消后不重试
- **WHEN** pending 阶段因 Esc、发送/准备提交、queue、新轮次、账号/组织/策略、模型、会话/工作区、readiness、可见性、卸载或关闭功能失去资格
- **THEN** 取消请求，保留普通草稿，迟到响应丢弃，不保存 pending 或产生可恢复结果
- **AND** queue 即使在同一事件循环内又清空也取消；恢复条件、清空、重挂载或重启不重试该轮

#### Scenario: 临时门禁只隐藏 ready 内容
- **WHEN** 已有 ready 建议，开关关闭、readiness 不可用、policy 加载或拒绝、model 临时变化、queue、提交准备、pane/page 隐藏或 surface 卸载
- **THEN** 建议隐藏，原建议及持久化内容保留，已接受草稿保留
- **AND** 条件恢复且输入栏全空时可展示原建议，不调用模型；暂时更换模型不替换原建议

#### Scenario: 请求完成后不自动重新生成
- **WHEN** 本轮请求已完成或取消、返回无建议、失败或跳过
- **THEN** 不因接受、Esc、编辑、清空、undo/redo、重渲染或完成事件再次请求
- **AND** 只有后续真实新用户轮次成功完成且满足初次及派发前资格，才可获得下一次尝试

#### Scenario: 两个 pane 或会话共存
- **WHEN** 主副 pane 共存，或用户从会话 A 切换到 B
- **THEN** 仅活动合格 pane 可请求和接受，A 的结果不进入 B
- **AND** 切回 A 可恢复其 ready 建议，同 renderer 同一轮不因双 surface 或 StrictMode 重复请求

#### Scenario: 尝试记录释放或 StrictMode 预演
- **WHEN** 非活动记录被有界缓存淘汰后重新进入该会话
- **THEN** 当前已存在轮次只作为生成基线，匹配的持久化建议可以恢复，不重新获得生成资格
- **AND** surface 卸载不立即丢失尝试记录；StrictMode 在实际派发前取消调度不消耗尝试，派发后不重试

### Requirement: 持久化建议按 scope 与稳定 identity 隔离

Desktop SHALL 将已生成的简短 ready 建议存入 localStorage，按 server endpoint、workspace ID、session ID 与稳定 account/org identity 隔离。键前缀 SHALL 为 `jugglework.prompt-suggestion.v1:`；仅保存 suggestion、turn ID、scope identity 与轮次/保存时间戳，SHALL NOT 保存 credential、token、key、完整历史、草稿、策略快照、pending 或可恢复任务。会话切换、重挂载与应用重启 SHALL 能恢复匹配 identity 和真实轮次的建议，不为旧轮发新请求。128 SHALL 仅为内存记录上限，内存淘汰 SHALL NOT 删除磁盘建议。存储异常 SHALL 静默降级为内存，跨重启恢复 SHALL NOT 在存储失败时被承诺。实现 SHALL 不引入多窗口同步或复杂协调机制。

#### Scenario: 重启恢复而非补生成
- **WHEN** 相同 endpoint/workspace/session/account/org 已有持久化 ready 建议，应用重启或新建 renderer 后加载同一真实轮次
- **THEN** 输入栏全空且展示条件满足时显示原建议，不调用模型
- **AND** 没有持久化结果的历史轮次只建立基线，不补生成或恢复 pending

#### Scenario: endpoint、workspace、session、account 或 org 不同
- **WHEN** 用户进入任一标识不同的 scope
- **THEN** 原 scope 的建议不显示在该 scope，也不因切换被删除
- **AND** 切回原 account/org 与 scope 后可恢复其建议，identity 不通过 credential 或 token 标识

#### Scenario: 内存上限不淘汰磁盘
- **WHEN** 超过 128 个 scope 使旧内存记录被淘汰
- **THEN** pending 被取消且不重试，ready 的 localStorage 记录保留
- **AND** 重新进入时可恢复匹配的 ready 建议，不因淘汰调用模型

#### Scenario: localStorage 异常
- **WHEN** localStorage 不可用、读取失败或写入失败
- **THEN** 当前内存建议仍可使用，不影响输入或发送，不显示错误 toast
- **AND** 不承诺跨重启恢复，不发额外模型请求修复存储

### Requirement: 仅真实新用户轮次或 session 删除清理旧内容

Desktop SHALL 仅在更新的真实用户轮次出现或 session 删除时清理旧 ready 内容。真实新轮 SHALL 由高于 scope 用户时间戳高水位的新用户输入识别，在新轮开始即清理旧建议，不等待成功终态或新建议结果；开关关闭或新请求失败 SHALL NOT 保留旧轮建议。revert、历史重放、模型/策略/identity 切换、ready 展示条件变化和内存淘汰 SHALL NOT 作为删除旧内容的理由。session 删除 SHALL 同时接入工作区 `session.deleted` 事件和成功删除调用后的直接清理；按 endpoint/workspace/session 清理全部 identity 的内存及持久化记录，取消 pending 并阻止迟到结果重建。

#### Scenario: 新真实用户轮次替换旧内容
- **WHEN** 观察到高于已知用户时间戳高水位的新真实用户轮次，或恢复历史时发现更新的真实用户尾部
- **THEN** 立即清理旧建议，即使功能关闭、新轮失败或新请求返回空结果也不恢复旧内容
- **AND** 被 revert 隐藏的更新真实尾部同样使旧建议过期，但历史投影切换本身不赋予新生成资格

#### Scenario: revert 与重放只影响展示
- **WHEN** 用户回退到较早轮次后再前向重放，期间没有更新的真实用户输入
- **THEN** 不匹配可见轮次时隐藏原建议，回到匹配轮次时可恢复，不删除、不重新生成

#### Scenario: 删除 session 清除全部 identity
- **WHEN** 收到工作区 `session.deleted`，或所属 endpoint 的删除 session 调用成功
- **THEN** 清除该 endpoint/workspace/session 下所有 account/org identity 的内存与 localStorage 建议，包括已被内存淘汰的记录
- **AND** 不依赖当前 session surface 正在监听，pending 被取消，迟到响应不能重新写入存储，其他 endpoint/workspace/session 保留

### Requirement: 专用建议调用不改变会话执行状态

Server SHALL 提供仅接受 model ref 与原始用户 turnKey 的专用 workspace/session 接口，沿用 client auth、collaborator、workspace/session 归属和 readOnly 合同。接口 SHALL 在生成前后核对最新真实轮次、明确成功终态、运行与等待状态。该接口 SHALL NOT 执行 workspace bootstrap/repair、创建 session/run、调用 prompt/promptAsync/压缩、修改偏好或 transcript、运行工具或触发引擎 reload。

#### Scenario: 本轮建议生成成功
- **WHEN** Server 为有效成功回合生成建议
- **THEN** 只返回该 turnKey 的建议文本或空结果
- **AND** 会话消息数量、run journal、工作区文件、模型偏好及引擎状态不因该调用改变

#### Scenario: 生成期间已开始新回合
- **WHEN** 推理期间最新真实用户消息或运行状态改变
- **THEN** Server 返回无建议，Desktop 不应用旧结果

#### Scenario: 只读或无生成权限
- **WHEN** Server 为 readOnly，或调用者不满足既有 collaborator/归属要求
- **THEN** 接口拒绝生成且不调用上游模型，普通会话读取行为不变

### Requirement: 上下文与输出有界且不执行会话数据

Server SHALL 自行从当前会话最多两页、每页最多 60 条历史中提取最多三轮真实用户文字与各轮最终助手正文，总计不超过 20,000 UTF-16 单元，保留完整当前轮并遵守 revert 边界。找不到当前真实轮次、当前轮超限或没有可用正文时 SHALL 跳过。reasoning、工具输入输出、synthetic/ignored/summary、附件字节及隐藏引用 SHALL NOT 作为推理上下文。模型 SHALL 使用固定无工具指令，输出同用户语言的一条自然后续输入或空结果，并保留已知行为边界。

#### Scenario: 历史只有中间过程或当前轮超限
- **WHEN** 有界窗口不能取得完整当前真实用户文本及成功最终正文，或当前轮超过预算
- **THEN** Server 返回无建议，不扫描全部历史、不回退旧轮或工具/推理内容

#### Scenario: 最新历史页已包含完整当前轮
- **WHEN** 第一页已能提取合格的当前轮上下文
- **THEN** Server 不为补充较早轮次额外读取第二页
- **AND** 并行独立读取但保留生成前后资格校验，不以缓存或提前生成绕过边界

#### Scenario: 用户消息含展开的引用与能力指令
- **WHEN** 历史中包含 `officeSelectionGroup`、`officeSelections`、`cloudDocSourceText` 或 composer 展开内容
- **THEN** 含 Office/云文档引用 part 的当前轮直接跳过、较早轮整轮省略，不因排除引用而丢失其中的用户限制
- **AND** 其他纯文本轮次只从明确 `composerTextSource=user` 的 part 提取用户文字，不使用编码/绑定或能力 prompt
- **AND** 旧当前轮来源不明或引擎不保留来源元数据时跳过，不能以 text 类型或自然语言猜测其来源

#### Scenario: 新消息的正文来源可识别
- **WHEN** composer 生成普通输入、用户粘贴或 capability/app/attachment 展开的 text parts
- **THEN** parts 携带非敏感 `metadata.composerTextSource=user | capability | app | attachment`，不改变主模型收到的文字
- **AND** 固定 OpenCode `v1.19.3` 的消息往返及持久化保留该来源 metadata

#### Scenario: 用户限制为只分析
- **WHEN** 提供的会话正文明确限制只分析、不修改或不提交
- **THEN** 生成指令要求保留该边界，不把建议描述为用户已授予的新授权
- **AND** 即使返回建议也不自动执行任何动作

#### Scenario: 模型输出不合格
- **WHEN** 输出为空、超出 240 UTF-16 单元、非单段、被截断、仅 reasoning、格式错误或包含结构化执行 token
- **THEN** 接口返回无建议，不截断展示、不再次调用修复

### Requirement: 复用当前模型且失败安全降级

首版 SHALL 使用当前会话 model ref，renderer SHALL 在 Desktop 模型策略明确允许时才派发，Server SHALL 复用有效 workspace 配置、模型启用/停用及黑白名单和 credential resolver；组织托管模型继续受 gateway 上游策略约束，不将 Server 配置检查冒充完整 Desktop policy。仅支持直接身份可解析的 OpenAI-compatible Chat Completions、OpenAI Responses、Anthropic Messages 文本协议。请求 SHALL 非流式、无工具、最多 512 输出 tokens，自 Server 接受请求开始采用覆盖历史、模型解析、上游响应体及生成后校验的单一 8 秒 deadline 并支持取消，不自动重试；错误 SHALL 脱敏且不影响主会话。

#### Scenario: 当前模型使用上游 alias 和网关 headers
- **WHEN** 当前公开 model ref 对应配置模型 `id` 或引擎解析的 `api.id`，且配置了有效 provider/model headers
- **THEN** Server 保持公开 model ref 不变，按配置 `id`、live `api.id`、公开 modelID 的优先级选择上游 ID，并按 live provider、配置 provider、live model、配置 model 顺序合并 headers
- **AND** 配置与 live alias 不一致、模板未解析或路由/header 无法复用时跳过，不丢弃配置后改用其他模型或 transport

#### Scenario: 当前模型不支持旁路调用
- **WHEN** 聊天模型已连接，但其 OAuth/凭据/协议不能用于此生成路径
- **THEN** 不显示建议，不改变模型选择，也不尝试另一模型
- **AND** OAuth-only、无法解析身份、renderer 策略无法确认、reasoning budget 或其他不支持预算/协议的模型 SHALL 跳过；SHALL NOT 隐式切换供应商、small_model 或回退 Agent

#### Scenario: 模型具备 reasoning 能力且支持有界输出
- **WHEN** 当前模型仅声明 `reasoning` / `capabilities.reasoning` 能力，使用受支持的 Anthropic、Responses 或上游 GPT-5/GPT-6/o 系列 Chat 协议，且没有额外启用的 reasoning/thinking 配置
- **THEN** 不因能力标记直接拒绝；Anthropic 关闭 thinking，Responses 和 GPT/o Chat 使用各自包含 reasoning 的 512 token 总上限
- **AND** 仅提取成功输出的最终文字，忽略伴随的 reasoning 内容，reasoning-only、截断或不合格文字仍返回无建议

#### Scenario: 请求成功但返回无建议
- **WHEN** 有效请求在状态、上下文、模型或输出检查中返回空结果
- **THEN** 既有请求日志记录固定 reason 与 detail，pretty 与 JSON 格式均可定位跳过分支
- **AND** 不记录正文、原始上游响应、提示词、模型配置、key 或 headers

#### Scenario: 超时或取消
- **WHEN** 请求超时、上游失败、用户取消或资格失效
- **THEN** 停止或忽略旁路请求，输入栏保持正常，不显示错误 toast，不自动重试
- **AND** 诊断不包含正文、原始上游响应、提示词或凭据

#### Scenario: 历史读取或响应体过慢
- **WHEN** 历史读取、模型解析或上游响应体读取消耗完共享 deadline
- **THEN** Server 取消可取消的 I/O 或停止等待并丢弃结果，不重置阶段计时、不开始后续推理或重试

### Requirement: 本机全局开关与远端能力门禁

Desktop SHALL 在全局通用页提供默认关闭、跨本机工作区一致的「下一轮输入建议」偏好，说明使用当前模型的额外调用与潜在费用。关闭 SHALL 立即取消 pending 并隐藏灰字，但保留 ready 内容与已经接受的普通草稿。Server SHALL 通过可选 `sessions.promptSuggestions` capability 宣告支持；请求 SHALL 使用所属 workspace server，能力缺失/关闭或旧路由 404/501 时禁用，不回退本机。

#### Scenario: 用户关闭功能
- **WHEN** 用户关闭全局开关
- **THEN** 不再生成或显示建议，pending 请求取消
- **AND** ready 持久化内容及已接受草稿不被清空；重新开启可恢复原建议，但不为没有结果的旧轮补生成

#### Scenario: 旧版本远端服务
- **WHEN** 工作区 server 未声明支持，或声明后返回缺失接口
- **THEN** Desktop 保留普通输入栏，不循环请求，不向本机或其他 endpoint 发送会话内容
