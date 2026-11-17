## 1. Specification and planning
- [x] 1.1 Define v2 layouts, themes, content limits, notes, and v1 compatibility.
- [x] 1.2 Define the default outline-confirmation behavior and direct-generation escape hatch.

## 2. Generator
- [x] 2.1 Implement strict v2 validation and retain v1 validation/generation.
- [x] 2.2 Implement ten visually distinct editable layouts.
- [x] 2.3 Add Chinese/Latin theme fonts, adaptive font sizing, overflow rejection, and notes.
- [x] 2.4 Validate every visible v2 text region, XML Unicode, optional field types, and cross-platform output filenames.
- [x] 2.5 Publish complete packages atomically and preserve the historical v1 acceptance range.

## 3. Agent guidance
- [x] 3.1 Update the bundled skill with story-planning and layout-selection guidance.
- [x] 3.2 Update the app presentation prompt and the home presentation starter prompt.
- [x] 3.3 Disambiguate requestVersion from generator spec version, require the confirmed page count, and preserve the user's language.

## 4. Verification
- [x] 4.1 Cover all layouts, compatibility, XML relationships, fonts, notes, and limits in tests.
- [x] 4.2 Run app/server/desktop focused tests and type checks.
- [x] 4.3 Generate a Chinese deck through the packaged Electron runtime and inspect it in the desktop Office editor.
- [x] 4.4 Validate OPC relationship closure, deterministic bytes, explicit line breaks, notes geometry, and failed-generation cleanup.
- [x] 4.5 Open all ten layouts in the native Office engine, edit text, save, close, reopen, and verify persistence.
- [x] 4.6 Add a blocking after-pack and final macOS package smoke test that runs the package-owned generator with the package-owned Electron executable and an empty PATH.
- [x] 4.7 Build a real staging `.app`, confirm the generator and skill are under `Contents/Resources`, generate a ten-layout PPTX using only that `.app`, and open it in the Office engine.
