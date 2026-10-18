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

## Deferred release evidence

- Final macOS `.app`/ZIP/DMG signing, notarization, staple, and Gatekeeper evidence requires the release identity and CI secrets.
- Actual Windows arm64/x64 Electron staging and Authenticode evidence must run on the release CI matrix.
- Actual Linux x64/arm64 AppImage/tar resource verification remains a release-CI requirement; the shared bundle verifier already validates ELF format, architecture, inventory, and executable mode.
- These target-specific release gates remain task 6.3 and must not be marked complete from local macOS arm64 evidence alone.
