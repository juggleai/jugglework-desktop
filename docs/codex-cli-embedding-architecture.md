# Codex CLI 嵌入 JuggleWork Desktop 架构方案

> 状态：架构探索稿，供评审，不代表已进入实施  
> 日期：2026-08-12  
> 目标平台：macOS arm64/x64、Windows x64；Windows arm64 作为后续目标

## 已确认产品决策

| 事项 | 已确认结果 |
| --- | --- |
| 首发工作区范围 | 仅本地工作区 |
| 已开始会话切换运行时 | 接受切换即新建会话 |
| 自有网关协议 | 已完整支持 Responses API |
| 用户认证 | 使用组织 Token；登录 JuggleWork 后即可使用，不要求 Codex 登录或个人 API Key |
| 产品权益 | 默认提供，免费能力 |
| 用户自装 Codex CLI | 不支持，不保留高级自定义路径 |
| 首版能力 | 必须支持 MCP、Skills 和图片 |
| 会话历史 | JuggleWork 与 Codex 双写，以 JuggleWork 为主数据源 |

## 1. 背景与目标

JuggleWork Desktop 当前以 OpenCode 作为本地工作区的智能体运行时。计划在现有产品中同时嵌入 Codex CLI，让用户可以在工作区会话输入框下方的智能体位置切换运行时，并让 Codex 通过 JuggleWork 自有大模型网关访问模型。

本方案需要满足以下目标：

- 保留现有 OpenCode 会话能力，同时增加 Codex 会话。
- 在输入框下方提供清晰的智能体切换入口。
- 支持流式回复、工具调用、命令执行、文件修改、审批、中断和会话恢复。
- 支持自有大模型网关，不把网关密钥暴露给 Renderer。
- 支持 macOS 和 Windows 的安装、签名、升级和进程回收。
- 为未来的远端工作区、更多智能体运行时预留扩展能力。

## 2. 结论摘要

推荐采用：

**Codex 原生 sidecar + Codex App Server + JuggleWork Runtime Adapter。**

不建议将 Codex TUI 嵌入界面，也不建议解析终端 ANSI 文本。`codex exec --json` 可以作为技术验证或降级通道，但正式交互应优先使用长驻的 `codex app-server --stdio`。

整体结构：

```text
┌──────────────────────────────────────────────────────────────┐
│                       React Renderer                         │
│                                                              │
│  Workspace / Session / Composer / Message Timeline / Approval│
└──────────────────────────────┬───────────────────────────────┘
                               │ Backend-neutral IPC / API
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                    Agent Runtime Service                     │
│                                                              │
│  Session ownership / event normalization / policy / logging  │
└───────────────────┬──────────────────────────┬───────────────┘
                    │                          │
                    ▼                          ▼
       ┌─────────────────────┐    ┌──────────────────────────┐
       │ OpenCode Adapter    │    │ Codex Adapter            │
       │ HTTP + SSE          │    │ App Server JSON-RPC      │
       └──────────┬──────────┘    └────────────┬─────────────┘
                  │                            │ stdio
                  ▼                            ▼
       ┌─────────────────────┐    ┌──────────────────────────┐
       │ OpenCode sidecar    │    │ Codex native sidecar     │
       └─────────────────────┘    └────────────┬─────────────┘
                                               │ Responses API
                                               ▼
                                  ┌──────────────────────────┐
                                  │ JuggleWork Model Gateway │
                                  └──────────────────────────┘
```

关键原则：

1. UI 不直接依赖 OpenCode 或 Codex 的协议类型。
2. 每个会话创建后绑定一个运行时，不在原会话中热切换引擎。
3. Codex 使用应用独立的 `CODEX_HOME`，不修改用户的 `~/.codex`。
4. 网关密钥只存在于主进程安全存储和子进程环境变量中。
5. 固定 Codex CLI 版本，并把 App Server 协议变化隔离在 Adapter 内。

## 3. 当前项目可复用能力

项目已经具备以下基础设施：

### 3.1 Sidecar 构建与打包

- `apps/desktop/scripts/prepare-sidecar.mjs`
  - 已支持按 target triple 下载 OpenCode。
  - 已有版本固定、资产选择、SHA-256 校验和 macOS sidecar 签名模式。
- `apps/desktop/electron-builder.yml`
  - 已按 macOS/Windows 架构将 sidecar 放入 `extraResources/sidecars`。
- `apps/desktop/electron/runtime.mjs`
  - 已有二进制查找、环境变量构建、进程启动、健康检查、日志截断和退出回收。

Codex 可以沿用相同模式，但应创建独立的 `CodexProcessManager`，避免继续扩大 OpenCode 专属的 runtime manager。

### 3.2 Composer 智能体与模型入口

