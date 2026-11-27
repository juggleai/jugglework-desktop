# 实施与验收任务

## M0 技术验证（阻断后续阶段）
- [ ] macOS、Windows 打包版：`getMediaSourceId()` 采集主窗口，画面包含 Docs `WebContentsView`；主窗口最小化时的表现。
- [ ] 部署版 JuggleIM：聊天室发送 `isStatus` 自定义消息只投在线、不进历史；每秒 5 条持续 1 分钟无限流，记录乱序与丢失比例。
- [ ] Electron 原型：会议窗口 `contentView` 挂 Docs 视图，主渲染器在会议窗口文档中测量 bounds，验证焦点、输入法、弹窗遮挡、保存屏障。
- [ ] Docs 原型：页面模式块锚点读取与应用，在 3 种窗口宽度、长文档、折叠块下误差不超过一屏的 10%；页面级缩放下光标、选区与弹层位置。

## M1 共享弹窗与 JuggleWork 窗口（仅 Desktop，可独立发布）
- [x] 标题「共享」，「桌面与窗口 | 云文档」分段（页签已实现）。
- [x] 页签切换时取消并重新发起采集请求，超时只清空该页。
- [x] 「桌面与窗口」首位固定 JuggleWork 主窗口项，源不在枚举结果时提示改选。
- [x] 主窗口「正在共享此窗口」提示条与停止按钮。
- [x] 「云文档」页先以「即将支持」占位（已由 M4 的真实列表取代）。
- [x] 选择器回归测试。
- [ ] 打包版双端验收。

## M2 Server 共享槽
- [x] `MeetingShare` 字段，`claim-share`、`release-share` action，离会、移除、结束时清理，90 秒未续期时快照投影为空。
- [x] 单测覆盖替换、本人与主持人释放、过期 shareId 释放、非在会者拒绝。
- [x] Desktop 屏幕共享先 claim 再推流，按快照显示共享人。

## M3 Docs
- [x] 会话侧 `session/docs/recent`、`session/docs/search`，复用 App 目录、ACL 与 `contentKind`。
- [x] `meetingViewport` 能力：`docs.viewport`、`docs.sharer-relation` 上报，`apply-viewport`、`open-page`、`zoom` 命令，页面与白板模式（代码已写，待 M0 原型验证精度）。

## M4 文档妙享
- [x] Desktop：`jugglework:docs:api` 增加 `recent`；preload 字段白名单与长度校验。
- [x] `cloud-docs-panel` 会议入口：所属窗口为会议窗口，控制方为主窗口，同 workspace 页内跳转，保存后销毁，不参与恢复与预热；bounds 与遮挡检测支持会议窗口文档。
- [x] 注册 `jw:meeting-share-docs`（`isStatus: true`），节流发送、3 秒重发、seq 与快照校验、10 秒中断提示。
- [x] 文档内共享人位置标记：自由浏览时显示，页面模式画块位置线与上下提示，白板模式画视口中心与边缘箭头，共享人换文档时清除。
- [x] 界面：「云文档」页列表与搜索、文档舞台、竖向视频栏、共享状态条（跟随中 / 自由浏览中 / 你正在共享）、位置提示、成为共享人、异常状态。
- [x] 双端真实环境验收（本地 Desktop 双实例连接测试环境，两个组织成员）：跟随（约 0.5 秒内对齐）、自由浏览与位置标记、跟随共享人、共享人换文档后的提示与跳转、换人共享、停止共享、中途入会、10 秒位置同步中断提示与恢复。
- [ ] 无权限成员：参会者打开无权访问的共享文档时显示无权限提示。

## 部署（2026-11-27，测试环境 47.237.210.32）
- [x] Work：二进制基于 `9715d1c`，同批带上 `eb15adc` 之后的任务模块提交与 6 个迁移（`2026112303`、`2026112501`、`2026112601`、`2026112602`、`2026112603`、`2026112604`），迁移已应用，`product_tasks` 21 行完整；`/jwork/api/health`、`/jwork/api/ready` 与公网 runtime-config 返回 200。部署前备份旧二进制、配置与 `jwork_db` 导出。
- [x] Docs Web 更新：发布目录 `meeting-web-7353415dd-20261127T083821Z`，只替换 Web 静态资源（`7353415dd`，页面锚点改取最内层正文块），Server 仍为 `ec5238c27`；部署前备份 PostgreSQL，上一版 `meeting-ec5238c27-20261127T060324Z` 保留可回滚。
- [x] Docs：发布目录 `meeting-ec5238c27-20261127T060324Z`，Server 与 Web 静态资源均为 `ec5238c27`；`/info` 返回 200，无会话访问 `session/docs/recent`、`session/docs/search` 返回 401。部署前备份 PostgreSQL，上一版 `review-d1a22ae88-20261126T082902Z` 保留可回滚。- [x] 单端真实环境（本地 Desktop 连接测试环境）：共享 JuggleWork 窗口与云文档均可开始、停止，服务端共享槽随之占用与释放；云文档列表加载，表格与幻灯片灰显。
- [ ] 打包 Desktop 后在测试环境完成 M0 验证与双端真实环境验收。

## 后续
- [ ] 表格与幻灯片定位、主持人全员跟随、移交共享。
