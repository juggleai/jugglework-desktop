## ADDED Requirements

### Requirement: 文件窗口使用宿主绑定能力
Main SHALL 核验登记窗口的真实 webContents 对象和顶层 frame，按宿主固定的 workspace/session/file 身份处理请求，不信任 renderer 覆盖归属。

#### Scenario: 伪造其他会话或来源
- **WHEN** 子 frame、伪造 sender 或文件 renderer 请求未绑定的 workspace/session
- **THEN** Main 拒绝请求，不转发至其他会话

### Requirement: 文件窗口不持有通用服务端凭据
文件窗口 state SHALL 不返回全局 token；Main SHALL 仅对已允许的文件和会话操作注入认证。桥接 SHALL 限制动作、参数、大小和时间，拒绝任意 URL/header 与重定向。

#### Scenario: 超出白名单
- **WHEN** renderer 请求任意地址、未登记文件、未知动作或过大响应
- **THEN** 宿主拒绝或中止，不回退通用 fetch/IPC

### Requirement: 失效窗口撤销请求与订阅
宿主 SHALL 在窗口销毁时取消会话订阅并拒绝迟到响应；不得因此停止 Server 已接受的任务。

#### Scenario: 读取期间关闭窗口
- **WHEN** 窗口在请求或事件订阅期间关闭
- **THEN** 不再向该 renderer 返回数据或继续其订阅，Server 任务按原会话继续