`apps/app/src/react-app/domains/session/surface/composer/composer.tsx` 已包含：

- 默认智能体选择器。
- OpenCode 自定义 Agent 列表。
- 模型选择器。
- 推理/模型行为选择器。
- Busy、Steer、Stop、附件、命令和技能等状态。

因此 UI 入口不需要重新设计一整套 Composer，主要是明确“运行时”和“运行时内部 Agent”的关系。

### 3.3 当前主要耦合点

当前会话链路直接使用 OpenCode SDK：

- `session.create`
- `session.promptAsync`
- `event.subscribe`
- OpenCode session/message/part 类型
- OpenCode provider/model catalog

相关逻辑主要分布在：

- `apps/app/src/react-app/shell/session-route.tsx`
- `apps/app/src/react-app/domains/session/sync/actions-store.ts`
- `apps/app/src/react-app/domains/session/sync/session-sync.ts`
- `apps/app/src/react-app/domains/session/sync/usechat-adapter.ts`

这部分是双引擎改造的核心，工作量大于 sidecar 打包本身。

## 4. Runtime Adapter 设计

### 4.1 统一接口

建议定义后端无关的运行时接口：

```ts
type RuntimeKind = "opencode" | "codex";

interface AgentRuntime {
  readonly kind: RuntimeKind;

  startWorkspace(input: StartWorkspaceInput): Promise<RuntimeWorkspace>;
  stopWorkspace(workspaceId: string): Promise<void>;

  createThread(input: CreateThreadInput): Promise<RuntimeThread>;
  resumeThread(input: ResumeThreadInput): Promise<RuntimeThread>;
  archiveThread(threadId: string): Promise<void>;

  sendTurn(input: SendTurnInput): Promise<void>;
  steerTurn(input: SteerTurnInput): Promise<void>;
  interruptTurn(input: InterruptTurnInput): Promise<void>;
  respondToApproval(input: ApprovalDecisionInput): Promise<void>;

  subscribe(listener: (event: RuntimeEvent) => void): () => void;
}
```

接口不应该泄漏 `opencodeClient`、Codex JSON-RPC method 或任一后端的原始 message part。

### 4.2 统一事件模型

建议先覆盖产品当前真正需要的事件：

```ts
type RuntimeEvent =
  | { type: "thread.created"; thread: RuntimeThread }
  | { type: "thread.updated"; threadId: string; patch: RuntimeThreadPatch }
  | { type: "turn.started"; threadId: string; turnId: string }
  | { type: "user.message"; threadId: string; turnId: string; content: ContentPart[] }
  | { type: "assistant.delta"; threadId: string; turnId: string; text: string }
  | { type: "reasoning.delta"; threadId: string; turnId: string; text: string }
  | { type: "command.started"; threadId: string; turnId: string; command: CommandInfo }
  | { type: "command.output"; threadId: string; turnId: string; chunk: string }
  | { type: "command.completed"; threadId: string; turnId: string; result: CommandResult }
  | { type: "file.changed"; threadId: string; turnId: string; change: FileChange }
  | { type: "approval.requested"; threadId: string; request: ApprovalRequest }
  | { type: "usage.updated"; threadId: string; turnId: string; usage: UsageInfo }
  | { type: "turn.completed"; threadId: string; turnId: string }
  | { type: "turn.failed"; threadId: string; turnId: string; error: RuntimeError };
```

OpenCode Adapter 和 Codex Adapter 各自负责：

- 原始事件映射。
- 去重和乱序修正。
- 流式 delta 合并。
- 后端错误标准化。
- 后端特有字段放入受控的 `metadata`，不能让 UI 依赖它们。

### 4.3 能力协商

不同运行时的能力不完全一致。建议运行时启动后返回能力集：

```ts
type RuntimeCapabilities = {
  steering: boolean;
  approvals: boolean;
  images: boolean;
  reasoningStream: boolean;
  mcp: boolean;
  skills: boolean;
  planMode: boolean;
  reviewMode: boolean;
  sessionFork: boolean;
};
```

Composer 根据能力显示功能，避免硬编码 `engine === "codex"`。

## 5. 会话模型

### 5.1 使用应用自己的 Session ID

目前会话身份高度依赖 OpenCode session ID。双引擎后建议由 JuggleWork 生成稳定的内部 ID，并保存后端映射：

```ts
type RuntimeSessionRecord = {
  id: string;                       // JuggleWork session ID
  orgId: string;                    // 认证与数据隔离边界
  workspaceId: string;
  runtimeKind: "opencode" | "codex";
  backendThreadId: string | null;   // OpenCode session ID 或 Codex thread ID
  agentProfileId: string | null;
  modelProviderId: string;
  modelId: string;
  reasoningEffort: string | null;
  cwd: string;
  configSnapshot: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
};
```

