## 1. Server Domain Foundation

- [x] 1.1 Map the existing server model, database migration, routing, authorization, and test conventions for the new task domain
- [x] 1.2 Add task, task member, task list, list member, comment, event, and reminder model types and enums
- [x] 1.3 Add additive database migrations, indexes, uniqueness constraints, versions, and soft-delete columns
- [x] 1.4 Implement task and task-list repositories with pagination, optimistic versions, and idempotent create support
- [x] 1.5 Add repository and migration tests for private, collaborative, list, version, and recovery behavior

## 2. Server Task Services and APIs

- [x] 2.1 Implement task authorization for private, members, organization, assignee, follower, Viewer, and list roles
- [x] 2.2 Implement task CRUD, multi-assignee completion, cancellation, reopen, soft delete, and 30-day restore services
- [x] 2.3 Implement system-view, search, filter, sort, and cursor-pagination queries
- [x] 2.4 Implement task-list creation, membership, role, move, archive, and restore services
- [x] 2.5 Add authenticated HTTP APIs and validation for task and list operations
- [x] 2.6 Add service and API tests covering authorization denials, idempotency, concurrency, lifecycle, and orphan-task transfer

## 3. Desktop Task Center Foundation

- [x] 3.1 Map the existing Desktop navigation, routing, API client, query-state, localization, and component conventions
- [x] 3.2 Add Tasks to More with optional navigation-rail pinning, the `/tasks` route, localization, and an Agent-independent loading/empty/error shell
- [x] 3.3 Add typed task API client, dedicated move contract, query keys, pagination, mutations, and draft-preserving optimistic-conflict handling
- [x] 3.4 Implement the Tasks sidebar information architecture: Today, Assigned to me, Following, and Activity as primary navigation; All tasks, Created by me, Assigned by me (`view=delegated`), and Completed in collapsible Quick access; task lists below; and safe migration of removed persisted destinations
- [x] 3.5 Implement paginated task rows, full create, priority filter, basic sorting, and title/due/priority display without quick-create or task search
- [x] 3.6 Add member, status, start/due time, visibility, list, and field-display controls plus permission-aware inline actions
- [ ] 3.7 Complete collaborative edit, member management, list-scoped move, and all lifecycle actions including delete/restore; full create and contextual list defaults are complete
  - Pre-release privacy fix: private-to-shared list moves require explicit native confirmation/cancel, authoritative task/destination permissions, and captured-scope/page-lifetime fencing. Member changes remain governed by the existing Desktop requirements permitting authorized automatic members visibility; no additional confirmation requirement was found for assignees/followers.
  - Local verification on 2026-11-07: `bun --conditions=development test --isolate tests/tasks-page.test.tsx tests/task-page-state.test.ts tests/den-product-tasks-client.test.ts tests/task-workbench.test.tsx` passed (134 tests); app typecheck, `node scripts/i18n-coverage.mjs --locale zh --strict`, and `git diff --check` passed. Native Electron confirmation and live server integration were not exercised; broader collaborative/lifecycle work remains open.
- [ ] 3.8 Implement the aggregate Activity view, pagination, unread state, and event navigation
- [x] 3.9 Add the dedicated route, loading/empty/error shell, section persistence, and no-Agent smoke tests
- [x] 3.11 Display organization-scoped `t100001`-style task numbers while retaining exact internal IDs for routing and copy actions
- [ ] 3.10 Add connected Desktop tests for edit, member management, lifecycle actions, Activity, and permission changes; full-create fields/defaults/validation, mutation errors, and scope fencing are covered

## 4. Explicitly Excluded IM Interoperability

IM message creation, Task source references, chat cards, access requests, and Task Assistant notifications are not part of `add-cloud-tasks`. They require a separate future OpenSpec and do not block core Tasks completion or release readiness.

## 5. Reminders, Events, and Notifications

- [x] 5.1 Implement immutable task events and stable business event IDs
- [x] 5.2 Implement one-active-reminder-per-recipient scheduling, rescheduling, cancellation, and timezone handling
- [ ] 5.3 Integrate task events with the Desktop notification center, task activity unread state, and system notifications
  - Reminder events reach the organization-scoped Desktop notification center, Tasks navigation badge, and system notifications with task deep links. Activity unread for the broader task-event matrix remains open.
- [x] 5.4 Add reminder delivery, multi-device deduplication, completed/canceled suppression, and notification-policy tests

## 6. MVP-B Content and List Enhancements

- [ ] 6.1 Add attachment upload/link, dual task/file authorization, removal, and inaccessible states
- [ ] 6.2 Add one-level subtasks, independent assignees/due dates, completion confirmation, and cascade recovery
- [ ] 6.3 Complete task-list member management, archived-list UI, list customization, and additional sorting/field configuration
- [ ] 6.4 Add MVP-B content and list tests

## 7. Release Readiness

- [x] 7.1 Add analytics events without Task content and operational metrics for failures, duplicates, reminders, and authorization denials
- [ ] 7.2 Run server migration, unit, API, Desktop, and i18n test suites and fix regressions
  - Verification completed against the configured local MySQL database on 2026-11-01: migration `20261101`, server unit/vet suites, authenticated Task API CRUD/comments/activity/reminders, Desktop typecheck/focused tests, Electron startup smoke, and visible Task deep-link/list/detail/comment/reminder/full-create flows passed. Connected collaborative Desktop coverage remains incomplete, so this item stays open.
- [ ] 7.3 Perform security review for private tasks, attachments, search, cache, organization-scoped notifications, and deep links
- [x] 7.4 Document feature-flag rollout, rollback, data retention, support diagnostics, and MVP-A/MVP-B release gates
