## Context

Today `handleCreateTaskInWorkspace` (`session-route.tsx`) calls `session.create` and navigates to the new session. The route `/workspace/:id/session` without a session ID already exists, but it renders a placeholder instead of a composer. `use-workspace-route-state.ts` also redirects that route to the remembered last session.

The composer is keyed by session ID almost everywhere: text, attachments, pasted-text parts, Office groups and queued messages live in `composer-state-store.ts`; model, agent and permission mode live in per-session stores or on the server. The only session-independent layer is the global default model. There is no atomic create-then-send path in live code: `actions-store.ts` has one but nothing calls it. Creation uses a retained intent ID (`session-creation-idempotency`), so a retried `session.create` returns the same session.

## Goals / Non-Goals

**Goals:**
- Defer session creation until the first send, for every user entry point.
- Keep one in-memory draft per workspace, preserved across repeated "+", workspace switches, and page visits.
- Reuse the existing composer so attachments, pasted-text collapse, mentions, skills, model, agent and permission controls work on the draft page.
- Never create more than one session per draft send, and never lose typed content when creation or send fails.

**Non-Goals:**
- Restoring drafts after an app restart.
- Office selection references on the draft page.
- Changing `session.create_task` for agents and voice.
- Any Server or engine API change.

## Decisions

**1. Reuse the composer with a draft identity instead of building a second composer.**
The draft uses the pseudo session ID `draft:<workspaceId>` in the composer state store. Alternative: a separate lightweight composer. That would drop pasted-text collapse, mentions and skill chips, and duplicate send logic. A prefixed ID cannot collide with real engine session IDs. Every consumer that passes the ID to the Server or engine (permission, queue, Office, title, history, tabs) must treat draft IDs as "no session". An explicit `isDraftSessionId` helper is the single check.

**2. Draft state lives in a per-workspace store with the composer state, not in localStorage.**
Model, agent, permission mode and target group are held on the draft record. Alternative: write them straight into the global defaults. That breaks the "never sent, never changes defaults" rule. Persisting to localStorage would need attachment file handling and is out of scope.

**3. Create, move state, then send, in this order.**
On first send: claim a draft-level single-flight lock, call `session.create` with its retained intent, rename the draft's composer state to the real session ID (including attachments and pasted parts), write the model, agent, permission mode and group to the new session, then send through the normal draft sender and navigate. Moving state before the send means a failed or unconfirmed send leaves the content in the created session's composer, matching the existing "outcome unconfirmed, check before retrying" rule. Alternative: delete the empty session on failure. Deleting after an ambiguous send risks removing a session whose prompt actually landed.

**4. The draft route is a marked variant of the existing no-session route.**
Use `/workspace/:id/session?draft=1` and have the last-session redirect and settings-return logic honor it. Alternative: a new path segment, which would require every route parser to learn another shape. The redirect already supports `?exact=1`, so this follows an existing pattern. The marker is confirmed during implementation (task 1.2).

**5. A single entry function for "start a task here".**
Introduce `openDraftForWorkspace(workspaceId, options)` and point all seven entries at it. `handleCreateTaskInWorkspace` stays as the immediate creator used by `session.create_task`, onboarding and the first-send path. Alternative: add a flag to the existing function, which mixes two behaviors in one source-text-tested function.

**6. Session-scoped UI must not fall back to another tab on the draft page.**
`resolveWorkbenchActionSessionId` currently falls back to an open tab when the primary session is null. On the draft page the primary is a draft, so actions are disabled instead of resolved.

**7. Office references are rejected for drafts at the composer boundary.**
`appendOfficeSelection` and the Office bridge reject draft IDs. The Office guard and clear paths ignore them.

## Risks / Trade-offs

- [Draft ID leaks into a Server or engine call] → One `isDraftSessionId` guard at each client boundary; tests assert no client call carries a `draft:` ID.
- [Moving composer state loses an attachment or pasted part] → Move the whole per-session record atomically; test with text, attachment, pasted part and mention.
- [Create succeeds, send is unconfirmed, user retries and duplicates] → After the move there is no draft; retry targets the created session.
- [Double send creates two sessions] → Draft-level single-flight plus the existing creation intent.
- [Sidebar selection and tab history assume a session ID] → Draft page selects no row and does not add a tab or history entry; verified by tests for empty-session routes.
- [Starter-card prefill reads from a draft store that nothing reads] → Prefill is written directly to the draft composer; implementation confirms the current behavior first.
- [Behavior differs from the agent action] → Documented in the spec; `session.create_task` is unchanged.
- [Source-text tests break] → `manual-session-creation.test.ts` and `workspace-sidebar-actions.test.ts` are updated alongside.

## Open Questions

- Does the existing starter-card prefill currently show in the composer? Confirmed by a manual check before reusing that path.
- Should an empty, untouched draft count as "no draft" for Settings-return routing? Default: yes, an empty draft does not override the last session on return.
