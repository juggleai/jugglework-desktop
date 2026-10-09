## Context

The desktop renderer already has a workspace-aware route parser, a retained session surface, and a fixed left application navigation rail. It also publishes semantic screen context for conversations and settings. The first Review workbench can therefore be implemented as a native React surface without introducing a provider connection, backend schema, MCP App host, or credential boundary yet.

The first version must make the future product shape tangible while remaining honest about its mock-data status. It needs enough interaction to validate navigation, triage, PR selection, detail tabs, responsive layout, and agent-visible context, but it must not expose controls that imply comments, approvals, merges, or AI review are already operational.

## Goals / Non-Goals

**Goals:**

- Add a workspace-scoped Reviews destination to the existing left vertical rail.
- Preserve the active session while the Reviews surface is open.
- Provide a polished mock PR Inbox and selected-PR workbench with Summary, Changes, Checks, and Threads views.
- Keep PR selection and optional deep links route-addressable.
- Publish a first-class `review` semantic screen and review resource.
- Cover route parsing, semantic projection, and the principal UI flow with focused tests.

**Non-Goals:**

- Connecting GitHub, GitLab, JuggleWork Connect, or local `gh`.
- Reading real PR data or persisting review state on the server.
- Running AI review.
- Publishing comments, review decisions, thread updates, or merges.
- Hosting arbitrary MCP Apps.
- Adding a session-side Review panel in this first slice.

## Decisions

### Use a native retained full-page surface

`WorkspaceAppRoute` will mount a `ReviewPage` alongside the existing Settings, Chat, Apps, and Automations surfaces. The session remains mounted and hidden while Reviews is visible.

This is preferable to a session side panel because the Inbox, file tree, diff, checks, and threads need substantially more horizontal space. It also avoids weakening the artifact iframe or coupling the feature to the Electron-only browser panel.

### Put the entry directly in the fixed application rail

The Reviews button will be a statically owned JuggleWork rail item for version one. Dynamic `app-rail-item` extension contributions are intentionally deferred until the generic extension surface and MCP App host exist.

### Use an opaque route-safe review ID

The route family will be:

```text
/workspace/:workspaceId/reviews
/workspace/:workspaceId/reviews/:reviewId
```

The mock data maps the opaque `reviewId` to a canonical PR identity. Future provider URLs and connection identifiers will not be embedded directly in route segments.

### Keep mock data explicit and isolated

Static review fixtures and domain types will live under the Review domain. The page will display a visible preview indicator and disabled/future-action affordances where necessary. No fake network delay or fake successful external mutation will be introduced.

### Make the host semantic context authoritative

The shared context schema will add a `review` screen kind and a `review` resource kind. Route parsing supplies workspace and review identity even when no embedded or provider-backed content exists. Agents will not need to inspect rendered DOM to understand the active surface.

### Use responsive master-detail composition

On wide windows the Inbox and detail area will be visible together. On compact windows selecting a PR will prioritize the detail view and expose an explicit back control. This preserves usability without adding a second navigation model.

## Risks / Trade-offs

- **Risk: Users may mistake fixtures for live provider data.** → Show a clear “Preview data” badge and avoid enabled external mutations.
- **Risk: Static rail composition does not prove extension-driven navigation.** → Keep the route and page modular; defer dynamic contributions to the later MCP App phase.
- **Risk: Extending the shared context union can break exhaustive consumers.** → Update projector tests and all schema consumers in the same change.
- **Risk: A mock page may accumulate throwaway code.** → Define provider-neutral types and isolate fixtures so later query hooks can replace only the data source.
- **Risk: Retaining another full-page surface can increase memory use.** → Mount Reviews only after first navigation and keep fixtures lightweight.

## Migration Plan

1. Add route types/builders and tests.
2. Add the Reviews rail item and wire navigation callbacks through existing shell surfaces.
3. Add the lazily retained `ReviewPage`.
4. Add semantic context schema/projector support.
5. Run focused tests and type checking.

Rollback consists of removing the rail item, route branch, retained surface, Review domain, and the additive semantic union members. No persistent or external data migration is involved.

## Open Questions

- Whether the provider-backed second version should use JuggleWork Connect exclusively or also support a local `gh` adapter.
- Whether the future MCP App should render the full detail surface or only provider-specific content inside a JuggleWork-owned shell.
- Whether pin and file-viewed state should remain local or synchronize when a provider exposes explicit support.
