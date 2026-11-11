# JuggleWork Docs 产品与规格入口

日期：2026-11-10。

本文件维护产品范围和跨项目入口。接口、模块实现约束和验收场景分别以对应项目 OpenSpec 为准，不在三个仓库复制同一接口定义。

## 1. 产品目标

用户从 Desktop 左侧 More →「云文档」进入本人 Personal 或当前团队组织的 AFFiNE 首页和文档页，复用已有登录。Server Web 提供云文档管理，复用 Docs 原生空间管理页面。文档正文、评论、历史、在线状态、持久化和多人合并均沿用 AFFiNE 原生 BlockSuite／Yjs／nbstore／Socket.IO。

本地文件由 Desk 本地 Office 编辑，云文档由 AFFiNE 原生协作编辑，两者不同步。本地文件一次性上传为云文档；Desk AI 通过 Docs 块级接口直接编辑选定的云文档。

## 2. 权威文档

| 项目／内容 | 唯一入口 |
| --- | --- |
| Server 变更和模块 | [proposal](../../../jugglework-server/openspec/changes/add-jugglework-docs-integration/proposal.md)、[design](../../../jugglework-server/openspec/changes/add-jugglework-docs-integration/design.md) |
| 身份接入 API | [Server api-contract.md](../../../jugglework-server/openspec/changes/add-jugglework-docs-integration/api-contract.md) |
| Desktop 变更和产品宿主 | [proposal](../../openspec/changes/add-jugglework-docs-desktop/proposal.md)、[design](../../openspec/changes/add-jugglework-docs-desktop/design.md) |
| Docs 变更和社区适配 | [proposal](../../../jugglework-docs/openspec/changes/add-jugglework-docs-adaptation/proposal.md)、[design](../../../jugglework-docs/openspec/changes/add-jugglework-docs-adaptation/design.md) |
| 原生宿主桥 | [Docs host-bridge.md](../../../jugglework-docs/openspec/changes/add-jugglework-docs-adaptation/host-bridge.md) |
| 文件上传、附件查看与 AI 编辑 | [Docs design](../../../jugglework-docs/openspec/changes/replace-word-sync-with-cloud-intake/design.md)、[Desktop design](../../openspec/changes/replace-word-sync-with-cloud-intake/design.md) |
| 原生批处理与输入延迟 | [Docs collaboration-performance.md](../../../jugglework-docs/openspec/changes/add-jugglework-docs-adaptation/collaboration-performance.md) |
| 站内和组织群／定向 IM 通知 | [Server notification-delivery.md](../../../jugglework-server/openspec/changes/add-jugglework-docs-integration/notification-delivery.md) |
| 群卡片跳转与多组织访问 | [Desktop card-navigation.md](../../openspec/changes/add-jugglework-docs-desktop/card-navigation.md) |

## 3. 系统职责

| 系统 | 管理范围 |
| --- | --- |
| JuggleWork Server | 全局账号、原 Session、Personal／团队租户、成员和组织角色 |
| JuggleWork Docs | Workspace 投影、Doc 授权、页面、评论、历史、附件和原生协作 |
| Desktop 本地 Server | 本地文件、Office 活跃模型、AI 编辑和保存 |
| Desktop／Web 宿主 | 页面承载、登录交接、组织导航和产品反馈 |

服务依赖方向为 Docs → Server，Desktop 直接装载 Docs。Server 不代理正文、不调用 Docs 文档写入；不新增服务间 API Key、IdP 或 SCIM。可信内网约定不取代用户和租户业务授权。

通知依赖为 Docs → Server → JuggleIM：Docs 负责原生事件、文档受众及站内记录；Server 负责受管组织群、当前组织成员和 IM 投递。无需 Server 反向调用 Docs。

## 4. 个人与团队隔离

| 对象 | 规则 |
| --- | --- |
| 全局账号 | 身份来源，不作为正文范围 |
| Personal | 独立原生 Workspace，只有本人；团队管理员无成员身份 |
| 每个组织 | 独立 Workspace；同一源用户按租户投影不同 AFFiNE User |
| 当前组织 | Desk 仅打开已实际进入的组织；群成员或其他组织管理员不能替代源成员 |
| 正文权限 | 保留 AFFiNE Workspace／Doc ACL，不增加管理员正文旁路 |
| Folder／标签／Collection | 内容组织形式，不充当权限容器，不继承另一产品 Space 规则 |
| 链接 | 只定位，接收者重新授权 |
| 退出再加入 | 新成员代次先 pending_reset，旧 Doc 授权清理完成前拒绝恢复 |
| Personal 的 IM | 不创建组织群、助手通知或团队邀请 |

组织内限定成员文档仍归组织，不等于独立 Personal 存储。原生角色和文档可读／可写矩阵在对应发布模块验收，不能直接复用 Docmost 的 Everyone／Space 权限假设。

