## 1. Implementation
- [x] 1.1 Add `SessionHomeHero` with the office scenario chips and prompt templates (en, zh).
- [x] 1.2 Add `WorkspaceSelect` and the composer `footerAccessory` / `homeLayout` props.
- [x] 1.3 Gate the home on an empty, idle session in `SessionSurface`; move the permission selector to the footer while it is shown.
- [x] 1.4 Pass workspace options, workspace switching, workspace creation and the scheduled-tasks entry from the session route; disable the home in the split-view secondary pane.
- [x] 1.5 Replace the no-session starter cards with `SessionHomeEntry`, which creates a task from typed text or a scenario chip.
- [x] 1.6 Create and select the 日常办公 workspace on first launch in the Electron workspace store.
- [x] 1.7 Prevent the legacy starter cards from flashing while a new session snapshot is loading.

## 2. Verification
- [x] 2.1 Add hero, workspace selector and layout-gate tests.
- [x] 2.2 Add workspace-store tests for first-launch creation, no recreation after removal, and the opt-out flag.
- [x] 2.3 Run app type checking, the app test suite and the desktop test suite; failures match the pre-change baseline.
- [x] 2.4 Add `SessionHomeEntry` tests for chip, Enter, IME and disabled handling.
- [x] 2.5 Check the rendered home in a browser preview.
- [x] 2.6 Observe a real dev-app new-session transition and verify that CSV/browser/extension starter cards never appear.
