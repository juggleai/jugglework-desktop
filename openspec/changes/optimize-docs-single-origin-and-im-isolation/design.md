# Desk 增量适配设计

跨端字段只在 [共享契约](../../../../jugglework-server/openspec/changes/optimize-docs-single-origin-and-im-isolation/integration-contract.md) 定义；[统一验收](../../../../jugglework-server/openspec/changes/optimize-docs-single-origin-and-im-isolation/rollout-and-acceptance.md) 不在本仓重复维护。

## 直接复用

| 已有实现 | 本次处理 |
| --- | --- |
| chat-connection.ts 的 readChatConnectionScope | 已含来源、账号、组织、AppKey、IM 地址和凭据指纹，保持现有模型 |
| runtime.ts 的 scope、epoch、wireClientEvents、reset | 已拒绝旧连接事件，沿用现有生命周期 |
| store.ts 的 currentScope、conversationLoad | 继续检查异步结果并复用在途加载，不另建状态机或加载队列 |
| product-view.ts／product-view-pool.ts | 已按来源／账号／组织复用后台页，空闲 120 秒释放；只适配域名，不重建池 |
| cloud-docs-panel.mjs 的 retained／backgrounds 和现有桥 | 复用页面保留、浮窗、附件、外观和权限失效处理 |
| Docs 卡片、上传、AI、FileWindowApp | 保留现有交互与协议，只修改下述关联点 |

## 1. 移除聊天分类前置

store.ts 删除 docsContext、docsContextKey、docsContextCheckedAt、classifyConversations，以及加载／选中／历史／收发／未读中的分类等待和整群过滤。删除无引用的分类客户端与类型；Work 旧分类接口保持兼容。

群列表直接采用当前 AppKey 连接的 SDK 结果，保留系统消息过滤、去重、排序和分页。现有连接切换、旧结果隔离只做回归；发现缺口才补该调用点，不重写组织切换。

Docs 卡片继续使用现有解析、Symbol 来源绑定、事件验证及打开流程；移除其对分类上下文的依赖，以实际连接 scope 与 payload 组织一致作为本地可操作条件。转发／不匹配卡片继续兜底；点击时仍由 Work notifications/validate 验证真实事件与会话，再由 Docs 校验权限。卡片错误不隐藏群、不清空未读。

不再由分类完成／失败触发全量刷新。现有 SDK 事件和加载去重保持，其他聊天性能重构不属于本次任务。实际 SDK AppKey／用户缓存隔离列为回归检查，未发现问题不新增缓存层。

## 2. 固定域名

“固定”表示一套部署内组织共用一个可配置 Origin，不表示产品写死域名或服务器 IP。Desktop 从当前 Work 的 runtime-config 获取；自托管／托管／迁机沿用同一契约。可见产品页与后台产品页首次加载等待窗口为 60 秒，允许远端 AFFiNE 冷缓存下载完成。

- 复用 Work 的 runtime-config 获取 docs.enabled／publicOrigin，缓存绑定来源；更换来源或重新连接时重新读取，不为粘贴链接申请 grant，不扩展登录／组织响应。
- validateCloudDocsLaunch 精确比较配置 Origin 与现有 bootstrapUrl，并保留固定路径、HTTPS、无用户信息／查询／fragment 的检查。删除 t- 前缀判断。
- 现有 Electron partition 哈希输入增加 tenantId；页面、后台池、会话标签和附件沿用已有 scope 清理。
- 每个 Docs 实例携带共享契约中的固定 contextId，受管页面／Worker 自行传递，不在 Desk 再建认证系统。
- 复制、粘贴、@ 搜索与 AI 引用复用现有结构化 tenantId／workspaceId／docId，只改链接生成和域名识别。跨组织仍走现有切换确认。

cloudDocsPanel 按错误原因／实例处理：页面绑定错误只影响旧实例，服务故障不撤销用户，不执行全 Origin 清理。真实撤权隐藏匹配 contextId 的实例，等待原生本地落盘后释放；已下载原件按旧 contextId 清理，新会话原件不受影响。缓存命中也通过 Docs 复核原生阅读权限。

已保留标签切回不重新 launch；主题、语言、隐藏入口、上传分享和 AI 工具均为回归项目，不列为重新开发。

## 3. File Browser 扩展

FileWindowApp 已承载本地 Office、云原件和会话聊天；本次仅补云文档标签类型及其受管视图。标签保存结构化引用，不伪造本地文件路径，并区分本地 workspaceId 与原生 Docs workspaceId。

复用 createCloudDocsPanel 的 getWindows／ownerWindow 宿主归属，接入现有文件窗口的受限 IPC、边界更新与关闭释放，不另建云文档窗口管理器。相同窗口内重复打开同范围文档只激活标签；保留实例避免重复加载。

云文档保存及跨窗口协作沿用 AFFiNE，AI 沿用 File Browser 的实际会话及实例绑定。本地提交白名单仅接收该窗口登记的当前原生文档和已打开标签引用；原生页内导航由 Main 读取实际路由并更新定位，不沿用初始标签作为可写目标。文件窗口的通用链接按普通文本保留，选区引用使用现有原生桥；变更卡片读取和撤销只允许绑定会话，不能借此直调 Docs 编辑接口。本地保存、只读原件和未保存关闭提示不重做；云端待同步状态不得被当作已保存，关闭不得丢弃未确认数据。切组织仅撤下旧云端范围，保留未同步数据。主动关闭、退出、更新／切组织先等待原生服务端确认，或确认原生本地持久化已完成再关闭；未确认本地写入时允许取消，不能直接销毁 WebContents。强制撤权立即隐藏并禁止网络写入，但保留受原身份约束的本地恢复数据。复用原生持久化状态经现有桥传递，不增加第二套保存协议。

旧 Documents 助手构建残留已清理，脚本在新 File Browser 签名成功后删除旧名称；沿用稳定 Bundle ID，不新增应用包。独立云文档标签已接入 File Browser；标签只包含非敏感定位、实例和固定 Origin，不持有 Work 登录凭据。

## 4. 范围

本次不新增服务端 AppKey 规则、IM 隔离系统、文档权限系统、后台池、同步协议或 Word 双向同步。固定域名、隔离分区上线前确认旧原生编辑已同步或有备份；不自动复制 Cookie、搬移 IndexedDB 或删除未确认内容。

分机部署仅调整 Docs 后端回源与 Work 内部入口，Desk／Web 不持有服务 Token，不增加服务登录或签名请求，沿用原 launch 与原生 Docs 会话。配置与错误隔离见 [服务鉴权](../../../../jugglework-server/openspec/changes/optimize-docs-single-origin-and-im-isolation/service-auth.md)。

源码实现及本机验证结果统一见 [实现与验证](../../../../jugglework-server/openspec/changes/optimize-docs-single-origin-and-im-isolation/implementation.md)。
