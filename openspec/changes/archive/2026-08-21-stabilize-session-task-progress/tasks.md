## 1. Todo State Reliability

- [x] 1.1 Keep manually observed todo query entries alive until explicit session cleanup
- [x] 1.2 Use runtime workspace identity for selected-session todo reads
- [x] 1.3 Subscribe primary and secondary split panes to their own session todo state
- [x] 1.4 Fence snapshot todo seeding against newer live todo events

## 2. Progress Presentation Lifecycle

- [x] 2.1 Classify empty, open, and terminal todo lists for display
- [x] 2.2 Keep active and incomplete progress visible while briefly acknowledging successful terminal progress
- [x] 2.3 Prevent delayed prompt acceptance from restoring busy state after fast completion

## 3. Verification

- [x] 3.1 Add tests for todo cache retention, runtime workspace keys, split-session lookup, and snapshot ordering
- [x] 3.2 Add tests for progress terminal visibility and fast-completion lifecycle behavior
- [x] 3.3 Run focused tests, TypeScript checks, OpenSpec validation, and diff checks
