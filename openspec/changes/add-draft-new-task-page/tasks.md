## 1. Verify assumptions

- [ ] 1.1 Manually confirm whether a starter-card prefill currently appears in the composer, and record the result in design.md Open Questions.
- [ ] 1.2 Confirm the route marker (`?draft=1`) against `parseWorkspaceAppPath`, `settingsReturnRoute`, and the last-session redirect in `use-workspace-route-state.ts`; adjust design.md if a different marker is needed.
- [ ] 1.3 Confirm which consumers of the composer session ID reach the Server or engine, and list the boundaries that need the draft-ID guard.

## 2. Draft state

- [ ] 2.1 Add `isDraftSessionId` and a `draft:<workspaceId>` ID builder next to the composer state store.
- [ ] 2.2 Add a per-workspace draft record (model, reasoning variant, agent, permission mode, target group) kept in memory, with open, get, update and clear operations.
- [ ] 2.3 Add an atomic "move composer state to session" operation covering text, attachments, pasted parts, mentions and history, and verify nothing is left under the draft ID.
- [ ] 2.4 Reject Office selection references for draft IDs in `appendOfficeSelection` and the Office composer bridge.

## 3. Draft page and routing

- [ ] 3.1 Replace the no-session placeholder in `session-page.tsx` with the draft page: centered prompt, workspace context, reused composer, focus on open.
- [ ] 3.2 Make the draft route survive the last-session redirect and settings return, and keep retained-session handling in `workspace-app-route.tsx` consistent.
- [ ] 3.3 Keep the draft page out of session tabs, split view, conversation history and sidebar selection.
- [ ] 3.4 Disable session-scoped actions on the draft page instead of resolving them to another open tab.
- [ ] 3.5 Route starter-card prompts into the draft composer.

## 4. Entry points

- [ ] 4.1 Add `openDraftForWorkspace(workspaceId, options)` and keep `handleCreateTaskInWorkspace` for immediate creation.
- [ ] 4.2 Point the sidebar project "+", the "no tasks" row, and the group-header "+" at the draft entry; carry the group on the draft.
- [ ] 4.3 Point the new-task shortcut, the command palette "New session", and the composer `/new` command at the draft entry; keep `/new` from clearing an unrelated session's composer.
- [ ] 4.4 Keep `session.create_task`, onboarding, fork and review-session creation on immediate creation.
- [ ] 4.5 Remove the pending-disabled state from "+" and the dead retry button that calls the creator.

## 5. First send

- [ ] 5.1 Implement the draft sender: single-flight per draft, create with the retained intent, move state, apply model, agent, permission mode and group, send, navigate.
- [ ] 5.2 On creation failure keep the draft and show an error; on send failure keep the created session with content restored and make retry reuse it.
- [ ] 5.3 Guard every Server and engine client boundary against `draft:` IDs.
- [ ] 5.4 Apply the draft model to the remembered default only when the session is created.

## 6. Tests and verification

- [ ] 6.1 Add tests for repeated "+" in one workspace, switching workspaces, visiting Settings, and restart not restoring drafts.
- [ ] 6.2 Add tests for first-send success, creation failure, send failure and retry reuse, double send, and group assignment.
- [ ] 6.3 Add tests that no client call carries a draft ID and that Office references are rejected for drafts.
- [ ] 6.4 Update `manual-session-creation.test.ts` and `workspace-sidebar-actions.test.ts` for the new entry function.
- [ ] 6.5 Run the touched app test suites, App `pnpm typecheck`, and `openspec validate add-draft-new-task-page --strict`.
- [ ] 6.6 Manually verify in the desktop app: "+" opens the draft page, no session appears before send, content persists across workspaces and Settings, and the first send creates and opens one session.