### 5.2 切换规则

不建议一个已开始的会话在 OpenCode 和 Codex 之间直接切换。

- 空会话：允许自由切换。
- 首次发送后：锁定 `runtimeKind`。
- 用户尝试切换：提供“使用 Codex 新建会话”或“使用 OpenCode 新建会话”。
- 可选增强：把当前上下文生成摘要，作为新运行时会话的首条上下文，但不伪造原始历史。

原因：

- 两边的系统提示、工具状态、MCP 状态不同。
- OpenCode session ID 与 Codex thread ID 不可互换。
- 直接复制完整历史容易丢失 tool call/tool result 对应关系。
- 审批、sandbox 和压缩后的上下文不可可靠迁移。

### 5.3 默认值层级

建议优先级：

```text
会话快照 > 工作区默认 > 应用全局默认
```

工作区可配置默认运行时，但已创建会话始终使用自己的快照，避免设置变化影响历史会话。

### 5.4 历史双写与恢复原则

已确认采用双写，并以 JuggleWork 为权威数据源：

```text
Codex App Server events
          │
          ▼
Codex Adapter 标准化、排序、去重
          │
          ├──▶ JuggleWork 会话事件账本（权威）
          │
          └──▶ Codex thread 本地状态（运行时副本）
```

- JuggleWork 保存标准化后的用户消息、助手消息、tool call/result、审批、文件变化摘要、turn 状态和 usage；Codex 自身保存 thread，供正常续跑。
- 每个后端事件使用 `runtimeKind + backendThreadId + backendEventId` 作为幂等键；没有稳定后端事件 ID 时，由 Adapter 生成并持久化映射。
- UI、搜索、归档、同步和审计只读取 JuggleWork 历史，不能把 Codex 本地 thread 当作展示主数据源。
- `backendThreadId` 是续跑指针，不是应用会话主键；所有记录同时绑定 `orgId`、`workspaceId` 和 `runtimeKind`。
- 应用异常退出后，先用 JuggleWork 账本校验最后一个 turn，再与 Codex thread 对账；重复事件丢弃，缺失的终态按恢复协议补写。
- Codex thread 丢失、损坏或版本不兼容时，以 JuggleWork 的规范历史/上下文摘要创建新的 Codex thread，并更新映射；不能反向用残缺的 Codex 状态覆盖 JuggleWork 历史。
- 为避免“模型已响应但主库未落盘”的窗口，事件账本必须逐事件幂等落盘；前端收到事件不代表已经持久化成功，Adapter 应报告持久化状态并支持重放。

## 6. Composer 交互方案

### 6.1 推荐展示

输入框下方保持当前布局：

```text
[ JuggleWork Agent ▾ ] [ provider/model ▾ ] [ 推理强度 ▾ ]
```

运行时选择菜单可以分区：

```text
智能体运行时
✓ JuggleWork Agent
  Codex

OpenCode 智能体
  Build
  Plan
  自定义 Agent A
```

选择 Codex 后：

```text
[ Codex ▾ ] [ gateway/coding-model ▾ ] [ High ▾ ]
```

### 6.2 运行时与 Agent 概念

内部应区分：

- Runtime：OpenCode、Codex。
- Agent Profile：OpenCode Build/Plan、自定义 Agent，或未来 Codex profile。
- Model：具体 Provider/Model。

产品 UI 可以继续使用“智能体”这个用户容易理解的名称，但数据层不能把三者混为一个字段。

### 6.3 会话锁定提示

已开始会话中可以继续显示当前运行时，但切换时应提示：

> 当前会话由 JuggleWork Agent 创建。切换到 Codex 将创建一个新会话。

操作：

- 取消
- 使用 Codex 新建会话
- 使用当前上下文新建会话（后续能力）

## 7. Codex 进程集成

### 7.1 为什么使用 App Server

正式产品建议运行：

```text
codex app-server --stdio
```

优势：

- 长驻进程，适合多轮会话。
- 结构化协议，不需要解析 TUI。
- 可以承载流式事件、审批、中断和线程恢复。
- stdio 不占用端口，不触发 Windows 防火墙提示。
- 子进程生命周期可以由 Electron Main 管理。

当前 Codex CLI 将 App Server 标为 experimental。因此必须：

- 固定 Codex CLI 版本。
- 构建时生成 JSON Schema 或 TypeScript bindings。
- 在 Adapter 中做协议版本检查。
- 未知事件记录但不导致 Renderer 崩溃。
- 保留 `codex exec --json` 作为有限降级方案。

具体方法名和字段必须以项目锁定版本生成的 App Server schema 为准，不应从文档示例手写长期类型。

### 7.2 进程归属

建议由 Electron Main 托管：

