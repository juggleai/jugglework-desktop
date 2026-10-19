## Replacement and migration boundary

- The `toon-factory-v2` branch is based on the mainline that does not contain the sibling branch's native `apps/app/src/react-app/domains/toon-factory/` or `apps/server/src/toon-factory/` implementation. The only product route now mounts `shell/toonFactoryPage.tsx`, which opens the managed sidecar.
- The legacy global `/toon-factory` route is rejected. The replacement route is `/workspace/:workspaceId/toon-factory`.
- No native Toon Factory database or project data is deleted by this change. If native project bytes exist in installations built from an experimental sibling branch, they are not automatically migrated or overwritten. Import/conversion remains a separately authorized migration decision.
- Rollback is application-version rollback: stop the sidecar, install the previous desktop artifact, and retain external Toonflow project directories and per-workspace sidecar data. The product never runs native and sidecar factories concurrently.

## Verification evidence

- App focused suites: 62 passed; App TypeScript check passed.
- JuggleWork Server focused suites: 57 passed; Server TypeScript check passed.
- Electron runtime/build/Linux/Windows verifier suites passed; Electron TypeScript and 89-method bridge checks passed.
- Toonflow managed Server suite: 53 passed; Server TypeScript check passed.
- Toonflow managed Web build, initial-route tests, and Vue TypeScript check passed.
- On 2026-10-18, `pnpm build:toon-factory` passed from the frozen Bun lockfile and emitted a schema-v3 inventory for 1,029 files (`inventorySha256=33419c6eab9b5cb9345695cd610f63673ba8f546ec6952d12dd625c2b8b3b91a`).
- On 2026-10-18, the real Electron smoke passed with the bundled Bun runtime and a real sandboxed `WebContentsView`: directory grants, FFmpeg denial, managed home, secret-free catalog, workspace isolation, and clean child shutdown.
- On 2026-10-18, the refreshed schema-v3 Toon Factory bundle contained 1,030 files (`inventorySha256=6fc2e563584348b5eccb1be55d567907fb10f2a876725bb09be959e58147dce1`). The real Electron smoke additionally covered project creation, persistent grants, A/B canvas switching and stable ordering, home/return lifecycle, docked Agent layout, responsive canvas controls, project rename, and list-only removal while preserving project files.
- On 2026-10-18, `pnpm --dir apps/desktop package:electron:dir` produced the macOS arm64 unpacked app. Local verifier components passed for bundle metadata and updater configuration, all Mach-O architectures, the schema-v3 Toon Factory inventory, trusted Bun 1.3.14 provenance/hash/signature, tray resources, packaged `better-sqlite3` and `node-pty` smoke tests, and the packaged UI-control MCP handshake.
- macOS/Windows/Linux verifier unit suites passed. The complete macOS release verifier correctly stopped at the outer-app code-signature gate because this machine has no valid `Developer ID Application` identity; the verifier was not weakened or bypassed.
- `openspec validate replace-toon-factory-with-sidecar --type change --strict --no-interactive` passed.
- `git diff --check` passed.

## 2026-10-19 smoke harness correction

- Diagnostic session `ses_eac12d727ffe59MXImLF1xR4GV` reproduced failure of the original smoke at release source `27761509b503096ed91d2efaf2f9841d5d25d345`: `managed home render` timed out, but the process incorrectly returned exit 0. The obsolete `.home .creationPanel` selector and home text no longer matched the introduction, six feature cards, and new-project hint. Default `window-all-closed` shutdown interrupted asynchronous cleanup before `app.exit(1)`.
- The diagnostic's temporary in-memory adaptation passed the remaining real Electron/WebContentsView and Bun checks against `jugglework-1.2.30-release/apps/desktop/dist-electron/mac-arm64/JuggleWork.app/Contents/Resources/toonFactoryV2`, including project workflows, directory grants, workspace isolation, and child shutdown. Log: `/var/folders/yx/2rczyx6d17bfk49syjynq_640000gn/T/opencode/jugglework-1.2.30-smoke-adapted.log`. This was development Electron exercising packaged resources, not a passing unmodified release smoke, installed-app/updater test, or primary-main candidate smoke.
- The primary `main` checkout now updates only the smoke assertions and quit interception, plus focused static lifecycle regression assertions in `apps/desktop/scripts/buildToonFactory.test.mjs`. No release worktree, signed package, staged bundle, or published artifact is changed by this test-only correction.
- Correction verification: `node --test apps/desktop/scripts/buildToonFactory.test.mjs apps/desktop/electron/toonFactoryRuntime.test.mjs` passed all 40 tests, with no failures or skips. The regression statically checks quit interception before startup, timeout rejection, failure exit-code assignment, asynchronous cleanup before explicit exit, and hard-timeout exit 1; it is not a mocked or real timed-out Electron run.
- `env -u ELECTRON_RUN_AS_NODE pnpm --dir apps/desktop exec electron scripts/toonFactorySmoke.mjs` printed its final PASS and returned exit 0 against the existing primary staging resources at `apps/desktop/resources/toonFactoryV2`. Post-run process inspection found no matching smoke Electron, Bun sidecar, or profile helper processes. Chromium cache-directory warnings remained non-blocking. The staging bundle was not rebuilt or bound to the current main candidate; this result must not be reported as a main-candidate or signed-release smoke pass. Independent bundle verification passed for darwin/arm64, 1,034 files, inventory SHA-256 `36c64a08f93f87e489d28030bf452cd6687fd670c1bb71004412825c0c1271d3`, build-manifest SHA-256 `59ffdf7ac425bb5eab77660de638aca2e8bf0943142dc86422a47a623c98d0c0`.
- Strict OpenSpec validation passed using `npx --yes --package @fission-ai/openspec openspec validate replace-toon-factory-with-sidecar --type change --strict --no-interactive` (the repository-local CLI was unavailable). `git diff --check` passed. No build, signing, publication, commit, or push was performed.

## Deferred release evidence

- Final macOS `.app`/ZIP/DMG signing, notarization, staple, and Gatekeeper evidence requires the release identity and CI secrets.
- Actual Windows arm64/x64 Electron staging and Authenticode evidence must run on the release CI matrix.
- Actual Linux x64/arm64 AppImage/tar resource verification remains a release-CI requirement; the shared bundle verifier already validates ELF format, architecture, inventory, and executable mode.
- These target-specific release gates remain task 6.3 and must not be marked complete from local macOS arm64 evidence alone.
