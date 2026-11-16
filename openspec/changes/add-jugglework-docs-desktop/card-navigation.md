> 后续优化设计见 [单域名与 IM 解耦](../optimize-docs-single-origin-and-im-isolation/design.md)。其中 IM 分类前置、租户子域名和宿主边界的冲突要求以新设计为准；其余要求及旧版本验收事实保留。新设计待开发项以对应 tasks 为准。

# 群卡片跳转与多组织访问契约

本文是 Desktop 已实现云文档卡片展示、组织进入、跳转和组织切换生命周期的权威交互契约。消息载荷与投递以 [notification-delivery.md](../../../../jugglework-server/openspec/changes/add-jugglework-docs-integration/notification-delivery.md)为准，登录交接以 [api-contract.md](../../../../jugglework-server/openspec/changes/add-jugglework-docs-integration/api-contract.md)为准；真实 Electron 点击和完整联合验收边界见本文末尾。

## 1. 登录与组织上下文

同一 Server 可有多个组织，一个全局账号可同时是 Personal、A、B 的成员。“登录组织”表示：已有该 Server 的真实用户 Session，已通过既有组织选择／switchOrganization 成功进入目标组织，当前成员和账号有效；不要求再次输入 AFFiNE 密码。

账号登录成功不代表自动显示所有组织文档。Desktop 当前仅有一个生效组织上下文；More → 云文档、站内通知、上传空间、文档树、搜索、最近访问和文件关联操作均取当前上下文的 tenantId，不聚合 A／B。目标不是当前组织时，先明确切换并验证成功，再申请目标 Docs 凭据。Personal 是独立租户，不是组织文档的默认兜底。

Server 的 Session.activeOrganizationId 是现有选择／默认值，不作为已打开页面每次请求的隐式租户。Web 各标签使用已验证的组织路由／上下文，可分别在 A、B；每个实例固定自己的租户。另一标签更新全局默认值不把 A 页面改成 B，也不替代对 A 当前成员资格的检查。Desktop 单组织展示与 Web 显式多标签不冲突，不新增组织登录系统。

## 2. 身份键与消息来源

| 对象 | 必须固定的范围 |
| --- | --- |
| Docs 产品页 | 已配置 Server 连接、源用户、tenantId、Docs Workspace、instanceId |
| IM 连接实例 | Server 连接、源用户、已进入 tenantId、IM endpoint／AppKey／IM 用户、现有凭据代次 |
| 群会话 | 上述来源＋IM conversationId，且 Server 群记录属于目标 tenantId |
| 定向通知 | 上述来源＋当前组织云文档助手会话；不按同名助手或昵称匹配 |
| 页面／通知缓存与未读 | Server 连接＋源用户＋tenantId；本地工作区 ID 不替代任何云端身份 |

Server 连接使用现有配置的稳定来源标识；包含部署前缀的不同连接不可仅按 hostname 合并。卡片本身不提供可覆盖此标识的 URL。同一 Server 的多组织可配置不同 IM App，也可共用同一 App；IM AppKey 或同一个 IM 用户 ID 不能证明是同一组织。

消息回调必须捕获接收该消息的连接来源和凭据代次，不能在点击时才读取已切换的全局 IM 配置来“补来源”。系统通知点击携带这份受限宿主上下文及稳定定位 ID，不携带正文、凭据；组织／账号变化后再次检查。来源无法确认的导入消息或旧消息仅显示通用兜底，不猜测 Server，也不自动切账号。

## 3. 群卡片与筛选

首版使用现有自定义消息扩展注册 `jw:docs-notification`，渲染固定模板和“打开云文档”按钮；不接受服务端任意 HTML、脚本或可执行卡片 schema。示意：

```text
┌ 云文档协作通知 ─────────────────┐
│ 云文档有新的协作消息             │
│ 当前组织名称                    │
│                 [打开云文档]    │
└────────────────────────────────┘
```

组织名称来自当前已验证组织资料，不信任载荷提供的显示名称；文档标题、评论原文等不写入 IM 历史。消息中 eventId／tenantId／pageId／commentId 是定位数据，不是访问凭据。

卡片进入会话展示前核对：类型／版本和字段合法，当前连接来源有效，载荷 tenantId 等于该连接绑定组织，实际群 conversationId／发送者与当前组织 Server 群及助手映射一致；direct 则校验该组织助手和当前 IM 接收身份。客户端任意伪造同名消息不能只凭消息名启用跳转，最终页面仍由 Docs 授权。

同 IM App 复用时，SDK 可能返回多个组织的历史。其他组织云文档群、助手会话及卡片不进入当前组织的会话列表、预览、云文档未读聚合、Toast 或系统通知，不自动连接目标 Docs，也不清除其他组织的未读；切回目标组织后使用原 IM 历史加载。不新增卡片离线队列。一般 IM 群的隔离继续遵守既有 IM 规则，本适配必须覆盖云文档新增群和助手。

