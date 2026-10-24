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