```text
Renderer
   │ typed IPC
   ▼
Electron Main
   ├── CodexProcessManager
   ├── AppServerRpcClient
   ├── RuntimeEventNormalizer
   ├── ApprovalRouter
   └── CredentialProvider
           │ stdio
           ▼
      Codex sidecar
```

Renderer 不能直接 spawn 进程，也不能拿到网关密钥。

### 7.3 进程粒度

第一版推荐“每个活跃工作区一个 Codex App Server”：

- 首个 Codex 会话创建时懒启动。
- 同一工作区的多个 Codex 会话共享进程。
- 工作区任务运行时保持进程存活。
- 长时间无会话活动后可空闲退出。
- 应用退出时统一停止进程树。

优点是 cwd、配置、日志和故障隔离清晰。以后确认 App Server 的多工作区隔离足够稳定后，可以优化为一个全局进程。

### 7.4 独立 CODEX_HOME

建议路径：

```text
<Electron userData>/codex/
  config.toml
  profiles/
  sessions/
  logs/
```

启动时设置：

```text
CODEX_HOME=<Electron userData>/codex
```

不要修改用户的：

```text
~/.codex/config.toml
~/.codex/auth.json
```

这样可以避免：

- 污染用户独立安装的 Codex CLI。
- 用户配置导致产品行为不可复现。
- 用户升级 CLI 后破坏内置协议。
- 产品卸载时误删用户个人会话。

### 7.5 首版 MCP、Skills 与图片

这三项已进入首版范围，需要作为运行时能力而不是 UI 附件实现：

**MCP**

- JuggleWork 管理内置和用户启用的 MCP 清单，再为隔离的 `CODEX_HOME` 生成锁定版本可识别的配置。
- MCP 凭据由 Main 进程安全存储和注入，不能写入会话历史、普通配置或发送给 Renderer。
- 启动 MCP 前校验工作区信任状态；网络、命令和额外目录权限继续走统一审批模型。
- 配置按 `orgId + workspaceId` 隔离，切换组织后不得沿用旧组织的 MCP 凭据或连接。

**Skills**

- 应用内置 Skills 随版本发布并带版本清单；工作区 Skills 可由 Codex 从项目内发现，但必须显示来源并受工作区信任策略约束。
- 隔离 `CODEX_HOME` 意味着不自动读取用户全局 `~/.codex/skills`，这与“不支持用户自装 Codex 路径”的产品决策一致。
- 会话快照记录已启用 Skill 的标识、来源和版本，便于历史恢复与问题诊断。

**图片**

- Renderer 只把附件引用交给 Main；Main 校验 MIME、大小、文件存在性以及路径是否位于当前工作区或应用受控临时目录。
- Adapter 按锁定版 App Server schema 构造图片输入，不在 IPC、日志和会话事件中复制 base64 正文。
- JuggleWork 权威历史保存附件元数据和受控对象引用；Codex thread 仅保存运行所需副本。组织切换或权限撤销后必须重新鉴权附件访问。

## 8. 自有大模型网关

### 8.1 配置方向

应用生成的 Codex 配置可采用自定义 model provider。示意：

```toml
model = "jugglework-coding-model"
model_provider = "jugglework-gateway"

[model_providers.jugglework-gateway]
name = "JuggleWork Gateway"
base_url = "https://gateway.example.com/v1"
env_key = "JUGGLEWORK_CODEX_API_KEY"
wire_api = "responses"
requires_openai_auth = false
```

字段需要在锁定的 Codex CLI 版本上通过 `--strict-config` 验证。不要把 API Key 写入 TOML。

### 8.2 网关协议要求

自有网关已确认完整支持 OpenAI Responses API。Desktop 与 Codex 集成仍需用契约测试验证以下能力：

- `/responses` 请求结构。
- SSE 流式输出。
- tool call 与 tool output 的多轮关联。
- reasoning 相关数据的透传或兼容处理。
- usage 与 finish 状态。
- 客户端中断。
- 图片输入，包括支持的 MIME、大小限制和多图请求。
- 稳定、可解析的错误结构。
- 长时间工具执行时的连接保活。

Desktop 不维护 Chat Completions 到 Responses 的转换逻辑，所有请求统一走网关的 Responses API。

### 8.3 模型目录

建议由 JuggleWork 服务端提供模型目录：

```ts
type CodexGatewayModel = {
  id: string;
  displayName: string;
  contextWindow: number | null;
  reasoningEfforts: string[];
  supportsImages: boolean;
  supportsTools: boolean;
  enabled: boolean;
};
```

Desktop 模型选择器读取该目录，选择结果保存到会话快照，再传给 Codex。不要依赖 Codex 自动展示网关中的所有模型。

### 8.4 认证目标：登录 JuggleWork 即可使用

已确认不要求用户：