消息转发到不同群／组织时，不能因原 payload 的 tenantId 而在新群启用原卡片动作；显示无跳转兜底。用户要共享文档使用原生链接，接收者仍单独选组织、登录及授权。若以后支持转发卡片，需单独定义来源核验，首版不猜测。

## 4. 点击状态机

| 当前状态 | 处理 | 成功后 |
| --- | --- | --- |
| 已登录正确账号、正在目标组织 | 确认实时上下文与有效成员 | 申请新 product/page grant，bootstrap 后验证 ready，定位文档／评论 |
| 同 Server 同账号，当前是另一个组织 | 显示“切换到目标组织并打开云文档”；取消不改变任何上下文 | 按既有切换流程进入目标组织后再申请 grant |
| 未登录来源 Server | 显示“请登录后打开云文档”；显式走已有登录 | 核对原账号、成员和目标组织后继续，不默认打开当前其他 Server |
| 当前换了账号／Server | 旧动作失效，提示使用原 Server 的适当账号登录并重新打开 | 不复用旧 Cookie 或旧 grant；不能静默切账号 |
| 已退出目标组织／组织停用或不存在 | 不切换／不申请 Docs 凭据，显示不可访问 | 停止该动作；不自动申请加入组织 |
| 有组织资格、无 Doc 读权限 | 交接或页面校验拒绝 | 显示无权限，不因为组织成员或群成员身份放行 |
| 页面已删除／回收或不可访问 | 使用原生权限与页面可用性结果 | 显示不可访问，不回退其他组织、同名页或回收站 |
| 页面可读、评论已删除／不存在 | 不定位其他评论 | 打开原页面并提示“该评论已不存在” |
| 加载超时／凭据过期 | 不显示旧页面充当成功，提供重试 | 新 instanceId＋新 grant，目标和来源保持不变 |

跨组织通知点击来自之前合法接收的系统通知／历史动作时，使用保存的来源上下文启动上述流程；日常 IM 列表仍只显示当前组织卡片。重复点击期间按钮 loading 并复用当前未决打开操作，不连续创建多个视图。

## 5. 组织切换与异步结果

1. 固定目标动作的 Server、源用户、目标 tenantId、pageId、commentId 和宿主代次；用现有账号／组织列表核验，不信任卡片来声明成员关系。
2. 检查 A 的原生待发送状态，提供取消；决定切换后按既有生命周期关闭 A 的云视图和 IM 回调展示。不得将 A 待发送内容带入 B。
3. 复用 den-auth-provider.switchOrganization，等待真实 Server 切换结果及本地 activeOrgId 更新为 B。仅点击确认或本地 URL 变化不算已进入 B。多次切换使用现有凭据／实例代次丢弃过期回调，不引入锁机制。
4. Server 已成功切换但 im=null 或 IM 重连失败时，当前组织仍为 B；显示“IM 暂时不可用”，Docs 可独立使用 B 身份交接。不得报告切换失败并恢复 A 的云视图。切换请求超时、结果不明确时先刷新既有账号／组织状态，再决定继续，不盲目回退或重发。
5. 为 B 创建新的 product instanceId，申请 tenantId=B 的 grant；检查返回租户、预期 Docs origin、workspace 和 ready 均匹配。当前来源或目标在等待期间再次变化则丢弃结果，迟到 B grant 不进入 C 视图。
6. 任一阶段失败，不在 B 外壳下留下 A 的文档、通知或空间清单。已完成的组织切换不因 Docs 连接失败自动回滚；用户显式切回 A 后重新授权恢复。

新打开、应用重启或切回组织时，原生本地缓存在身份和成员重新确认前不显示正文／搜索摘要／附件预览。仅当前已经合法加载的实例可以按既有源故障策略暂时只读；不能把“只读保留”扩大为旧组织缓存免登录打开。下载、导出、附件、评论和 WS 均沿用同一目标组织校验，不能只检查卡片入口。

## 6. 验收矩阵

| 场景 | 必须结果 |
| --- | --- |
| 同 Server、同用户、组织 A／B 各有同名空间／文档 | 各自列表和页面隔离，以 ID／Host 定位，不按名称串用 |
| 仅 A 成员拿到 B 卡片、链接或 UUID | B 登录交接／资源授权拒绝，不回退 A |
| A／B 不同 IM App | 组织切换重新绑定正确 App 和来源，旧回调不展示 |
| A／B 共用 IM App 和 IM 用户 | B 云文档群／助手及通知不进入 A UI／预览／未读／系统提示 |
| 在 B 收到系统通知，切到 A 后点击 | 提示切回 B，确认成功后重新授权，取消不改变 A |
| 未登录、换账号、换 Server、通知延迟到达 | 来源保持且重新验证，不借当前其他身份打开 |
| Server 切 B 成功但 IM bootstrap 失败 | 保持 B，Docs B 可独立打开；无 A 内容残留 |
| 切换结果未知、Docs 加载超时、重复点击 | 核对权威状态、新凭据重试、无重复视图和静默回退 |
| A→B→C 时 B ready／消息迟到 | 旧代次结果丢弃，不覆盖 C |
| 页面失权、评论删除、附件／导出越租户 | 分别拒绝或仅在授权页面提示评论不存在，不能绕过权限 |
| 浏览器 A／B 双标签与 Session 默认组织变化 | 各自固定租户并独立验证，不互相导航或串用 |
| 群卡片被转发、改 pageId／tenantId／伪造助手 | 无效动作不执行，任何资源访问仍按当前真实授权拒绝 |

