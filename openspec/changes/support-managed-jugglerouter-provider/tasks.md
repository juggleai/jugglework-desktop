## 1. Canonical Provider Contract

- [x] 1.1 Add `juggle_router` to the organization provider source type and parser
- [x] 1.2 Preserve optional managed kind, organization access scope, enabled state, and managed flag without breaking older payloads
- [x] 1.3 Add realistic list and connection parser tests for managed JuggleRouter and its canonical models

## 2. Cloud Import and Model Configuration

- [x] 2.1 Keep legacy `jugglework` hosted providers filtered while retaining enabled `juggle_router` providers
- [x] 2.2 Import JuggleRouter under the opaque `lpr_*` key with the projected gateway URL, token, environment declaration, and provider identity
- [x] 2.3 Resolve deployment catalog metadata case-insensitively while preserving server-published model fields
- [x] 2.4 Bump import metadata version and test source persistence plus corrected model metadata reconciliation

## 3. Lifecycle Reconciliation

- [x] 3.1 Treat an explicit disabled JuggleRouter row as unavailable for import
- [x] 3.2 Cover removal from current Cloud state and re-enable/re-import behavior through existing full-state helpers

## 4. Verification

- [x] 4.1 Run focused provider parser/import/reconciliation tests
- [ ] 4.2 Run the application test suite and typecheck
- [x] 4.3 Run the smallest meaningful desktop build check, strict OpenSpec validation, and diff checks
