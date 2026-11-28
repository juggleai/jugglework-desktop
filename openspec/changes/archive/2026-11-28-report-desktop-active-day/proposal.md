## Why

Desktop interactions that never issue a business mutation are not reflected in the server's daily active user count. The Desktop can report a minimal daily signal after real foreground interaction without collecting what the user did.

## What Changes

- Report foreground interaction for a validated signed-in account, never from startup or background work alone.
- Deduplicate by deployment, account and UTC day; keep failures independent of the sign-in session.

## Capabilities

### New Capabilities

- `desktop-active-day-reporting`: Report one confirmed daily activity signal to the account's business server.

### Modified Capabilities

## Impact

- Desktop cloud auth provider, local receipt storage and the existing business `POST /jwork/api/v1/activity/active-day` endpoint. No server changes are required for this client integration.
