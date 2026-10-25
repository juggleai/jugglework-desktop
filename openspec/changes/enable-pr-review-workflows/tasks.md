## Implementation
- [x] Add bounded shared review-write and AI workflow contracts.
- [x] Add same-connection capability discovery, fresh-head checks, and fixed GitHub write operations.
- [x] Add durable private AI runs, cancellation, restart recovery, and publish replay protection.
- [x] Add model-selectable AI analysis and normal workspace fix task dispatch.
- [x] Add explicit publishing dialogs, findings selection, stale-revision guards, and task navigation.
- [x] Align the opened pull-request layout with the native code-review overview, including the Inbox, rendered description, top actions, and status rail.
- [x] Add the native header status menu, sidebar pin, URL shortcuts, and confirmed merge/auto-merge actions through the organization GitHub connector.

## Verification
- [x] Reproduce the live gateway's nested GitHub result envelope and add regression coverage for inbox/detail reads and downstream error propagation.
- [x] Verify contracts, provider writes, operation replay, private AI results, cancellation, stale revisions, and UI confirmation with focused tests (70 tests passed).
- [x] Run app/server/type checks and production builds.
- [x] Validate OpenSpec and inspect the updated local development UI; verify real connector comment/review capabilities and workflow reads, and inspect publish/fix dialogs with isolated example data without publishing live GitHub content.

## PR-associated review task refinement
- [x] Add predictable bounded PR review task titles and reuse one review session across reruns and revisions.
- [x] Preserve bounded revision-scoped run history and expose related review/fix tasks in the PR workflow dialog.
- [x] Add bounded exact-revision local repository context with Git remote verification and applicable `AGENTS.md` guidance while retaining deny-all model tools.
- [x] Verify title truncation, session reuse, history, repository mismatch degradation, exact-revision context, UI navigation, and existing publish/fix revision guards (37 focused tests passed; app/server/shared-types checks passed).

## Pull request reaction display
- [x] Normalize non-zero pull request reaction counts from GitHub detail or exact repository search responses and carry them through the shared review contract.
- [x] Display existing reactions beside the pull request description reaction control and verify provider, view-model, and rendering behavior (59 focused tests and app/server/shared-types checks passed).

## Review comment summary
- [x] Preserve GitHub discussion kind so ordinary issue comments and submitted review bodies remain distinct from inline review threads.
- [x] Replace the Summary sidebar Threads navigation with a Codex-style review comment count, compact previews, resolved state, and Activity anchor navigation.
- [x] Verify root-only counting, ordinary-comment exclusion, expansion, and Activity location behavior.
