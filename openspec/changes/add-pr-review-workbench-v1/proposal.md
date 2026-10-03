## Why

JuggleWork currently has no first-class place for users to triage and inspect remote pull requests without leaving the desktop app. A native first-version review workbench establishes the product shell, navigation, route, and semantic context needed before connecting real GitHub/GitLab data or enabling external write actions.

## What Changes

- Add a workspace-scoped Reviews route and a persistent entry in the left vertical application navigation rail.
- Add a native, responsive first-version Review workbench with a mock PR Inbox and PR detail views for summary, changes, checks, and threads.
- Preserve the active session while the full-page Reviews surface is visible, matching the retained-surface behavior of other workspace pages.
- Expose the active Review route and selected pull request through JuggleWork semantic context.
- Add focused route, context, and UI tests.
- Explicitly defer real provider connections, AI review execution, comments, approvals, merge operations, and MCP App hosting.

## Capabilities

### New Capabilities
- `pr-review-workbench`: Workspace navigation, mock PR triage/detail experience, and semantic context for the first-version remote PR Review workbench.

### Modified Capabilities

None.

## Impact

- Affects workspace route parsing and retained full-page surface composition.
- Adds a new application navigation rail destination.
- Adds a new React review domain with static first-version data and local selection state.
- Extends shared JuggleWork context types and the context projector with a review screen/resource.
- Adds no provider dependency, credential handling, server API, database migration, or external write operation in this version.
