## ADDED Requirements

### Requirement: 双入口复用一套会话模块与存储
主窗口和文件窗口 SHALL 复用同一 SessionSurface、会话装配/控制代码及既有 Server/OpenCode 接口，不复制会话历史、发送业务或运行存储。本次 SHALL 不新增数据库表、schema 升级或 runtime DB 路径变更。

#### Scenario: 两窗口打开同一会话
- **WHEN** 主窗口和文件窗口绑定同一 workspace/session
- **THEN** 两处读取同一既有历史和运行状态，不创建镜像 session 或第二套会话库

### Requirement: 单一运行入口与无重复消费者
发送、停止及 permission/question SHALL 复用既有服务端入口。文件窗口 SHALL 不运行 follow-up 自动 drain、enqueue、steer 或 goal continuation；忙时提交失败 SHALL 保留本窗口输入。

#### Scenario: 两处竞争发送
- **WHEN** 同一会话两窗口同时提交或一处已有运行
- **THEN** 既有服务端仲裁生效，未接受的输入保留，不因第二 renderer 启动队列消费者

### Requirement: 草稿保持窗口局部
未发送文字、附件和 IME composition SHALL 属于当前窗口，不同步覆盖另一 renderer；不新增持久协同或重启恢复承诺。

#### Scenario: 两窗口分别输入
- **WHEN** A 和 B 各自编辑输入框
- **THEN** A 的编辑、发送或清空不覆盖 B 的未发送输入

### Requirement: 投影复用既有事件与重读
两个入口 SHALL 使用既有会话读取和事件源更新状态，断线后重读既有快照/历史，不新增持久事件协议。

#### Scenario: 窗口重新连接
- **WHEN** 文件窗口断线后重新连接
- **THEN** 重新读取同一会话的服务端状态，不用过期本地消息宣称运行或交互成功
