## 1. Completion reconciliation

- [x] 1.1 Verify renderer terminal hints against current engine/descendants and a final assistant created in the current run.
- [x] 1.2 Confirm idle across separated authoritative samples even after progress, preserving run identity and abort acceptance.
- [x] 1.3 Ignore user-message writes as engine progress and use server ownership to shield task presentation from transient idle snapshots.
- [x] 1.4 Align session running presentation with coordinator ownership and reserve green markers for non-error completion.
- [x] 1.5 Cover startup/old-message/tool-step races, descendants, stale generations, errors and temporary idle in focused tests; validate App/Server types.