- 再执行一次 Codex/OpenAI 登录。
- 配置个人 OpenAI API Key。
- 接触或复制组织 Token。
- 安装用户自己的 Codex CLI。

用户体验应为：

```text
用户登录 JuggleWork
        │
        ├── 已加入有效组织 ──▶ Codex 自动可用
        │
        └── 登录态失效 ──────▶ Codex 停止并提示重新登录 JuggleWork
```

### 8.5 为什么不能只把短期组织 Token 注入 Codex 环境变量

Codex 自定义 Provider 可以从环境变量读取凭证，但 App Server 是长驻进程：

```text
spawn Codex
   │
   └── env.JUGGLEWORK_CODEX_API_KEY = token-A

20 分钟后 token-A 过期
   │
   └── Electron 获取 token-B，也无法修改已运行子进程的环境
```

如果每次 Token 刷新都重启 App Server，会带来：

- 正在运行的长任务中断。
- thread 恢复和事件订阅出现竞态。
- MCP 连接需要重建。
- 多会话同时运行时很难找到安全重启窗口。

因此，直接把组织短期 Token 作为 Codex Provider 的固定环境变量只适合早期 Spike，不适合作为正式架构。

### 8.6 推荐方案：本地 Credential Broker

由 Electron Main 启动一个仅监听 loopback 的轻量本地代理。Codex 只持有本地进程凭证，真实组织 Token 由代理按请求动态注入并自动刷新。

```text
┌──────────────────────┐
│ JuggleWork 登录会话  │
└──────────┬───────────┘
           │ 使用现有登录态换取短期模型访问 Token
           ▼
┌──────────────────────────────┐
│ Electron Main               │
│ Gateway Credential Broker   │
│                              │
│ - 内存保存组织 Token         │
│ - 到期前自动刷新             │
│ - 401 后单次刷新重试         │
│ - 注入 Authorization         │
│ - 日志脱敏                   │
└──────────┬───────────────────┘
           │ https + Responses API
           ▼
┌──────────────────────────────┐
│ JuggleWork Model Gateway     │
└──────────────────────────────┘

Codex App Server
       │ base_url=http://127.0.0.1:<random>/<nonce>/v1
       ▼
Gateway Credential Broker
```

Codex 配置示意：

```toml
model = "jugglework-coding-model"
model_provider = "jugglework-gateway"

[model_providers.jugglework-gateway]
name = "JuggleWork Gateway"
base_url = "http://127.0.0.1:39127/<random-session-path>/v1"
env_key = "JUGGLEWORK_CODEX_LOCAL_SECRET"
wire_api = "responses"
requires_openai_auth = false
```

`JUGGLEWORK_CODEX_LOCAL_SECRET` 不是组织 Token，只是当前 App Server 访问本地 Broker 的随机进程凭证。即使它随子进程环境固定，也不影响远端组织 Token 的轮换。

Broker 收到请求后：

1. 验证本地随机路径和 Bearer secret。
2. 删除本地 Authorization。
3. 获取当前有效的组织模型 Token。
4. 注入远端 Authorization。
5. 以流式方式转发请求和 SSE 响应，不缓存模型正文。
6. 遇到 401 时刷新一次 Token；只有在尚未向 Codex 返回任何响应字节、且网关支持幂等键时才自动重放，否则将失败交给上层，避免重复计费或重复执行。

### 8.7 组织 Token 设计要求

这里的“组织 Token”应是由 JuggleWork 登录态换取的、仅供模型网关使用的派生访问 Token，而不是把 JuggleWork 主登录 Token 原样转发给模型网关。对用户只有一次登录，但后台凭证应按 audience 和权限拆分：

```text
JuggleWork 登录凭据
      │ 服务端交换
      ▼
短期 Codex 网关 Token（仅 responses/models 权限）
```

如果当前后端所谓“组织 Token”就是 JuggleWork 主登录 Token，应在首发前增加这一层交换；否则模型网关泄漏会同时扩大到 JuggleWork 业务 API 权限。

建议由 JuggleWork 服务端提供专用 Token 交换接口，例如：

```text
POST /v1/codex/gateway-token
```

Token 至少应绑定：

- `sub`：当前成员。
- `org_id`：当前组织。
- `device_id`：当前桌面设备或安装实例。
- `aud`：JuggleWork Model Gateway。
- `scope`：例如 `responses:create`、`models:read`。
- `exp`：短有效期，建议 10–30 分钟。
- 可选模型、并发和速率限制声明。

免费能力不等于无限调用。服务端仍应提供：

- 每成员并发限制。
- 每组织速率限制。
- 每日或滚动窗口使用保护。
- 异常滥用检测。
- 可审计但不记录敏感 Prompt 正文的计量信息。

### 8.8 登录、登出和组织切换

登录完成：

