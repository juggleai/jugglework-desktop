# 云文档刷新恢复与重启加速设计

## 1. 目标、事实与非目标

覆盖三种情形：普通切换复用；同进程宿主强刷恢复；完全重启后的授权打开与受控预热。冷启动仍需执行授权、脚本和编辑器初始化，目标是减少重复工作、提前可安全提前的工作，并定位剩余慢点，不以假 ready 或缩短超时掩盖延迟。

常规进入由 Desktop 申请一次性交接凭据并打开受限 WebContentsView。Main 维护与 React 独立的原生视图注册和来源／账号／组织隔离分区。Docs 的 context 轮询为 15 秒；命令 ready、正文展示和保存确认是独立状态。

不改变 ACL、失权策略、协作／CRDT、草稿归属、Office revision、保存 ACK、关闭屏障或现有 view render key。不新增锁、分布式缓存、跨实例正文共享或常驻多目标预热池。没有缓存时保持现有正确流程。

## 2. 两种恢复路径

| 场景 | 保留什么 | 必须做什么 | 不执行什么 |
| --- | --- | --- | --- |
| 普通切换 | 原生实例与当前正文 | 现有可见性判断 | 不重新 launch |
| 主界面强刷 | Main 中的原生实例、协作、保存 | 隐藏、撤销旧宿主能力，当前授权确认后重新接管 | 成功恢复不 bootstrap、不重建编辑器 |
| 完全退出／崩溃重启 | 磁盘静态缓存、原有文档存储、有限目标定位 | 新 launch／bootstrap、context 校验、正常正文同步 | 不序列化原生实例，不离线绕过授权 |
| 身份改变／失权／原生页崩溃 | 按现有规则保护本地草稿 | 禁止恢复旧页，当前身份重新打开 | 不把历史 ready 当授权 |

## 3. Main 生命周期与身份

每个可恢复前台产品页登记 ownerWindow、preload 私有的宿主绑定号、instanceId、来源／账号／tenant、Docs origin、实际 context 和目标。Main 维护主框架代次，在重新加载或渲染进程退出时撤销绑定。会话文件面板、独立文件窗口、后台 AI／上传页和 manage 页不参与本期刷新接管。instanceId 是展示身份，不是授权凭据。

只维护简单状态：`attached → detached → validating → attached`；另外有 denied、failed、closing。主框架非原地导航或 renderer gone 时，Main 隐藏该窗口产品视图、使旧绑定号失效，保留实际文档与保存任务。新 renderer 无权在校验前使用 bounds、引用、布局、api、fileIntake 或 close 操作旧实例；所有异步完成检查原实例与绑定号。不要把 detach 等同于关闭或失权。

恢复查询仅对受信任的所属窗口顶层 IPC 开放，不返回正文、凭据、截图或其他窗口实例。Main 可返回候选展示定位，但候选在校验完成前不可见。旧 renderer 的迟到 cleanup／close 不能关闭已由新绑定号接管的实例。

全页 home 的恢复语义是“回到本进程该宿主最后实际浏览位置”。Main 从同 origin 的实际路由及已校验 context 得到候选 `{workspaceId,pageId}`，其中路由 docId 映射为授权 target 的 pageId；若是列表，则为 home。renderer 自报目标不是实际路由凭证。申请 fresh grant 使用该解析后的候选目标，而非一律 home；私有页及 baseWorkspaceId 仍由 Docs 复核。

显式文档／评论深链优先于恢复记录。仅相同 workspace／page、且没有新增 commentId 定位要求时可直接恢复；不同文档、同文档新评论、跨 workspace 或不能可靠解析的路由，第一期一律先完成原视图保存，再按显式 target fresh bootstrap，沿用原有评论缺失提示和 mode 选择，不新增导航桥，也不承诺此路径零导航。会话与独立标签以稳定来源和 tab 标识匹配，不能仅按同 docId 合并。第一阶段只实现全页宿主，其他宿主继续原流程，不声明已支持。

## 4. 恢复时的授权确认

Main 的旧 ready 或 15 秒轮询不够，恢复前需要当前 Work 会话重新确认。新 renderer 仍调用现有 Work docs/launch，使用候选原 instanceId、当前目标和 product mode 获得新的一次性 grant。沿用现有账号／组织状态失效检查，不持久化 grant。

Docs 增加受限 POST `/api/jw/session/resume`：用该原生 Session 的 fetch、同 origin、no-store 和短超时发送 fresh grant、实例与预期 context。复用 bootstrap 的权威 grant 消费校验及正常 context／页面 ACL 校验，比较当前源会话、成员 generation、tenant、展示实例、base workspace 与实际 scope；不 issueUser、不替换 Cookie、不投影目录、不导航、不修改原 context。只有所有绑定保持一致时返回固定 `resumed` 及非敏感当前 context／路由；不返回正文。授权结果仅用于本次 claim，不形成 TTL 权限缓存。

