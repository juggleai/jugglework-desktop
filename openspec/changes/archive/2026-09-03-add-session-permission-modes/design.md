## Context

See `proposal.md` for motivation and the delta specs for required behavior. Runtime permissions currently arrive through legacy and v2 OpenCode events, are normalized into a workspace interaction cache, and are replied to through JuggleWork's semantic interaction endpoint. The server already re-reads the exact pending request, preserves descendant target identity, and serializes competing local and remote replies.

The current UI's `always` response is unsuitable as a session contract: legacy approvals live in an engine-wide in-memory ruleset, while v2 approvals can persist project-wide. OpenCode session permission rules are also order-sensitive, so appending a wildcard allow can override earlier safety denies. Local and remote workspaces share the renderer flow but must execute policy on the server that owns the workspace.

## Goals / Non-Goals

**Goals:**

- Make the server-owned root session the authority for permission mode and reusable grants.
- Reuse the existing exact-target interaction reply and race-coordination boundary.
- Auto-approve only concrete pending requests, after current policy and ancestry checks.
- Keep the selected mode accurate across reloads, split panes, descendants, and remote JuggleWork workspaces.
- Make escalation explicit, versioned, reversible for future requests, and auditable.

**Non-Goals:**

- Grant OS privileges, expand OAuth scopes, or turn the selected workspace into a sandbox.
- Add project-wide or permanent OpenCode saved permissions.
- Resume interrupted model runs after engine restart.
- Let remote-control clients widen persistent session authority in the first version.
- Change question interactions or automatically answer questions.

## Decisions

### Persist a versioned root-session profile on the owning server

Introduce a server-owned record keyed by workspace and authoritative root session. The record contains the requested mode, effective mode, profile version, acknowledgement, actor, one shared authority revision, and timestamps. Mode and grant mutations advance the same authority revision. `Request approval` is the absence/default state; `Full access` is explicit and versioned.

The server also stores reusable grants keyed by workspace, root session, permission/action, and bounded resources. Grants include their source protocol, governing profile version, authorizing principal ID and required scope, creation metadata, exclusion set, and state, but never rely on upstream `always` persistence. Full access records likewise retain the authorizing principal rather than treating the broker service as the authorization actor.

The renderer reads and mutates this state through typed workspace APIs. It may cache results for presentation, but browser storage is not authoritative. Updates use revisions or compare-and-set so stale split panes cannot silently overwrite newer mode changes.

Alternative considered: store the mode in localStorage following the session model selector. Rejected because it cannot enforce remote workspaces, cannot act while the renderer is disconnected, and can disagree with server behavior.

Alternative considered: store a wildcard OpenCode session permission rule. Rejected because session rules are evaluated after other rules and may override hard denies.

### Broker automatic approvals at the workspace-owning server

Add a permission broker beside the semantic interaction routes. It observes or polls authoritative pending permission requests, resolves the request's current root ancestry, reads the current mode and grants, evaluates policy, reserves the existing interaction scope, and dispatches `allow_once` to the exact target request. Reservation is rolled back on upstream failure.

Full access activation uses an `arming` state. Under one broker serialization boundary, the server establishes live arrival capture and reads a complete authoritative pending snapshot for the root tree. The runtime adapter must expose the snapshot's linearization point: the instant represented by the complete pending list. Requests present in that snapshot, plus captured requests whose authoritative creation or event sequence is at or before that point, form the persisted activation exclusion set. Requests created after that point are future requests even if the effective-mode commit occurs later. The server writes the audit intent and exclusion set before committing Full access as effective. If the adapter cannot provide a complete snapshot and trustworthy boundary, activation fails closed. Excluded identities remain manual until they resolve or disappear from a later complete snapshot, including when first delivered after activation or after a restart.

For the pinned runtime adapter, JuggleWork treats the complete pending-list read as the linearization operation and continuously captures permission events before starting that read. Events captured during and after the read are reconciled against the returned list; requests absent from the linearized list are classified after the boundary. An adapter with eventual or partial pending-list semantics is unsupported for automatic authority.

Immediately before dispatch, the broker re-reads the pending request, root ownership, shared authority revision, effective profile or grant version, authorizing grant when applicable, the authorizing human principal's current scope, and policy. A downgrade, grant removal, author demotion, ancestry change, or policy change therefore wins over a stale automatic decision.

Alternative considered: auto-reply in the renderer on `permission.asked`. Rejected because it stops working during renderer disconnection and creates inconsistent behavior across devices and remote workspaces.

### Implement reusable session grants as matching rules over pending requests

For legacy requests, reusable scope comes from non-empty `always` patterns; for v2 requests, it comes from non-empty `save` resources. A grant also records the source protocol and normalized permission/action. Grants never match across protocols or normalized actions.

