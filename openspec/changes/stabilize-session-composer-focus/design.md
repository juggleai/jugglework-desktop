## Context

`SessionSurface` reuses one composer while its session identity changes. The snapshot query also refetches after lifecycle events and reconciliation. Previously, both initial loading and background fetching produced the same `switching` state, and `switching` disabled Lexical. Separately, the shell emitted four anonymous window events after navigation, while every mounted composer listened to the same event.

## Decisions

### Distinguish initial switching from background refresh

When renderable data belongs to the intended session, a fetch is a background refresh. The render source may be cached, but the transition remains idle so drafting and caret state are preserved. A session with no renderable target state remains switching until it is ready.

### Keep one cancellable, target-scoped focus request

A focus request identifies the target session and reason. A newer request replaces the old request. The request remains pending until the matching active composer is mounted and editable, expires after a bounded interval, and is cancelled by newer pointer or keyboard intent.

### Let the active pane claim focus

Each composer checks the requested session, its workbench control-target state, its enabled state, and visibility before focusing. Completing the request removes it so other mounted surfaces cannot claim it.

## Risks and Mitigations

- A target session may never mount. Requests expire automatically.
- A modal may still be closing when focus is requested. Eligibility remains false until the model picker closes, then the pending request is applied.
- Hidden retained surfaces may share the application tree. Visibility and control-target checks prevent them from consuming the request.
