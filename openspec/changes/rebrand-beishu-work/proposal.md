# Change: Rebrand user-visible product name to 北数Work

## Why
The 北数Work distribution must not show the JuggleWork name. The first-launch sign-in page also showed hard-coded English copy, no logo, and a JuggleWork-specific introduction regardless of the system language.

## What Changes
- Replace the user-visible product name `JuggleWork` with `北数Work` in locale strings, UI copy, window and menu titles, tray labels, page titles, Windows shortcut fallback names, macOS usage descriptions, and helper app display names.
- Use `北数Work` as the default display name when no organization brand name is configured. The server's default `brandAppName: JuggleWork` counts as not configured.
- Localize the full-screen sign-in page through i18n, show the bundled app logo when no organization logo is configured, and replace the introduction panel with 北数Work copy and bundled icons.
- Keep internal identities unchanged: app IDs, protocol scheme, userData paths, packaged `productName`, executable and bundle file names, icons, on-disk Documents folder names, agent and model prompts, server CLI logs, and strings matched by code.

## Impact
- New spec: `desktop-product-branding`
- Affected areas: app locales and UI, Electron main process display names, packaging display strings