验收使用同一 Server 中独立测试库生成的有效 A／B、两个账号和 Personal；相同 IM App 的场景必须单独执行，不能用两个隔离 App 的通过结果替代。规格校验不替代上述运行证据。

IM 提供方按当前要求使用本地模拟服务，不需要真实业务组织 ID。Source A／B、账号和 Personal 使用独立测试库生成的有效夹具。Server 同 App 群／助手隔离、桌面固定卡片／来源／历史／未读、新交接、系统通知受限动作及组织切换状态机已通过三仓模拟联合验证，见 [联合证据](evidence/m4-notification-chain-three-repository.json)和[卡片证据](evidence/m4-im-cards.json)。系统通知动作不携带 Token、正文或任意 URL，主进程与渲染进程分别校验；启动或重载期间点击动作暂存并按来源＋事件去重，渲染器安装监听后再复用卡片的组织切换和持久事件复核。im=null 作为成功结果且不重复切换；响应未知只读核对 Server 权威组织，卡片和系统通知的同一事件共享进行中操作，旧账号／旧实例回调丢弃。真实操作系统通知中心人工点击、正式宿主评论侧栏高亮未完成。


## 7. 已实现的来源与历史过滤

2026-11-13，开发版 Desktop 已通过真实组织群的普通评论和评论 @ 卡片点击，打开正确文档并高亮目标评论；重启后历史卡片仍可用。正文 @ 事件已核对真实 IM 历史。助手新身份为 `jw_docs_` 加 24 位摘要，总长 32；客户端兼容旧 32 位摘要，并将固定通知类型纳入正常消息气泡分支。实测评论 @ 的空关键词列表和 `li` 姓名搜索均可找到其他组织成员。权威证据与未覆盖项见 [真实 IM 验收](../../../../jugglework-docs/openspec/changes/add-jugglework-docs-adaptation/evidence/real-im-notifications-20261113.json)。

连接来源包含完整 Server 部署前缀、源用户、租户、源凭据指纹及 IM App／端点／用户／凭据指纹。同一套 IM 凭据在不同组织仍重建连接；连接创建时捕获来源，旧回调和旧加载结果不补用新组织身份。A→B→A 以 Store 范围实例识别旧请求。

Server 的只读 `/api/v1/docs/notifications/context` 为当前组织提供真实群／助手映射，并为 SDK 群 ID 提供受管／当前组织分类；不以群名或载荷 tenantId 代替。分类每批最多 100 个 ID，到期复核，缺页或失败撤下未核实的群、助手、历史、置顶与回复。会话分页完整加载和分类后才计算可见会话的未读快照，不使用跨组织 SDK 总数。

固定卡片在宿主内绑定不能经 JSON 转发继承的来源。点击前 `/api/v1/docs/notifications/validate` 核对持久事件和真实投递目标，再由云文档页面申请全新 product grant。事件发送 TTL 不限制已送达历史的重新授权；Docs 仍重新检查当前原生 Doc.Read、正文、根目录和回收状态。评论不存在时打开原页并提示；画板保留 edgeless 模式。新原生页面未授权前隐藏，401／403／404 及失效会话不会被迟到 ready 重新显示。

组件明暗色截图分别为 [明色](evidence/docs-card-light.png)和[暗色](evidence/docs-card-dark.png)。截图为实际源码组件＋模拟宿主，不代表完整聊天外壳或平台包验收。

复验：在仓库根目录执行 `pnpm exec bun test --isolate apps/app/tests/cloud-docs-cards.test.ts apps/app/tests/cloud-docs-chat-store.test.ts apps/app/tests/cloud-docs-chat-runtime.test.ts apps/app/tests/cloud-docs-native-panel.test.ts apps/app/tests/desktop-notifications.test.ts apps/app/tests/den-auth-provider.test.ts apps/app/tests/toon-factory-permission-cleanup.test.ts`，并执行 `node --test apps/desktop/electron/desktop-notification-actions.test.mjs`。浏览器组件使用 `node scripts/verify-docs-cards-ui.mjs`，要求 `JW_TEST_PLAYWRIGHT_MODULE`，可通过 `JW_TEST_REPORT_PATH` 和 `JW_TEST_SCREENSHOT_DIR` 输出结果。
