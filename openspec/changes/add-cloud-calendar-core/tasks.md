# Tasks

## 1. 契约与依赖基线

- [x] 1.1 对照三个 capability spec 固化 Calendar、CalendarEvent、bootstrap、changes、错误码和 feature config 的 HTTP DTO/路由契约，明确未知字段拒绝、分页上限与排他边界，并以 Server API contract tests 和 Desktop normalization fixtures 验证两端字段一致
- [x] 1.2 在 Desktop 评估 `@js-temporal/polyfill` 实际发布版本的许可证、生产 bundle 增量和 Electron 兼容性，记录审核结论；只有 gate 通过才添加依赖，并以 `pnpm --filter @jugglework/app build` 和许可证检查验证，否则实现同一接口的受测 calendar time adapter
- [x] 1.3 建立 Calendar 服务端与 Desktop 领域模块的最小目录、测试 fixture 和命名边界，确认不引用 ProductTask、Automation、Session 或 Agent 模型，并以 Server/ Desktop 定向编译和 import-boundary tests 验证无循环依赖

## 2. Server 数据模型与迁移

- [x] 2.1 在 `jugglework-server` 增加 Calendar、CalendarEvent、CalendarChange、CalendarMutationReceipt 领域类型和枚举，包含独立稳定 ID、owner、version、软删除及判别式时间字段，并以 model/service validation unit tests 验证非法混合时间状态不可进入持久化
- [x] 2.2 添加只增不减的顺序 SQL migration，创建 calendars、calendar_events、calendar_changes、calendar_mutations 及 tenant/range/change/idempotency 索引，不添加 foreign key 或 CHECK constraint，并以 migration discovery/readiness tests 验证全新库和已升级库
- [x] 2.3 为支持的数据库方言补充 migration 测试，验证唯一默认槽位、tenant 索引、事件范围索引、change sequence 和 mutation receipt 唯一键，并运行 `go test ./commons/dbcommons/...`
- [x] 2.4 实现严格 organization+owner scoped 的 Calendar repository CRUD、惰性默认 Calendar 创建和当前版本条件更新，并以 repository tests 验证并发首次访问仅有一个默认 Calendar、默认 Calendar 不可删除和裸 ID 不可跨成员读取
- [x] 2.5 实现 CalendarEvent repository CRUD、Calendar 归属校验、活动资源读取、范围相交查询、稳定分页和受限文本搜索，并以 repository tests 覆盖全天/定时/跨日/排他结束、筛选、搜索和软删除过滤
- [x] 2.6 实现 mutation、资源 version、软删除和 change append 的单事务 repository 操作，并以 fault-injection repository tests 验证任一步失败均不产生部分资源、receipt、游标或 change 状态

## 3. Server 时间、授权与写入服务

- [x] 3.1 实现服务端日期、RFC 3339 Instant 和 IANA time zone 校验及 coverage date 派生，拒绝 DST 不可表达输入和无效排他区间，并以 table-driven tests 覆盖单日、跨日、午夜结束、DST 前进/回退和非法 zone
- [x] 3.2 实现集中式 owner-only Calendar 授权 service，所有读取、搜索和 mutation 从已验证 membership 获取 owner 且对跨成员/组织使用不可区分的不可见结果，并以 authorization tests 覆盖 owner、同组织他人、跨组织、失效 membership 和已删除资源
- [x] 3.3 实现 Calendar service 的默认日历、额外个人日历 CRUD、version conflict 和软删除规则，并以 service tests 验证默认 Calendar 生命周期、冲突返回当前权威版本及 owner 隔离
- [x] 3.4 实现 CalendarEvent service 的创建、读取、更新、时间类型显式转换、移动到有效 Calendar 和删除，并以 service tests 验证字段互斥、Calendar 归属、版本递增、软删除和权威响应规范化
- [x] 3.5 实现 organization+actor+operation+key scoped 的幂等 receipt 与规范化 payload digest，回放原成功响应并拒绝同 key 异载荷，并以 service tests 覆盖创建/更新/删除重试、跨成员隔离和失败请求不占用 key
- [x] 3.6 实现删除非默认 Calendar 时同事务软删除其活动 Event 并为 Calendar 及每个 Event 生成版本化 delete change，并以 service/repository tests 验证普通查询全部退出、墓碑防旧版本复活且事务失败可回滚
- [x] 3.7 对写入和搜索增加字段长度、请求范围、筛选数量、页大小与资源数量限制，并以 validation/load-boundary tests 验证超限 fail closed、正常个人月范围查询不退化为无界扫描

## 4. Server Bootstrap、游标与 HTTP API

