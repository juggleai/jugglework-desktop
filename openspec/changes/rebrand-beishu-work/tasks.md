## 1. Implementation
- [x] 1.1 Replace user-visible `JuggleWork` with `北数Work` in locales, UI copy, and Electron display strings.
- [x] 1.2 Split the Electron process name from the default display name so packaging and installer shortcuts are unchanged.
- [x] 1.3 Localize the sign-in page, add a default logo, and replace the introduction panel with bundled icons.
- [x] 1.4 Keep internal identities, on-disk folder names, model prompts, and code-matched strings unchanged.

## 2. Verification
- [x] 2.1 Update tests that assert visible copy.
- [x] 2.2 Run app and server type checking and the app, server, and desktop test suites; failures match the pre-change baseline.
- [x] 2.3 Render the sign-in page in Chinese and English and inspect the result.
