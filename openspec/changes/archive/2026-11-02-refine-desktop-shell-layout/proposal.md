## Why

The desktop session shell currently splits navigation and utility actions across visually disconnected left, top, and right rails, while the central work surface remains full-bleed and square. Aligning the shell with the compact macOS reference makes hierarchy clearer and gives the conversation content a focused, card-like workspace.

## What Changes

- Give the left navigation/list chrome and the top window chrome a shared tinted background.
- Remove the permanent right-side vertical action strip.
- Move Browser, Voice when enabled, Files, and Extensions into the session top bar as horizontal actions while preserving behavior and accessibility labels.
- Render the main session work area as a white/theme-page surface with rounded corners and visible surrounding chrome.
- Remove the Files expanded overlay's obsolete reservation for the former right rail.
- Preserve side-panel state, resizing, macOS drag/no-drag behavior, and compact navigation dimensions.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `ui-theme-tokens`: Change session-shell top chrome from page-white to shared chrome tint and require a rounded center work surface with horizontal utility actions.

## Impact

- Affects the session shell, application rail, session top bar, side-panel entry controls, expanded Files overlay, and desktop layout tests.
- Does not change side-panel data, actions, persistence, or external APIs.
