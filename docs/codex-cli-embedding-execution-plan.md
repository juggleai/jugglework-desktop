# 开发计划：JuggleWork Desktop 内置 Codex CLI

> 状态：待产品与架构确认；确认前不开始实施  
> 生成日期：2026-08-12  
> 基于：[Codex CLI 嵌入 JuggleWork Desktop 架构方案](./codex-cli-embedding-architecture.md)及已确认的 8 项产品决策  
> PRD：当前没有独立 PRD，本计划以架构文档“已确认产品决策”和“已确认的首版范围”为本期需求基线  
> 交付范围：首版，仅本地工作区

---

## 一、范围与规划策略

### 1.1 首版交付范围

- 内置固定版本的 Codex CLI，不发现、不调用用户全局安装的 Codex。
- 仅支持本地工作区；远端工作区不展示或禁用 Codex。
- OpenCode 与 Codex 通过统一 Runtime Adapter 接入，现有 OpenCode 行为保持兼容。
- 用户在新会话中选择运行时；会话开始后切换运行时等于新建会话。
- Codex 模型请求通过 JuggleWork 自有 Responses API 网关，不直接使用用户 OpenAI/ChatGPT 登录或个人 API Key。
- 使用 JuggleWork 登录态换取组织短期模型 Token，经 Electron Main Credential Broker 自动刷新与转发。
- 支持文本、流式回复、reasoning、工具调用、命令、文件修改、审批、中断、恢复与归档。
- 首版必须支持 MCP、Skills、图片上传及图片分析/识别，包括单图和多图。
- 会话历史由 JuggleWork 与 Codex 双写，以 JuggleWork 事件账本为权威。
- 支持 macOS arm64/x64、Windows x64 的安装、签名、升级和进程回收。
- Codex 作为默认免费能力，但服务端保留并发、速率、用量和滥用保护。

### 1.2 明确不在首版范围

- 远端工作区运行 Codex。
- 已开始的 OpenCode 会话原地切换为 Codex，或反向切换。
- 使用用户自行安装的 Codex CLI、用户全局 `CODEX_HOME` 或用户 OpenAI/ChatGPT 登录。
- Windows arm64。
- 图片生成；首版图片能力仅指图片输入、识别、理解和分析。
- 跨运行时完整上下文迁移、会话 fork、Plan/Review 等非必需实验能力。

### 1.3 项目规模判断

本项目涉及 Desktop Main、React Renderer、Server/Gateway、会话持久化、原生 sidecar 打包和跨平台验收，属于中型跨端改造。按功能域与部署边界聚合为 10 个模块；不把单个 Store、IPC 方法或 UI 组件拆成独立模块。

---

## 二、模块全景图

```text
Layer 0 方案验证与公共契约
  [MOD-001] Codex 技术 Spike 与协议锁定
  [MOD-002] 运行时领域模型与会话数据契约

Layer 1 核心运行框架
  [MOD-003] 组织 Token 与模型网关服务
  [MOD-004] Codex Sidecar、App Server 与 Credential Broker
  [MOD-005] Runtime Adapter、事件标准化与安全 IPC

Layer 2 首版业务能力
  [MOD-006] 权威会话账本、双写与恢复
  [MOD-007] Composer、会话与运行时交互
  [MOD-008] MCP、Skills 与图片分析
  [MOD-009] 跨平台打包、安全与诊断

Layer 3 集成验证与发布
  [MOD-010] 全链路测试、灰度与发布验收
```

---

## 三、模块详情

> 按依赖和建议执行顺序排列。模块内是聚合工作范围，不是具体任务清单；计划确认后再进行任务级拆解。

### [MOD-001] Codex 技术 Spike 与协议锁定

| 属性 | 内容 |
| --- | --- |
| 所属层 | Layer 0：方案验证 |
| 描述 | 在不改造正式会话链路的前提下，验证锁定版 Codex App Server、JuggleWork 网关、图片理解和跨平台进程能力。 |
| 依赖模块 | 无 |
| 解锁模块 | MOD-002、MOD-003、MOD-004 |
| 接口契约 | Codex 版本与 SHA-256；App Server schema/version；初始化、thread、turn、stream、tool、approval、interrupt、image 的协议映射；Responses/SSE 与错误契约。 |
| Done Definition | macOS arm64 与 Windows x64 均能通过测试网关连续完成至少 20 次“创建 thread → 文本/图片分析 → 工具事件 → 中断或完成”；进程退出无残留；协议 schema 固化；Token 过期/刷新验证通过；形成 Go/No-Go 记录。 |

