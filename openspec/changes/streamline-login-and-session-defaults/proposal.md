## Why

The first signed-in experience currently interrupts members with organization and model-provider choices even when deterministic defaults are available. New sessions also remember the last model but not the last reasoning strength, and a fresh install may point at a hard-coded model that is not present in the workspace.

## What Changes

- Automatically activate the last organization selected by the signed-in user; when that user has no saved organization, activate their personal organization.
- Keep the remembered organization scoped to the user so different accounts on one desktop cannot inherit each other's organization.
- Skip the organization chooser during ordinary sign-in while retaining explicit organization switching after login.
- Automatically choose the first organization-managed model provider with an available model and use its first model instead of asking the member to choose a provider.
- Persist the model and reasoning strength selected by a member as the defaults for subsequently created workspace sessions.
- When no valid previous model exists, initialize new sessions from the first available model of the first available provider and sanitize the remembered reasoning strength for that model.

## Capabilities

### New Capabilities
- `signed-in-default-selection`: Covers automatic organization and managed-provider selection during sign-in and onboarding.
- `new-session-model-defaults`: Covers persisted model/reasoning choices and deterministic defaults for new workspace sessions.

### Modified Capabilities

None.

## Impact

- Den settings and authentication bootstrap persistence in `apps/app/src/app/lib/den.ts` and cloud auth/onboarding components.
- Organization onboarding default-model selection and its tests/evals.
- Local model preferences, connected-provider resolution, and session model/variant selection in the React session shell.
- Focused unit tests for account-scoped organization restoration, provider fallback, and model/reasoning inheritance.
