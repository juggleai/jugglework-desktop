## 1. Shared Contracts and Policy

- [x] 1.1 Define versioned session permission mode, acknowledgement, reusable grant, mutation, and sanitized audit event schemas in shared types
- [x] 1.2 Add an organization policy gate for Session Full access with fail-closed parsing and owner-only enablement in the initial profile
- [x] 1.3 Define the shared approval-ceiling result and initial eligibility classes, including policy-blocked requests and doom-loop permissions
- [x] 1.4 Add contract tests proving authenticated remote-control channels and forged origin fields cannot enable Full access, create grants, or request persistent upstream approval

## 2. Server Persistence and APIs

- [x] 2.1 Add durable workspace/root-session storage for requested/effective modes, acknowledgements, authorizing principals, activation exclusions, versioned grants, one shared authority revision, and transition timestamps
- [x] 2.2 Add typed APIs to read and compare-and-set a root session's permission mode, list or clear its grants, and report server capability
- [x] 2.3 Enforce owning-workspace, authoritative-root, server-writable, caller-scope, and organization-policy checks on every mutation
- [x] 2.4 Implement fail-closed paused behavior for older, future, unknown, malformed, or mismatched Full access profile/acknowledgement versions and inactive behavior for unsupported grant versions
- [x] 2.5 Persist durable suspension or grant invalidation with an authority-revision advance when the authorizing principal is demoted, removed, transferred, deleted, or cannot be authoritatively verified; require explicit renewal instead of silent resumption
- [x] 2.6 Remove mode, exclusion, and grant records when the authoritative root session is deleted and test restart persistence and cleanup

## 3. Grant Semantics

- [x] 3.1 Normalize reusable scope from legacy `always` patterns and v2 `save` resources without using protocol-native `always`
- [x] 3.2 Implement same-protocol, same-action, case-sensitive full-string grant matching with literal characters plus `*`, exact upstream strings, complete resource coverage, deduplication, and fail-closed malformed input
- [x] 3.3 Define and verify each runtime adapter's complete pending-snapshot linearization contract; disable automatic authority for partial or eventual-only adapters
- [x] 3.4 Implement grant arming around that linearization point with serialized arrival capture and an exclusion set for every matching request present at the boundary except the explicitly approved source request
- [x] 3.5 Implement the durable pending/dispatching/active/failed/indeterminate grant state machine around exact-request `allow_once` resolution
- [x] 3.6 Extend the local permission reply API to create a grant through that state machine without trusting caller-supplied origin
- [x] 3.7 Test source-request exemption, boundary requests delivered late, requests created after the linearization point but before commit, unsupported adapters, same-root descendant coverage, unrelated roots, cross-protocol/action isolation, matching grammar, partial failures, restarts, and resources outside the displayed future scope

## 4. Automatic Permission Broker

- [x] 4.1 Add a server-side permission broker that serializes root activation, observes incoming permissions, and resolves current root ancestry
- [x] 4.2 Reuse interaction reservation, exact target-session dispatch, rollback, and terminal error semantics for automatic `allow_once` replies
- [x] 4.3 Implement arming against the adapter's explicit pending-snapshot linearization point, reconcile serialized arrival capture, and persist the exclusion set before Full access becomes effective
- [x] 4.4 Revalidate pending state, ancestry, shared authority revision, effective profile or grant version, authorizing human principal's current scope, exact grant, and approval ceiling immediately before dispatch
- [x] 4.5 Apply the shared approval ceiling to manual one-time approval, grant creation, and broker dispatch while leaving execution-time policies authoritative
- [x] 4.6 Test boundary requests first delivered after enablement, post-boundary requests created before commit, durable suspension after author demotion/removal/ownership transfer or unavailable membership authority, no silent resumption, local and remote workspaces, nested descendants, ancestry failure, user/broker races, grant clear and mode downgrade races, upstream failure, and restart recovery

## 5. Auditability

- [x] 5.1 Add a transactional security-decision ledger with durable intent, succeeded, failed, and indeterminate outcomes for mode, grant, and automatic approval decisions
- [x] 5.2 Bound and redact permission resources and metadata so credentials, raw environment values, unbounded commands, and tool output are not persisted
- [x] 5.3 Retain at most 10,000 completed linked decision units per workspace for 90 days, prune each intent/outcome pair atomically, and preserve unresolved or indeterminate units until reconciliation
- [x] 5.4 Fail closed when authority-widening intent cannot be persisted, reconcile interrupted decisions without retrying uncertain approvals, and add failure-injection tests

## 6. Composer and Approval UI

- [x] 6.1 Add a viewport-bounded, portalled permission-mode selector after model behavior and before Run/Queue in each composer
- [x] 6.2 Resolve requested/effective mode state and mutations by each pane's actual root session and owning server, including loading, paused, unsupported, stale-revision, and failure states
- [x] 6.3 Add versioned Full access confirmation copy and keep the active warning state visible while idle or running
- [x] 6.4 Update the approval panel to show current-request resources separately from reusable scope and offer a session grant only when that scope is non-empty
- [x] 6.5 State that Request approval follows upstream policy, running mode changes affect subsequent requests, pre-activation requests remain manual, and returning to Request approval unconditionally clears grants
- [x] 6.6 Surface detectable upstream saved approvals without representing them as JuggleWork session grants
- [x] 6.7 Add English and Chinese strings and responsive coverage for narrow windows, stacked panes, and split sessions with different modes

## 7. Integration and Verification

- [x] 7.1 Add renderer tests for upstream-policy copy, Allow once, grant availability, Full access acknowledgement and paused state, error rollback, and split-pane isolation
- [x] 7.2 Add server integration tests proving Full access and grants use only one-time upstream replies and never install wildcard or project-persistent permissions
- [x] 7.3 Add end-to-end descendant tests proving root configuration governs hidden children while replies retain exact child identity
- [x] 7.4 Run focused App, Server, shared-type, and Desktop remote-control tests plus TypeScript typechecks
- [x] 7.5 Run strict OpenSpec validation and document migration behavior for pre-existing OpenCode legacy and v2 saved approvals