Resource matching uses the same wildcard grammar as the pinned upstream runtime for that protocol: full-string glob matching with `*` matching zero or more characters and all other characters treated literally. Matching is case-sensitive, performs no path or URL canonicalization, and compares the exact upstream resource strings. Every resource requested by the later permission must match at least one grant pattern; empty, malformed, truncated, mixed-action, or unrecognized input fails closed. Duplicate resources are removed without changing meaning.

Grant creation uses a durable state machine: `pending → dispatching → active | failed | indeterminate`. The server persists a sanitized audit intent and inactive pending grant before reserving the permission, sends `allow_once`, persists the terminal outcome, and activates the grant only after upstream success and durable success attribution. A failure before dispatch removes or fails the pending grant and rolls back the reservation. If restart or storage failure leaves dispatch outcome uncertain, the current operation is reported as possibly completed, the grant remains inactive, and reconciliation records an indeterminate outcome rather than retrying authority widening.

Grant activation uses the same adapter-defined linearization point, serialized arrival capture, and complete pending snapshot as Full access. Before the source request is dispatched, the server persists all other matching request identities present at that boundary as the grant's exclusion set. The source request is explicitly exempt because the user is approving it in the same action. Requests in the linearized snapshot but first delivered later remain manual across restart; requests created after the boundary are future requests. Grant activation is unsupported when the adapter cannot provide this boundary.

If no reusable scope is supplied, the UI omits or disables the reusable action.

Grant matching must be centralized and tested for exact values, wildcard patterns, empty resources, mixed resources, and protocol normalization. It must fail closed on unsupported or malformed request shapes.

Alternative considered: treat the currently displayed request resources as the reusable scope. Rejected because OpenCode distinguishes requested resources from the scope it offers for future approvals.

### Establish a hard-policy ceiling above session modes

All approval dispatches, including manual Allow once, grant creation, and broker decisions, pass a shared server-side approval ceiling for server writability and caller authority, organization policy, workspace ownership, current ancestry, and known disabled MCP or hard-deny policy. Existing execution-time plugins and OS/provider boundaries remain authoritative after approval.

Add an organization policy gate for Session Full access. Missing or malformed policy fails closed where an organization policy is expected. Mode updates and automatic replies enforce the same policy server-side; hiding the selector is only a usability measure.

In the initial version, enabling Full access requires owner scope. Collaborators retain existing one-time approval and rejection rights and may create a reusable grant only through an explicit pending request whose offered reusable scope is displayed. Viewers cannot mutate either modes or grants.

Automatic authority remains delegated by the recorded human principal. Before each Full access reply, the server verifies that principal still has owner authority in the owning workspace context. Before each grant-based reply, it verifies that the grant author still has collaborator authority. A confirmed demotion, membership removal, ownership transfer, deleted identity, or inability to obtain authoritative membership data triggers a durable transaction that suspends Full access or invalidates the grant and advances the shared authority revision before dispatch can continue. The service principal is never substituted for the human authorization actor. A current owner must explicitly renew suspended Full access; restored membership never silently reactivates it. An invalid grant stays inactive and must be recreated through a new pending request.

The first profile version treats all well-formed OpenCode permission requests that reach the broker as eligible, including doom-loop permission requests. Question interactions are a separate protocol and are never answered automatically. A request is policy-blocked when the shared approval ceiling identifies a disabled MCP, server read-only state, insufficient caller authority, prohibited organization policy, unverifiable ownership, or another explicit execution-time hard deny exposed to the server. Policy-blocked requests remain visible with only rejection available unless the underlying runtime resolves them; malformed or unrelated requests are never projected as actionable.

Alternative considered: assume that receiving a permission request means it is always safe to approve. Rejected because organization policy and workspace state can change after the engine created the request.

### Apply root configuration to descendants while preserving target identity

Mode and grant lookup uses the authoritative root session. Requests from descendants inherit that root configuration, but reservation and upstream reply continue to use the descendant's exact `sessionID` and request ID. Unresolvable or cyclic ancestry fails closed and is never assigned to an unrelated root.

This follows the existing descendant interaction contract and avoids copying permission state onto short-lived child sessions.

Alternative considered: store the profile on every child. Rejected because child creation and nested ancestry would introduce propagation races and cleanup debt.

### Keep pre-existing pending requests manual

Enabling Full access records the adapter-defined activation linearization point. The broker only auto-approves requests classified as created after that point; requests present at the boundary remain excluded even if first delivered later. Existing pending requests remain visible until individually allowed or rejected. Changing back to Request approval immediately prevents not-yet-dispatched automatic replies after the final revision recheck.

Returning to Request approval unconditionally clears active and pending reusable grants for that root in the same authority-revision transaction so the resulting behavior is predictable. The UI explains that already running actions cannot be revoked.

Alternative considered: approve all pending requests when the toggle changes. Rejected because a settings action would execute operations the user had not reviewed.

### Place a controlled selector in each composer

Add a compact, portalled selector after model behavior and before Run/Queue. Each `SessionSurface` receives mode data resolved for its own root session, following the pane-specific model settings pattern. The selector stays visible in both idle and running states; running changes explicitly apply only to subsequent requests.

