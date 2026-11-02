# Implementation status

- [x] Resolve and validate local targets in the host; reject unsupported directories and remote targets.
- [x] Extract bounded owner-scoped terminal manager with idempotent open and output replay.
- [x] Separate hiding the view from terminating its shell.
- [x] Add toolbar terminal icon, dynamic theme integration, compact title and hide-only control.
- [x] Add targeted manager, resolver, native PTY, state and theme tests.
- [ ] Design recovery for exited terminals and resource cleanup without reintroducing removed header controls.
- [ ] Make changed view focus versus retained terminal binding safely discoverable without restoring verbose title text.
- [ ] Verify complete child-process cleanup and sustained output behavior.
- [ ] Verify packaged macOS/Windows, IME and full-screen TUI behavior.
- [ ] Complete full-repository type checks after unrelated baseline errors are resolved.

The OpenSpec CLI is unavailable in this environment; these records have not been CLI-validated or archived.
