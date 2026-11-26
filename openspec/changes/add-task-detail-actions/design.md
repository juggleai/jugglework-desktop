# Design

## Context
`task-page.tsx` owns the selected detail, permissions and follow/complete controls. `task-detail-actions.tsx` composes the menu, picker, badges and dialogs. `den.ts` validates the wire model; `task-queries.ts` scopes detail, list and activity caches. The server owns edges and member roles.

## Goals / Non-Goals
Make the direction legible from either endpoint and the read-only experience useful. Keep completion independent of dependencies; do not add report, automatic scheduling, new lifecycle actions or a second history feed.

## Decisions
- **One relation query per active detail.** Use the internal task ID within the current deployment/account/organization scope. Fetch for readers too. Decode both arrays, status values, milestone boolean and nullable parent. Treat a missing route or malformed payload as unavailable, never as an empty graph that may be edited.
- **Stage parent selection.** Dependency pickers use `view=all`; the parent picker uses only `/parent-candidates`, scoped to the task and search term. Select locally, then submit on outside press or Save. Cancel, Escape or changing the search clears the selection. Never offer a cached row while permissions are being rechecked.
- **Use the live task marker.** Detail, table, kanban, Today and subtask views read `isMilestone` from the task. Change the shape, not completion behavior; a row does not need a separate relations fetch.
- **Make direction explicit.** In header order: completion, red milestone, green incoming count, orange outgoing count, follow, overflow, close. Dependency badges open their corresponding lists; only editors may unlink. Hide the detach command unless actionable. History and delete form a separate menu group; delete uses its own permission and a named confirmation dialog independent of relation availability. Restore focus to the opener when dialogs close.
- **Refresh rather than infer.** A POST returns a projection, not a task version. Refresh affected detail/relations (including old/new parent), lists/child pages and activity; on conflict, refresh before a new user decision. Fence late results by scope and selected task. History reads its own `/history` pages; `/activity` remains the comments and recent activity surface.
- **Use follower rows rather than an owner/assignee heuristic.** Keep draft selections optional and read the saved set back. Self-unfollow uses the narrow 204 operation; reauthorize the detail and evict it on lost access. Managing another person's follower role still requires member-management authorization. Following collection filters remain independently editable.

## Risks / Trade-offs
- A picker result can become hidden or read-only before submit → surface the server error and refresh; do not retain a speculative badge.
- Older servers may support activity/delete but not relations → degrade only relation controls. A stale detail cannot authorize a late result after navigation.
- A reader may lose access between history pages → hide loaded events on denial; never fall back to cached names or notification payloads.
- History is a subpage of the detail panel, not a dialog. Group returned events by local day across pages; return to the mounted detail to preserve its local editing state.

## 飞书官方对照与边界
[查看和编辑任务](https://www.feishu.cn/hc/zh-CN/articles/548906337874)说明里程碑标记由圆变菱、可查看完整更改记录；[使用子任务](https://www.feishu.cn/hc/zh-CN/articles/684209533480)说明只搜索可编辑任务、排除子任务、选中后点空白保存。显式「保存」是本端的另一入口。飞书文档提到最多五层和创建人删除，本轮沿用既有深层层级与 `canDelete` 授权。[关注任务](https://www.feishu.cn/hc/zh-CN/articles/792978480444)说明主动关注及通知；这些文档未证实自动关注、完成后依赖徽标的显隐规则，也不能作为逐像素一致的依据。

## Migration Plan
Ship after the paired Server change. No Desktop data migration is required; a rollback to an earlier client leaves the server's relationships intact. Verify localized layout and keyboard interaction separately from schema and component checks.