需要以服务端实际 grant/context schema 证明完整绑定可比较；缺字段必须在既有消费结果内增加明确字段或拒绝 resume，不以 renderer 自报身份或 authToken 指纹代替。scope 与私有页规则沿用 context service；跨 workspace／私有 scope 变化返回 `requires_bootstrap`，不放宽权限。

只有可识别的结构化会话失效／成员无效／context 变更业务码触发既有失权保护；不按 HTTP 401／403 本身推断用户失权，代理认证或权威服务故障走隐藏、可重试状态。binding mismatch 禁止展示，不删除本地草稿。网络故障保留隐藏实例，不覆盖 Cookie。404／不支持可回落 fresh launch，每次回落重新申请 grant。

现有 Main 的 `open` 保存确认覆盖同实例替换和部分当前视图替换；保留标签、独立窗口与后台页可能共用同一原生分区及 Docs origin。Docs bootstrap 会在原生会话无法复用时换发 Cookie 并撤销原绑定。P1 回落前若无法证明旧会话可复用，须对可能受同一 Cookie 替换影响的视图执行现有 `prepareClose`，包括其他窗口与后台视图。任一保存未确认时保留实例并提示重试，暂缓回落。确认可复用时保留其他视图；原候选释放仍须完成自己的保存确认。不得以本地 ready 或推断当前账号相同证明 Cookie 可复用。

### Resume 接口合同

- Main 使用候选原 nativeSession 对固定 Docs origin 发起 POST，`credentials: include`、`cache: no-store`、10 秒超时；header `x-jugglework-docs-context` 为候选实际 context，body 为 `{launchGrant,instanceId,expectedContextId,target:{kind,workspaceId,pageId?}}`。恢复目标的 workspaceId 始终为实际原生位置。Work 的 home grant 仍只声明 home，Docs 另外核对实际 workspaceId 等于基础工作区；page grant 核对 workspaceId 和 pageId。含评论的定位使用正常交接。
- 200：`{outcome:"resumed",grantState:"consumed",instanceId,contextId,workspaceId,pageId:null|string}`；409：`{outcome:"requires_bootstrap",grantState:"consumed"|"not_consumed",reason}`。结构化已确认失权使用现有会话业务码；基础设施错误使用 502／503 及 `authority_unavailable`，不伪装失权。非结构化响应、超时或断连接视为 grantState unknown；任何非成功路径后再次 launch 都申请新 grant，不以 not_consumed 优化重用。
- 实现抽取无目录投影的 grant 消费／绑定比较与只读 ACL 检查，不能直接调用会 directory.open 的 bootstrap／authorize。角色投影不一致、缺少 scope 或成员数据时返回 requires_bootstrap，由正常流程修复，不在 resume 中执行目录同步、issueUser、SessionIssuer 或 Set-Cookie。业务源 grant 消费本身仍为一次性写入，不把“只读恢复”描述为完全无服务端状态变化。
- 通用 AuthGuard 在 resume 路由委托给专用 handler。handler 只用原生 Cookie 解析 Session，随后通过新 grant 和 ACL 校验，保持响应 no-store。Docs 从已授权 context 发布能力声明，旧服务缺少能力时直接走正常交接。

校验期间若发生退出、组织切换、原生导航、context 变化、deny 或原窗口关闭，结果作废。Main 在单个 await 前后检查同一实例及宿主绑定，不引入新锁。成功后先恢复状态订阅、主题、真实布局及引用来源，再允许可见；不能重放旧 API／上传／编辑请求。

## 5. 清理与保存

明确关闭／切换身份继续 prepare-close，任一保存未确认则保留隐藏原视图与错误恢复入口；不得为释放内存丢草稿。detach 不触发正文重载和自动保存以外的新业务写入。未决 AI／上传请求的业务任务继续由原实例执行；旧宿主等待者失效标记结果未知，恢复后只允许用原 requestId 查询现有幂等回执，不自动再次 create/edit/commit。

无主实例隐藏保留 120 秒后仅做一次保存屏障清理；超时／失败保留并提示未保存状态，不持续新建替代实例。每个全页宿主最多一个可恢复实例；显式目标打开先接管或完成原视图保存，不能因匹配失败不断堆积。窗口真正关闭或应用正常退出沿用 prepareQuit，全部确认后释放；强杀不承诺在内存中的最后输入已落盘，仍依赖原有草稿恢复。

## 6. 重启后的定位、缓存与预热

