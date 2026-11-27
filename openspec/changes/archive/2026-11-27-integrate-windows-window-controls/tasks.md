## 1. Windows window chrome
- [x] 1.1 Add deterministic light and dark Windows title-bar overlay options matching the 44-pixel application toolbar.
- [x] 1.2 Apply the overlay only to the Windows main window and refresh it when the native theme changes.
- [x] 1.3 Reserve the native caption-button area after the session toolbar actions.

## 2. Verification
- [x] 2.1 Add tests for overlay dimensions, colors, main-window integration, and theme refresh.
- [x] 2.2 Add a session-shell layout assertion for the Windows caption-button safe area.
- [x] 2.3 Run the focused desktop and app tests, App type checking, and Electron bridge verification.

## 3. Windows follow-up fixes
- [x] 3.1 Apply the existing `mac:titlebar-drag` / `mac:titlebar-no-drag` regions on Windows so page-level drag regions no longer swallow navigation rail clicks.
- [x] 3.2 Remove native `title` tooltips from navigation rail buttons (except the cloud-docs native view) and session list rows; keep `aria-label` for accessibility.
- [x] 3.3 Run navigation rail, session shell, and sidebar tests plus App type checking.
