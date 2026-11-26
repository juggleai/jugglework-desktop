# Proposal

## Why
用户需要在当前任务详情中辨认“谁是我的前置”和“我阻塞谁”，并能调整层级、检查历史和安全删除。只读成员也需要看到自己有权查看的关系。

## What Changes
- 在详情表头提供七项更多菜单、可搜索任务选择器、分方向的关系徽标和解除入口。
- 使用任务级历史、带不可恢复提示的永久删除及服务端独立 follower 角色；将草稿的显式选择与持久化后的默认关注区分开。
- 校正 `add-nested-product-subtasks` 和 `add-cloud-tasks` 在途规范；保留原有完成控件及集合筛选规则。

## Capabilities
### New Capabilities
- `desktop-task-detail-actions`：详情关系展示与操作、关注状态、历史和删除确认。

### Modified Capabilities
无已归档能力变更。在途的 `nested-product-subtasks`、`desktop-task-center` 在其所属变更中校正。

## Impact
涉及 Den 任务客户端、任务查询、详情表头及中英文文案。复用现有详情导航、活动与删除接口；依赖 Server 同名变更提供的权限过滤关系摘要。