Main 私有 userData 中仅存一个最近成功展示目标：格式版本、规范化 Work origin、userId、tenantId、已验证 Docs origin、目标 kind／workspaceId／docId 和更新时间。最多 7 天有效；文档 ID 属于私有使用记录，不进 Git／遥测。没有标题、正文、截图、comment 文本、grant、token、Cookie、contextId 或授权指纹；没有真实秘密进入本提案。退出登录／账户移除删除定位；组织切换取消当前预热，记录仅在完整身份匹配时可用。无定位时不预热。

身份与组织加载确认、主窗首屏可交互后至少空闲 2 秒，调度最多一个可取消预热，最长 30 秒；不阻塞聊天、会议或首屏。按最近目标执行正常 launch／bootstrap，创建可前台接管的“全页宿主预热实例”，与现有 AI background 页隔离。隐藏但给正常布局尺寸，不聚焦、不自动开始导入／导出／AI／写操作；正常协作可能连接和同步，属于现有打开语义。无额外网络探测，离线／权威不可用即停止本次预热，不自动重试风暴。

用户打开与预热共用 Main 的一个全页打开登记：执行调度前检查 pending／attached，任何明确用户打开都取消尚未启动的本次启动预热。若用户先打开相同目标则不补建预热；先打开不同目标也不再预热旧目标。预热先开始且目标相同时，点击复用进行中的 Promise 和实例；尚未成功则继续正常 loading，不能再开第二份。点击不同显式目标、切换组织／账号、会话失效、窗关闭时取消“展示接管”；仅在安全保存后清理实例，不把 Abort 等同于服务器已取消。预热未使用 120 秒后保存确认清理；会话后来恢复正常时由下一次明确用户打开决定重试。

沿用 persistent partition 的 HTTP 缓存与 Docs 原有 IndexedDB／nbstore，不复制快照到 Main，也不新增跨身份缓存；内容指纹资源走 immutable，HTML／manifest 原策略保留。现有 context 授权前隐藏正文，授权后本地引擎恢复、远端同步和 capability 判定仍按现行合同。表格／幻灯片不保证存在可独立离线展示的快照，未实测前不能承诺“先显示旧表格”。不清除 Cookie／缓存来实现重启恢复。

预热通过 `JUGGLEWORK_DOCS_STARTUP_WARMUP=1` 独立开启，默认关闭。显式主页请求仅接管主页预热，文档定位须同时匹配 workspaceId 与 pageId。缺少 workspaceId 或包含评论定位的深链仍经正常交接，以服务端解析的范围为准。

## 7. 正文可展示与耗时

保留 `docs.ready` 为命令桥就绪。新增可选、纯展示 `docs.content-state`：instanceId、contextId、workspaceId、targetKind（home／document）、docId（home 为 null）、Main 下发本次观测号、状态 `loading|presentable|error`；无正文和凭据，经过原有 origin／frame／实例校验。能力声明 `contentState:1`／`resume:1` 可独立缺省；旧 Docs 按现有 command-ready 显示原生页面、由内部 loading 接管，正文诊断记 unsupported，不无限等待 content-state，也不超时伪造 presentable。

仅缺少 contentState 不影响已授权的 resume／实例复用；缺少 resume 才按保存及同分区保护回落 bootstrap。当前授权、宿主绑定和正常 command-ready 展示条件完成后，原生页可见性不等待 content-state；该信号只用于诊断及不遮挡既有交互的状态呈现，不新增盖住正文的外部 loading 门槛。隐藏预热未获得绘制机会仍可转为前台，由既有 Docs 内部 loading 接管，不等待其自身 presentable。声明支持但查询 5 秒未响应时，本次诊断记 unavailable，继续既有展示路径，不伪造 presentable、不触发额外 bootstrap／新建实例；已返回 loading 的正文初始化可继续正常进行，不受此查询响应超时限制。

开发版热更新时，新 preload 可与旧 Main 共存。可选 IPC 通道未注册时沿用正常打开。已注册通道报告的权限、保存和请求失败继续按既有语义处理。

Main 在订阅完成、fresh 打开／claim／预热接管时，经受限 preload 发送 `request-content-state {instanceId,contextId,observationId,targetKind,workspaceId,docId}`。Docs 核对当前实际路由和 context 后重新评估现有编辑器／列表，不重挂载；立即返回当前状态，之后状态变化继续携带该观测号。已就绪编辑器重新请求仍返回 presentable。每个宿主仅保留当前一个观测，目标不匹配的请求直接忽略，由 Main 的诊断超时处理。home 仅指实际 `/workspace/{workspaceId}/all` 路由，已授权的活动列表挂载且工作区文档列表完成初次同步才算 presentable。辅助页面与非活动编辑器不参与观测。