1. 不立即启动 Codex，保持懒加载。
2. 用户第一次选择 Codex 时，用现有 JuggleWork 登录态换取组织模型 Token。
3. 启动 Broker 和当前工作区的 Codex App Server。
4. Token 获取失败时禁用发送，但不影响 OpenCode 会话。

登出：

1. 阻止新的 Codex turn。
2. 中断或结束正在运行的 Codex turn。
3. 停止所有 Codex App Server。
4. 停止 Broker 并清除内存 Token。
5. 保留非敏感的会话映射，重新登录后可以恢复。

切换组织：

1. 将其视为一次强制认证边界切换。
2. 停止旧组织的 Codex 进程和 Broker。
3. 清除旧组织 Token。
4. 使用新组织身份重新创建 Broker 和 App Server。
5. 会话记录必须携带 `orgId`，禁止用新组织凭证恢复旧组织会话。

### 8.9 安全要求

- Renderer 永远拿不到组织 Token 或本地 Broker secret。
- Broker 只绑定 `127.0.0.1`，不绑定 `0.0.0.0`。
- 每次应用启动生成随机端口、随机路径和高熵 secret。
- Broker 不启用 CORS，不接受浏览器 Origin 请求。
- 请求体和 SSE 正文不落盘、不进入普通日志。
- 日志清理 Authorization、API Key、Cookie 和 URL 随机路径。
- 组织 Token 优先只保存在内存；通常只持久化现有 JuggleWork 登录所需的可刷新凭据。确需保存模型 Token 时，使用 macOS Keychain、Windows Credential Manager 或 Electron `safeStorage`。
- 企业代理和自签 CA 沿用当前系统 CA 导出机制；真正访问远端网关的是 Broker，因此证书和代理兼容可以在 Electron Main 统一控制，不依赖 Codex 原生网络栈。

## 9. 权限与审批

默认策略建议：

```text
sandbox: workspace-write
approval: on-request
```

禁止产品默认启用：

```text
danger-full-access
dangerously-bypass-approvals-and-sandbox
```

审批链路：

```text
Codex approval request
          │
          ▼
Codex Adapter 标准化
          │
          ▼
JuggleWork Approval DTO
          │
          ▼
会话内确认卡片
          │
          ├── Approve once
          ├── Approve scoped rule
          └── Deny
```

Desktop 还应在运行时边界做二次校验：

- thread cwd 必须属于目标工作区。
- 额外可写目录必须来自用户明确授权。
- 禁止未解析的环境变量或宽泛根目录成为删除目标。
- Windows 驱动器、UNC 路径、符号链接和 junction 必须纳入路径校验。
- 审批决定按 `workspaceId + threadId + requestId` 绑定，防止跨会话串线。

## 10. macOS 与 Windows 打包

### 10.1 目标二进制

建议第一期：

```text
codex-aarch64-apple-darwin
codex-x86_64-apple-darwin
codex-x86_64-pc-windows-msvc.exe
```

Windows arm64 在官方资产、依赖和 CI 验证稳定后加入。

### 10.2 构建流程

复用 `prepare-sidecar.mjs` 的模式：

1. 从统一常量文件读取固定 Codex 版本。
2. 根据 target triple 解析资产名称。
3. 下载到临时目录。
4. 校验 SHA-256。
5. 验证 `codex --version`。
6. 验证 `codex app-server --help`。
7. 生成并保存 App Server schema/types。
8. 复制到 `resources/sidecars`。
9. 生成 `versions.json`，记录版本、target、hash 和协议 schema 版本。

### 10.3 macOS

- sidecar 必须在外层 App 签名前完成 codesign。
- 使用与主应用一致的 Team ID。
- 验证 hardened runtime 和 notarization。
- 在 arm64 与 Intel 实机验证，不只依赖 Rosetta。
- 验证从 DMG 安装后 sidecar 不触发 Gatekeeper 拒绝。

### 10.4 Windows

- `spawn` 必须使用 `shell: false` 和 `windowsHide: true`。
- 不拼接命令字符串，参数始终使用数组。
- 使用 Job Object 或等效机制终止完整进程树。
- 对嵌套 Codex `.exe` 做 Authenticode 签名验证。
- 测试安装路径和工作区路径包含空格、中文、括号、`&`。
- 测试长路径、不同盘符和 UNC 路径。
- 确保升级安装不会因为存活的 sidecar 导致 `EBUSY`。

## 11. 错误与可观测性

### 11.1 统一错误

```ts
type RuntimeErrorCode =
  | "runtime_not_installed"
  | "runtime_start_failed"
  | "runtime_protocol_mismatch"
  | "gateway_auth_failed"
  | "gateway_unavailable"
  | "model_not_found"
  | "workspace_access_denied"
  | "approval_expired"
  | "turn_interrupted"
  | "runtime_crashed"
  | "unknown";
```