**主要工作内容**：

- 固定一个 Codex CLI 版本，验证 `codex app-server --stdio`、严格配置和自定义 Responses Provider。
- 覆盖文本、多轮、流式、工具、审批、中断、单图、多图及不支持 MIME 的协议行为。
- 验证 JuggleWork 网关对 Responses、SSE、reasoning、tool call/output、usage、图片输入和错误结构的兼容性。
- 验证隔离 `CODEX_HOME`、本地随机 Provider 凭据、短期组织 Token 刷新和 401 重放边界。
- 验证 macOS/Windows 的启动、路径、信号/进程树回收和基础打包可行性。

**风险/注意事项**：

- App Server 为实验接口；Spike 未通过不得绕过 Adapter 直接接入正式 UI。
- 图片分析必须使用首发候选模型验证，不能只证明请求字段可发送。
- 若 Windows x64 环境暂时不可用，M0 不能标记完整通过，只能记录为有条件 Go。

---

### [MOD-002] 运行时领域模型与会话数据契约

| 属性 | 内容 |
| --- | --- |
| 所属层 | Layer 0：公共契约 |
| 描述 | 建立 OpenCode/Codex 共用的运行时接口、事件模型、能力模型、错误模型和会话数据结构。 |
| 依赖模块 | MOD-001 |
| 解锁模块 | MOD-005、MOD-006、MOD-007 |
| 接口契约 | `RuntimeKind`、`AgentRuntime`、`RuntimeEvent`、`RuntimeCapabilities`、`RuntimeError`、`RuntimeSessionRecord`、`ContentPart`、附件元数据、审批 DTO 与 IPC DTO。 |
| Done Definition | 公共类型不引用 OpenCode SDK 或 Codex 原始类型；事件 schema 可版本化并通过序列化/反序列化契约测试；会话数据包含 `orgId`、`workspaceId`、`runtimeKind`、`backendThreadId` 和配置快照；旧 OpenCode 数据有明确兼容/迁移规则。 |

**主要工作内容**：

- 统一 thread、turn、消息、reasoning、命令、工具、文件变化、审批、usage 和终态事件。
- 定义运行时能力协商，至少覆盖 images、MCP、Skills、approvals、steering 和 reasoning stream。
- 定义应用 Session ID 与后端 thread ID 的映射，以及运行时锁定规则。
- 定义图片附件的 MIME、大小、数量、来源、对象引用和历史展示字段。
- 定义向前兼容策略：未知事件保留诊断但不导致 Renderer 崩溃。

**风险/注意事项**：

- 该契约是后续模块的共同边界，不能为 Codex 临时增加 UI 可见的专属类型。
- 数据迁移必须保证现有 OpenCode 会话无需重建即可继续展示和运行。

---

### [MOD-003] 组织 Token 与模型网关服务

| 属性 | 内容 |
| --- | --- |
| 所属层 | Layer 1：Server/Gateway |
| 描述 | 提供“登录 JuggleWork 即可使用 Codex”的服务端认证、模型目录、用量保护和 Responses 网关契约。 |
| 依赖模块 | MOD-001 |
| 解锁模块 | MOD-004、MOD-008、MOD-010 |
| 接口契约 | 短期 Token 交换接口；JWT/opaque token claims；模型目录；Responses/SSE；幂等键；401/403/429/5xx；撤销、限流与审计事件。 |
| Done Definition | 有效 JuggleWork 登录态可为当前组织换取仅面向模型网关的短期 Token；Token 绑定用户、组织、设备、audience、scope 和过期时间；网关拒绝跨组织、过期、错误 audience/scope 的请求；模型目录声明图片/工具/推理能力；Responses 契约测试全通过。 |

**主要工作内容**：

- 增加专用 Token 交换能力，禁止把 JuggleWork 主登录 Token 原样转发给模型网关。
- 建立组织、成员、设备、模型和权限绑定，支持登出/组织切换后的撤销或自然快速过期。
- 对外提供 Codex 可用模型目录及 `supportsImages`、`supportsTools`、reasoning effort 等能力。
- 实现免费能力对应的并发、速率、滚动用量保护、滥用检测和脱敏计量。
- 固化 Responses API 的图片、工具、流式、usage、错误和幂等行为。

