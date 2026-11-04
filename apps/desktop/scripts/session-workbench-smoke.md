# 会话工作台隔离 Electron smoke

安装工作区依赖后，在仓库根目录执行：

```sh
apps/desktop/node_modules/.bin/electron apps/desktop/scripts/session-workbench-smoke.mjs
```

pnpm 可用时的等价命令：

```sh
pnpm --dir apps/desktop exec electron scripts/session-workbench-smoke.mjs
```

负控命令（预期非零退出，失败位置必须为 `SSE-only message reaches both renderers`）：

```sh
apps/desktop/node_modules/.bin/electron apps/desktop/scripts/session-workbench-smoke.mjs --drop-business-events
```

fixture 协议测试（每项上限 10 秒）：

```sh
node --test apps/desktop/scripts/session-workbench-smoke-fixture.test.mjs
```

可选命名空间 agent 回归：在正常命令后加 `--namespaced-agent`，文件窗口开窗参数及实际发送的 agent 均为 `team/reviewer`；断言 HTTP admission 收到该名称。此模式要求生产桥支持该合法 agent 名称，脚本不改写生产校验器。默认模式使用 `build`。

脚本使用真实 Electron `BrowserWindow` renderer、Vite API 和生产应用模块。Main 的 smoke HTML 入口由内联 middleware 提供；文件窗口的生产 sandbox preload 由 `buildFileWindowPreload` 构建到临时目录。没有生产测试后门或模拟 UI。

## 真实模块装配

- **Main**：`session-workbench-smoke-main.tsx` 装配真实 `SessionSurface`、`ReactSessionRuntime`、上下文 Provider、`createSessionDraftSender`、`installFileWindowSessionStopBridge` 和生产提交链路。生产 ESM preload 接收停止请求并在 helper 清理完成后回复确认。它是 smoke 专用模块组合，**不是完整 `SessionRoute` 或全应用启动入口**。普通文本发送采用生产无需 Cloud gate 的路径和合成模型。
- **文件窗口**：实际加载 `file-window.html` → `src/file-window.tsx` → `FileWindowApp` → `FileWindowConversation`，由生产 `createFileWindows` 创建。使用真实受限 IPC fetch、后代关系快照校验、响应投影、SSE 订阅和 sandbox CJS preload。
- **Backend**：内存中的 loopback HTTP/SSE 协议 fixture，提供合成 session、模型、provider 目录、任务 admission、交互快照/回复和消息。不启动真实服务运行时、provider、用户 DB 或凭据存储。

## 验证项

1. 两个 renderer 进程 ID 不同；文件窗口使用独立非持久 session、启用 sandbox，真实 preload bridge 可用；共享 Surface 完成加载并建立两条 SSE。
2. 相同 workspace/session 的两窗草稿互不串；成功发送只清除发送端草稿。
3. 独立 SSE-only 阶段依次验证 message、`message.part.delta` 和 busy status：两端 DOM 与生产缓存断言通过前，backend 的 snapshot、messages、active-runs 均不提供待提交消息、delta 或 busy。HTTP 恢复与 5 秒轮询保持启用；三项全部断言通过后才 commit。message 与 delta 分别验证完整文本，busy 单独验证两端状态。
4. 文件窗口经生产发送器完成 HTTP admission，两端 DOM 包含输出，生产 transcript/status 缓存对比一致；同时检查 agent 与 `whenBusy: "reject"`。
5. Main 停止文件窗口发起的任务；Main 发起真实 busy 任务后向 Main composer store 追加 pending queue，由文件窗口 Stop。backend 收到 abort 时的只读探针验证 Main queue 和 claims 已清空、两窗输入草稿保留；两端 idle 后再观察 3 秒，确认没有新增 start、没有队列重启。清队列由生产 helper 执行，smoke 不模拟清理或 ack。后续 Main 队列正控仍须成功提交。
6. Backend 在 renderer 不知情时进入 busy，产生真实 HTTP 409；UI 保留原草稿，显示 busy 提示，未将草稿加入队列。
7. 挂载后新建 child 并产生 permission/question：两处显示，请求回复正确指向 child，两处同步消失；文件窗口 permission 回复经过 Main 的权威后代快照检查。
8. 断开两条 SSE，向 backend snapshot 单独加入消息；验证两端各自重新建立 SSE、读取恢复快照，最终消息/transcript 一致。
9. 向文件窗口真实 composer store 加入队列项：在有界 idle 等待及 idle/busy/stop 转换中保持未 claim、未发送。Main 使用同一生产 store/Surface 的正向对照必须成功消费并提交。
10. 没有捕获到的 preload/renderer runtime 错误或外部 renderer 网络尝试。
11. Vite 未加载应用配置文件，公开 env 中没有继承的 `VITE_*` 键。

