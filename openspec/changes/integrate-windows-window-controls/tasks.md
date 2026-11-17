## 1. Windows window chrome
- [x] 1.1 Add deterministic light and dark Windows title-bar overlay options matching the 44-pixel application toolbar.
- [x] 1.2 Apply the overlay only to the Windows main window and refresh it when the native theme changes.
- [x] 1.3 Reserve the native caption-button area after the session toolbar actions.

## 2. Verification
- [x] 2.1 Add tests for overlay dimensions, colors, main-window integration, and theme refresh.
- [x] 2.2 Add a session-shell layout assertion for the Windows caption-button safe area.
- [x] 2.3 Run the focused desktop and app tests, App type checking, and Electron bridge verification.
