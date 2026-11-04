## 1. Implementation
- [x] 1.1 Stop reconnecting healthy event streams solely because no business event arrived.
- [x] 1.2 Add bounded jittered reconnect backoff while retaining one stream per workspace endpoint.
- [x] 1.3 Abort superseded workspace-list and selected-session hydration requests.
- [x] 1.4 Propagate query cancellation to bounded session snapshot reads.

## 2. Verification
- [x] 2.1 Added focused coverage for shared event subscriptions, quiet streams, retry delay bounds, superseded route reads, and desktop IPC cancellation (14 tests passing).
- [x] 2.2 App type checking and the production Vite build pass.
- [ ] 2.3 `git diff --check` passes and the change structure was reviewed manually; the OpenSpec CLI is unavailable in this checkout (`openspec: command not found`).

