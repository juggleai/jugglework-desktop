# 发布验收

本轮 macOS ARM64 本机实现与验收完成。正式发布仍须完成外部平台、签名、公证及安装门槛。

| 范围 | 必须验证的结果 |
| --- | --- |
| 同一会话 | 两 renderer 使用相同 workspace/session；历史不复制、不创建新 session；主窗口切会话不改文件窗口归属 |
| 模块复用 | 两处使用同一 SessionSurface 和装配/控制代码；文件窗口没有独立消息/运行存储与业务实现 |
| 发送与停止 | 竞争发送沿用服务端仲裁，不触发两个自动消费者；另一窗口能停止同一 run；冲突/失败保留本窗口输入 |
| 交互与刷新 | 根/新建子任务的 permission/question 结果刷新到两处；健康 SSE 下也能发现首条子交互；断线重连重新读取，无本地伪成功 |
| 局部草稿 | 窗口 A 的输入和附件不覆盖 B；IME 不误提交；首版文件窗口不运行 follow-up drain 或 goal continuation |
| 凭据与请求 | state 无全局 token；文件窗口与主窗口/其他文件窗口 storage 隔离；伪造 sender、其他会话、未登记 fileEditor 路径、任意 URL/header、重定向和销毁后的请求被拒绝；正文不向无权窗口广播 |
| 策略与恢复 | 每次发送按最新可信策略及真实 provider 校验；策略暂不可用时关闭能力，恢复后原窗口可重试；model/variant 展示与实际提交一致 |
| Office 布局 | 实际分栏更新 native bounds，无覆盖、重开模型或 owner 迁移；收起不丢 dirty/撤销/任务 |
| 文件回归 | 无归属外部文件创建或复用默认工作区和真实会话，原文件不复制；保存回原路径，父目录不登记为工作区 |
| 数据库 | 不新增表、不升级 schema、不更换 runtime DB 路径；既有队列和历史继续使用原存储 |

自动测试与真实双窗口、原生 Office 场景分别记录实际结果；没有执行的场景保持未验收，不以单元测试数量替代。

## 当前覆盖与剩余门槛

- 完整 SessionRoute/FileWindowApp、真实 Server/临时 SQLite 与真实 OpenCode 已通过同会话发送、竞争 409、双向停止、清 queue/claims、SSE 终态及 journal 核对，丢终态负控必须失败。该组 provider/账号为合成协议。
- 实际开发实例使用已有登录和 gpt-6.1-sol，通过无缓存、无主窗口启动、中文外观、真实回复、错误后重试、重启历史及同会话跳转；忙碌时第二次 start 返回 409/session_busy。
- 真实 provider 已通过双向跨窗口停止、运行期间重载恢复且不重发、两处权限展示和 File 拒绝。精确拒绝工具错误在权威空闲后以 aborted 收尾，下一次请求可直接成功；普通工具错误不得释放运行。
- CSV 两宿主选区、Word 两宿主选区和 PPT 两宿主单页真实修改、原路径保存及回读已通过。并发首次打开相同文件或硬链接只登记一个 document/page/model；真实共享 Word 的交付卡片完整。
- 四格式原生 UI 输入及撤销/重做、两 Composer 拼音、连续组合、Enter/Escape/Tab、面板焦点恢复，以及 Word/PPT/XLSX 原生中文已验证。DOCX 源码及 CSV/XLSX/PPT 本地包实际点击取消/放弃/保存关闭通过；不把放弃解释为回滚已自动保存的内容。
- 两宿主原生另存为取消保留草稿；Main 文件选择器无效工作区目标、File 文件选择器损坏 XLSX 和最近文件失效均保留原文档及草稿。主窗口切换其他真实聊天后 File 归属和草稿保持。代次、排队、移动光标及恢复由对应回归覆盖。
- App/Electron/Server 类型检查、完整桌面构建、920 项桌面默认测试及既有 46 项 App 定向回归通过；最新主窗口生命周期与文件会话/布局定向 24 项、Office 272 项、权限模式 33 项通过。打包资源门禁拒绝网页绝对路径及缺失资源。
- macOS ARM64 ad-hoc 包静态架构、版本、更新源、ToonFactory 清单、源码匹配和 deep/strict 签名通过；实际包四格式修改、保存及关闭重开通过。零用户工作区主窗口实际进入登录页，四格式存活时正常退出码 0；最新包权限首次保存 API 及正常退出通过。隔离包无复制凭据，真实已登录 provider 验收使用源码正式 main.mjs；正式发布前须在正常登录的包内补跑 provider smoke。
- 真实根 question、新建子任务 question 和子任务 permission 两端展示及共同收尾通过；健康 SSE 下 File 发现首个子问题，Main 回答问题、File 拒绝子权限均通过。使用已有 build Agent 的 question 能力，默认 jugglework 的 deny 不变；仅专用子会话收紧外部目录为 ask，不扩大全局授权。
- 新会话首次保存请求审批已修复，源码及实际包 API 返回 200 并持久回读 revision=1；无 grant、无 schema 变更。
- 用户确认暂时没有 Windows x64、macOS Intel 实机与本项目团队的 Developer ID/公证配置，记录为外部待验项。既有 sandbox harness 的嵌套沙盒失败不作为产品启动结论。
- 详细结果、性能样本与能力边界见 `implementation-status.md`。全部剩余门槛满足前，不宣称完整发布验收通过。
