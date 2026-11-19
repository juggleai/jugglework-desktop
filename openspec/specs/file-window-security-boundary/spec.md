# file-window-security-boundary Specification

## Purpose
Define the host-bound capability and authorization boundary for file assistant windows, including safe navigation, IPC, and workspace access.

## Requirements

### Requirement: 文件窗口使用宿主绑定能力
Main SHALL 核验登记窗口的真实 webContents 对象和顶层 frame，按该窗口中宿主登记的 source（workspaceId、sessionId、workspaceRoot）及其文件集合处理请求，不信任 renderer 覆盖归属。fetch 和 SSE SHALL 捕获并持续验证对应 registered source 的 authority，不以可变的活动标签顶层投影或窗口分组代替授权。同一窗口内每个 workspace SHALL 只登记唯一会话，文件和文档操作 SHALL 限于对应来源的标签及文档身份。

#### Scenario: 伪造其他会话或来源
- **WHEN** 子 frame、伪造 sender 或文件 renderer 请求未绑定的 workspace/session
- **THEN** Main 拒绝请求，不转发至其他会话

#### Scenario: 异步期间切换活动标签
- **WHEN** 来源 A 的 fetch 或 SSE 已开始，用户切换到来源 B
- **THEN** A 的请求与事件仍按 A 的登记来源及既有根会话/已验证子会话范围处理，不被 B 的活动投影改绑；B 也不能借 A 的文件或文档登记扩大权限

#### Scenario: 异步期间注销来源
- **WHEN** 获取连接、读取响应或订阅重连期间，该来源的最后一个标签关闭或窗口失效
- **THEN** 取消该来源请求与订阅，拒绝迟到响应；同窗口其他仍登记来源继续按自身权限工作

### Requirement: 文件窗口不持有通用服务端凭据
文件窗口 state SHALL 不返回全局 token；Main SHALL 仅对已允许的文件和会话操作注入认证。桥接 SHALL 限制动作、参数、大小和时间，拒绝任意 URL/header 与重定向。

#### Scenario: 超出白名单
- **WHEN** renderer 请求任意地址、未登记文件、未知动作或过大响应
- **THEN** 宿主拒绝或中止，不回退通用 fetch/IPC

### Requirement: 失效窗口撤销请求与订阅
宿主 SHALL 在来源注销或窗口销毁时取消对应 fetch 与会话订阅并拒绝迟到响应；不得因此停止 Server 已接受的任务。用户明确停止任务 SHALL 另走既有 run 归属核对与停止清理流程；传输取消 SHALL NOT 被转换为 session/run abort。Office 保存、dirty、草稿确认及 owner 生命周期 SHALL 继续遵循原文档合同。

#### Scenario: 读取期间关闭窗口
- **WHEN** 窗口在请求或事件订阅期间关闭
- **THEN** 不再向该 renderer 返回数据或继续其订阅，Server 任务按原会话继续
