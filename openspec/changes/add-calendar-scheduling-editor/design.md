# Design

## Context

Calendar core 继续提供普通事件、版本、幂等和离线 baseline。Scheduling API 返回参与人 aggregate、展开 occurrence 和按成员的 busy-only availability。Desktop 必须在两类结果之间保持真实身份、并发基准和隐私边界。

## Goals / Non-Goals

**Goals:**

- 在个人日历编辑路径加入有硬上限的组织内参与人和基础重复。
- 让 scheduling occurrence、普通事件和离线 baseline 不重复、不丢失真实单次事件身份。
- 在 scheduling authority 不可确认时保持普通读取可用，同时阻止可能错误的编辑/删除。
- availability 永远只展示 busy/unknown，不接收或推断底层日程详情。

**Non-Goals:**

- 不实现邀请投递、RSVP、响应状态编辑、取消通知或外部联系人。
- 不实现“仅本次”重复例外、`this-and-following` 或任意 RRULE。
- 不把离线草稿自动同步或把旧 availability 冒充当前结果。

## Decisions

### 1. Scheduling aggregate 是参与人/重复事件的编辑权威

普通 bootstrap 用于持续展示 core 数据；fresh scheduling occurrences 按事件 ID 替换参与人/重复 aggregate。非重复 scheduling 事件保留真实 event ID；只有重复 occurrence 使用稳定 synthetic display ID 并只读，防止把虚拟实例当作系列主记录写入。

### 2. 编辑基准不能被后台 refetch 静默推进

编辑器保留表单所基于的 `base.version`。后台收到同事件新版本时，保留用户表单和旧基准并进入显式 conflict；只有“使用最新”或“保留我的修改”动作才更新基准。这样不会以新 expectedVersion 覆盖用户从未审阅的远端变化。

### 3. 参与人硬限制在 UI 和 validator 双层执行

个人日程以事件 owner（新建时为当前 scope member）作为不可移除的创建人参与者。成员/群组选取在 UI 达到包含创建人在内的 20 人时停止；framework-free validator 先补齐创建人，再对去重后的非空 member IDs 执行 20 人上限。群组按服务端 cursor/offset 完整分页，但只把当前组织目录可映射成员加入选择，并报告 added/skipped/over-limit。团队日历继续由其独立 owner/授权模型表达创建人，不把参与人字段发送到不支持的 scheduling endpoint。

### 4. Availability 是隐私最小投影

请求只包含 member IDs、有限 instant 范围和 IANA timezone。UI 只消费每个成员的 busy 半开区间或 unknown；加载、失败、离线、缺失成员结果均不得显示为空闲，也不得缓存为可确认建议。

### 5. Core baseline 与 scheduling 写权限解耦

Scheduling 查询失败时，在线 UI 继续显示 bootstrap 事件并展示错误，但个人事件的编辑/删除保持 fail-closed。离线持久化仍保存普通 bootstrap baseline，避免一个扩展服务故障清空整个离线 Calendar；只有 fresh scheduling success 才把 occurrences 合并进持久 baseline。

## Risks / Trade-offs

- 普通 baseline 在 scheduling 故障时可能包含无法分类的 aggregate → 离线统一只读，在线相关编辑/删除禁用。
- 群组可超过 20 人 → 分页和目录映射保证选择结果可解释，validator 阻止绕过 UI。
- 本阶段参与人没有真实邀请语义 → UI 不提供 RSVP/通知承诺，OpenSpec 不关闭完整 attendance 任务。

## Migration Plan

1. 先部署 scheduling API/migration，保持 Desktop capability 关闭或 fail-closed。
2. 发布严格 DTO 和 query/cache merge，再启用编辑器参与人/重复入口。
3. 监控 scheduling 错误、validation 和冲突，不记录标题、描述或 busy 区间内容。
4. 回滚 Desktop 入口时保留 Server additive 数据；旧客户端仍可读取 core event，但不得以 core 写入破坏 scheduling aggregate。