## 5. 产品形态

| 场景 | 用户操作 | 结果与失败反馈 |
| --- | --- | --- |
| 云文档首页 | More → 云文档 | 当前租户原生首页，无第二次登录；不可用可重试 |
| 指定页面 | 打开组织内链接 | 同租户定位；不同租户提示切换；无权限拒绝 |
| 管理空间 | Server Web → 云文档管理 | 嵌入原生空间页；组织成员修改仍去原有成员管理 |
| 上传文件 | Office 顶栏或文件操作 → 上传云文档 | 先保存，一次性上传到当前组织；成功提示中可查看云文档 |
| 查看附件 | 点击云文档中的 Office 附件 | Desk 下载原件并用本地 Office 只读打开 |
| AI 编辑 | `@云文档`、粘贴链接、交给 Desk AI 或名称 | AI 按当前用户权限块级修改云文档 |
| 账号／组织切换 | 复用现有菜单 | 先处理未确认状态并停止旧视图 |
| 云文档通知 | 原生站内列表＋IM 卡片 | 全组织可见文档可进受管组织群，限定文档定向；点击重新授权和定位 |

管理嵌入保留 Server Web 外壳和 AFFiNE 原生 Provider。加载 15 秒未就绪显示重试；源身份失效回到既有登录；长期登录令牌不进入 URL。公开分享首版停用，前后端行为一致。

同一 Server 可有多个组织：先登录全局账号，再通过既有选择流程进入目标组织，Desktop 只展示当前组织的 Docs；不需要再登录 AFFiNE。群内使用固定云文档卡片，点击时同组织重新授权定位，跨组织先确认并完成真实切换。Web 多标签各自固定组织，不随 Session 默认选择隐式串用。

不同组织共用 IM App／IM 用户也必须隔离云文档群、助手、历史卡片、预览及未读。系统通知保留接收时来源；旧通知不能使用切换后的账号／Server 猜目标。切换成功但 IM 不可用时保留新组织，Docs 可独立打开；新进入或重开前不展示未重新授权的旧组织缓存。完整状态机和验收以 card-navigation.md 为准。

## 6. 文件上传

| 类型 | 云端结果 |
| --- | --- |
| DOCX／Markdown／HTML | 转换为可编辑页面，页首保留原件附件 |
| DOC／XLS／XLSX／CSV／PPT／PPTX／PDF | 原件附件页面，Desk 本地 Office 只读打开 |

单文件 50MiB，并受 Workspace 原生配额约束。上传后本地文件与云文档独立编辑；再次上传同一文件时选择打开已有或另存为新云文档。

## 7. 权限失效

原会话是持续权威。Docs 新请求／协作连接／入站正文修改在应用前校验当前源状态，不使用 30 秒成员资料缓存授权。正常网络下活动 Session 每 1 秒批量检查，空闲失效连接关闭目标为 5 秒；身份读取 3 秒不可确认则暂停新增操作。

本地输入即时显示，合并复用 AFFiNE 原生 nbstore 每文档 job 和 Yjs mergeUpdates，不沿用 Hocuspocus 参数；源授权、原生发送、远端可见和服务端保存分别验收。

单设备注销只撤销该源 Session 的 Docs 连接；从 A 移除不影响 Personal 或 B；全局停用影响所有租户。移除与重新加入之间即使没有目录刷新，成员访问代次也必须使旧关联失效。源所有权转移、唯一 文档管理者 退出和旧组授权清理分别有明确生命周期。

成员完整分页不保证一致快照；缺席仅形成候选，清理前按当前成员状态及代次复核，不能误删扫描期间恢复者的新授权。

首版同时交付站内和 IM 的提及、评论新增／解决。站内记录与 IM outbox 在 Docs 本地事务提交后异步投递，IM 故障不影响编辑。组织受管群需补建和全员同步；限定页面使用定向 IM，Personal 无 IM。卡片无标题、正文和凭据，历史消息点击也重新授权。两个通道已读独立；外部发送结果不确定显示待确认，不承诺全局 exactly-once。

## 8. 发布与验收

实施顺序为社区基线构建及原生协作／批处理测量 → 身份与 Personal／A／B → Desktop／Web 容器 → 文件上传与 AI 编辑、站内＋组织群／定向 IM → 平台、迁移、备份和发布验收。双通道属于首版验收范围，不能只完成站内就声明完成。

每个项目的 tasks.md 记录任务状态。核心验证必须使用真实身份存储、AFFiNE 服务、原生 SDK 与独立客户端，不能以 mock 或 OpenSpec 结构校验替代。

## 源码集成界面约束

三个端的集成均使用源码。Desk 云文档正常页面不增加“组织名·云文档”及“重新打开”栏；AFFiNE 界面禁用 AI 生成入口、Download App、引导及客户端打开机制／偏好／命令与布局占位。失败保留重试。
