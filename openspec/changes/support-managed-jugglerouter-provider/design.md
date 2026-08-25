## Context

The desktop parses organization provider list and connection payloads into a strict source union, then filters the old `jugglework` hosted provider before importing ordinary organization providers into runtime configuration. Cloud imports already use opaque `lpr_*` keys, store server-issued gateway credentials, copy canonical model metadata, and reconcile removal from full current-state responses. See `proposal.md` for motivation and `specs/managed-jugglerouter-desktop/spec.md` for the behavioral contract.

## Goals / Non-Goals

**Goals:**
- Add canonical `juggle_router` support without changing existing provider import architecture.
- Preserve managed metadata for current/future UI use while remaining compatible with older server payloads.
- Prevent JuggleRouter from inheriting legacy hosted-inference filtering or fixed provider identity.
- Exercise realistic list, connect, model metadata, import, disable, and re-enable contracts in tests.

**Non-Goals:**
- Add direct communication with the JuggleRouter upstream.
- Add desktop controls for organization-level enable/disable or managed configuration.
- Change server response identity to `models_dev` or `jugglework`.
- Implement incremental resource-version/tombstone replay; full-state reconciliation remains authoritative.

## Decisions

### Accept and preserve the canonical source

Extend the Den source union and parser with `juggle_router`. Preserve optional `managed`, `managedKind`, `accessScope`, and `enabled` fields when valid, but do not require them so older ordinary-provider payloads remain compatible.

Alternative considered: alias JuggleRouter to `jugglework`. Rejected because the provider store intentionally excludes that hosted source and older client generations attach special semantics to its fixed identity.

### Keep hosted filtering narrow and explicit

Extract a pure importable-provider filter that continues excluding source/provider ID `jugglework`, excludes explicit `enabled: false`, and retains `juggle_router`. The server normally omits disabled providers from member lists; the explicit check makes administrator or future richer payloads fail safe.

Alternative considered: filter every managed source. Rejected because management controls mutation rights, not whether an enabled organization provider can be imported.

### Reuse opaque Cloud import identity and gateway projection

No JuggleRouter-specific execution adapter is added. Runtime provider, auth storage, import baseline, and model references remain keyed by the server row's `lpr_*` ID. The inner provider identity remains `JuggleRouter`; its projected OpenAI-compatible package, gateway Base URL, per-provider environment declaration, models, and `jwgw_*` token use the existing import flow.

### Resolve deployment catalog identity case-insensitively

Try the exact provider identity first, then a normalized case-insensitive key match. This lets `JuggleRouter` use catalog key `jugglerouter` while preserving exact behavior for existing providers. Server-published model fields continue to override catalog fallback.

Increment Cloud provider metadata version to 6 so existing imports are reconciled once with corrected catalog metadata and the fail-closed gateway-mirror lifecycle contract.

### Retain full-state lifecycle reconciliation

Disablement is represented by absence from an importable current-state provider list; existing synchronization already deletes missing imported providers and credentials. Re-enable republishes the same cloud row with a newer timestamp, causing reconnect and re-import. Explicit server tombstones and resource versions remain optional future enhancements rather than requirements for this compatibility change.

## Risks / Trade-offs

- [Case-insensitive catalog keys could be ambiguous] → Prefer exact match first; catalog keys are expected unique under case normalization and tests pin the JuggleRouter case.
- [An explicit disabled row may reach desktop in a richer response] → Filter `enabled: false` before import, matching member-list omission semantics.
- [Older installed clients still reject the source] → This change requires a new desktop build; keep server identity canonical and avoid accumulating a permanent compatibility alias.
- [Full-state synchronization ignores explicit version ordering] → Continue requiring full current-state list semantics; add disable/re-enable regression coverage.

## Migration Plan

1. Release the desktop parser/import support while the server keeps canonical `source: "juggle_router"`.
2. On sign-in or provider sync, enabled managed providers are discovered and imported automatically; no local user migration is required.
3. Existing Cloud imports increment to metadata version 5 and reconcile once.
4. Rollback to an older desktop hides JuggleRouter again but does not expose upstream credentials or mutate the server provider. Reinstalling the supporting build restores synchronization.