Use warning styling only for the Full access icon and keep labels visually aligned with other toolbar settings. The popover is viewport-bounded for narrow windows and stacked split panes. Enabling Full access opens a confirmation dialog with versioned acknowledgement copy.

The approval panel continues to show deny and one-time allow. Its reusable action appears only when the request supplies a grantable scope, and the details distinguish the current request resources from the future scope being granted.

Alternative considered: put permission mode in the Tools menu. Rejected because it is persistent execution authority that should remain visible before submission.

### Add sanitized durable audit events

Add a durable security-decision ledger in the server database with intent and terminal-outcome records for profile changes, grant creation/removal, automatic approval, and policy-blocked decisions. Records include workspace/root/target identity, bounded normalized resource summaries, actor/authenticated origin, profile version, authority revision, and timestamp. The existing workspace audit reader may project these events, but append-only JSONL is not the transactional authority.

Do not write raw request metadata, environment values, complete shell output, credentials, or unbounded commands. Intent and terminal outcome share one decision ID and form a linked decision unit. The ledger retains at most 10,000 completed decision units per workspace and removes completed units older than 90 days atomically, deleting both intent and terminal outcome. Genuinely unresolved intent or indeterminate units are exempt from age and count pruning until reconciliation completes, after which normal retention applies. Mode mutation and grant activation fail if their required audit records cannot be persisted; automatic request handling fails closed if the security decision cannot be durably attributed.

Alternative considered: rely only on the in-memory resolution coordinator. Rejected because it does not survive server restart and does not provide user-auditable security history.

### Suspend incompatible persisted profiles

Whenever a persisted Full access profile version and acknowledgement pair is not exactly supported by the running server—including older, future, unknown, malformed, or mismatched values—the record keeps its requested mode but its effective mode becomes `paused`. The broker behaves as Request approval, the composer displays `Full access paused`, and no automatic approval resumes until an owner accepts the currently supported profile. Every grant independently carries its governing profile version; an old, future, unknown, or malformed grant remains inactive in every root mode and is cleared when the profile is renewed, downgraded, or the user clears grants. This makes rollback to an older binary fail closed.

Alternative considered: silently continue the old profile. Rejected because its consent does not cover changed authority semantics. Silently showing Request approval was also rejected because it hides the user's persisted choice and the reason behavior changed.

### Derive controller origin from authenticated context

Mode and grant APIs do not accept an authoritative `origin` from request JSON. The server derives actor and channel from the authenticated route context. Desktop remote-control adapters have no Full access or grant mutation operation, and their permission reply schema remains one-time-or-reject. Forged body fields are ignored or rejected. Direct workspace API callers remain governed by token scope, with Full access restricted to owner credentials.

Alternative considered: continue trusting the existing `origin` body discriminator. Rejected because a security boundary cannot depend on a caller-asserted string.

## Risks / Trade-offs

- [A broad reusable pattern can still approve more than the user expects] → Show the future grant scope separately, require complete resource coverage, and provide clear-grants control.
- [Automatic approval can amplify prompt injection or destructive model behavior] → Require explicit acknowledgement, preserve hard policy, audit every decision, and keep Full access continuously visible.
- [Event ordering can race with mode changes] → Record observation boundaries and re-read pending state, ancestry, profile revision, and policy immediately before dispatch.
- [A server restart can interrupt an in-flight reservation] → Treat OpenCode pending state as authoritative after restart, use one-time idempotent-style resolution where possible, and surface indeterminate failures rather than assuming approval.
- [Remote OpenCode deployments may not expose identical legacy/v2 capabilities] → Feature-detect pending and reply protocols and fail closed when ownership or reply semantics cannot be verified.
- [Audit logs can become sensitive or large] → Store bounded normalized fields, redact sensitive values, cap resource counts and lengths, and use existing log retention conventions.
- [Full access wording can imply a sandbox escape or OS privilege] → Explain that it auto-approves runtime prompts only and list the boundaries that remain enforced.

## Migration Plan

1. Add storage, shared schemas, policy gate, APIs, and audit event definitions with Request approval as the default for all existing sessions.
2. Add the broker in observation-only mode during tests, then enable automatic decisions only for explicit Full access records created under the current profile version.
3. Ship the composer selector and updated permission panel after server capability detection confirms the owning server supports the profile API.
4. Stop offering protocol-native `always` as “Allow for session.” Existing OpenCode legacy or v2 saved approvals are not silently imported because their scope cannot be represented as a root-session grant; Request approval copy explicitly says it follows upstream runtime policy, and detectable v2 saved approvals are surfaced as existing runtime approvals rather than attributed to JuggleWork.
5. On rollback, disable broker execution and hide the selector. Persisted JuggleWork profiles and grants remain inert data and can be removed by a later cleanup migration; no upstream wildcard or saved permission needs reversal.

## Open Questions

- Decide whether end users need a dedicated security activity surface in addition to the existing debug audit view; this does not change ledger persistence or retention.
