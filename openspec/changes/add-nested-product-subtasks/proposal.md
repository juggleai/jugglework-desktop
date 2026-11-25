# Proposal

## Why
复杂工作需要拆成可独立指派、归类和完成的任务，而不是只能写在主任务描述中。任务中心需要同时呈现层级和独立的筛选结果。

## What Changes
- 支持从任何可编辑的任务详情中创建直接子任务，包括从子任务创建下一层。
- List 支持展开子任务、顶层父任务链接、直接子任务完成进度、附件与回复数。单条任务命中筛选时仍是独立结果。
- 详情支持行内新建、子任务进度、独立完成与打开下级详情。
- 同级子任务默认按添加顺序排列，详情可拖动并保存顺序；清单展开分支使用同一顺序，外层任务排序不影响分支。

## Capabilities
### New Capabilities
- `nested-product-subtasks`: 独立任务之间的多级层级关系及 Desktop 呈现。

### Modified Capabilities
无。此变更替代尚未交付的 `add-cloud-tasks` 单层子任务计划。

## Impact
Server 增量迁移、创建/列表/详情 API；Desktop Den 客户端、List 和详情。不改变任务授权与归类模型。