- [ ] 4.1 实现一致性事务内的 bootstrap snapshot，原子返回活动 Calendar、请求范围 Event、完整性元数据和对应 change high-watermark，并以并发插入测试验证 snapshot 与后继 cursor 之间不漏变更
- [x] 4.2 实现版本化签名 opaque cursor，绑定 organization、owner 和 sequence，并以 unit tests 验证篡改、跨成员、跨组织、错误 deployment 签名、过期及保留窗口外 cursor 返回 resync required
- [x] 4.3 实现按 sequence 稳定分页的 changes service，返回 Calendar/Event upsert 和 delete payload，只有已返回页才推进 cursor，并以并发分页 tests 验证不跳过、不倒退且重复读取可安全去重
- [x] 4.4 在现有 Gin `/v1` 路由注册 Calendar、CalendarEvent、bootstrap、changes、范围和搜索 API，接入 session、organization membership、严格 JSON 和请求大小限制，并以 API tests 验证状态码、DTO、分页和所有错误契约
- [x] 4.5 增加 fail-closed calendar `enabled`、organization allowlist 和 `writeEnabled` 配置，将当前组织能力投影到 Desktop config，并以 config/route tests 验证缺省关闭、只读 gate 拒绝 mutation、禁用 gate 不创建默认 Calendar
- [x] 4.6 添加 Calendar API 结构化指标和安全日志，只记录操作、延迟、结果量、冲突、cursor reset 和不可逆 scope hash，并以 metrics/log capture tests 验证标题、描述、搜索文本、草稿和原始成员标识不进入日志
- [ ] 4.7 运行 Calendar Server 定向测试、`go test ./...` 和 `go vet ./...`，修复 migration、repository、service、API、cursor、授权及现有回归后才允许进入 Desktop 联调

## 5. Desktop API 与时间领域

- [x] 5.1 在 Desktop Den client 增加 Calendar、CalendarEvent、bootstrap、changes、range/search 和 mutation 类型及严格 normalization，保留 server 权威字段并拒绝畸形 payload，以 client fixture tests 覆盖成功、冲突、resync 和未知时间联合
- [x] 5.2 实现规范化 deployment base URL + organizationId + memberId 的 Calendar scope 和完整 query key 工厂，缺少任一维度时返回不可用 scope，并以 unit tests 验证 URL 尾斜杠、跨 deployment、跨组织和跨成员键绝不碰撞
- [x] 5.3 实现 Desktop calendar time adapter，以 PlainDate、Instant、IANA ZonedDateTime 和排他区间驱动月格/表单转换，并以 unit tests 覆盖 DST、午夜、跨日、全天不经 UTC、locale 显示和类型转换
- [x] 5.4 实现 Calendar API query/mutation hooks，mutation 使用稳定 idempotency key 和最后读取 expectedVersion，且仅用成功响应更新权威实体，并以 hook tests 验证重试不换 key、失败不伪保存和 conflict 保留输入

## 6. Desktop 分区缓存与同步

- [x] 6.1 实现带 schema version 的 IndexedDB calendar adapter，分别存储实体、墓碑、范围覆盖、cursor/刷新时间和草稿，所有 key 以完整 scope 开头，并以 fake IndexedDB tests 验证重启恢复和跨 scope 不可见
- [x] 6.2 实现 bootstrap 持久化和范围覆盖账本，仅在完整分页成功后记录 `[startDate,endDateExclusive)` 与 Calendar filter 覆盖，并以 cache tests 验证失败/部分页不标完整、未缓存月份不被表示为空
- [x] 6.3 实现 change page 原子应用，按 version 接受较新 upsert/delete、维护活动索引和墓碑，并在同一 IndexedDB transaction 推进 cursor，以事务中断 tests 验证 cursor 不越过未应用变更
- [x] 6.4 实现 sync coordinator，在页面前台、网络恢复、成功 mutation 和低频刷新时拉取 changes，cursor resync 时失效覆盖并重新 bootstrap，并以 deterministic coordinator tests 验证跨设备收敛、重复页去重和删除不复活
- [x] 6.5 实现 scope generation fence 和请求取消，organization/member/deployment 切换或登出时先隐藏旧数据并丢弃迟到 UI 结果，同时只写回原 scope，并以 race tests 验证旧请求不能污染新身份视图
- [x] 6.6 实现按 scope 的离线只读状态、覆盖/过期提示和本地草稿生命周期，不创建离线 mutation queue；恢复在线先刷新再显式提交，并以 cache/UI state tests 覆盖缓存月、未缓存月、离线删除、草稿恢复和远端更新/删除冲突
- [x] 6.7 实现目标 scope 的缓存/游标/草稿清除与不兼容 schema 失效策略，不合并或误删其他 scope，并以 IndexedDB migration/clear tests 验证升级、回滚后重建和身份隔离

## 7. Desktop 路由、导航与月视图

