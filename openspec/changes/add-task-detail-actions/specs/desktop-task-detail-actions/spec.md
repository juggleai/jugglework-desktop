## Purpose
Let members inspect and edit the visible relationships of the selected task, understand its history and confirm destructive actions in the detail panel.

## ADDED Requirements

### Requirement: Seven detail actions
The live task header SHALL retain completion, follow and close controls and order its overflow actions as 设置父任务, 转为独立任务, 设为里程碑/取消里程碑, 添加前置任务, 添加后置任务, 查看历史记录, 删除. It SHALL omit 转为独立任务 whenever that command is unavailable rather than show a disabled entry. The milestone toggle occupies one slot. There SHALL be a separator before history and no report action.

#### Scenario: Reader opens the menu
- **WHEN** the task is readable but `canEditContent` and `canDelete` are false
- **THEN** history and visible relationships are available; the five relation commands and delete cannot submit

#### Scenario: No parent or milestone
- **WHEN** an editor opens a task with `parentTaskId: null` and `isMilestone: false`
- **THEN** detach is absent and the milestone command offers to set, not unset, the flag

### Requirement: Select an existing task in scope
Parent selection SHALL search and page only `GET /v1/tasks/:taskId/parent-candidates`: editable live tasks in the current organization, excluding self, the current parent and all descendants. Desktop SHALL NOT substitute a generic task list if this resource is unavailable. Dependency selection SHALL continue to search visible live tasks, excluding self and already linked tasks. Canceling either picker SHALL send no write.

#### Scenario: Choose the new parent
- **WHEN** a user searches, loads more and selects Q for task T
- **THEN** Q is selected locally and no write is sent; changing the search, Cancel or Escape discards the selection
- **WHEN** Q is still selected and the user clicks outside the dialog on blank space or presses Save
- **THEN** Desktop submits one `set-parent` with Q's internal ID and refreshes T and affected parent/child views on success

#### Scenario: Server rejects the choice
- **WHEN** the server rejects a cycle, permission change or version conflict
- **THEN** Desktop shows the error, refreshes authoritative state and does not leave a fabricated link or silently resubmit

### Requirement: Directional badges adjacent to completion
The header SHALL place the red solid-diamond milestone badge, green left-arrow `{count} 前置任务` and orange right-arrow `阻塞 {count} 任务` beside completion. Each directional count SHALL use its visible array and be omitted at zero. Dependency badges open visible titles and statuses with detail navigation and permission-gated unlink; they do not block completion or reschedule tasks.

#### Scenario: A precedes B
- **WHEN** both tasks are readable and A → B is their only edge
- **THEN** B has a green `1 前置任务` opening A, and A an orange `阻塞 1 任务` opening B; neither shows an empty direction
- **AND** unlinking A from B's green list uses `remove-predecessor`, whereas unlinking B from A's orange list uses `remove-successor`

### Requirement: Milestone markers across task views
Desktop SHALL use the server's `isMilestone` flag for the task marker in detail, table, kanban, Today and subtask rows. A milestone uses a diamond; an ordinary task uses a circle. The shape SHALL NOT change the available completion or reopen action.

#### Scenario: Toggle the marker from detail
- **WHEN** an editor marks a task as a milestone and then unmarks it
- **THEN** the refreshed detail and corresponding rows show a diamond and then the ordinary circle, with task status unchanged

### Requirement: Read and write the same relation resource
Desktop SHALL read `GET /v1/tasks/:taskId/relations` for a readable live detail, validating `{predecessors,successors,isMilestone,parentTaskId}` with `{id,title,status}` rows. Editable actions SHALL POST to the same resource with `action`, `expectedVersion`, `idempotencyKey` and `relatedTaskId` only for commands taking a target. Writes SHALL use the server result and refresh versions, lists, affected details and activity in the original scope.

