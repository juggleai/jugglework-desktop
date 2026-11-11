# Spec Delta

## Purpose

定义 JuggleWork Desktop 原生日历入口和月视图体验，使成员无需 Agent 即可浏览个人日程、筛选日历并安全完成在线日程管理。

## ADDED Requirements

### Requirement: Desktop 提供独立日历页面
Desktop SHALL 为已登录成员提供独立 `/calendar` 页面，并以当前云端 deployment、organization 和 member 身份加载日历数据，不将页面归属到本地文件工作区。

#### Scenario: 打开日历路由
- **WHEN** 已登录成员导航到 `/calendar`
- **THEN** Desktop 显示日历页面并加载该成员当前组织的个人日历数据

#### Scenario: 未打开工作区
- **WHEN** 已登录成员在没有本地文件工作区的情况下打开 `/calendar`
- **THEN** Desktop 仍可显示其云端个人日历

#### Scenario: 未登录访问
- **WHEN** 未登录用户访问 `/calendar`
- **THEN** Desktop 不显示任何缓存成员的日历内容并引导用户完成登录

#### Scenario: 仅日历能力 gate 刷新
- **WHEN** Desktop 配置刷新仅改变 `calendarEnabled` 或 `calendarWriteEnabled`，其他配置保持不变
- **THEN** Desktop 将该差异应用到当前配置，开启能力后显示可用日历，关闭能力后隐藏受保护内容，撤回写 gate 后保留只读视图并禁用写入
- **AND** 缺失或非法 gate 仍按关闭处理，开启 gate 不替代登录、完整 organization/member scope 或服务端授权

### Requirement: 日历入口位于 More 且可置顶
Desktop SHALL 在 More 导航中提供日历入口，并允许成员使用既有导航定制机制将其置顶或取消置顶。

#### Scenario: 从 More 打开日历
- **WHEN** 成员在 More 导航中选择日历
- **THEN** Desktop 导航到 `/calendar` 且入口显示选中状态

#### Scenario: 置顶日历入口
- **WHEN** 成员将 More 中的日历入口置顶
- **THEN** Desktop 在主导航中持续显示日历入口并保持其路由行为

#### Scenario: 取消置顶
- **WHEN** 成员取消置顶日历入口
- **THEN** Desktop 从主导航移除该入口但仍在 More 中提供日历

### Requirement: 页面提供迷你月历和月份导航
Desktop SHALL 显示迷你月历、当前可见月份和上月、下月、今天导航；选择迷你月历日期 SHALL 同步主月视图与选中日。

#### Scenario: 前往相邻月份
- **WHEN** 成员选择上月或下月
- **THEN** 主月视图切换到对应月份并请求或显示覆盖该月的日程

#### Scenario: 返回今天
- **WHEN** 成员选择今天
- **THEN** 主月视图切换到今天所在月份且今天成为选中日

#### Scenario: 从迷你月历选择日期
- **WHEN** 成员选择当前主视图之外月份的日期
- **THEN** 主月视图切换到该日期所在月份且该日期成为选中日

### Requirement: 月视图按本地日期展示日程
Desktop SHALL 在月网格中按事件定义的时间语义展示日程：全天日程按日期区间展示，定时日程按存储 IANA 时区转换后的本地日期和时间展示，结束边界不占用。

#### Scenario: 展示单日全天日程
- **WHEN** 全天日程的 startDate 为某日且 endDateExclusive 为次日
- **THEN** 月视图只在 startDate 对应日期展示该日程

#### Scenario: 展示跨日全天日程
- **WHEN** 全天日程跨越多个日期
- **THEN** 月视图在从 startDate 到 endDateExclusive 之前的每个日期展示连续占用

#### Scenario: 展示跨日定时日程
- **WHEN** 定时日程在其存储 IANA 时区下跨越日期边界
- **THEN** 月视图在该时区下被日程覆盖的各日期展示该日程且不包含排他结束时刻后的日期

#### Scenario: 月格内容溢出
- **WHEN** 某日期的日程数量超过月格可显示容量
- **THEN** Desktop 显示可发现的剩余数量入口且成员可查看该日完整议程

### Requirement: 成员可筛选可见个人日历
Desktop SHALL 显示当前成员的活动 Calendar 列表，并允许成员切换各 Calendar 在月视图和选中日议程中的可见性。

#### Scenario: 隐藏一个日历
- **WHEN** 成员关闭某 Calendar 的可见性
- **THEN** 月视图和选中日议程隐藏该 Calendar 的日程但不修改或删除云端资源

#### Scenario: 恢复日历可见性
- **WHEN** 成员重新开启某 Calendar 的可见性
- **THEN** 月视图和选中日议程重新显示该 Calendar 的已加载日程

#### Scenario: 日历已被软删除
- **WHEN** 刷新结果表明一个 Calendar 已被软删除
- **THEN** Desktop 将其移出筛选列表并不再展示其活动日程

### Requirement: 选中日议程与月视图联动
Desktop SHALL 为选中日期显示按时间语义稳定排序的议程，并与月格和迷你月历的日期选择保持一致。

#### Scenario: 选择月格日期
- **WHEN** 成员选择月视图中的日期
- **THEN** 该日期成为选中日且议程显示与其相交的可见日程

