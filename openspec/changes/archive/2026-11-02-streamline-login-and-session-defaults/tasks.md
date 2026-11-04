## 1. Organization defaults

- [x] 1.1 Add per-user last-organization persistence and a shared remembered/personal/server fallback resolver.
- [x] 1.2 Record explicit organization switches and use the shared resolver during authentication and settings refresh.
- [x] 1.3 Remove the ordinary organization chooser/redirect while preserving automatic activation progress and failure handling.
- [x] 1.4 Add tests for same-user restoration, account isolation, personal fallback, and chooser-free onboarding resolution.

## 2. Provider and model defaults

- [x] 2.1 Change organization onboarding to automatically select the first model of the first usable managed provider.
- [x] 2.2 Add a connected-provider resolver that keeps a valid remembered model or falls back to the first model of the first usable provider.
- [x] 2.3 Stop forcing the hard-coded legacy model when no preference has been saved and reconcile global preferences after provider data loads.
- [x] 2.4 Persist reasoning-strength changes globally as well as per session so new sessions inherit the last selection.

## 3. Verification

- [x] 3.1 Add or update focused tests for provider order, fallback model resolution, and model/reasoning inheritance.
- [x] 3.2 Run the relevant Bun test files and OpenSpec validation, fixing any regressions.
