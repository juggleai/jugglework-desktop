## 1. Specification

- [x] 1.1 Define immediate preparation feedback, draft preservation, readiness reuse, and background revalidation behavior.

## 2. Readiness fast path

- [x] 2.1 Route ordinary drafts through the existing non-Connect fast path while retaining strict readiness for explicitly selected Cloud capabilities.
- [x] 2.2 Add a bounded, provider/model-scoped positive readiness cache with fresh and background-refresh thresholds.
- [x] 2.3 Integrate cache hit, invalidation, background revalidation, and existing blocking repair into the submission coordinator.
- [x] 2.4 Add inspector evidence for cache hits, misses, revalidation, and phase transitions.

## 3. Composer feedback

- [x] 3.1 Enter a session-scoped preparation state synchronously on submit and clear it safely on every outcome.
- [x] 3.2 Present localized preparation/check/repair/submission labels and prevent duplicate submission while pending.
- [x] 3.3 Preserve drafts and attachments on blocked, cancelled, and failed submission.

## 4. Verification

- [x] 4.1 Add focused cache tests for freshness, scope isolation, expiry, invalidation, and bounded size.
- [x] 4.2 Add focused integration assertions for immediate preparation presentation and draft-safe lifecycle.
- [x] 4.3 Run focused tests, type checking, production build, i18n coverage, and OpenSpec validation.

Validation note: focused tests, type checking, production build, and strict OpenSpec validation pass. Strict i18n coverage still reports the repository's pre-existing partial-locale baseline (roughly 1,700–1,800 missing legacy keys per partial locale); all four keys introduced by this change are present in every existing locale. The full app suite reaches 1,285 passing tests and retains four pre-existing failures/two errors in sign-in fallback copy and automation-header source-contract expectations, outside this change.
