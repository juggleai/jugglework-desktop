## 1. Runtime Activity State

- [x] 1.1 Extend session activity records with structured provider retry detail and canonical update/clear actions
- [x] 1.2 Classify retry events separately from meaningful assistant and tool progress in live synchronization
- [x] 1.3 Restore retry activity from session snapshots without adding synthetic transcript text

## 2. Conversation Presentation

- [x] 2.1 Pass canonical retry and stalled activity into the active message list and render the correct live status
- [x] 2.2 Derive and display a local-only tool activity summary with current action and completed-step count
- [x] 2.3 Project child-session retry detail into parent task tool presentation
- [x] 2.4 Add localized activity labels for retry and tool-step summaries

## 3. Verification

- [x] 3.1 Add state and synchronization tests proving retry events do not reset meaningful-progress stalled detection
- [x] 3.2 Add presentation/helper tests for visible retry, stalled, tool-only progress, and child-session activity
- [x] 3.3 Run focused app tests, type checking, and strict OpenSpec validation
