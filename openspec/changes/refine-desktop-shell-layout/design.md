## Context

The session shell currently uses a tinted left application/workspace region, an opaque white session header, a full-bleed square center surface, and a permanent 44px right utility rail. Browser, Files, and Extensions actions live vertically in that rail, with Voice added conditionally. The generic sidebar inset mode can create rounded content, but enabling it would also alter sidebar geometry and collapse behavior.

## Goals / Non-Goals

**Goals:**

- Create one continuous tinted window chrome across the left region and top edge.
- Focus the conversation list and conversation content in one white/theme-page rounded surface.
- Move existing utility actions into the session top bar without changing their state or accessibility contracts.
- Preserve macOS drag/no-drag zones, side-panel resizing, Files expanded mode, and dark-theme mappings.

**Non-Goals:**

- Redesigning side-panel contents or data.
- Changing navigation order or side-panel persistence.
- Changing the native Electron titlebar mode.
- Applying the rounded session shell to unrelated full-page Settings, Chat, Automation, or Review surfaces in this slice.

## Decisions

### Join the session list and content inside one inset treatment

The session list receives the left edge, top/bottom border, and left-hand corners of the page-white surface. The `SidebarInset` content wrapper receives the right edge and right-hand corners, with its left border acting as the internal divider. Both surfaces use the same top offset and bottom inset so they read as one continuous card. When the sidebar is collapsed, the content wrapper restores its left corners and inset. This is more isolated than switching the shared Sidebar to `variant="inset"`, which would also change generic sidebar dimensions.

### Keep the session header inside the white work surface

The visible native top strip remains tinted because the rounded work surface is inset from the top. The session header itself remains part of the white card, preserving contrast and existing 50px alignment with panel headers.

### Reuse existing utility callbacks in the header

Browser, Voice, Files, and Extensions buttons move to the existing `mac:titlebar-no-drag` right-action container. Labels, `aria-pressed`, callbacks, and active-state classes remain stable so side-panel behavior and accessibility automation continue to work.

### Remove right-rail geometry completely

The vertical `<aside>` is removed rather than visually hidden. Expanded Files changes from `right-11` to `right-0`, because there is no longer a reserved right edge.

## Risks / Trade-offs

- **Narrow headers can run out of space.** → Keep utility buttons icon-only and let secondary workspace/branch metadata hide at existing responsive breakpoints.
- **Rounded clipping can hide panel resize affordances.** → Apply clipping only at the outer white shell and preserve internal ResizablePanelGroup geometry.
- **Dark theme could become too contrasty.** → Use semantic page/sidebar tokens rather than hard-coded white or gray values.
- **Existing eval prose calls actions a right rail.** → Preserve accessible labels/selectors now; update prose separately when those evals are next maintained.
