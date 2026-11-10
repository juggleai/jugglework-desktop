# M4：云文档全量交付

范围：此前三个项目全部未完成任务，包括 M2 私有范围、M3-A～C 未完成项、原 M4 通知及发布验收。原有需求和 W-01～W-16 不删减。状态：实施中，未达到完整交付门槛；实验通过不自动开放 linked。

| 编号 | 交付范围 | 主要归属与依赖 | 验收状态 |
| --- | --- | --- | --- |
| M4.1 | 迟到 Word 操作的原生相对位置映射、同位置插删、结构／文本组合及正式桥 | Docs 原生对象／Yjs → Desk SDK；沿用 editor.attach/apply/changed/state 契约 | 正式三段宿主桥已接线并通过控制器回归；完整真实运行矩阵待验收 |
| M4.2 | 支持集合补齐：标题／列表／样式、链接、基础表格、内嵌图片、评论锚点、AI admission、真实 IME、undo／redo | 固定 SDK 和 BlockSuite 原生命令；不支持或无法确认时暂停 | 待验收 |
| M4.3 | 正式单写绑定、文件身份／定位、共同检查点、首次关联及重开／云端单独变化恢复、分叉和 unknown 处理 | Desk 原子文件写入＋原生缓存／状态向量；账号／租户／模型代次绑定 | 待验收 |
| M4.4 | 文件 preview/commit/status、Office 保存准备、产物上传、转换预览、附件模式与请求去重 | Desk → Docs 原生编辑／附件及 ACL；不以导入导出代替 Word 双向 | DOCX page 模式的原件、任务状态和去重已实现；页面内附件块、通用附件模式和扩展转换对象待验收 |
| M4.5 | 私有目录元数据／缓存隔离、成员生命周期、所有权、搜索／历史／附件／回收站／导出权限矩阵、Web 管理 | Docs 原生权限＋Server 当前目录；共享根 Y.Doc 的私有元数据问题必须实际解决 | 私有隔离、缓存、转交、离职／重入及部分资源矩阵通过；其余待验收 |
| M4.6 | 同事件站内通知＋持久 IM outbox、Server 分片幂等接收／状态、受管组织群／助手、成员核对与 unknown | Docs → Server → JuggleIM，按 notification-delivery.md | Server 65 项、Docs 原生 14 个场景、管理组件 8 项交互及三仓模拟联合验收通过；真实提供方待验收 |
| M4.7 | 卡片、评论定位、组织切换和 im=null、历史／未读／通知来源过滤、同 App 多组织隔离 | Desk 既有 IM、自定义消息和 docs/launch；载荷不授予访问权 | 应用 50 项、Electron 点击交接 5 项及 Chrome 组件 7 项模拟通过；真实 OS 通知点击与正式宿主链路待验收 |
| M4.8 | 原生批处理与输入／持久化性能、失权及关闭顺序、故障恢复、生产部署／备份、三平台正式包和回滚 | 三仓联合及真实运行环境；各平台逐项记录 | 本机 ARM64 原生协议、进程重启、数据库恢复和未签名目录包通过；真实 UI／Word、旧原生库升级、Intel、Windows、签名公证待验收 |

依赖顺序：M4.1 是 M4.2～4.4 的前置；M4.5 与 Word 链路独立推进，但阻止私有模式发布；M4.6 的事件和成员服务是 M4.7 的前置。M4.8 验收全部已实现模块，不能用单个样例代替完整矩阵。

三个项目 tasks.md 的原始未完成项继续保留，按对应验收事实逐项关闭。任一关键链路未实现、未知外部发送、缺少真实平台证据或存在私有范围泄漏时，不声明本里程碑完成。

本轮 IM 验收使用模拟提供方，覆盖成员分页、回执、明确失败、超时未知结果和卡片跳转，不要求真实组织 ID；结果不得描述为真实 IM 提供方已验证。

已完成 Server SDK／持久化／worker、Docs 原生事务 outbox、权限复核与管理组件的分层验证，详见 [通知证据](evidence/m4-notification-chain.json)。三仓独立数据库＋模拟 IM 联合链路见 [联合证据](evidence/m4-notification-chain-three-repository.json)；卡片跳转、桌面历史／未读筛选及受限系统通知动作见 [卡片证据](evidence/m4-im-cards.json)。真实 IM 提供方、操作系统通知中心人工点击及单进程生产部署仍未验收。

2026-11-07 的本机 ARM64 源码构建、未签名目录包、原生协作延迟、进程重启和数据库恢复事实见 Docs 仓库 [本机发布证据](../../../../jugglework-docs/openspec/changes/add-jugglework-docs-adaptation/evidence/m4-performance-release-local.json)。该证据不替代真实 Electron／Word、中文 IME、长文、并发负载、跨平台和正式签名验收。

相关规格：[Word 矩阵](word-adapter.md)、[检查点与恢复](word-recovery.md)、[卡片导航](card-navigation.md)、[原生宿主桥](../../../../jugglework-docs/openspec/changes/add-jugglework-docs-adaptation/editor-bridge.md)、[通知投递](../../../../jugglework-server/openspec/changes/add-jugglework-docs-integration/notification-delivery.md)。