普通文档：当前目标权限通过、root 可用、当前 BlockSuite 容器已绑定并经历绘制机会；表格／幻灯片：当前读取能力和资源就绪、首个有效活动表／页已挂载并经历绘制机会。presentable 仅是“可呈现并进入交互”，不是全部资产加载完成或持久化 ACK；无业务内容的合法空文档可成立。重试／导航／目标变化重置观测号，旧目标迟到消息不移除当前占位；dirty 编辑／远端 revision 更新不重入初始 loading。

Desk 分别用宿主与 Main 的单调时钟记录 Work runtime-config、Work launch 和原生启动阶段。Main 记录 command-ready、首次实际可见、内容 presentable 及结果，区分 bootstrap 与 resume。成功样本在实际可见和正文可展示都成立后结算。Workbench 导航可重新观测当前目标，每次启动最多保留一个结果。内存保留最近 128 条匿名样本，性能采集时可设置 `JUGGLEWORK_DOCS_STARTUP_DIAGNOSTICS=1` 输出到本机日志。旧服务缺少能力记 unsupported，声明支持但未响应记 unavailable。样本只包含耗时、路径、结果码和格式类别。

基线还需采集点击、Docs context、脚本／Worker、workspace/root、Office describe/content 与编辑器初始化子阶段，可用本地浏览器网络与 Performance 采集。各进程只计算自己的相对耗时，不直接相减时钟读数。同一终点比较冷启动、磁盘暖缓存、活实例恢复、预热命中／未完成／未命中；无正文终点的样本不可用 command-ready 补位。附记创建实例数、bootstrap 次数与磁盘缓存命中。诊断不包含凭据或业务标识，不上报新增遥测。

## 8. 性能验收与分期

先在相同设备、网络、账号和固定测试文档上取得基线，每类至少 20 次，冷缓存／暖缓存分组，分别报告 p50／p95、失败率、内存、流量与点击到可交互，不以健康接口耗时替代。目标待基线后冻结，不写无依据秒数；必须分别冻结“重启立即点击／无预热”“预热完成后点击”“活实例恢复”三个收益门禁，不能只用预热命中组代表重启加速。若无预热路径没有改善，P0 根据必要 API／引擎占比明确新增最小优化任务及独立评审，或把发布范围收窄为刷新恢复／延迟点击预热，不得宣称重启慢已解决。硬性回归要求：恢复成功零 bootstrap／零新增实例；同目标预热与点击至多一个实例；首屏可交互不等待预热；授权／保存正确率不下降；暖打开不得比基线 p95 恶化超过 10%（噪声需重复确认）。

P0 最小正文观测、分段诊断与基线；P1 全页同进程 detach／resume／claim；P2 单目标重启定位与预热；P3 性能验收和受控发布。正文信号不能成为核心授权依赖。会话文件面板及独立文件窗口恢复另期，现有正常切换保持不变。新增恢复／预热提供独立开关，可关闭回落既有流程；旧客户端、旧 Docs 兼容分别测试。回退不得关闭尚有未确认保存的视图。

## 9. 验证矩阵

- 真实 Electron：主窗 reload／reloadIgnoringCache／renderer gone 与进程重启分开；文档 WebContentsId 与导航次数证明复用，不仅检查 React props。
- 主界面刷新中正在输入、IME、未确认 Office 保存、导入确认、AI 请求；旧 close／bounds／reference 回调不影响新宿主，原生无多重实例泄漏。
- 当前会话 fresh grant resume、grant 已消费／未知、旧 Docs 404、401／403、网络超时、成员 generation 改变、同账号新登录、组织切换、私有 scope／跨 workspace，全部验证不可误展示及正确回落。
- prewarm 与点击交错、不同目标、退出、冷启动立即点击、过期定位、失效目标、内存清理未保存；不得自动重复业务写入。
- resume／contentState 能力分别缺省；新能力查询失联、隐藏页尚未绘制、预热完成早于订阅及重复 claim，均不产生可见性死等或额外实例。
- 缓存隔离、HTML／manifest 更新与旧分包可用、强刷不清隔离文档分区；普通文档、表格、幻灯片分别测量。
- 协作对端持续编辑、保存失败／重试、退出取消、浮层可操作、AI 引用仍指向实际路由，保护现有合同。

## 10. 风险与尚未验证的前提

未实测重启耗时占比，预热不保证用户立即点击时提速；后台加载会增加 CPU／网络／内存，只能在基线达标后默认启用。Docs resume 必须证实不刷新同分区 Cookie、不改变 context、不投影目录且完整验证当前授权；做不到就保留 bootstrap，不牺牲权限。真正的离线先展示、后台定时同步、长期授权缓存、全标签自动恢复和持久截图不在本期。
