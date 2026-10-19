# Support the JWorkRouter managed identity

## Why

The Cloud-managed routing provider is being renamed to JWorkRouter so JuggleRouter can remain an independent third-party provider. Desktop must preserve existing workspace imports and model selections across the rename while continuing to interoperate with older Server releases.

## What Changes

- Parse the optional canonical `managedIdentity=jwork_router` field while retaining the legacy `juggle_router` discriminator.
- Classify managed routing by canonical identity with a legacy fallback, never by provider display name.
- Keep the Cloud row ID as the local provider key so existing `lpr_*/model` references remain stable.
- Allow ordinary JuggleRouter and managed JWorkRouter to coexist in one workspace.

## Impact

Cloud response parsing, shared provider types, CLI managed-points decisions, runtime synchronization, tests, and compatibility documentation.
