## Why

Clicking "+" on a project row currently calls `session.create` immediately and opens an empty session. Users who change their mind, or who switch away before typing, leave empty sessions behind in the sidebar. The session should exist only once the user actually starts a task.

## What Changes

- All "new task" entries open a per-workspace **draft page** at the workspace's no-session route instead of creating a session: the sidebar project "+", the "no tasks" row, the group-header "+", Cmd/Ctrl+N, the command palette "New session", the composer `/new` command, and the placeholder starter cards.
- The draft page shows the normal composer centered under a prompt such as "What should we do in <project>?", with the workspace as context. No session, sidebar row, or tab exists until the first send.
- Sending the first message creates the session, sends the prompt, applies the draft's model, agent, permission mode and group, then navigates to the new session. The draft is cleared only after the session is created and the prompt is accepted.
- Each workspace keeps its own in-memory draft (text, attachments, pasted-text parts, mentions, model, agent, permission mode, target group). Clicking "+" again in the same workspace, switching to another workspace and back, and visiting Settings or other app pages all preserve it. The draft is lost on app restart.
- The draft page does not support Office selection references in this version. The Office "AI edit" entry keeps targeting existing sessions only.
- The agent-callable control action `session.create_task` keeps creating a session immediately, because it has no composer to fill.
- If session creation succeeds but the prompt send fails or is unconfirmed, the created session is kept, the user is taken to it with the unsent content restored, and a retry reuses that session rather than creating another.

## Capabilities

### New Capabilities

- `draft-new-task-page`: the per-workspace no-session draft page, its entry points, draft retention rules, and the deferred session creation and first-send contract.

### Modified Capabilities

- `new-session-model-defaults`: the remembered model and reasoning selection is applied to the draft and then to the session created from it; choosing a model on the draft page does not retarget another session.

## Impact

- `apps/app/src/react-app/shell/session-route.tsx` (`handleCreateTaskInWorkspace`, shortcut and command-palette wiring, send path), `use-workspace-route-state.ts` (last-session redirect), `workspace-routes.ts`, `workspace-app-route.tsx` (retained targets).
- `apps/app/src/react-app/domains/session/sidebar/app-sidebar.tsx` and `session-page.tsx` (entry points and the placeholder replaced by the draft page).
- `apps/app/src/react-app/domains/session/surface/` (composer state keyed by a draft identity; migration to the real session on creation), model, agent and permission stores.
- `session-surface.tsx` and `session-draft-sender.ts` for the create-then-send path.
- Existing tests that inspect source text or extract functions (`manual-session-creation.test.ts`, `workspace-sidebar-actions.test.ts`) need updating.
- No Server or engine API change. Sends continue to use the existing `session.create` intent identity (see `session-creation-idempotency`).