**风险/注意事项**：

- 如果模型网关不在当前仓库，该模块需要由网关团队按同一接口契约交付，仍是首发关键路径。
- “免费”是产品权益，不代表无配额；具体阈值需在发布前配置完成。

---

### [MOD-004] Codex Sidecar、App Server 与 Credential Broker

| 属性 | 内容 |
| --- | --- |
| 所属层 | Layer 1：Desktop Main |
| 描述 | 在 Electron Main 中托管隔离的 Codex 进程、JSON-RPC 客户端和本地凭证代理。 |
| 依赖模块 | MOD-001、MOD-003 |
| 解锁模块 | MOD-005、MOD-008、MOD-009 |
| 接口契约 | `CodexProcessManager` 生命周期；App Server RPC；本地 Broker 请求/响应；Token Provider；工作区/组织绑定；健康状态与脱敏诊断。 |
| Done Definition | 每个活跃本地工作区可懒启动固定版 Codex；使用应用独立 `CODEX_HOME` 且不读取/修改 `~/.codex`；Broker 仅监听 loopback 并动态注入组织 Token；登出、切换组织、应用退出和异常退出均能停止进程并清理凭据；Renderer 无法读取任何 Token。 |

**主要工作内容**：

- 实现工作区级 Codex App Server 生命周期、握手、schema/version 检查、空闲退出和崩溃检测。
- 创建隔离的配置、sessions、skills、logs 目录，并生成固定 Provider 配置。
- 实现随机端口、随机路径、高熵本地 secret 的 Credential Broker，流式转发 Responses/SSE。
- 实现 Token 到期前刷新以及安全条件下的单次 401 重试；已经输出响应字节时不自动重放。
- 将登录、登出、组织切换和应用升级纳入强制生命周期边界。

**风险/注意事项**：

- Broker 不启用 CORS，不记录请求正文、SSE 正文、Authorization 或随机访问路径。
- 本地 secret 不是组织 Token；不得为简化实现而把真实组织 Token 固定注入 Codex 环境变量。

---

### [MOD-005] Runtime Adapter、事件标准化与安全 IPC

| 属性 | 内容 |
| --- | --- |
| 所属层 | Layer 1：跨运行时核心框架 |
| 描述 | 用统一 Adapter 包装 OpenCode 与 Codex，将 Renderer 从具体运行时协议中解耦。 |
| 依赖模块 | MOD-002、MOD-004 |
| 解锁模块 | MOD-006、MOD-007、MOD-008 |
| 接口契约 | `AgentRuntime` 实现；事件排序/去重；turn 命令；审批回应；能力查询；typed IPC allowlist；统一错误码。 |
| Done Definition | Renderer 主会话链路不再直接调用 OpenCode SDK；OpenCode 与 Codex 都可通过统一接口完成 create/resume/send/interrupt/approve/archive；同一 fixture 可验证两个 Adapter 的标准事件；IPC 拒绝越权 workspace/org/thread 组合；现有 OpenCode 回归测试通过。 |

**主要工作内容**：

- 先以 OpenCode Adapter 包装现有行为，建立无功能回归的兼容基线。
- 实现 Codex JSON-RPC 到统一事件的映射、delta 合并、乱序修正、幂等标识和错误翻译。
- 将工作区、组织、会话、审批请求的作用域校验下沉到 Main/Runtime 边界。
- 建立运行时能力查询，让 UI 依据 capabilities 展示功能，而不是判断 `runtimeKind === "codex"`。
- 标准化可观测字段，原始 stderr 和后端 metadata 只进入脱敏诊断。

**风险/注意事项**：

- 不允许在现有 Store 中长期保留 OpenCode/Codex 两套分支逻辑。
- OpenCode 兼容性是模块完成条件，不是首发末期才处理的回归项。

---

### [MOD-006] 权威会话账本、双写与恢复

