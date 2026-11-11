# M4：云文档全量交付

范围：三个项目全部未完成任务，包括 M2 私有范围、通知、文件上传与 AI 编辑及发布验收。状态：实施中。

| 编号 | 交付范围 | 主要归属与依赖 | 验收状态 |
| --- | --- | --- | --- |
| M4.1 | 文件一次性上传、DOCX／Markdown／HTML 转换、原件附件页面、重复上传选择 | Desk → Docs file-intake，见 [replace-word-sync-with-cloud-intake](../replace-word-sync-with-cloud-intake/design.md) | 待实现 |
| M4.2 | 云端附件下载与 Desk 本地 Office 只读打开 | Docs 附件下载接口＋Desk 文件窗口 | 待实现 |
| M4.3 | Desk AI 定位并块级编辑云文档 | Desk 本地 MCP → Docs ai 接口 | 待实现 |
| M4.4 | 移除 Word 双向同步代码 | Docs、Desktop、Server | 待实现 |
| M4.5 | 私有目录元数据／缓存隔离、成员生命周期、所有权、搜索／历史／附件／回收站／导出权限矩阵、Web 管理 | Docs 原生权限＋Server 当前目录 | 私有隔离、缓存、转交、离职／重入及部分资源矩阵通过；其余待验收 |
| M4.6 | 同事件站内通知＋持久 IM outbox、Server 分片幂等接收／状态、受管组织群／助手、成员核对与 unknown | Docs → Server → JuggleIM，按 notification-delivery.md | Server 65 项、Docs 原生 14 个场景、管理组件 8 项交互及三仓模拟联合验收通过；真实提供方待验收 |
| M4.7 | 卡片、评论定位、组织切换和 im=null、历史／未读／通知来源过滤、同 App 多组织隔离 | Desk 既有 IM、自定义消息和 docs/launch；载荷不授予访问权 | 应用 50 项、Electron 点击交接 5 项及 Chrome 组件 7 项模拟通过；真实 OS 通知点击待验收 |
| M4.8 | 原生批处理与输入／持久化性能、失权及关闭顺序、故障恢复、生产部署／备份、三平台正式包和回滚 | 三仓联合及真实运行环境 | 本机 ARM64 原生协议、进程重启、数据库恢复和未签名目录包通过；真实 UI、旧原生库升级、Intel、Windows、签名公证待验收 |

依赖顺序：M4.4 先于 M4.1～M4.3；M4.5 阻止私有模式发布；M4.6 是 M4.7 的前置；M4.8 验收全部已实现模块。

本轮 IM 验收使用模拟提供方，覆盖成员分页、回执、明确失败、超时未知结果和卡片跳转，不要求真实组织 ID。

Server SDK／持久化／worker、Docs 原生事务 outbox、权限复核与管理组件的分层验证见 [通知证据](evidence/m4-notification-chain.json)。三仓独立数据库＋模拟 IM 联合链路见 [联合证据](evidence/m4-notification-chain-three-repository.json)；卡片跳转、桌面历史／未读筛选及受限系统通知动作见 [卡片证据](evidence/m4-im-cards.json)。

2026-11-07 的本机 ARM64 源码构建、未签名目录包、原生协作延迟、进程重启和数据库恢复事实见 Docs 仓库 [本机发布证据](../../../../jugglework-docs/openspec/changes/add-jugglework-docs-adaptation/evidence/m4-performance-release-local.json)。

相关规格：[卡片导航](card-navigation.md)、[原生宿主桥](../../../../jugglework-docs/openspec/changes/add-jugglework-docs-adaptation/host-bridge.md)、[通知投递](../../../../jugglework-server/openspec/changes/add-jugglework-docs-integration/notification-delivery.md)。
