# Calendar dependency review

## `@js-temporal/polyfill@0.5.1`

- **Decision:** approved for the Desktop calendar time adapter.
- **License:** ISC. This is confirmed by the package metadata and the upstream `LICENSE` at tag `v0.5.1`; the earlier OpenSpec draft incorrectly called it BSD-3-Clause and has been corrected.
- **Runtime compatibility:** the package declares Node `>=12`. JuggleWork targets Node 24 for development and Electron 44 for Desktop, so the package has no declared engine conflict with either runtime.
- **Transitive runtime dependency:** `jsbi@^4.3.0`.
- **Published unpacked size:** 2,981,675 bytes according to npm metadata. This is not the shipped bundle cost because Vite tree-shakes and minifies the imported modules.
- **Integration boundary:** only the calendar domain imports Temporal. Calendar routes must remain code-splittable so the polyfill is not forced into unrelated entry points.

## Bundle gate

The bundle gate compares a production build before and after adding one isolated Temporal import using the same Vite configuration. The evidence must record raw and gzip sizes of the emitted Temporal-containing chunk and confirm that unrelated entry chunks do not regress unexpectedly.

The dependency is accepted when:

1. `pnpm --filter @jugglework/app build` succeeds;
2. `pnpm --filter @jugglework/desktop build` succeeds, proving the packaged Electron renderer can bundle the dependency;
3. the isolated Temporal chunk and its transitive dependency are recorded from the production output;
4. no license other than ISC is observed for the locked package version.

The calendar implementation must not replace Temporal with native `Date` for domain calculations if a later bundle regression occurs. It must instead preserve the calendar time-adapter interface and reevaluate loading or adapter implementation.

## Verification evidence

Verified on 2026-11-05 against the locked `0.5.1` package:

- The minified published ESM artifact is 128,868 raw bytes and 36,217 gzip bytes. The package is not yet imported by an application route, so the current full application build has no shipped Temporal chunk; the calendar route must introduce it behind the calendar domain boundary.
- A runtime probe using `PlainDate`, `Instant`, and `Asia/Shanghai` passed under the workspace Node runtime.
- `pnpm --filter @jugglework/app typecheck` passed.
- `pnpm --filter @jugglework/app build` passed before and after installation. The existing large-chunk warnings are unchanged in kind and are not caused by a Temporal import because none exists yet.
- `pnpm --filter @jugglework/desktop build` passed with the repository-approved Bun 1.3.14 binary supplied through `BUN_BINARY`. The first attempt using the developer PATH failed the repository's trusted-Bun SHA-256 gate before reaching the renderer build; this was an environment provenance failure rather than a Temporal compatibility failure.
- The installed package manifest and upstream LICENSE both declare ISC, and `pnpm why` resolves exactly one `@js-temporal/polyfill@0.5.1` version for `@jugglework/app`.
