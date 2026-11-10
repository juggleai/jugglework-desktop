## Context

Desktop 是 Electron＋React，内置本地 TypeScript Server 管理文件、Office 原生模型、保存和 AI 工具。More 已承载工作台入口，账号系统已有租户切换。AFFiNE 页面在独立 WebContentsView 中使用原生协作。

## Goals / Non-Goals

目标为 More 内云文档、免重复登录、Personal／团队隔离、原生协作页面及站内与 IM 通知。云端同步、合并、历史、评论和恢复沿用 AFFiNE。本地 Office 编辑独立使用，与云文档不同步。文件上传、附件查看与 AI 编辑见 [replace-word-sync-with-cloud-intake](../replace-word-sync-with-cloud-intake/design.md)。

## Decisions

### 1. 模块与职责

| 模块 | 位置 | 职责 | 依赖 |
| --- | --- | --- | --- |
| CloudDocsPage／导航 | React shell、domains/cloud-docs | More、页面状态及租户路由 | DenAuth、宿主能力 |
| CloudDocsPanel | Electron | WebContentsView、Cookie 分区、布局、下载及外链 | 现有宿主模式、Docs URL |
| DocsSessionLifecycle | Cloud Auth 衔接 | 启动交接，切换账号／组织及退出清理 | Server 契约；不复制认证实现 |
| DocsNotificationBubble | 既有 jugglechat 自定义消息与气泡 | 站内外消息入口、预览、租户及评论定位 | Server notification-delivery.md；不重建通知中心 |

云文档路由采用组织级 `/cloud-docs/:tenantId`；页面 ID 作为明确目标传入，不能以本地 workspaceId 代替源租户。当前组织从 DenAuth 获取，个人账户也有明确 tenantId。规范使用“本地工作区”“源租户”“Docs Workspace”三个名称，禁止混用。

同一 Server 支持多组织，但 Desktop 当前云文档仅取已登录并成功进入的组织。全局账号登录不自动聚合多个组织的目录、搜索、通知或附件；URL 和群卡片不能直接改变云视图所属组织。组织进入、同 IM App 隔离、卡片来源和切换异常的唯一交互契约为 [card-navigation.md](card-navigation.md)。

### 2. 产品形态

```text
[已有 Desktop 左侧主导航]  [当前 Personal／组织名称]
  ...                      [新增云文档内容区]
  More → 云文档              AFFiNE 原生空间／目录 | 原生编辑页
                              原生评论、历史、在线成员
```

保留现有主导航宽度与交互；云文档内部复用 AFFiNE React 页面，不在 Desktop 重新实现文档树和权限面板。React 使用现有组件库承载 DropdownMenu、Dialog、AlertDialog、Button、Toast 及状态外壳，文案接入中英文 i18n。

| 控件／入口 | 触发 | 反馈 | 失败与恢复 |
| --- | --- | --- | --- |
| More → 云文档 | 读取明确当前租户；可固定到左侧导航并本机持久化 | “正在打开云文档”，进入原生首页；云朵文档专用图标显示当前选中态 | 未启用／不可用显示原因和重试 |
| 组织内文档链接 | 解析规范租户与 pageId | 同租户直接定位；不同租户弹出切换确认 | 无成员或无空间权限拒绝，不把链接当授权 |
| IM 云文档通知卡片 | 解析当前 IM 连接来源、租户和页面 | 同租户打开；跨租户确认切换，评论可定位 | 未知版本、已退出组织、无权限／删除均不盲开 |

More 首版保留一个云文档入口，不要求用户配置协作协议或新增登录方式。入口可按现有 More 应用规则固定或取消固定，固定状态仅保存在本机；图标使用圆角实心文档与右下云朵叠放的图形，文字和图层间隔透明镂空，默认弱化、选中强化，颜色跟随深浅主题。More 与固定导航复用同一图标，遮罩 ID 按组件实例区分，不使用 AFFiNE 品牌标识。Personal 页显示“我的文档”；团队页显示组织名称和“组织协作”。公开分享入口不出现。

云文档在 Desk 窗口顶部复用漫剧工厂的搜索与左侧栏控件样式；左侧栏展开时按钮随其实际宽度对齐，收起后仍保留展开和搜索入口。右侧栏按钮固定在窗口顶部右上角。AFFiNE 页面内不重复显示左侧独占按钮行或右侧展开／收起按钮。所有操作通过当前实例的固定展示命令调用 AFFiNE 原生侧栏和搜索，快捷键及拖动改宽后的真实状态回传 Desk；不维护第二份持久化侧栏状态，不重建编辑会话。Server Web 内嵌页面保留原浏览器控件。

窗口顶部空白区域支持按住拖动，搜索、收起和导航等按钮使用不可拖动区域，文档正文保持正常选择和编辑。由于原生云文档视图高于宿主网页浮层，云文档页面的左侧导航使用系统提示，避免悬浮文字被内容视图遮挡；其他页面沿用原有网页提示。

