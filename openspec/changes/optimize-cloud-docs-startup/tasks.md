# 实施与验收任务

## 设计
- [x] 核对现有宿主、持久分区、授权 context、命令 ready 与保存边界。
- [x] 定义分期设计和增量规范，明确观测与可见性独立、共享 Cookie 回落前的保存范围。

## P0 基线
- [x] 同步 Desk 与 Docs 的 dev 源码。
- [x] 实现可选正文观测、request-content-state 重取与能力协商，覆盖活动文档、表格、幻灯片和主页，保持 command-ready 与保存 ACK。
- [x] 分别记录 Work runtime-config 和 launch、Main command-ready、实际可见、正文 presentable 和诊断结果，内存保留最近 128 条匿名样本。
- [x] 本地验证新旧能力协商、失联回退、迟到消息隔离和保存确认。Electron 44 隔离页验证原生 preload 往返、先展示后收到正文状态，以及站内导航更换观测号。
- [ ] 核验联调客户端和 Docs 运行版本；采集子阶段基线，三种格式及冷／暖／刷新各至少 20 次。
- [ ] 分别冻结重启立即点击、预热命中、活实例恢复的收益目标及资源／失败率门禁；未改善的立即点击路径必须追加有证据优化或收窄发布承诺。

## P1 活实例恢复
- [x] Main 接入主框架重载、渲染进程退出和宿主绑定失效。恢复开关为 `JUGGLEWORK_DOCS_LIVE_RESUME=1`，默认关闭。
- [x] 实现全页候选发现与 claim。Desk 测试覆盖跨租户、旧绑定和新增评论定位的拒绝路径。
- [x] Docs 通过专用 resume handler 解析原生 Cookie、消费新 grant 并复核现有权限。服务单测验证绑定和消费范围，handler 不写入 Cookie 或执行目录投影。
- [x] 接入 context header、10 秒超时及结构化失权判别，支持表明需要重新交接的响应。Desk 测试验证同分区后台保存未确认时阻止 fallback bootstrap。
- [x] 使用隔离 HTTP fixture 和真实 Electron 44 验证主窗 reload、原生 HttpOnly Cookie 发送、相同 WebContents 与内存草稿，以及新增 bootstrap 数为零。
- [x] 无主视图在 120 秒后尝试一次保存确认。保存失败保留原生视图，重新打开时显示本地保存提示。
- [ ] 在真实 Work 与最新 Docs 环境验证 IME／Office 草稿、在途导入和 AI 回执、私有范围、切换身份、reloadIgnoringCache 和 renderer gone。

## P2 重启加速
- [x] Main 保存一条带版本的最近目标定位，7 天有效。退出登录或确认会话失效后清理。单测验证账号和组织隔离以及字段白名单。
- [x] 首屏挂载后等待 2 秒和空闲时段。Main 登记单目标，初始化期限 30 秒，ready 后未使用保留 120 秒。身份变化撤销登记并走保存清理。
- [x] 显式打开与预热共用 Main 登记。隔离 Electron 测试验证相同目标的 pending 点击复用同一个原生视图和一次 bootstrap。
- [ ] 验证磁盘缓存／本地引擎实际命中及各格式限制，不改授权前正文门禁。
- [ ] 对 CPU／内存／首屏、网络和误建实例数进行基线比较后再启用默认预热。

## P3 观测与发布
- [x] 本机开发 Desk 已在 Work 测试环境打开 Docs。Electron 混合版本测试验证新 preload 遇到未注册的可选 IPC 能退回正常打开。
- [ ] 复核正文观测号、重复 claim、先于订阅的完成、home 状态、独立能力缺省及观测查询失联；隐藏页未绘制不阻塞前台可见性，不新增实例。
- [ ] 执行设计第 9 节完整测试矩阵与真实双用户协作／保存验收。
- [ ] 验证新旧 Desktop／Docs 兼容、独立开关、回滚及未保存实例保护。
- [ ] 按独立能力开关完成发布与回滚验收。