#### Scenario: 议程排序
- **WHEN** 选中日同时包含全天日程和多个定时日程
- **THEN** 议程先显示全天日程，再按开始时点排序定时日程，并对相同开始时间使用稳定次序

#### Scenario: 空议程
- **WHEN** 选中日没有可见日程
- **THEN** Desktop 显示该日无日程的明确状态和创建入口

### Requirement: Desktop 提供日程详情
Desktop SHALL 允许成员从月格或选中日议程打开 CalendarEvent 详情，展示标题、归属 Calendar、时间语义、描述和当前保存状态。

#### Scenario: 打开全天日程详情
- **WHEN** 成员选择一个全天 CalendarEvent
- **THEN** 详情以日期范围展示且不伪造具体开始或结束时刻

#### Scenario: 打开定时日程详情
- **WHEN** 成员选择一个定时 CalendarEvent
- **THEN** 详情展示其开始、排他结束和 IANA 时区对应的可理解本地时间

#### Scenario: 详情资源已在其他客户端删除
- **WHEN** Desktop 刷新时发现当前详情资源已软删除
- **THEN** Desktop 关闭或标记详情不可用并从活动视图移除该资源

### Requirement: Desktop 提供在线日程 CRUD 表单
Desktop SHALL 为已登录且在线的成员提供创建、编辑和删除个人 CalendarEvent 的交互，并在提交前校验标题、归属 Calendar 和时间字段。

#### Scenario: 从选中日创建全天日程
- **WHEN** 成员从选中日创建日程并选择全天类型
- **THEN** 表单以该日预填有效排他日期区间并在云端确认后显示已保存日程

#### Scenario: 创建定时日程
- **WHEN** 成员提交有效开始时间、排他结束时间和 IANA 时区
- **THEN** Desktop 请求云端创建并仅在成功响应后将日程显示为已保存

#### Scenario: 编辑日程
- **WHEN** 成员修改日程并提交其最后读取的版本
- **THEN** Desktop 在云端成功后显示返回的权威字段和新版本

#### Scenario: 删除日程
- **WHEN** 成员确认删除并提交其最后读取的版本
- **THEN** Desktop 在云端确认软删除后从活动月视图和议程移除该日程

#### Scenario: 客户端校验失败
- **WHEN** 表单缺少必填值、结束不晚于开始或混用全天与定时字段
- **THEN** Desktop 阻止提交并在对应字段显示可操作的校验信息

### Requirement: Desktop 明确处理冲突和失败
Desktop SHALL 将版本冲突、授权失败、校验失败和网络失败与成功保存状态区分显示，并保留未被云端接受的用户输入以便修正或重试。

#### Scenario: 乐观版本冲突
- **WHEN** 云端因预期版本过期拒绝编辑或删除
- **THEN** Desktop 显示冲突状态、保留用户编辑内容并提供查看最新权威版本的路径

#### Scenario: 网络失败
- **WHEN** 日程写入未获得云端成功确认
- **THEN** Desktop 不显示“已保存”且保留表单内容供成员重试或存为草稿

#### Scenario: 授权失效
- **WHEN** 云端拒绝请求因为登录或组织成员身份失效
- **THEN** Desktop 隐藏受保护日历内容并引导成员恢复有效身份

### Requirement: 月视图适配可用窗口尺寸
Desktop SHALL 在支持的窄窗口和标准桌面窗口中保持月份导航、日期选择、筛选、议程及日程详情可操作，不产生必须横向滚动整页才能访问的核心操作。

#### Scenario: 标准桌面窗口
- **WHEN** 日历页面在标准桌面窗口宽度显示
- **THEN** 迷你月历、筛选、主月视图和选中日议程按桌面布局可用

#### Scenario: 窄窗口
- **WHEN** 日历页面宽度不足以并排显示所有区域
- **THEN** Desktop 重排或折叠辅助区域，同时保留月份导航、月格日期选择、议程和 CRUD 入口

#### Scenario: 键盘访问核心控件
- **WHEN** 成员使用键盘遍历日期、导航、筛选和表单控件
- **THEN** Desktop 提供可见焦点和可识别名称并允许触发对应操作

### Requirement: 日历 UI 不依赖 Agent 或 AI Provider
Desktop SHALL 在 Agent 不可用、未开启会话或未配置 AI Provider 时保持日历导航、月视图、筛选、详情和在线 CRUD 可用。

#### Scenario: Agent 不可用
- **WHEN** Agent 运行时不可用但成员已登录且日历云服务可达
- **THEN** Desktop 日历核心界面和操作正常工作

#### Scenario: 无 AI Provider
- **WHEN** 成员没有可用 AI Provider
- **THEN** Desktop 不禁用或隐藏日历核心功能

### Requirement: 本阶段仅提供月视图核心体验
Desktop SHALL 不将周或日时间轴、重复日程编辑、提醒、参会邀请、团队共享、会议、任务叠加或外部日历同步呈现为本阶段可用功能。

#### Scenario: 打开日历页面
- **WHEN** 成员进入本阶段日历页面
- **THEN** 核心视图以月视图和选中日议程为边界且不出现声称上述后续能力已启用的控件
