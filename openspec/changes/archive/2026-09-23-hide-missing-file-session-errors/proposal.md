## Why

Missing prompt files currently produce a large red session error card, including filesystem suggestions. Users want these missing-file diagnostics hidden even when the file genuinely does not exist.

## What Changes

- Suppress explicitly identified missing-file session error cards for both live errors and stored error messages.
- Preserve underlying errors, task status, and all unrelated error presentation.
- Add focused classification and rendered-output regression coverage.

## Capabilities

### New Capabilities

- `session-error-presentation`: Selective presentation of session errors without altering diagnostic records.

### Modified Capabilities

None.

## Impact

Shared chat error-card renderer and focused tests. No engine, attachment ingestion, task execution, tool-output, installer, or release changes.
