## Context

Login and organization-switch responses share one optional `im` bootstrap. Both Chat and Contacts require its websocket URL, app key, IM user id, and token. A null or invalid bootstrap is authoritative unavailability for the selected organization.

## Decisions

- Gate Chat and Contacts together with one predicate.
- Fail closed during initial auth checks and organization/account switching.
- Persist IM bootstrap with both auth-token fingerprint and organization id; reject legacy or mismatched cache entries.
- Preserve valid current-organization credentials during transient control-plane unavailability.
- Keep the existing eager Chat mount and bootstrap recovery behavior; this change controls discoverability, not runtime architecture.

## Risks

- Legacy unscoped cache is rejected on first upgraded launch. Existing startup repair re-fetches credentials for non-personal organizations.
- Account refresh temporarily hides both entries because `accountBusy` is the existing bounded organization/account loading signal.
