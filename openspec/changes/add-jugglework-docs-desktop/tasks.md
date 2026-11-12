三仓未完成项见 [M4](milestone-4.md)。Desk 设置权威已作为 [M4-D](milestone-4d-managed-settings.md) 完成。文件上传、附件查看与 AI 编辑任务见 [replace-word-sync-with-cloud-intake](../replace-word-sync-with-cloud-intake/tasks.md)。

## 1. 原生基线

- [ ] 1.1 与 Docs 固定基线并跑通两个原生客户端的编辑、评论、历史、断线与重开。

## 2. 导航与宿主

- [x] 2.1 增加组织级云文档路由和 More 菜单，支持 Personal 与团队文案、固定／取消固定、本机持久化及云朵文档专用图标。
- [x] 2.2 实现云视图、POST 交接、受限 preload、布局及覆盖层交互。
- [x] 2.3 衔接账号／Server／组织切换与退出，处理过期异步结果和分区隔离。
- [x] 2.4 实现文档链接定位、无权限、未启用、15 秒超时及重试。

## 3. 联合验收与发布

- [ ] 3.1 完成 Personal／A／B、跨账号、两个设备的真实验收。
- [ ] 3.2 验证 Viewer、权限撤销、服务不可用、原生重连和缓存回放。
- [ ] 3.3 macOS ARM64 生产构建和 1.0 GiB ad-hoc 目录包已通过；macOS Intel、Windows、Team H7PDHSK3C7 正式签名、公证、安装升级和回滚仍未验收。
- [ ] 3.4 验证关闭开关回滚不损坏本地文件或云页面。
- [ ] 3.5 联合 Server／Docs 验收全部规格后再声明交付。

## 4. 通知与批处理

Docs 原生通知／outbox、Server 投递和组织通知管理的分层结果见 [m4-notification-chain.json](evidence/m4-notification-chain.json)。三仓独立数据库＋模拟 IM 联合结果见 [m4-notification-chain-three-repository.json](evidence/m4-notification-chain-three-repository.json)；真实 IM 提供方、操作系统通知中心人工点击和单进程生产部署仍未验收。

- [x] 4.1 启动交接传入 presentation／instanceId，产品页、双标签和旧实例消息丢弃已通过分层验证。
- [ ] 4.2 原生 nbstore 批合并已接通；当前撤权按绑定上下文隐藏并暂停同步，保留原生待同步数据；两个原生客户端已测得 234 次操作合并为 270 字节更新、19.889 ms ACK、19.960 ms 远端可见、重启恢复及 851 ms 撤权，仍需真实 Electron 链路、中文 IME、长文和并发负载验收。
- [x] 4.3 在既有 jugglechat 注册 jw:docs-notification，完成群／定向卡片、会话预览、未知版本兜底、来源校验和展示去重。
- [ ] 4.4 通知点击的新交接、跨租户确认、评论定位、退出／删除／失权、离线 IM 历史和站内独立未读已通过三仓模拟联合验收；Electron 主进程已在启动／重载期间暂存并去重点击动作，渲染器安装监听后交接。真实操作系统通知中心人工点击仍未验收。
- [x] 4.5 按 card-navigation.md 固定卡片模板、真实群／助手映射、接收时来源及系统通知点击上下文，验证转发／伪造／未知来源的无动作兜底。
- [x] 4.6 实现当前组织的群／助手历史、预览、云文档未读及系统提示过滤；单独验收 A／B 共用 IM App 和 IM 用户场景。
- [x] 4.7 切换成功但 im=null、切换结果未知、重复点击和 A→B→C 迟到回调已分层验证：新上下文授权前不显示旧原生缓存，im=null 不重发、未知结果只读核对、跨入口点击合并、旧账号／旧实例回调丢弃。

## M1. 原生云文档基础链路

- [x] M1.1 More 云文档入口与组织级路由。
- [x] M1.2 受限原生视图和一次性交接。
- [x] M1.3 原生创建／编辑／保存／重开链路。
- [x] M1.4 本机开发环境启动及宿主明暗／语言／字体／配色适配。
- [x] M2.1 成员生命周期与权限重置基础闭环已联调；完整权限和清理矩阵由 3.1／3.2 验收。
- [x] M2.2 完成 Web 管理入口、统一外壳及嵌入双标签验收。

范围见 [milestone-1.md](milestone-1.md)；M2 的共享身份、Web 管理基础及完整私有文档未通过项见 [milestone-2.md](milestone-2.md)。

M4 三仓模拟联合验收：Desktop 应用 50 项、Electron 通知动作 5 项、实际卡片／云文档页面 Chrome 组件 7 项、Server 65 项（含子用例）、Docs 原生 14 个场景通过。4.4 保留未完成：真实操作系统通知中心人工点击与真实宿主评论高亮仍须验收。
