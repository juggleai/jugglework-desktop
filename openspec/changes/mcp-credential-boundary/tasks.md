## 1. 导出剥离（已完成）

- [x] 1.1 新增 `workspace-archive-redaction.mjs`：环境变量值、凭据类请求头、OAuth secret、命令行内嵌连接串密码的结构化剥离
- [x] 1.2 `workspace-archive.mjs` 导出前调用剥离，manifest 增加 `redacted` 清单
- [x] 1.3 单测覆盖：Bearer 令牌、环境变量、连接串密码、OAuth secret、非凭据头、无凭据不变、解析失败兜底
- [x] 1.4 测试接入 `pnpm --filter @jugglework/desktop test`

## 2. 凭据引用取代明文值

- [ ] 2.1 定义引用语法与解析时机（spawn / 请求前解析，绝不落盘）
- [ ] 2.2 `cloud-mcp-reconciler.ts` 改为写引用，不再每小时重写配置
- [ ] 2.3 验证引擎重载次数下降，且 token 过期不再需要改配置
- [ ] 2.4 导出剥离退化为兜底——配置里本就没有明文值

## 3. 云端工具调用审计（服务端）

- [ ] 3.1 `apis/mcp.go` 的 `tools/call` 路径记录成员、连接、工具名、结果码、耗时
- [ ] 3.2 与 `GatewayUsage` 对齐字段与保留策略
- [ ] 3.3 控制台暴露按连接与按成员的调用记录

## 4. token 粒度收窄（服务端）

- [ ] 4.1 `MCPAccessToken` 增加 connection 允许清单，复用 `AllowsAutomationConnection` 思路
- [ ] 4.2 连接注册时标注工具读写属性，取代从 `tools/list` 推断
- [ ] 4.3 重新定义 scope 语义，使 `mcp:read` 真正可用
- [ ] 4.4 撤销授权时的下行失效通道

## 5. gateway 凭据隔离注入

- [ ] 5.1 桌面停止把 gateway token 镜像进全局 env store
- [ ] 5.2 仅注入声明了该 provider 绑定的 MCP 子进程
- [ ] 5.3 回归：vision-mcp 等既有绑定不受影响

## 6. stdio MCP 的服务端凭据通道

- [ ] 6.1 设计取值时机与失败语义（依赖第 2 节）
- [ ] 6.2 `mcp_delivery.go` 的 desktop 组件补上凭据就绪度

## 7. 第一方 Cloud MCP 一次性鉴权恢复

- [x] 7.1 会话维护和发送前使用 direct probe，避免陈旧 Engine `connected` 掩盖 401
- [x] 7.2 direct probe 失败后绕过 freshness marker，按 workspace/org/server scope 自动 re-mint、重注册并复验一次
- [x] 7.3 非 Token 鉴权错误不 re-mint，新 Token 仍失败时停止循环并保留可操作错误
- [x] 7.4 根目录 `config.json` 退出 Git 跟踪并加入忽略，本机文件与当前账户运行时保持不变
