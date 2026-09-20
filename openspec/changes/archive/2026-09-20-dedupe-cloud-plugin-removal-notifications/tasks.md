## 1. Durable Cloud Change Identity

- [x] 1.1 Add persisted occurrence versions and deterministic migration for desktop cloud sync state.
- [x] 1.2 Reconcile current differences so repeated observations preserve identity and synchronized resources clear stale pending changes.
- [x] 1.3 Scope fallback reads to the active organization/member context.

## 2. Idempotent Notification Delivery

- [x] 2.1 Persist bounded source delivery cursors independently from visible notification rows.
- [x] 2.2 Emit scoped plugin update/removal notifications only for newer occurrence versions.
- [x] 2.3 Preserve generic notification coalescing semantics and allow a later observed removal to notify again.

## 3. Verification

- [x] 3.1 Add Server cloud-sync lifecycle tests for repeated removal, reappearance, later removal, and legacy-state migration.
- [x] 3.2 Add App tests for scoped cloud-sync parsing and persistent notification-source idempotency across read/clear/rehydration.
- [x] 3.3 Run focused Server/App tests, typecheck/build, strict OpenSpec validation, and diff hygiene checks.