| 属性 | 内容 |
| --- | --- |
| 所属层 | Layer 2：会话数据 |
| 描述 | 让 JuggleWork 持久化标准化事件并成为唯一展示主数据源，同时保留 Codex thread 作为运行时副本。 |
| 依赖模块 | MOD-002、MOD-005 |
| 解锁模块 | MOD-007、MOD-010 |
| 接口契约 | 事件账本 schema；幂等键；事务边界；session/thread 映射；对账状态；归档/恢复；附件对象引用；数据迁移。 |
| Done Definition | 所有 Codex 用户消息、助手消息、tool call/result、审批、文件变化摘要、usage 和 turn 终态逐事件幂等落盘；重放不会产生重复记录；异常退出后可对账恢复；Codex thread 丢失时能从 JuggleWork 规范历史/摘要创建新 thread；任何恢复都不能跨 `orgId` 或覆盖权威历史。 |

**主要工作内容**：

- 扩展会话记录和数据库迁移，保存运行时、后端 thread、组织、模型和配置快照。
- 建立 `runtimeKind + backendThreadId + backendEventId` 幂等策略及缺失事件 ID 时的稳定映射。
- 明确“持久化成功后可展示/确认”的投影规则，以及流式 delta 的落盘与聚合方式。
- 建立启动对账、未完成 turn 收敛、thread 丢失/损坏重建和归档恢复流程。
- 将图片附件保存为受控元数据与对象引用，不在事件账本复制大体积 base64。

**风险/注意事项**：

- 需要先确认当前会话存储的事务与迁移能力，避免双写形成两个独立真相源。
- 重建 thread 时只能使用可审计的规范历史或摘要，不能伪造原始 tool 状态。

---

### [MOD-007] Composer、会话与运行时交互

| 属性 | 内容 |
| --- | --- |
| 所属层 | Layer 2：产品交互 |
| 描述 | 在现有 Composer 和会话页面中接入运行时选择、模型能力、运行状态和切换新建规则。 |
| 依赖模块 | MOD-002、MOD-005、MOD-006 |
| 解锁模块 | MOD-010 |
| 接口契约 | 新建会话参数；运行时/模型选择状态；会话锁定状态；能力驱动 UI；错误/重新登录提示；本地/远端可用性。 |
| Done Definition | 本地新会话可选择 OpenCode 或 Codex；首次发送后运行时锁定；切换运行时明确创建新会话；远端工作区不可选择 Codex；Codex 会话支持发送、steer/stop、审批、恢复和归档；选择会话后输入框自动聚焦；OpenCode 交互无回归。 |

**主要工作内容**：

- 在现有智能体位置提供运行时入口，并区分 Runtime、Agent Profile、模型和推理强度。
- 使用会话快照保存运行时与模型选择，遵循“会话 > 工作区 > 全局”默认值层级。
- 按 capabilities 控制图片、MCP、Skills、审批和 reasoning 展示。
- 实现 Token 失效、网关不可达、模型不可用和运行时崩溃的可恢复提示。
- 保持现有工作区列表、会话排序、loading、通知和输入焦点行为稳定。

**风险/注意事项**：

- 不在已有会话中静默替换运行时；所有切换动作都必须产生新的 JuggleWork Session ID。
- “Codex 免费”不增加 API Key、OpenAI 登录或购买入口。

---

### [MOD-008] MCP、Skills 与图片分析

| 属性 | 内容 |
| --- | --- |
| 所属层 | Layer 2：首版能力 |
| 描述 | 在隔离 Codex 环境中交付 MCP、Skills 和视觉输入，并复用统一权限、附件与会话体系。 |
| 依赖模块 | MOD-003、MOD-004、MOD-005 |
| 解锁模块 | MOD-010 |
| 接口契约 | MCP 配置投影与凭据注入；Skill 清单/来源/版本；图片附件输入 DTO；MIME/大小/数量限制；工作区信任与审批；模型 capability。 |
| Done Definition | Codex 可发现并调用批准的 MCP；可发现应用内置与受信任工作区 Skills，且不读取用户全局 Skills；用户可上传、粘贴或拖入单图/多图并获得与图片内容相关的有效分析；图片权限、格式、大小和模型能力校验生效；三项能力在 macOS/Windows 均通过契约测试。 |

**主要工作内容**：

