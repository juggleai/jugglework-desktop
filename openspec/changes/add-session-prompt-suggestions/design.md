# Design

## Context

当前 `SessionSurface` 复用 `sessionTaskPresentation` 提供真实用户轮次的 `turnKey`、`turnCreatedAt`、完成/停止/等待/待继续投影。`ReactSessionComposer` 与 `LexicalPromptEditor` 接入全空输入栏灰字占位建议、Tab 接受与视图隐藏，保留按 session 保存的草稿和加号、slash、mention 菜单的键盘处理。动态建议通过专用 workspace/session 接口生成；已生成建议独立于草稿持久化。

服务端已有工作区会话历史读取、有效模型配置、凭据 resolver，以及 Toonflow 的三类文本协议代理。Toonflow 的模型枚举同时涉及媒体 runtime，其 HTTP proxy 接受较通用的推理 payload，不能直接作为输入栏建议接口。现有 workspace resolver 可能执行 bootstrap/repair；建议读取路径不能借此写文件或触发引擎 reload。

竞品公开合同：

- [Codex Composer Predictions](https://developers.openai.com/codex/features/composer-predictions)：当前 thread 上下文生成建议，Tab 接受为草稿而非发送。
- [Claude Code Prompt suggestions](https://code.claude.com/docs/en/interactive-mode#prompt-suggestions)：灰字、Tab 接受；使用当前模型的短后台请求，并在部分不适合的状态跳过。

本设计借鉴交互，不依赖竞品内部实现，也不承诺其缓存命中率、兼容范围或免费计费政策。

## Goals / Non-Goals

**Goals:**

- 在自然的下一步明确时给出一条用户口吻的可编辑建议；允许没有建议。
- 不增加主回合延迟，不覆盖草稿，不影响既有发送、队列、停止、焦点与输入法行为。
- 生成调用严格限定到当前工作区、会话、真实用户轮次和当前模型，不跨供应商回退；已有建议不因临时模型变化被删除。
- 用小范围文本调用复用实现旁路请求，失败静默降级，无需新增运行系统。

**Non-Goals:**

- 不根据输入中的编辑逐字续写或重新生成建议；已发出的 pending 请求和 ready 建议在编辑后保留。不做多候选轮播、新会话起手建议或历史会话批量补生成。
- 不自动发送、提交代码、接受权限、代答 question、续跑 goal 或消耗队列。
- 不检索其他会话、Memory Bank、连接服务或工作区文件；不加入工具、联网或 Agent 能力。
- 不引入多窗口同步、锁或复杂协调机制；不持久化 pending 请求、接受历史、credential 或完整会话上下文。
- 不增加独立模型选择器，不为 OAuth-only provider 增加旁路认证/刷新实现。
- 首版仅接入主窗口工作区聊天的主/副 pane，不扩展文件窗口、review composer、IM 或自动化入口。

## Decisions

### 1. 建议是展示状态，接受后才是草稿

建议只在完全空白输入栏的占位区域展示可换行灰字，不在编辑区下方另起一行，不展示 `Tab 应用` 等额外可见文字；保留 Tab 接受和无障碍快捷键说明。完全空白同时检查真实 Lexical 内容与 composer 状态，文字（包括空格和换行）、附件、mentions、粘贴对象、Office 引用及能力标签均使建议隐藏。不将文字提前写入 Lexical、composer draft 或输入历史。建议本身不激活发送按钮，不改变引用或标签状态。建议出现时不移动焦点、不播放通知、不展示生成中 loading。

编辑器获得焦点、建议可接受且真实编辑器与 composer 全部为空时，普通 Tab 将建议全文写为可编辑草稿，光标位于文字末尾。接受独立为一次正常、可撤销的编辑，不合并先前手动编辑，不删除存储中的建议。接受后因草稿非空隐藏占位；一次 undo 恢复接受前的空草稿并显示原建议，清空草稿同样恢复原建议，redo 后再次隐藏，不产生新模型请求。非空时不拦截 Tab，不修改已有文字、selection、chips、附件或引用。后续 Enter 走原有发送逻辑，灰字本身不响应 Enter 发送。

请求实际发出后的 pending 和 ready 阶段，普通输入、编辑、粘贴、历史草稿恢复、附件/mention/chip/Office 引用加入或移除均保留本轮请求或建议，但任何非空输入均隐藏展示并禁止接受。pending 请求继续，返回的有效结果不改写草稿；清空或撤销到全空时显示同一建议，不重新生成。Esc 在没有其他活动菜单或 IME composition 时仅隐藏当前视图的 ready 建议，保留草稿和持久化内容；重开会话或清空输入恢复原建议。Esc 若取消 pending，则该请求同轮不重试，也没有可恢复的结果。设置支持键盘操作和无障碍说明；读屏通过一次简短状态说明告知建议可用，不循环播报正文，不把灰字伪装成真实编辑值。

### 2. 只在新近观察到的成功回合完成后尝试

首版只对本 renderer 已建立历史基线后观察到的真实新用户回合生成：`turnKey` 变化且 `turnCreatedAt` 严格高于该 scope 已知的用户时间戳高水位，再观察到明确成功终态。初次挂载的 completed 或 active-run snapshot 均只建立基线；设置刚开启也不追溯已有回合。只有仍保留未尝试资格的同 scope 运行可在重挂载后接续观察。

初次触发及实际调用 transport 前均同时要求：

- 开关已开启，surface 可见且属于当前活动 pane，窗口页面可见，输入栏可编辑。
- `sessionTaskPresentation.completed` 为真，且非 stopped/resumable/waiting/compacting；存在最终回复正文。
- 会话不 streaming、不 sending、不 preparing submission，服务端无活动运行或等待交互。
- 没有排队 follow-up；空白不仅指文字为空，还包括附件、mentions、粘贴对象、Office 引用和能力标签全部为空。
- 当前模型通过现有 Desktop 策略检查，所属 server 宣告支持此功能。

不只监听 `session.idle`，不以工具步骤结束、压缩完成或默认 stop 值判断成功。已有队列自动 drain 和真实用户输入永远优先。不为了生成建议推迟下一轮运行。

空白条件同时用于初次触发、实际派发前及展示/接受检查，同时检查 surface 状态与当前真实 composer 内容。完成时已非空，或完成后至实际派发前出现非空草稿，本轮跳过；之后清空不补生成。运行期间编辑但在成功完成前已清空，仍可满足初次触发资格。请求实际发出后不因 empty 变为 false 取消请求，但非空时隐藏结果且不能接受；清空只恢复已生成建议，不补生成跳过或取消的请求。

### 3. 每轮一次的内存记录与持久化建议

独立 renderer 内存模块以 server endpoint + workspace ID + session ID + 稳定 account/org identity 为 scope，记录最近原始 user message ID（`turnKey`）及用户时间戳高水位；pending 请求额外绑定当前 model ref、策略与本次视图上下文。identity 使用服务地址、账号 ID 和组织 ID 等非 credential 标识，不读取 token 或 key。主副 pane 共用该模块，避免一个 renderer 对同一轮重复请求。surface 卸载或切换工作区保留尝试记录；renderer 退出释放内存记录。

ready 建议以独立 localStorage 记录保存，键前缀为 `jugglework.prompt-suggestion.v1:`，按上述完整 scope 隔离。仅保存简短 suggestion 文本、turn ID、scope identity 与轮次/保存时间戳，不保存 credential、完整历史、模型配置、策略快照、草稿、pending 或可恢复任务。切换会话、工作区、账号/组织、重挂载或应用重启后，匹配 identity 与真实轮次的已生成建议可以恢复，不发模型请求。存储不可用、读取失败或写入失败时静默降级为内存，不能承诺跨重启恢复。

128 仅为内存 scope 记录上限，按最近访问优先淘汰非活动记录，取消被淘汰的 pending 请求，不删除 localStorage 中的 ready 建议。重新进入已淘汰 scope 或新 renderer 时恢复匹配的持久化建议，当前历史/运行快照仅作为生成基线，不把已存在的 user message 重新登记为新轮。没有已生成建议的旧轮不补生成；active run 首次挂载的观察只在同 scope 尚有未尝试内存记录时接续。

scope 内的用户创建时间戳高水位只增不减，基线包含持久化/live 历史中被 revert 隐藏的用户尾部。回退、前向重放、暂时空的投影或仅更换 turnKey 均不代表新输入；时间戳缺失、相同或延迟到达只更新基线，不追溯赋予当前轮资格。

生成状态为 `eligible → pending → ready | skipped`；无建议、失败、不支持或派发后取消进入本轮终结状态，同轮不重试。接受、Esc、普通输入与临时门禁仅控制 ready 的视图展示，不终结或删除内容。非活动 pane 不生成请求；若回合在非活动状态结束，首版跳过，不在切回时补生成。

每轮最多尝试一次，无定时轮询、自动重试或重新生成按钮。只有实际调用 transport 才消耗尝试资格；资格检查后的派发推迟到下一次事件循环，StrictMode 预演 effect 的 cleanup 仅取消尚未派发的调度，不消耗资格；空白等实际资格不满足则本轮 skipped，不因恢复资格而补生成。真正已请求后，普通编辑不取消；Esc、发送/提交准备、queue（即使同一事件循环内又清空）、目标会话/工作区/模型/账号组织或策略变化、readiness 失效、离开活动 pane、窗口隐藏、关闭开关、新轮次或卸载取消 pending。取消是 best effort；迟到响应按作用域及取消条件复检后丢弃，不以普通编辑判为过期。pending 不持久化，重启不恢复或重试请求。

ready 内容属于 scope 与真实轮次，不属于某个模型、策略、挂载或 pane。关闭开关、readiness/policy/model 临时变化、queue、提交准备、可见性变化或卸载仅隐藏已有内容，条件恢复且输入栏全空时可重新显示；切换账号/组织仅切换隔离 scope，不删除原 identity 内容。仅真实新用户轮次或 session 删除清理旧内容：新轮开始时即清除旧建议，即使功能关闭或新请求失败也不沿用旧内容；revert、历史重放及旧 snapshot 不构成新轮。删除通过工作区 `session.deleted` 事件与成功 delete 调用后直接清理接线，按 endpoint/workspace/session 清除全部 identity 的内存与存储记录，取消 pending，防止迟到响应重建。无需多窗口同步、锁或复杂协调。

### 4. 输入法与菜单优先，Tab 仅作用于编辑区

按键优先级：IME composition → 加号菜单 → slash/mention 菜单 → 建议 → 原有行为。

- 建议只消费 ContentEditable 内无 Shift/Ctrl/Alt/Meta 的 Tab，且 `event.repeat` 为假。来自按钮、选择器或其他控件的 Tab 保留焦点导航。
- 同时检查 React composition 标记、原生 `isComposing`/229 和 Lexical composition 状态。
- 任意活动菜单拥有按键优先权，即使暂时无匹配项也不由建议接管。
- Shift+Tab、方向键等保留原义；首版不绑定右方向键接受。
- 接受分支再次检查真实编辑器与 composer 全空；非空时不改写内容或 selection，不 preventDefault。接受只更新草稿，不调用 send/queue/steer。

### 5. 专用会话接口，不创建辅助回合

新增可选 server capability `sessions.promptSuggestions`，缺失或 false 即不支持。通过所属 workspace endpoint 请求，不能退回本机或另一个工作区。老 server 即使错误宣告能力而返回 404/501，也在当前连接内视为不支持，不循环重试。

接口：

```text
POST /workspace/:id/sessions/:sessionId/prompt-suggestions
{ "turnKey": "<raw-user-message-id>",
  "model": { "providerID": "...", "modelID": "..." } }

200 { "turnKey": "...", "suggestion": "一条下一轮用户输入" }
200 { "turnKey": "...", "suggestion": null,
      "reason": "no_suggestion | ineligible_turn | context_unavailable | model_unavailable" }
```

请求采用严格 schema，不允许附加历史正文、system prompt、工具、凭据、baseURL 或客户端自报策略。沿用 client auth、workspace/session 归属和 collaborator scope 检查；readOnly 拒绝推理。传输/上游错误沿用已有脱敏错误合同，前端统一静默降级。

服务端使用不做 bootstrap/repair 的 workspace 读取与已有 SDK client。核实最新真实用户消息与 turnKey 一致，已有引擎/宿主运行空闲且无 permission/question 等待，最新 assistant 非 summary/error/aborted 且有 completed 与明确成功 finish。生成后再次检查最新轮次、运行状态及模型有效性，变化则返回无建议；不使用锁阻止正常发送。

该调用不进入 prompt/promptAsync、admission、run reservation、session 模型偏好写入或 journal，不创建临时会话。前端不得通过 `noReply`、压缩或隐藏用户消息替代此接口。

### 6. 服务端读取有限正文，固定提示词

服务端通过现有历史 API 从最新窗口开始读取，每页最多 60 条，最多两页。第一页已有完整合格上下文即使用，不为增加较早轮次补读；仅当目标轮次或 revert 边界可能在旧页时读取第二页。找不到目标真实用户消息及其最终成功回复就跳过，不扫描整场历史。应用现有 revert 边界，忽略 synthetic、ignored、compaction continuation 和 summary 内容。

状态检查与第一页读取并行；状态合格后，模型解析与上下文读取并行。生成后上下文与模型复检并行，完成后仍执行最终状态检查，不引入跨请求缓存、锁或运行中预生成。现有诊断以纯数字记录 state/context/model/inference/revalidate 耗时，用于区分读取等待和模型延迟；并行阶段不可直接求和，且不得记录正文或凭据。

只提取最近最多三轮真实用户文字与各轮最终助手正文，总计最多 20,000 UTF-16 单元：优先保留当前用户消息及最终回复，再放入可容纳的完整较早轮次。如果当前一轮本身超限则跳过，不用不完整的用户指令生成建议。排除 reasoning、工具输入输出、附件字节、Office 选区与隐藏结构化引用；纯文本不足时不回退到旧轮。结果文本不能依赖未提供的附件内容。

用户正文来源按原始持久化 parts 的元数据识别，不只检查 `type === text`：

- 有 `metadata.officeSelectionGroup`、`metadata.officeSelections` 或 `metadata.cloudDocSourceText` 的 part 不解析或回填其选区、编码和正文。首版对包含这类 part 的当前轮直接跳过，避免整段排除时连带丢失其中用户的「只分析、不修改」等限制；较早轮整轮省略，不仅取同消息剩余文字。
- `draftToParts` 已在普通输入/用户粘贴、能力展开、app mention 展开和附件说明处写入非敏感来源标记 `metadata.composerTextSource`，取值 `user | capability | app | attachment`；只将 `user` 文本纳入建议上下文。固定 OpenCode `v1.19.3` 已验证该元数据在消息往返及持久化后保留。此标记不包含额外正文、引用或凭据，不改变送给主模型的文字，不新增存储表。
- 带 synthetic/ignored 标志或文件/agent 等非 text part 不提取。助手只取最终成功回复的普通正文 part。
- 缺少可辨识来源的旧用户 part 不猜测为用户正文；若其与当前用户消息混合且不能确认完整用户指令，整个当前轮跳过；较早轮无法提取则整轮省略。不同版本引擎若不能保留来源元数据，该连接不生成建议。不得凭自然语言正则删除任意注册能力的 prompt。

服务端固定提示词要求：预测一条最自然的下一轮**用户输入**，语言跟随最近用户，建议简短、不加标题/解释；遵守「只分析、不修改」「不提交」等已知边界，不制造用户授权或事实，不要求执行当前未授权的发送、删除、发布等动作。没有明确下一步时输出空结果。会话正文作为待分析数据，不作为更高优先级指令，也不允许其改变调用参数。

首版非流式、无 tools，自 Server 接受请求开始采用一个 8 秒绝对 deadline，覆盖 workspace/历史分页、模型/凭据解析、上游 fetch 与响应体读取、生成后二次校验；所有可取消 I/O 共用 request abort + deadline signal，不能每阶段重置计时。不可取消的现有读取也在 deadline 到达后停止等待并丢弃结果，不继续发起下阶段或后台重试；不为此引入持久 job。renderer 同样以 8 秒预算取消并停止展示资格，不保证网络和事件调度有严格毫秒级完成时限。输出 token 总预算最多 512。需额外无界 reasoning 预算或无法遵守调用边界的模型跳过。上游输出归一为一条纯文本；仅接受 1–240 UTF-16 单元的单段建议，空结果、截断输出、格式错误、reasoning-only、超长或结构化执行 token 等返回无建议，不截断后显示，不再次请求修复。

### 7. 小范围复用单模型文本推理

从 Toonflow 提取单模型解析、协议适配与请求 transport 到共享服务端模块；共享模块不依赖 Toonflow 路由、UI 或媒体 runtime，避免循环依赖。Toonflow 保持现有公开行为并补回归，不将其全模型/媒体发现流程搬到建议请求。

沿用有效 workspace 配置、启用/停用、provider whitelist/blacklist、模型能力与已有 credential resolver，不建立第二套凭据存储，不让 renderer 接触模型凭据或上游 endpoint。首版只支持可由此路径解析身份的三类文本协议；OAuth-only、仅引擎内部可用的凭据及其他原生协议直接跳过，不回退 Agent 或其他模型。

`reasoning` / `capabilities.reasoning` 表示模型能力，不等同于必须开启 thinking。Anthropic 使用 `thinking: disabled` 与 `max_tokens: 512`；Responses 使用 `max_output_tokens: 512`；OpenAI-compatible 的上游 GPT-5、GPT-6、o 系列使用 `max_completion_tokens: 512`（包含 reasoning token），普通兼容模型保留 `max_tokens: 512`。未知兼容 reasoning 方言与显式开启的 reasoning/thinking 配置仍跳过，不复制额外预算或提高上限。Responses 的 reasoning 项及 Chat 的 reasoning 字段不作为建议正文；仅完整成功的最终可见文字可显示，reasoning-only 仍为空。

公开 model ref 与上游模型 ID 分离：优先使用配置模型的 `id`，其次使用引擎解析的 `api.id`，再使用公开 modelID；配置与 live alias 不一致时跳过。有效 headers 按 live provider、配置 provider、live model、配置 model 的顺序合并，后层同名字段覆盖前层；模型级 `provider.api/npm` 与 provider `options.baseURL` 按现有引擎配置语义解析。未解析模板、无效路由/header 或无法复用的自定义 transport 不静默丢弃，直接跳过。

策略责任沿用现有分层，不假定 Server 已有完整 Desktop policy 镜像：renderer 使用当前组织策略与 `isDesktopModelBlocked` 等现有模型 gate，未知/加载中的策略不派发。Server 通过 `readEffectiveWorkspaceOpencodeConfig` 的 enabled/disabled provider、whitelist/blacklist，以及 workspace provider credential resolver 检查配置与执行资格；组织托管 provider 仍受其 gateway 的上游权威策略约束。普通显式配置 API 模型受本机 Desktop gate 和所属 server 配置约束；这两者不合称 Server 的组织策略权威。请求不携带允许列表/策略快照，不新增策略复制或额外信任机制。账号/组织或策略变化取消 pending 并隐藏不合格视图，不删除 ready 内容；恢复匹配 identity 与允许状态后可展示原建议。三协议真实验收的前提是 renderer 当前策略已明确允许且该 server 已配置相应可解析凭据的文本模型，不要求所有组织或连接均支持。

此旁路使用精简上下文，不保证命中主会话 prompt cache。额外费用由当前 provider 正常计费；不开启新供应商、不自动切到 small_model。

### 8. 全局本机开关与可降级发布

在全局「通用」页增加「下一轮输入建议」，沿用 LocalProvider 偏好存储，默认关闭，跨本机工作区一致。说明文案：「在回复结束后，使用当前会话模型生成下一轮输入建议；可能产生额外模型费用。按 Tab 填入后可编辑，不会自动发送。」不写 workspace OpenCode 配置，不增加 per-workspace 模型参数。

关闭立即取消 pending 并隐藏 ready，不删除已生成建议或已接受草稿。重新开启可恢复匹配轮次的原建议，但仅后续真实新轮次具备新生成资格；旧轮没有结果时不补生成。功能不支持或生成失败不显示错误 toast，不影响模型选择或发送；设置说明不承诺所有模型可用。只记录现有必要诊断中的状态码、耗时与非敏感 reason，不记录正文、提示词、原始上游响应或凭据，不新增内容埋点系统。

既有请求日志在 pretty 与 JSON 格式均记录固定的 `prompt_suggestion` reason 与 detail：区分宿主/引擎忙碌、模型偏好不符、交互读取/等待、上下文来源/父消息/终态/预算、模型配置/协议/输出能力及生成后状态变化。不读取响应正文来记录日志，不记录模型配置、key 或 headers；响应 DTO 保持原有 reason 合同。

## Risks / Trade-offs

- 当前模型可能慢或不支持直接推理 → 8 秒超时、有限输出、可为空，不阻塞输入，不换模型。
- 预测可能误解用户意图 → 不自动写草稿、不自动发送，短文本可编辑，保留关闭入口。
- 历史窗口可能缺少约束或过长 → 有限完整轮次、保守空结果，不宣称等价完整 Agent 上下文。
- 抽取 Toonflow transport 可能回归既有代理 → 仅提取共用逻辑，针对三协议和取消/错误补回归。
- 默认关闭降低功能发现 → 通用设置说明明确，首版不增加强提示或额外付费自动开启。
- 旧远端和 OAuth-only 模型覆盖有限 → capability gate、明确支持范围，不为兼容而污染主会话。

## Compatibility and Verification

Server route/capability 为增量合同，无能力的旧 server 保留普通输入栏，不回退本机调用。开关默认关闭，不回填历史轮次；关闭偏好或 server capability 不清理持久化建议及已接受的普通草稿。

自动化测试覆盖全空占位与接受、undo/清空恢复、视图隐藏、localStorage 恢复与 identity 隔离、内存淘汰不清磁盘、存储异常降级、删除接线及 pending 取消无重试。固定 OpenCode `v1.19.3` 隔离 synthetic provider 的真实引擎验证已完成，确认来源 metadata 持久化与取消；完整真实 Desktop 三协议、真实模型及系统 IME 验收仍待完成。
