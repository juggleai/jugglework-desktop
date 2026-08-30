## 1. Workspace-bound operations

- [x] 1.1 Introduce an immutable workspace plugin operation context (workspace ID/root/type/client/capabilities/key) captured before Cloud resolution; verify a delayed install test cannot move from workspace A to B.
- [x] 1.2 Add load-key protection to imported plugin refreshes and mutation completions; verify late workspace A responses cannot overwrite workspace B state.
- [x] 1.3 Gate install/sync/remove actions for unsupported, read-only, or insufficiently authorized runtimes; verify direct remote OpenCode shows an explanation without sending a mutation request.

## 2. Delivery plan, ownership, and transaction

- [x] 2.1 Build a deterministic delivery plan for files, runtime MCPs, Cloud-only components, removals, warnings, and conflicts; verify a mixed Skill/Command/Agent/local-MCP/Cloud-MCP fixture produces a stable plan.
- [x] 2.2 Extend installation persistence with a component outcome and ownership ledger while retaining legacy record reads; verify migration and round-trip tests.
- [x] 2.3 Add MCP ownership/conflict checks and ownership-safe removal; verify user-owned and other-plugin MCPs are never overwritten or deleted.
- [x] 2.4 Apply file/MCP/record mutations with snapshots, staged writes, and compensating rollback; verify injected failures at every stage restore the prior installation and leave no unowned resources.
- [x] 2.5 Serialize install, update, and removal per workspace; verify concurrent operations cannot overwrite another operation's runtime config or installation ledger.
- [x] 2.6 Treat digest changes on valid-owned files and MCPs as removal conflicts, preserving both resources and a repair-required ledger.
- [x] 2.7 Restore only plugin-affected runtime MCP names during compensation; verify unrelated concurrent runtime changes survive install and removal rollback.
- [x] 2.8 Reject duplicate normalized file and MCP destinations within one incoming graph before mutation; verify fresh installs remain empty and updates preserve the previous installed resources and ledger.

## 3. Exact synchronization and status

- [x] 3.1 Reconcile obsolete owned files and MCPs across all component types; verify removed/renamed Skills, Commands, Agents, Tools, Hooks, Context, and MCPs are cleaned on upgrade.
- [x] 3.2 Make repeated install/sync/remove operations idempotent and preserve valid member MCP state; verify duplicate operations do not duplicate files, records, or engine effects.
- [x] 3.3 Account for Cloud-only components and persist structured component outcomes; verify pure-Cloud and mixed plugins reach stable installed/update states.
- [x] 3.4 Return and render installed, partial, failed, repair-required, needs-sign-in, and needs-admin outcomes; verify Toast severity and detail actions match actual component results.
- [x] 3.5 Include live engine reconciliation in transaction outcomes for install, update, and removal; verify sync failure rolls back and rollback failure persists repair-required details.
- [x] 3.6 Preserve resolved plugin Cloud readiness and map member sign-in/administrator setup to partial component outcomes.

## 4. Post-operation refresh and user experience

- [x] 4.1 Refresh initiating-workspace plugin records, Marketplace state, Skills, MCPs, Commands, Agents, and session capability inventory after mutation; verify all surfaces update without navigation.
- [x] 4.2 Show the installed Marketplace plugin count in the session-side plugin card; verify it reflects the captured workspace only.
- [x] 4.3 Add actionable conflict, rollback, authorization, administrator-setup, and unsupported-workspace copy in English and Chinese; verify i18n/type checks.

## 5. Integration verification

- [x] 5.1 Add two-workspace isolation tests for install, update, remove, state preservation, and out-of-order refreshes.
- [x] 5.2 Add mixed organization plugin end-to-end tests covering local files, local MCP, Cloud MCP, update cleanup, partial failure, rollback, retry, and removal.
- [x] 5.3 Run Desktop Server tests/build, App tests/typecheck, OpenSpec strict validation, and `git diff --check`; record all checks green before marking complete.