- 将 JuggleWork 管理的 MCP 清单投影到隔离 `CODEX_HOME`，按组织和工作区隔离配置与凭据。
- 随应用发布内置 Skills 清单，记录来源与版本，并允许受信任工作区 Skills 按策略被发现。
- 复用现有 Composer 附件体验，把图片经 Main 路径校验后按锁定版 App Server schema 发送。
- 支持常见首发图片格式、单图和多图；模型不支持视觉时发送前阻止并给出明确原因。
- 保证 IPC、普通日志、事件账本不复制图片 base64；历史只保存附件引用和必要元数据。

**图片分析专项验收**：

- UI 截图：能描述主要区域并回答指定控件相关问题。
- 报错截图：能识别可见错误信息并结合工作区给出分析。
- 流程图/架构图：能识别主要节点和关系。
- 多图比较：能区分图片顺序并总结差异。
- 安全边界：工作区外文件、超限文件、伪造 MIME 和跨组织附件引用均被拒绝。

**风险/注意事项**：

- “请求成功”不等于视觉能力验收通过，必须对候选模型执行语义结果测试。
- MCP/Skills 可能执行命令或访问网络，必须沿用统一 sandbox 与审批模型。

---

### [MOD-009] 跨平台打包、安全与诊断

| 属性 | 内容 |
| --- | --- |
| 所属层 | Layer 2：发布基础设施 |
| 描述 | 将固定版 Codex sidecar 安全纳入 macOS/Windows 构建、签名、升级、回收与运行时诊断。 |
| 依赖模块 | MOD-004 |
| 解锁模块 | MOD-010 |
| 接口契约 | sidecar manifest；版本/hash/schema 元数据；target triple 映射；签名流程；进程树回收；诊断结果 DTO；升级兼容规则。 |
| Done Definition | macOS arm64/x64 和 Windows x64 安装包只包含对应架构 Codex；构建校验 SHA/version/schema；macOS 完成嵌套签名和 notarization 验证；Windows 完成签名和完整进程树回收；升级安装无 sidecar 占用；诊断页可在不泄漏凭据/路径/正文的情况下定位版本、启动、网关、模型和 sandbox 问题。 |

**主要工作内容**：

- 扩展现有 sidecar 准备脚本和版本清单，按目标平台下载、校验、复制 Codex 资产。
- 将 Codex 资产加入 Electron Builder `extraResources`，避免同时打入通用和目标架构二进制。
- 完善 macOS nested signing、hardened runtime、notarization 与 DMG 安装后验证。
- 完善 Windows `shell:false`、隐藏窗口、Job Object/等效进程树回收、路径与升级占用处理。
- 增加 Codex 运行时健康检查和脱敏诊断导出。

**风险/注意事项**：

- 预计安装包压缩体积增加约 85–100 MB、安装后约 215–230 MB；实际值以锁定版三平台构建产物为准。
- 杀进程、升级和清理只能针对已解析并绑定到当前应用实例的 sidecar。

---

### [MOD-010] 全链路测试、灰度与发布验收

| 属性 | 内容 |
| --- | --- |
| 所属层 | Layer 3：集成验证 |
| 描述 | 建立跨协议、跨平台、安全、数据恢复和产品回归矩阵，并以功能开关控制灰度发布。 |
| 依赖模块 | MOD-003、MOD-006、MOD-007、MOD-008、MOD-009 |
| 解锁模块 | 首版发布 |
| 接口契约 | 自动化测试环境；网关测试租户/模型；发布开关；兼容矩阵；遥测 schema；回滚和 sidecar 降级规则。 |
| Done Definition | macOS arm64/x64、Windows x64 的首发矩阵全部通过；OpenCode 回归通过；Token 过期/登出/组织切换、崩溃恢复、双写对账、MCP、Skills、单图/多图分析和升级场景通过；安全测试无高危问题；灰度指标与回滚演练完成后才允许全量。 |

**主要工作内容**：

- 建立 App Server schema、Adapter fixtures、Responses 网关和 Token 刷新的自动契约测试。
- 覆盖正常退出、强制退出、sidecar crash、SSE 断流、429/5xx、审批超时、重复/乱序事件和恢复。
- 覆盖多工作区并发、非 Git、只读目录、中文/空格/特殊字符路径以及 Windows UNC/长路径。
- 建立 OpenCode 会话、工作区列表、通知、归档、loading、附件和输入焦点的回归测试。
- 使用服务端/客户端功能开关按内部、少量组织、扩大灰度、全量四级推进，并定义自动暂停条件。

