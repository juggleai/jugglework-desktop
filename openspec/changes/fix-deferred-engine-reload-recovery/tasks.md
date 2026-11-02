## 1. Implementation
- [x] 1.1 Classify the active-task reload fence as deferred state.
- [x] 1.2 Keep deferred reloads pending and eligible for automatic retry.
- [x] 1.3 Remove persistent reload errors from task/composer readiness gates.
- [x] 1.4 Preserve the server reload fence and direct-dispose protection.

## 2. Verification
- [x] 2.1 Add and run focused deferred-reload state tests (5 passing assertions groups across the new state test and reload-fence test).
- [x] 2.2 Run the app production build successfully.
- [ ] 2.3 App type checking remains blocked by the pre-existing `cloud-provider-config.test.ts:561` `expect.any` typing error; no new type errors were reported.
- [x] 2.4 Validate formatting with `git diff --check`; OpenSpec CLI validation is unavailable in this checkout (`openspec` command not found).
