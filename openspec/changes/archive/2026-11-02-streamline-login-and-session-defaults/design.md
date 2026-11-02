## Context

Den currently stores one disposable active-organization tuple alongside the auth token. Sign-out and ordinary handoff login clear that tuple, so the desktop cannot reliably restore a user's last explicit organization. Multiple organization-resolution paths also use different fallbacks and the onboarding route renders a chooser even after bootstrap has resolved a valid organization.

Model selection has a similar split: session model changes update the global default model, but session reasoning changes do not update the global variant. A clean profile also migrates to the hard-coded `opencode/big-pickle` model before the connected provider catalog is known. Organization onboarding only auto-selects when exactly one provider exposes exactly one model.

## Goals / Non-Goals

**Goals:**

- Restore the last explicitly selected organization for the confirmed user, with personal organization as the first-login fallback.
- Remove ordinary post-login organization/provider choice screens when deterministic defaults exist.
- Make the last user-selected model and reasoning strength authoritative for new sessions.
- Repair missing or stale model defaults from the current connected-provider catalog.
- Keep fallback ordering deterministic and testable.

**Non-Goals:**

- Remove organization switching from the account menu or settings.
- Automatically start OAuth/API-key authentication for arbitrary third-party providers.
- Change provider ordering returned by Den or OpenCode.
- Synchronize desktop preferences between devices.

## Decisions

### Store the last organization in a per-user map

Persist a local map from confirmed Den user ID to organization ID. Explicit organization switches update the map, while sign-out leaves it intact. Organization resolution reads this map only after the session identity has been confirmed, preventing one user from inheriting another user's organization. Existing active-org fields remain the current-session projection and may still be cleared on sign-out.

Alternative considered: retain the existing active-org tuple across sign-out. This is smaller but unsafe on shared desktops because the incoming identity is not known at handoff exchange time.

### Use one pure organization resolver

Resolve organizations in this order: remembered organization for the confirmed user, personal organization (`kind === "personal"`, then legacy `slug === "personal"`), server-active organization, and finally the first returned organization as a defensive fallback. The auth bootstrap and settings refresh paths use this shared rule. Ordinary onboarding always activates the resolved organization without rendering a chooser; failures remain visible with retry rather than silently selecting another organization.

### Preserve server catalog order for automatic provider/model defaults

Organization-managed providers retain Den response order. Automatic default selection uses the first provider in that order that has a valid first model. Connected OpenCode providers retain `provider.list()` order and use the first valid model key in insertion order. Providers without models are skipped.

This avoids adding a new client-specific ranking that would disagree with server/admin ordering.

### Treat local preferences as the last-selection record

`jugglework.preferences.defaultModel` and `modelVariant` remain the authoritative last model/reasoning pair. Selecting a reasoning strength in an active session updates both the session override and the global `modelVariant`, matching existing model-selection behavior. Changing to another model clears an incompatible remembered variant as it does today.

### Resolve stale or absent defaults after provider data loads

A pure resolver checks whether the remembered model exists in the connected catalog. If it does, it remains selected. Otherwise it returns the first model of the first connected provider with models. The session shell writes that repaired model into global preferences before a new/untouched session needs to prompt. If no provider has a model, the selection remains null and the existing connect-provider empty state is preserved.

Reasoning values continue through the existing model-behavior sanitizer before display/submission; unsupported values therefore become the selected model's effective default.

### Migrate away from a forced hard-coded default

Legacy `jugglework.defaultModel` is read only when present. A clean profile no longer turns an absent legacy value into `opencode/big-pickle`; it starts with `defaultModel: null` until the provider catalog provides a valid fallback. Existing saved values continue to migrate.

## Risks / Trade-offs

- [Provider order changes server-side] → The default may change for members without a remembered model; this is intentional because server order is the source of truth.
- [Remembered organization was removed] → The resolver falls back to personal, then server active/first organization, and overwrites the stale map entry.
- [Reasoning variant is not supported by a later model] → Existing model behavior normalization/sanitization prevents sending an invalid variant.
- [Organization activation fails during onboarding] → Keep the progress/error state and expose retry; do not reintroduce a choice screen.
- [Existing hard-coded default is stale] → Catalog reconciliation replaces it only when it is not available.

## Migration Plan

1. Introduce the user-scoped organization map and resolver while retaining current active-org keys.
2. Record explicit switches and resolved fallbacks in the map.
3. Remove chooser redirects and make onboarding auto-activation unconditional when an organization can be resolved.
4. Relax the legacy model reader and reconcile global defaults from provider data.
5. Persist reasoning selections globally as well as per session.

Rollback can ignore the new organization map and restore the previous chooser/default behavior; existing current-session settings and session model records remain compatible.

## Open Questions

None.
