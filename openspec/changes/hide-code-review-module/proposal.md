# Change: Hide the Code Review module behind a build flag

## Why
The 北数Work distribution does not ship the GitHub pull-request Code Review workbench. Users must not reach it from navigation, a stale pin, or an old link.

## What Changes
- Add the `CODE_REVIEW_ENABLED` build flag (`VITE_CODE_REVIEW_ENABLED`), default off.
- When off, remove the Reviews entry and pin action from the rail More menu and ignore a previously stored Reviews pin.
- When off, redirect `/workspace/:id/reviews` routes to the workspace's last session instead of mounting the Review surface.
- Keep the Review page code and server review APIs unchanged so the module can be re-enabled without code changes.
- The OpenCode `/review` composer slash command is a separate engine command and is unchanged.

## Impact
- Affected spec: `pr-review-workbench`
- Affected app areas: application navigation rail, workspace app routes
