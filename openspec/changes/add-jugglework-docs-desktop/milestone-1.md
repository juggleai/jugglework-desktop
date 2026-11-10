# M1：源码集成 AFFiNE 云文档

当前实现基于公开 AFFiNE 源码固定 commit `8bbbfcf07874078bcb37cf88c40b81002382d0ba`（0.27.5），源码编译 Web、NestJS Server 和 Rust NAPI。没有连接 AFFiNE 云端产品页面。

| 本机组件 | 配置 |
| --- | --- |
| Desk | Vite 15173，现有 Electron 开发启动方式 |
| Go Server | 18020，独立测试 MySQL 13316 |
| AFFiNE | 13010，t-<tenantKey>.docs.localhost:13010 |
| Docs 存储 | 独立 PostgreSQL、Redis 16389、独立附件目录 |

More → 云文档进入当前已登录组织，使用源 Session 一次性交接。工作区、源用户投影和 host-only Cookie 按租户隔离。仅本机允许 HTTP；生产须 HTTPS、Host 透传和 WebSocket 代理。

正常页面只有 Desk 导航和原生文档布局，**没有顶部“组织名·云文档”或“重新打开”栏**。加载失败保留重试。集成页面禁用 AFFiNE AI 生成入口、浮动 AI、Download App、首次引导、客户端打开偏好和提示／命令／设置入口，不保留相应布局占位。主题、语言和语义色跟随 Desk，不重建原生协作。

已验证：Desk 内创建、标题／正文编辑、PostgreSQL 持久化、离开后新交接重开；两个真实成员用原生 Socket.IO/Yjs 修改、广播及重新加载；A/B/Personal 工作区隔离、跨 Host／Workspace 拒绝、源注销约 392ms 断开且另一成员有效；明暗和中英切换保留正文与连接。完整迁移后 PostgreSQL 用户 schema 外键与 CHECK 为零。

正文协作沿用原生机制，焦点切换只触发上游索引节能调度，不停止正文同步。账号／组织／Server 变化仍先销毁旧视图。连续三次普通配置刷新及跨越一次 60 秒后台会话检查后，文档和内容保持；原生引擎确认 synced=true、syncing=0。

当前仍未完成：完整 Word／AI 对象集合、页面内附件块与通用附件模式、通知真实联合链路、跨平台正式包和生产部署。Web manage、成员生命周期基础闭环、DOCX 原件 page 接入、共同检查点、受支持 Word 基础对象桥和站内＋IM 分层能力已实现。准确范围见 tasks.md。

受管 M1 暂停 StorageWorkerModule 的自动存储清理任务，正文快照与同步保持原生运行；完成应用层关联完整性验收后再开放清理。
