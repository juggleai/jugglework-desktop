# Change: Integrate Windows window controls into the application toolbar

## Why
The native Windows title bar uses a different background from the application toolbar, making the main window look visually split. The system minimize, maximize, and close controls should sit at the right edge of the existing top toolbar, immediately after its actions, while retaining native Windows behavior.

## What Changes
- Use Electron's native Windows title-bar overlay for the main window instead of a separate standard title bar.
- Match the overlay height and light/dark colors to the application top toolbar.
- Reserve the native caption-button area to the right of the session toolbar actions so the Extensions/settings action remains clickable immediately to their left.
- Keep native minimize, maximize/restore, close-to-tray, document-close protection, Windows Snap Layout, and accessibility behavior.
- Leave macOS and Linux window decoration behavior unchanged.

## Impact
- Affected capability: `desktop-window-chrome`
- Affected files: Electron main-window appearance, Windows title-bar helper/tests, session top-bar layout/tests
- No new IPC and no custom implementation of minimize, maximize, or close
