## Why

Interactive sessions currently expose individual permission prompts, but the existing “Allow for session” action delegates to OpenCode's protocol-specific `always` behavior, which may be engine-wide, project-persistent, or effectively one-time rather than truly session-scoped. Users also lack a visible per-session way to choose between reviewing permission requests and automatically approving requests for trusted work.

## What Changes

- Add a persistent permission-mode selector to the conversation composer with two modes: **Request approval** and **Full access**.
- Keep Request approval as the default and continue presenting runtime permission requests for explicit deny or one-time approval.
- Replace protocol-native `always` replies with JuggleWork-owned grants that apply only to the visible root session and its descendants, and only to matching reusable request scopes.
- In Full access mode, automatically resolve future eligible runtime permission requests with one-time upstream approvals instead of installing wildcard OpenCode allow rules.
- Preserve organization policy, server roles, read-only state, operating-system authorization, connector scopes, disabled MCPs, and other hard-deny boundaries regardless of session mode.
- Persist modes and grants on the JuggleWork server that owns the workspace, apply them consistently to descendant sessions, and record mode changes and automatic decisions in a sanitized audit trail.
- Require explicit acknowledgement before enabling Full access; mode changes affect future requests and do not silently resolve requests that were already pending.
- Keep remote-control clients from enabling Full access or creating reusable session grants in the initial version.

## Capabilities

### New Capabilities

- `session-permission-modes`: Defines user-visible per-session approval modes, reusable session-scoped grants, automatic approval behavior, persistence, safety boundaries, and lifecycle semantics.

### Modified Capabilities

- `descendant-session-interactions`: Extends descendant interaction ownership so a root session's permission mode and reusable grants can govern eligible requests from its hidden descendants without changing the exact reply target.

## Impact

- Conversation composer controls, permission approval presentation, split-pane session settings, and localized copy in `apps/app`.
- Workspace-owned permission-mode and grant APIs, storage, permission-event brokering, ancestry checks, race coordination, and audit logging in `apps/server`.
- Shared types for mode records, grants, mutations, audit events, and any organization policy gate.
- Existing OpenCode permission replies remain the execution mechanism, but JuggleWork stops using protocol-native `always` to promise session-scoped behavior.
- No prompt, transcript, or model-context content is added for permission configuration or derived automatic decisions.