### 3. 页面装载和生命周期

Desktop 为每个页面创建 UUID instanceId，使用现有 JuggleWork Session 向 Server 提交 target 与 presentation={instanceId,mode} 申请一次性交接，主进程仅 POST grant 装载 Docs bootstrapUrl。展示模式和实例随凭据绑定，Docs 依据 consume 结果进入 product／manage 并在初始化后发送匹配的 ready。源长期令牌只留在现有身份机制中；原生页面 origin 和租户键以 Server 返回值为准。

会话分区至少按 sourceServerOrigin＋sourceUserId 隔离，租户 origin 使用独立子域。账号切换、Server 来源变化、注销时先关闭相关云视图，再发布新的身份；源租户切换只关闭旧租户视图，不影响本地文件。

| 状态 | 可见表现 | 退出条件 |
| --- | --- | --- |
| loading | 正在打开云文档 | 收到当前实例 ready 或失败 |
| ready | 原生产品页 | 导航、身份切换或真实连接错误 |
| unavailable | 云文档暂时无法连接；重试 | 新交接成功；15 秒未就绪也进入此状态 |
| unauthorized | 登录已失效 | 现有 JuggleWork 登录成功后重新打开 |
| forbidden | 你没有此空间的访问权限 | 当前权限重新验证成功或离开页面 |

组织切换前检查原生 pendingLocalChanges：可取消切换；确认后停止旧连接，保留允许恢复的原生本地数据。下一次访问仍需授权，不允许依靠缓存绕过已退出组织。旧 instanceId 的异步结果不能激活新租户页面。

WebContentsView 复用现有隐藏／布局／覆盖层模式。宿主菜单、对话框和 Toast 不能被原生视图盖住；切换页面时隐藏而非无条件重建原生编辑会话。远程页面 nodeIntegration=false、contextIsolation=true、sandbox=true，只暴露宿主桥所需操作。

产品页 WebContents 关闭后台动画及计时器限速，隐藏授权与跨空间导航期间仍完成初始化；可见性由当前实例的授权就绪状态和宿主覆盖层控制。产品视图从隐藏恢复为可见时恢复 WebContents 焦点，使原生引擎接收 focus 并正常恢复编辑输入；已可见页面的周期授权检查不重复抢焦点。

即时输入不等待网络；原生 nbstore 按文档调度和合并 Yjs 更新。输入、远端可见及保存分别按 [协作性能契约](../../../../jugglework-docs/openspec/changes/add-jugglework-docs-adaptation/collaboration-performance.md)验收。

### 4. 站内与 IM 通知

首版同步交付 AFFiNE 站内通知和 JuggleIM 通知。站内继续使用原生通知列表／未读，不复制到另一个自建收件箱。IM 注册 jw:docs-notification 消息，在现有 jugglechat 的注册表、气泡、会话预览、未知类型兜底及原生通知策略中接入。群与定向的受众、payload 和持久投递以 [notification-delivery.md](../../../../jugglework-server/openspec/changes/add-jugglework-docs-integration/notification-delivery.md)为准。

全组织可见文档可发组织受管群，限定成员文档只定向给原生有权收件人。卡片不带标题／正文／评论原文或凭据；点击不调用 AI，使用当前 IM 连接对应 Server 的真实用户会话重新申请 product/page 交接。跨组织确认切换，尚未登录正确账号则先走既有登录，不采纳消息内任意来源 URL。commentId 只用于原生已授权评论定位。

站内和 IM 未读独立，点击 IM 不批量清空站内未读；同一 IM 来源＋tenantId＋eventId 去重展示。Personal 不连接 IM。切账号、组织或更换 Server 后，旧消息不能沿用旧云页面实例执行导航。

卡片使用固定模板和结构化打开动作，不接受任意 URL／HTML。同 App 多组织必须在进入会话、预览、未读和系统提示前过滤云文档群／助手历史；消息回调捕获接收时来源及凭据代次，不以点击时的全局 IM 连接猜来源。跨组织历史系统通知经确认、真实 switchOrganization 成功后再打开；IM 失败不回滚已完成的组织切换。具体行为及验收见 card-navigation.md。

### 5. 状态与真实反馈

provider synced 只表示原生同步状态，不据此显示“服务端已备份”。真实持久化通过其他客户端、刷新和服务重启验收。

## Risks / Trade-offs

- 本地已下载内容不能通过云端撤销追回：撤销阻止新访问，不删除用户磁盘文件。

## Migration Plan

先发布宿主能力检查和默认关闭的入口，再接入身份／页面。回滚关闭新入口并释放会话，保留本地文件。

## Validation gates

先在当前 macOS ARM64 验证，再验收 macOS Intel、Windows 和签名安装包。必须完成 Personal／A／B、跨账号、单设备退出、菜单覆盖、中文 IME 和两设备原生协作。
