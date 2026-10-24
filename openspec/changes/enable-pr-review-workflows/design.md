## Decisions

1. Use the organization connection already selected for reads. Never accept raw capability names or GitHub credentials from the renderer. Expose a fixed set of comment, review, lifecycle, merge, and auto-merge availability flags; downstream GitHub permissions remain authoritative.
2. Mutate GitHub only through authenticated collaborator POST routes after explicit confirmation. Re-read the PR head without cache, compare the reviewed SHA, and bind review creation or merge to that SHA. Never automatically retry an ambiguous external mutation. Persist operation IDs and content fingerprints so lost responses and restarts cannot duplicate an acknowledged operation.
3. AI review reads bounded PR metadata and patches on the server, checks the head again, and gives untrusted reference data to a tool-denied engine session. It returns validated JSON findings, with changed-file/line validation and explicit partial-coverage notices. No GitHub write tool is exposed to this task.
4. Save private runs under hashed workspace/connection execution scope. Background execution outlives navigation, supports cancellation and bounded deadlines, and marks interrupted runs failed after restart. The transcript remains a normal workspace task.
5. Fix tasks accept only selected IDs from the saved analysis of the current revision. They must verify repository and revision before changing files, protect local work, investigate false positives, and avoid commits/pushes/publication unless requested in the task. Reopening the same selection reuses its linked task.
6. Keep the existing native master-detail layout. The header exposes a status menu, local pin, copy URL, open in GitHub, and a merge menu. Every remote mutation opens a confirmation dialog; local shortcuts do not. AI results and review publishing use separate dialogs, and copying AI findings into a draft never publishes them. Organization changes close dialogs and fence late navigation/results.

## Reference

Local Codex desktop assets were inspected for review actions, PR revision presentation, related review chat, and finding/fix navigation. GitHub MCP operation parameters follow the official `pull_request_review_write` and `add_issue_comment` tool schemas.