读取 store/cache 使用 canonical `/src/` 模块 URL，避免 `/@fs/` 别名产生第二份 Zustand 模块、使队列断言失真。

## SSE 负控与停止握手

`--drop-business-events` 仅在 fixture 的文件窗口 SSE 连接上过滤业务帧，保留 connected/heartbeat；Main 连接不受影响。正常与负控都经过生产 Main SSE parser、会话事件投影、IPC、sandbox preload 及 renderer sync，没有直接写入 renderer cache。每个 SSE-only 等待上限 12 秒，允许跨过两次 5 秒轮询周期；pending 数据直到断言通过前均不进入 HTTP 读模型。失败诊断包含 commit 状态、被丢弃事件及剔除主动 HTTP 探针后的文件 renderer 快照读取次数。

文件窗口 Stop 使用生产 Main manager 的 abort-run 校验和停止请求握手：`jugglework:file-window:session-stop-request` → Main preload → `installFileWindowSessionStopBridge` → 生产队列清理 → preload IPC reply → backend abort。fixture 的 `onAbort` 只读取现场状态，不修改队列或生成确认。pending queue 回归与后续 Main 消费正控分别断言。

## 隔离与时限

- 每次运行使用独立临时 `userData`、`sessionData`、Vite 依赖缓存、最近文件记录和构建后的 preload；端口由 loopback 动态分配。
- `configFile: false`、`envFile: false`：不执行真实 `vite.config.ts`，不经该配置读取 `.env.migration-release`，不加载 Vite env 文件。
- 手动装配 `@vitejs/plugin-react`、`@tailwindcss/vite` 和 `@` → 应用 `src` alias。省略仅处理注解的 React Compiler 优化插件，因此不覆盖该优化路径。
- `envPrefix: "JUGGLEWORK_SESSION_SMOKE_PUBLIC_"` 仅用于专用非敏感公开变量，取代默认 `VITE_`。脚本不修改 `process.env`，不调用 `process.chdir`。
- Renderer 网络只允许 fixture 和临时 Vite 端口；desktop HTTP 只允许 fixture origin；文件窗口 fetch 仍执行生产授权。
- 不加载真实应用 Main 入口、已保存账号启动信息，不执行真实 provider 或初始化用户数据库。
- Main 使用生产 ESM preload，`sandbox: false`；文件窗口使用生产打包 CJS preload，`sandbox: true`。
- 总时限 180 秒，单项等待有界，清理硬时限 10 秒。成功、断言失败或总超时都会销毁窗口、中止文件订阅、关闭 HTTP/Vite、删除临时目录并退出。
- 退出码 0 和最终 JSON `result: "pass"` 表示全部断言通过。失败输出已完成项、最近 fixture 路由和 DOM 诊断。

## 验收边界

本 smoke 验证合成协议 backend 下的客户端、IPC 和 SSE 组合，不覆盖真实 Server admission 正确性、完整应用启动/路由/Cloud readiness、真实 provider、生产打包资源或 React Compiler 优化路径。队列不消费是有界观察，包含 Main 消费正向对照，未挂载全应用后台队列协调器。原生 Office 编辑验收不在本 smoke 范围内。