**风险/注意事项**：

- 不以“主流程可运行”替代安全、恢复和跨平台验收。
- 遥测只记录版本、耗时、状态和哈希标识，不记录 Prompt、模型正文、Token 或真实工作区路径。

---

## 四、依赖关系与执行顺序

```text
MOD-001 技术 Spike
  ├──▶ MOD-002 公共契约 ──▶ MOD-005 Runtime Adapter ──▶ MOD-006 双写恢复 ──▶ MOD-007 产品交互 ──┐
  │                              │                         │                                      │
  │                              └────────────────────────▶ MOD-008 MCP/Skills/图片 ──────────────┤
  │                                                                                               │
  └──▶ MOD-003 组织 Token/网关 ──▶ MOD-004 Sidecar/Broker ──▶ MOD-009 打包/安全 ──────────────────┤
                 │                       │                     │                                  │
                 └──────────────────────▶ MOD-008 ─────────────┴──────────────────────────────────┤
                                                                                                  ▼
                                                                                      MOD-010 集成与发布
```

**关键路径**：

```text
MOD-001 → MOD-003 → MOD-004 → MOD-005 → MOD-006 → MOD-007 → MOD-010
```

**建议执行波次**：

| 波次 | 可执行模块 | 说明 |
| --- | --- | --- |
| Wave 0 | MOD-001 | 单独完成技术去风险；未通过则回到架构评审。 |
| Wave 1 | MOD-002、MOD-003 | 协议/数据契约与服务端认证可并行。 |
| Wave 2 | MOD-004；随后 MOD-005 | Sidecar/Broker 依赖网关契约，Adapter 依赖公共契约与 App Server。 |
| Wave 3 | MOD-006、MOD-008、MOD-009 | 双写、首版能力、打包基础设施在核心 Adapter 稳定后并行。 |
| Wave 4 | MOD-007 | 基于稳定数据与运行时接口完成产品交互，避免 UI 反复返工。 |
| Wave 5 | MOD-010 | 汇总全部模块，完成灰度和发布验收。 |

---

## 五、里程碑与退出标准

| 里程碑 | 完成标志 | 解锁内容 |
| --- | --- | --- |
| M0：技术可行性门禁 | MOD-001 DONE；固定 Codex 版本/schema；macOS arm64 与 Windows x64 完成文本、工具、图片、Token 刷新验证；Go/No-Go 已签字 | 正式架构改造 |
| M1：核心契约就绪 | MOD-002、MOD-003 DONE；Runtime/事件/会话/附件/错误/Token/模型目录契约冻结 | Desktop Main 与 Adapter 集成 |
| M2：双运行时骨架就绪 | MOD-004、MOD-005 DONE；OpenCode/Codex 统一链路跑通；Renderer 不再依赖具体运行时协议 | 会话数据与首版能力并行开发 |
| M3：首版功能完整 | MOD-006、MOD-007、MOD-008 DONE；本地 Codex 会话、双写恢复、MCP、Skills、图片分析主流程通过 | 跨平台候选版本 |
| M4：候选包就绪 | MOD-009 DONE；三个目标构建可安装、可升级、可诊断、无残留进程 | 全链路验收与灰度 |
| M5：发布门禁通过 | MOD-010 DONE；跨平台、安全、恢复、OpenCode 回归、灰度和回滚全部达标 | 首版全量发布 |

### M0 前必须冻结的接口参数

- [ ] Codex CLI 版本、目标资产名、SHA-256、App Server schema/version。
- [ ] 组织模型 Token 交换接口、claims、有效期、刷新与撤销语义。
- [ ] 网关 base URL、Responses/SSE、幂等键、模型目录和错误结构。
- [ ] 首发模型及其 tools、reasoning、单图/多图支持能力。
- [ ] 图片 MIME 白名单、单图大小、单次图片数量及受控临时文件保留策略。
- [ ] MCP 来源、凭据注入、网络/命令审批和组织隔离策略。
- [ ] 内置/工作区 Skills 的发现优先级、版本与信任策略。
- [ ] 会话事件账本 schema、幂等键、事务边界和旧数据迁移规则。
- [ ] 灰度开关、用量保护阈值、遥测字段和自动暂停条件。