UI 不直接展示 Codex stderr 原文；应显示标准文案并提供可复制的脱敏诊断信息。

### 11.2 诊断字段

- app version
- Codex CLI version
- App Server protocol/schema version
- platform/arch
- runtime kind
- workspace ID 哈希，不记录真实路径
- backend thread ID 哈希
- gateway origin，不记录 path/query/token
- turn duration
- first-token latency
- tool count
- exit code/signal
- redacted stderr tail

### 11.3 健康检查

建议提供“设置 → 调试 → Codex 运行时诊断”：

- 二进制是否存在。
- 版本是否匹配。
- App Server 能否启动和握手。
- 网关 DNS/TLS 是否可达。
- token 是否有效。
- 模型是否存在。
- sandbox 是否可用。
- 工作区是否可读写。

## 12. 远端工作区边界

首发已明确只支持本地工作区。

远端工作区的文件系统在远端机器上，本机 Codex sidecar 不能安全、完整地操作远端目录。正确结构应是：

```text
Desktop Renderer
      │
      ▼
JuggleWork Remote Protocol
      │
      ▼
Remote Worker
      │
      ▼
Codex App Server + workspace filesystem
```

未来可以复用同一 Runtime Event 协议，让本地 Adapter 和远端 Adapter 对 Renderer 表现一致。

## 13. 分阶段计划

### Phase 0：技术 Spike

目标是验证关键不确定性，不修改正式会话架构。

- 固定一个 Codex CLI 版本。
- 从 Electron Main 启动 `codex app-server --stdio`。
- 完成初始化、创建线程、发送一轮消息、流式输出和中断。
- 使用测试网关验证 Responses API。
- 验证 macOS arm64 和 Windows x64。
- 导出协议 schema，记录版本差异风险。

退出条件：

- 两个平台可以稳定完成 20 次连续会话。
- 进程退出无残留。
- 网关鉴权和 token 刷新可用。
- 事件足以映射到现有 UI。

### Phase 1：Runtime 抽象

- 建立 `AgentRuntime`、统一事件和统一错误。
- 用 OpenCode Adapter 包装现有逻辑，保持行为不变。
- 增加 Codex Adapter。
- 为所有映射增加 fixture 和契约测试。

退出条件：

- Renderer 会话组件不再直接依赖 OpenCode SDK 类型。
- 现有 OpenCode 回归测试通过。

### Phase 2：会话与 Composer

- 会话记录增加 `orgId`、`runtimeKind` 和 `backendThreadId`。
- 智能体入口支持 JuggleWork Agent/Codex。
- 新会话绑定运行时。
- 已开始会话切换运行时创建新会话，不迁移原 thread。
- 支持模型和推理强度。
- 支持流式文本、工具、文件变化、审批、中断。
- 建立 JuggleWork 权威事件账本以及与 Codex thread 的幂等双写、对账和恢复。

### Phase 3：打包与安全

- sidecar 下载、校验和版本清单。
- macOS 签名和 notarization。
- Windows 签名、Job Object、升级占用处理。
- 实现 Credential Broker、组织短期 Token 自动刷新、登出/组织切换清理和日志脱敏。
- 企业代理和 CA 验证。
- 完成首版 MCP、Skills、图片输入及其权限边界和跨平台契约测试。

### Phase 4：首发后的增强能力

- 会话 fork 和更高级的跨会话恢复工具。
- Plan/Review 等非首发模式。
- 上下文迁移。
- 远端工作区。

## 14. 测试矩阵

### 协议测试

- App Server 初始化成功/失败。
- 未知 method/event 的向前兼容。
- delta 乱序、重复、断流和重连。
- approval 超时、拒绝和重复回应。
- turn 中断时最终状态一致。
- sidecar crash 后会话状态恢复。

### 网关测试

- 正常流式 Responses。
- 401/403、429、5xx。
- SSE 中途断开。
- 超长工具调用。
- 模型不存在。
- token 过期与刷新。
- 登录态失效、登出和组织切换时立即撤销访问。
- 401 在可安全重放/不可安全重放两种情况下的行为。
- reasoning/tool call 兼容。
- 图片输入、多图和不支持的 MIME。

### 首版能力契约测试

- MCP server 的启停、审批、超时、断连和配置隔离。
- 内置 Skills 的发现、调用、版本锁定和升级兼容。
- 图片只允许来自当前工作区或应用受控临时目录，且不会泄漏跨组织文件。
- 隔离的 `CODEX_HOME` 不读取或修改用户全局 Codex 配置、凭据、MCP 和 Skills。

### 跨平台测试

