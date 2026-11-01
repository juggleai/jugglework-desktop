## 1. Server Domain Foundation

- [x] 1.1 Map the existing server model, database migration, routing, authorization, and test conventions for the new task domain
- [x] 1.2 Add task, task member, task list, list member, source, comment, event, and reminder model types and enums
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
- [x] 3.2 Add a dedicated Tasks navigation item, `/tasks` route, localization, and Agent-independent loading/empty/error shell
- [x] 3.3 Add typed task API client, query keys, pagination, mutations, and optimistic-conflict handling
- [x] 3.4 Implement Today, Inbox, Assigned to me, Created by me, Following, Activity, All, Completed, Trash, and archived-list navigation
- [x] 3.5 Implement task list rows, title-only create, filters, sorting, field display, and permission-aware inline actions
- [x] 3.6 Implement task detail, full create/edit, multi-assignee completion confirmation, comments, activity, and lifecycle actions
- [x] 3.7 Add Desktop component, route, state, and no-Agent regression tests

## 4. IM Task Integration

> Deferred by implementation direction: JuggleIM-dependent work is intentionally skipped in the current implementation pass. These tasks remain open and must not block verification of the non-IM Task domain.

- [ ] 4.1 Add task source storage and separate Task/source-message authorization reads
- [ ] 4.2 Add Create task to accessible text-message menus with deterministic title extraction and no default assignee
- [ ] 4.3 Add duplicate-source detection and source deleted/inaccessible states
- [ ] 4.4 Add permission-safe full/restricted task cards, Viewer access requests, approval, and latest-state open behavior
- [ ] 4.5 Add task assistant message types and deduplicated assignment, due, mention, completion, reopen, and cancellation notifications
- [ ] 4.6 Add IM integration and permission-leak regression tests

## 5. Reminders, Events, and Notifications

> The Task Assistant portion of 5.3 is deferred with the JuggleIM work. Non-IM cloud scheduling, Desktop activity/notification-center, and system-notification work may proceed independently.

- [x] 5.1 Implement immutable task events and stable business event IDs
- [x] 5.2 Implement one-active-reminder-per-recipient scheduling, rescheduling, cancellation, and timezone handling
- [ ] 5.3 Integrate task events with the Desktop notification center, task activity unread state, task assistant, and system notifications
  - Non-IM reminder events now reach the scoped Desktop notification center and system notifications with task deep links. Activity unread for the broader task-event matrix remains open; Task Assistant remains deferred with JuggleIM.
- [x] 5.4 Add reminder delivery, multi-device deduplication, completed/canceled suppression, and notification-policy tests

## 6. MVP-B Content and List Enhancements

- [ ] 6.1 Add image, file, and quoted-message task creation with task-owned versus source-owned content boundaries
- [ ] 6.2 Add attachment upload/link, dual task/file authorization, removal, and inaccessible states
- [ ] 6.3 Add one-level subtasks, independent assignees/due dates, completion confirmation, and cascade recovery
- [ ] 6.4 Complete task-list member management, archived-list UI, list customization, and additional sorting/field configuration
- [ ] 6.5 Add MVP-B content and list tests

## 7. Release Readiness

- [x] 7.1 Add analytics events without task/message content and operational metrics for failures, duplicates, reminders, and authorization denials
- [ ] 7.2 Run server migration, unit, API, Desktop, and IM test suites and fix regressions
  - Non-IM verification completed against the configured local MySQL database on 2026-11-01: migration `20261101`, server unit/vet suites, authenticated Task API CRUD/comments/activity/reminders, Desktop typecheck/focused tests, Electron startup smoke, and visible Task deep-link/list/detail/comment/reminder/quick-create flows passed. Fixed the MySQL event-row auto-increment panic, notification-store render loop, and Today/Trash list-sort request mismatch found by this run. IM suites remain deferred with section 4, so this item stays open.
- [ ] 7.3 Perform security review for private tasks, source deletion, group exit, restricted cards, attachments, search, cache, and deep links
- [x] 7.4 Document feature-flag rollout, rollback, data retention, support diagnostics, and MVP-A/MVP-B release gates
