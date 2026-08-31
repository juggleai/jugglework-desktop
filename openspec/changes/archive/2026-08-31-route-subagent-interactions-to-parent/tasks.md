## 1. Server Interaction Aggregation

- [x] 1.1 Add cycle-safe session ancestry and visible-root resolution for workspace sessions
- [x] 1.2 Add descendant-aware pending permission and question read models that retain exact target session IDs
- [x] 1.3 Expose an authoritative root-session interaction snapshot endpoint with bounded v2 descendant reads
- [x] 1.4 Cover nested descendants, unrelated children, malformed ancestry, protocol merging, and exact-target replies in server tests

## 2. Renderer Canonical Interaction State

- [x] 2.1 Introduce workspace-level canonical permission and question records with target, parent, and root ownership
- [x] 2.2 Route live parent, child, nested, and initially orphaned interaction events into canonical state
- [x] 2.3 Hydrate and reconcile visible-root interactions from the authoritative snapshot without stale snapshot resurrection
- [x] 2.4 Adapt interaction hooks and approval UI to select by root while replying to the originating target session
- [x] 2.5 Cover untracked child events, nested routing, event-order races, snapshot recovery, reply cleanup, and rejection in renderer tests

## 3. Task and Remote-Control Presentation

- [x] 3.1 Correlate descendant pending interactions with parent Task metadata and show a waiting-for-approval state
- [x] 3.2 Project descendant interactions to root-bound remote sessions while retaining exact target mutation arguments
- [x] 3.3 Add Task lifecycle and local/remote exactly-once race regression tests

## 4. Verification

- [x] 4.1 Run focused app, server, desktop, and interaction-resolution test suites
- [x] 4.2 Run TypeScript checks and formatting/diff validation for affected packages
- [x] 4.3 Validate the OpenSpec change strictly and document any deferred compatibility limitations