- macOS arm64/x64。
- Windows x64。
- 路径含空格、中文和特殊字符。
- 非 Git 工作区。
- 只读目录。
- 多工作区并发运行。
- 应用正常退出、强制退出、升级安装。

### 产品回归

- OpenCode 现有会话行为不变。
- 工作区内新建、删除、归档、恢复会话。
- 选中会话与工作区状态。
- 后台运行和 loading 状态。
- 通知与错误提示。

## 15. 主要风险

| 风险 | 影响 | 应对策略 |
| --- | --- | --- |
| App Server 仍是 experimental | 协议升级可能破坏兼容 | 固定版本、生成 schema、Adapter 隔离、契约测试 |
| 当前 UI/Store 与 OpenCode 类型耦合 | 双引擎改造范围扩大 | 先抽象 Runtime，不直接在组件中增加 Codex 分支 |
| 网关 Responses 实现与锁定版 Codex 存在契约偏差 | 工具、推理或流式事件异常 | 固定 Codex 版本，对 Responses、SSE、工具、reasoning、图片做端到端契约测试 |
| 会话热切换造成上下文损坏 | 历史和工具状态不一致 | 会话创建后锁定运行时，切换即新建会话 |
| Windows 遗留进程 | 升级失败、资源占用 | Job Object、退出回收、升级前检测 |
| macOS sidecar 未正确签名 | Gatekeeper/Notarization 失败 | 嵌套签名和安装后实机验证 |
| 组织 Token 过期、泄漏或跨组织复用 | 任务中断或严重越权 | Main-only Credential Broker、短期凭证、自动刷新、组织强绑定、统一脱敏 |
| 双写事件不一致 | 历史丢失、重复或无法恢复 | JuggleWork 权威事件账本、幂等键、逐事件落盘、启动对账 |
| 远端工作区误用本地 Codex | 文件访问不完整或不安全 | 首发明确仅本地；远端未来在 Worker 运行 sidecar |

## 16. 已确认的首版范围

首版只承诺：

- 本地工作区。
- JuggleWork Agent/Codex 两种运行时。
- 新会话选择运行时；已开始会话切换运行时等于新建会话。
- 登录 JuggleWork 后自动使用当前组织的短期 Token，不要求 Codex 登录或个人 API Key。
- 自有网关的 Responses-compatible Provider，并由本地 Credential Broker 自动刷新凭证。
- 文本输入、流式回复、命令、文件修改、审批、停止。
- MCP、Skills 和图片输入。
- 会话恢复和归档；JuggleWork/Codex 双写，以 JuggleWork 为权威。
- Codex 为默认支持的免费能力，但服务端保留合理的并发、速率和滥用保护。
- macOS arm64/x64、Windows x64。

首版暂不承诺：

- 已有 OpenCode 会话原地切换 Codex。
- 远端工作区 Codex。
- 用户自行安装任意 Codex CLI 版本。
- ChatGPT 账号登录与自有网关混合认证。
- 所有 Codex 实验功能。
- Windows arm64。

## 17. 决策带来的实现约束

1. Renderer 不能出现 API Key 配置入口，组织 Token 和本地 Broker secret 也不能经 IPC 返回 Renderer。
2. Codex 必须使用应用内置、固定版本的 sidecar 和隔离的 `CODEX_HOME`，不能发现或调用 PATH 中用户自己的 Codex。
3. 所有 Codex 会话必须绑定 `orgId`；登出或切换组织是强制进程与凭证边界。
4. MCP、Skills、图片不是后续增强项，必须进入首发验收矩阵、权限模型和跨平台测试。
5. JuggleWork 会话事件账本是唯一权威历史；Codex thread 只能作为运行时续跑副本。
6. 免费能力仍需服务端配额保护和可观测性，但产品界面不应要求用户购买或配置独立密钥。

## 18. 推荐下一步

先做一个独立的 Codex App Server spike，验证以下三件事：

1. 锁定版本的协议能否完整覆盖当前会话 UI。
2. 自有网关对 Responses API、工具调用、图片和流式事件的端到端兼容程度。
3. macOS/Windows 的 sidecar 签名、启动和进程回收是否稳定。

Spike 还必须验证 Credential Broker 在 Token 到期、401、登出和组织切换时的行为。认证链路通过前，不应把“登录即用”视为已经完成。

验证后再创建正式变更提案，并优先实施 Runtime Adapter。不要先把 Codex 分支直接写进现有 OpenCode Session Store，否则短期能跑起来，长期会在会话恢复、审批和消息渲染处形成大量双分支。

## 19. 参考资料

- [OpenAI Codex App Server](https://developers.openai.com/codex/app-server)
- [OpenAI Codex Configuration Reference](https://developers.openai.com/codex/config-reference)
- [OpenAI Codex Non-interactive Mode](https://developers.openai.com/codex/noninteractive)
