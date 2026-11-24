# Change: Rebrand user-visible product name to 北数Work

## Why
The 北数Work distribution must not show the JuggleWork name. The first-launch sign-in page also showed hard-coded English copy, no logo, and a JuggleWork-specific introduction regardless of the system language.

## What Changes
- Replace the user-visible product name `JuggleWork` with `北数Work` in locale strings, UI copy, window and menu titles, tray labels, page titles, Windows shortcut fallback names, macOS usage descriptions, and helper app display names.
- Use `北数Work` as the default display name when no organization brand name is configured. The server's default `brandAppName: JuggleWork` counts as not configured.
- Localize the full-screen sign-in page through i18n, show the bundled app logo when no organization logo is configured, and replace the introduction panel with 北数Work copy and bundled icons.
- Brand the Windows package itself: the installer `productName`, artifact filename, shortcut name, and rounded Windows icon use `北数Work`, while the process and executable file name stay `JuggleWork`.
- Keep internal identities unchanged: app IDs, NSIS GUID, protocol scheme, userData paths, executable and bundle file names, on-disk Documents folder names, agent and model prompts, server CLI logs, and strings matched by code.

## Impact
- New spec: `desktop-product-branding`
- Affected areas: app locales and UI, Electron main process display names, packaging display strings
