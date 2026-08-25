## Why

JuggleWork Cloud now publishes a deployment-managed organization provider with canonical `source: "juggle_router"`. Current desktop builds reject that source during response parsing, so signed-in Windows and macOS members cannot discover, import, or use the organization's JuggleRouter models even though the server and gateway are ready.

## What Changes

- Accept the canonical `juggle_router` provider source in organization provider list and connection responses.
- Preserve backward-compatible managed-provider metadata while continuing to exclude the distinct legacy `jugglework` hosted-inference provider.
- Import JuggleRouter under its opaque organization-qualified `lpr_*` row ID, using the server-projected gateway URL and token rather than upstream credentials.
- Resolve catalog metadata case-insensitively so `providerId: "JuggleRouter"` can use the embedded `jugglerouter` catalog entry without changing its canonical server identity.
- Reconcile disablement as provider absence/removal and automatically re-import it after the organization enables it again.
- Retire the always-disabled legacy hosted JuggleWork Models promotion surfaces, hosted inference type module, preview aliases, and promotional content while retaining parser, import-filter, reserved-ID, model-picker hiding, and cloud-managed cleanup guards for stale installations.

## Capabilities

### New Capabilities
- `managed-jugglerouter-desktop`: Defines native discovery, parsing, gateway import, model exposure, and lifecycle reconciliation for organization-managed JuggleRouter providers.

### Modified Capabilities

None.

## Impact

- Den organization-provider response types and parsers.
- Cloud provider filtering, import metadata, runtime provider configuration, catalog lookup, and synchronization.
- Desktop parser/import/reconciliation tests using realistic managed list and connection payloads.
- Removal of hosted-model status-bar/startup promotion code and its promo-only localization, evals, and documentation.
- Retirement of active hosted inference eval contracts and stale promo-dialog handling in broader flows; generic Voice session coverage and managed broker server tests remain.
- No server compatibility alias, upstream API key delivery, or special JuggleRouter execution protocol is introduced.
- Voice Mode's independent JuggleWork Models broker and `JUGGLEWORK_*` runtime environment contract are unchanged.
