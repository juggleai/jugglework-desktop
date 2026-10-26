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

## Compact PR conversation and model parity
- [x] Reduce the floating PR conversation to the compact composer while preserving full chrome in docked/full layouts.
- [x] Source the PR model catalog and variants from the originating workspace and keep execution scoped to the isolated review workspace.
- [x] Mirror effective source-workspace provider and disabled-provider settings into the hidden review workspace so every visible selection can execute.
- [x] Verify compact layout, source catalog queries, review-workspace submission routing, and model parity.
- [x] Default a newly opened pull request to the circular conversation launcher and restore the compact composer only after an explicit click.
- [x] Reveal the joined quick-conversation control row on input focus, add six-dot layout actions, and support long-press floating-window drag.
- [x] Keep full conversation view inside the PR detail region, remove docked/full close actions, and add bounded draggable pane dividers.
- [x] Render docked/full PR transcripts with the shared local-task message list for Markdown, progress, timing, and completion collapsing.
- [x] Match the reference quick-conversation chrome and icon proportions, and dismiss the upper control row on outside interaction without breaking portalled menus.
- [x] Align the compact placeholder baseline, preserve identical composer geometry across focus changes, and replace the oversized custom six-dot handle with the standard compact vertical grip.
- [x] Force the Lexical caret and placeholder onto the same compact baseline and prevent a completed long-press drag from opening the layout menu.
- [x] Guard the post-drag synthetic click/open sequence with a timed capture-phase lock so delayed Popover events cannot reopen the layout menu.
- [x] Close docked/floating layout menus before applying an option and keep pane resize hit areas visually transparent on hover.
- [x] Return an accepted queued review before slow PR/workspace/model preparation and detach background work from the initiating HTTP signal.
- [x] Optimistically render the readable review request with shared task timing and suppress transient snapshot timeout errors while the run is active.
- [x] Keep explicit review queuing immediate even when the automatic PR conversation session is still being prepared, and preserve the queued run when that setup completes.

## Private review conversation workspaces
- [x] Open AI Review as a right-side PR conversation and automatically start first-run analysis with the globally selected text model.
- [x] Create durable date-partitioned review workspaces below the user's Documents directory, with safe PR-derived names, collision suffixes, and non-secret metadata.
- [x] Save the private workspace reference with each review run, reuse its session for later revisions, and support follow-up conversation and explicit re-review.
- [x] Persist private workspaces while filtering them from normal workspace APIs and managed-engine workspace selection.
- [x] Verify model inheritance, automatic first-run startup, private workspace naming/reuse, list isolation, review UI regressions, and app/server type checks.
- [x] Reuse the local-task composer controls in the PR panel and auto-migrate legacy completed reviews that do not have a durable workspace/session association.
- [x] Bind panel state and persisted hidden-workspace metadata to the PR identity and reject mismatched workspace reuse.
- [x] Add Codex-style review conversation placement controls for full view, left/right panes, a bottom-right quick composer, and a minimized pill while retaining one PR-bound session surface.
- [x] Show the quick composer for every opened PR, prepare its hidden conversation without running analysis, inject bounded untrusted PR context into follow-up prompts, and reserve explicit AI review startup for the right-pane Review action.
