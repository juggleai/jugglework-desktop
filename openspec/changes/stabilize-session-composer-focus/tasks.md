## 1. Background Refresh

- [x] 1.1 Treat a fetch with renderable target-session data as a background refresh rather than a switching transition.
- [x] 1.2 Preserve initial and mismatched-session switching behavior.

## 2. Focus Coordination

- [x] 2.1 Replace fixed-delay global focus retries with a target-session request coordinator.
- [x] 2.2 Cancel superseded requests and requests overtaken by newer user input.
- [x] 2.3 Restrict focus completion to the active, visible, editable composer.
- [x] 2.4 Route session switching, session creation, onboarding, model-picker return, and control input through the coordinator.

## 3. Validation

- [x] 3.1 Add regression tests for background refresh, rapid navigation replacement, target matching, and user-intent cancellation.
- [x] 3.2 Run application typecheck and focused tests.
- [x] 3.3 Run the application production build.
- [ ] 3.4 Manually verify rapid session switching and uninterrupted typing in the desktop development runtime.