---

## 六、首版验收矩阵

| 能力域 | 必须验证的行为 |
| --- | --- |
| 运行时 | 创建、恢复、归档、流式、reasoning、工具、命令、文件修改、审批、中断、崩溃恢复 |
| 运行时切换 | 空会话可切换；已开始会话切换必定新建会话；原会话不被改写 |
| 网关认证 | 登录即用、Token 自动刷新、401 边界、登出、切换组织、跨组织拒绝、Renderer 不可见 Token |
| 图片分析 | 上传/粘贴/拖入、单图、多图、UI 截图、报错截图、流程图、格式/大小/数量限制、无视觉模型阻止发送 |
| MCP | 发现、连接、工具调用、审批、超时、断连、凭据隔离、组织切换清理 |
| Skills | 内置 Skill、受信任工作区 Skill、版本快照、来源展示、不读取用户全局 Skill |
| 历史 | 逐事件落盘、去重、乱序、异常退出对账、Codex thread 丢失重建、归档恢复、附件引用 |
| 平台 | macOS arm64/x64、Windows x64；签名、安装、升级、卸载、空格/中文/特殊路径、无残留进程 |
| 兼容性 | 所有现有 OpenCode 核心会话和工作区交互回归通过 |
| 安全 | workspace-write、按需审批、路径校验、IPC allowlist、日志脱敏、本地 Broker 隔离、无全局 Codex 污染 |

---

## 七、风险与阻塞项

| # | 风险描述 | 影响模块 | 处理建议 |
| --- | --- | --- | --- |
| R1 | Codex App Server 协议仍可能变更 | MOD-001、MOD-004、MOD-005 | 固定版本与 schema，契约测试；升级单独评审，不使用浮动 latest。 |
| R2 | 网关宣称支持 Responses，但与锁定版 Codex 的工具、reasoning、图片细节存在偏差 | MOD-001、MOD-003、MOD-008 | 使用真实 Codex 端到端测试，不只做独立 HTTP mock。 |
| R3 | 组织 Token 交换接口当前尚未在仓库中体现 | MOD-003、MOD-004 | 在 M1 前完成服务端接口；不得用主登录 Token 或固定子进程 Token 临时代替正式方案。 |
| R4 | 当前会话链路与 OpenCode SDK 耦合较深 | MOD-002、MOD-005、MOD-007 | 先完成 OpenCode Adapter 兼容层，再接 Codex，不在 UI Store 中堆叠双分支。 |
| R5 | 双写时发生事件已展示但未落盘、重复或乱序 | MOD-006 | 权威账本逐事件幂等落盘、持久化状态、重放和启动对账。 |
| R6 | 图片请求可发送但模型实际识别效果不达标 | MOD-001、MOD-008、MOD-010 | 用首发候选模型建立语义验收样本，不仅检查 HTTP 200。 |
| R7 | MCP/Skills 扩大命令、网络和凭据攻击面 | MOD-008、MOD-010 | 工作区信任、统一审批、组织隔离、来源与版本记录、安全测试。 |
| R8 | Windows 遗留进程或 macOS 嵌套签名失败 | MOD-009、MOD-010 | Windows 进程树回收与升级演练；macOS 实机 notarization/Gatekeeper 验证。 |
| R9 | Codex 增加安装包体积 | MOD-009 | 每个平台只打入目标架构资产；M4 记录实际压缩/安装体积并评估分发影响。 |
| R10 | 免费能力被滥用或成本失控 | MOD-003、MOD-010 | 服务端并发、速率、滚动用量、异常检测和可调灰度开关。 |

当前产品范围没有未关闭的产品决策。上表中的 Token 接口、图片限制、版本/hash 等属于实施前需要冻结的技术参数，不改变已确认的产品方向。

---

## 八、计划确认后的下一步

1. 对本计划做产品、Desktop、Server/Gateway 和安全联合评审。
2. 冻结 M0 所列接口参数，并将架构文档状态从“探索稿”更新为“已批准实施”。
3. 将 MOD-001 至 MOD-010 按依赖关系拆成 AI Agent 可执行任务和验收用例。
4. 只启动 MOD-001 技术 Spike；通过 M0 后再进入正式代码改造。

在用户明确确认本计划前，不开始上述实施工作。