#### Scenario: Relations unavailable
- **WHEN** GET is unsupported, forbidden, fails or returns malformed data
- **THEN** indicate unavailability or error, suppress relation writes and stale badges, and keep independently permitted history and delete usable

### Requirement: Follow state reflects independent roles
Follow state, avatars and count SHALL reflect actual follower roles rather than creator or assignee identity. Creation, including inline subtasks, SHALL rely on the server for creator and assignee defaults. Desktop SHALL render the returned roles in the detail footer and task list, and a delayed create receipt SHALL NOT overwrite a newer cached detail. Assignment edits SHALL preserve unrelated roles.

#### Scenario: Show the saved followers after creation
- **WHEN** the server returns the creator and assignees as followers of a newly created task
- **THEN** Desktop shows those saved follower roles in the task list and detail footer without inferring any additional followers

### Requirement: Self-service follow controls
Desktop SHALL use the dedicated follow and unfollow POSTs when their respective capability is true, independent of member management. Both send `expectedVersion` and `idempotencyKey` and accept empty `204`.

#### Scenario: Compatibility and scoped follow refresh
- **WHEN** a member uses the self-follow controls
- **THEN** explicit false disables the action; only absent `canFollowSelf` allows the legacy member-manager PATCH preserving unrelated roles
- **AND** Desktop prevents duplicate in-flight changes, refreshes detail, lists and activity in the original scope and does not apply late results to a different account, organization or server

#### Scenario: Read-only viewer follows
- **WHEN** a viewer with `canFollowSelf: true` uses Follow
- **THEN** Desktop sends one scoped self-follow POST without PATCHing members, and displays the follower role only after reading it back from the server

#### Scenario: Assignee stops following
- **WHEN** a signed-in assignee uses Unfollow and still has task access
- **THEN** their assignment remains, the independent follower role disappears after refresh, and editing the title or retaining the assignment does not restore the badge

#### Scenario: Former assignee loses their final grant
- **WHEN** self-unfollow succeeds with 204 and the detail is no longer readable
- **THEN** Desktop discards protected detail data rather than keeping cached relations, follower names or history visible

### Requirement: Task-local history and confirmed permanent deletion
History SHALL read `GET /v1/tasks/:taskId/history` and offer older pages until `nextCursor` is empty. It SHALL show each authorized event's type, time and currently visible actor (or a generic actor), with loading, empty, error and retry states. It SHALL NOT reconstruct counterpart details from event payloads, old selections or an organization-wide feed. Delete SHALL require the existing `canDelete` and explicit confirmation naming the task.

#### Scenario: Open history and return to the same task
- **WHEN** the user selects 查看历史记录 in the detail menu
- **THEN** history replaces the detail content within the same side panel without opening a modal, groups events by local calendar day, and shows the time and actor avatar or fallback beside each event
- **AND** the top-left Back button returns to the same task detail without closing the side panel

#### Scenario: Read beyond the first page
- **WHEN** a reader loads older changes
- **THEN** Desktop appends them in server order; if a subsequent page reports loss of access, it hides all loaded events for that task

#### Scenario: View history after a neighbor is hidden
- **WHEN** a reader opens history after losing access to another endpoint
- **THEN** the safe local action remains understandable without disclosing that endpoint's ID or title

#### Scenario: Cancel, then confirm deletion
- **WHEN** the user opens Delete and cancels
- **THEN** the task is unchanged and no delete request is sent
- **WHEN** an authorized user confirms after the dialog warns that deletion is permanent and the task cannot be restored
- **THEN** Desktop sends one `DELETE /v1/tasks/:taskId` with the current `expectedVersion` and `idempotencyKey`, accepts `204 No Content` without parsing JSON, closes only the matching detail and refreshes the affected scope. It offers no Undo or Trash action; failure is visible without claiming success

#### Scenario: Older server returns its legacy delete result
- **WHEN** the same request succeeds with the older server's `200` task-result body
- **THEN** Desktop treats it as success and refreshes from the server without retrying, adding a local tombstone, or promising recovery
