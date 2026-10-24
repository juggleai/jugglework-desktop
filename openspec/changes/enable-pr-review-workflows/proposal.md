## Why

The connected Code Review workbench can only inspect PRs. Members need to analyze defects privately, publish their own review decisions, and create repair tasks without leaving the workbench or configuring another GitHub credential.

## What Changes

- Discover comment, review-write, lifecycle, merge, and auto-merge capabilities from the same organization connection as PR reads.
- Add explicit, revision-bound comment, review, status, and merge operations with durable replay protection.
- Run cancellable, model-selectable AI analysis on bounded PR context in a tool-denied session, persist private findings, and link its transcript.
- Create normal workspace repair tasks from selected server-owned findings, carrying repository/revision verification and explicit no-push instructions.
- Add native review dialogs, findings selection, private-to-published review drafts, PR status menus, local sidebar pinning, GitHub shortcuts, and recovery states.
- Associate review and fix tasks with the pull request, use predictable repository/PR titles, and reuse the review task across revisions instead of creating duplicate opaque sessions.
- Enrich AI review with bounded repository context read from the exact PR revision when the current local workspace matches the GitHub repository, including applicable `AGENTS.md` guidance, without granting the model write or shell tools.

## Capabilities

### New Capabilities
- `pr-review-workflows`: Private AI review, explicit GitHub publishing, and finding-to-fix tasks.

### Modified Capabilities
- `pr-review-workbench`: Enable actionable review controls while preserving read access when organization write tools are unavailable.

## Impact

Updates shared contracts, the desktop embedded server, server client, renderer, and review tests. Uses the existing organization GitHub connector and workspace model/engine. GitLab, automatic review publication, and automatic pushing are excluded.