- [x] 7.1 将全局 `/calendar` 接入 retained app shell，增加 Calendar domain 页面和登录/能力 gate，确保不依赖 workspace、Session、Agent 或 AI Provider，并以 route tests 和 no-Agent render smoke test 验证
- [x] 7.2 在 More 增加 Calendar 入口并扩展既有 pin parser/rail 支持置顶和取消置顶，保持旧 pin 数据及未知值安全迁移，并以 navigation tests 验证 active 状态、键盘操作和持久化
- [x] 7.3 实现 Calendar 筛选列表、迷你月历、上月/下月/今天导航和 6 周主月格，使用现有设计 token 与 i18n，并以 component tests 覆盖月份边界、筛选隐藏不改云端和已删除 Calendar 退出
- [x] 7.4 实现月格 Event 布局和溢出入口，按保存时区/全天日期/排他结束覆盖日期且稳定排序，并以 component tests 覆盖单日、跨月、跨日定时、DST、午夜结束及多事件溢出
- [x] 7.5 实现选中日议程、空状态和 Event 详情，全天先于定时且相同开始时间以稳定 ID 排序，并以 component tests 验证月格/迷你月历/议程联动及远端删除时详情退出
- [x] 7.6 实现在线 Event 创建、编辑、时间类型转换和删除表单，提交前校验 title/Calendar/time union，区分 pending/saved/validation/network/conflict 状态，并以 interaction tests 验证权威响应、失败草稿和 conflict 解决入口
- [ ] 7.7 实现离线页面与表单体验：已覆盖范围只读、未覆盖范围明确不完整、delete/权威 save 不可用、草稿明确未同步，并以 interaction tests 验证绝不出现虚假“已保存”或自动上线写入
- [ ] 7.8 完成窄窗口和标准桌面布局、键盘月格导航、可见焦点、语义标签及 Dialog 焦点恢复，并以组件可访问性测试和 Desktop 两种窗口尺寸的可视 smoke test 验证无核心操作依赖整页横向滚动
- [ ] 7.9 补齐所有支持 locale 的 Calendar 导航、时间、离线、冲突、校验和空状态文案，并运行 `pnpm --filter @jugglework/app test:i18n` 验证无缺失键
- [ ] 7.10 运行 `pnpm --filter @jugglework/app typecheck`、Calendar 定向测试、`pnpm --filter @jugglework/app test` 和 `pnpm --filter @jugglework/app build`，修复 Calendar 及现有 Desktop 回归

## 8. 安全、迁移与灰度发布

- [ ] 8.1 完成 Server 授权安全评审和攻击测试，覆盖 IDOR、裸 ID 枚举、跨组织/成员、cursor 篡改、幂等 key 复用、搜索泄漏、请求放大和未知后续阶段字段，并以书面评审记录及全部 security tests 通过验证
- [ ] 8.2 完成 Desktop 本地数据安全评审，检查 IndexedDB profile 边界、scope 键、登出隐藏、迟到响应、缓存/草稿清除、日志/遥测和纯文本渲染，并以评审 checklist 和针对性 isolation/XSS tests 验证
- [ ] 8.3 为 migration、默认 Calendar 惰性创建、change/mutation 表增长、cursor reset 和配置 readiness 增加运维检查与告警说明，并在预发布数据库执行 upgrade/readiness/canary 脚本验证可重复运行
- [ ] 8.4 编写 Calendar feature gate、organization allowlist、只读/写入分阶段、最低 Desktop 版本、指标阈值、支持诊断和非破坏性回滚 runbook，并以 staging 演练验证关闭写 gate 后可读、关闭 enabled 后入口/API fail closed
- [ ] 8.5 在内部 organization 执行只读 canary，验证 bootstrap/range/search/changes、时区与跨租户拒绝且无内容日志，再记录 gate、指标和通过证据后进入写 canary
- [ ] 8.6 在内部 organization 执行写 canary，跨两台 Desktop 验证默认 Calendar、CRUD、版本冲突、幂等重试、软删除、游标收敛、离线草稿和组织切换，并记录无数据丢失/泄漏的通过证据
- [ ] 8.7 按 organization 再按 deployment 扩大灰度，持续检查 error/latency、cursor reset、conflict、IndexedDB failure 和表增长；任一阈值越界即按 runbook 关闭写入或能力 gate，并以每阶段 rollout checklist 签字验证

## 9. 跨端完成门

- [ ] 9.1 在 staging 从 migration 开始执行真实 Server + Desktop 端到端主路径，覆盖在线月视图 CRUD、范围分页、搜索、多设备变更、软删除和重启后缓存恢复，并保存可复现命令与测试结果
- [ ] 9.2 执行故障注入端到端检查，覆盖写响应丢失后同 key 重试、并发 expectedVersion、changes 页持久化失败、cursor resync、网络恢复和身份切换迟到响应，并验证无重复资源、漏变更、状态倒退或跨 scope 内容
- [ ] 9.3 逐项追踪三个 capability spec 的全部 Scenario 到自动测试或明确的可重复人工验证，修复未覆盖项并由评审确认后再将变更标记为实现完成
