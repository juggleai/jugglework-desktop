## ADDED Requirements

### Requirement: Account-scoped organization restoration
The desktop SHALL remember the last organization explicitly selected by each signed-in user and SHALL restore that organization when the same user signs in again, provided the user still belongs to it.

#### Scenario: Returning user has a remembered organization
- **WHEN** a confirmed user signs in and their remembered organization is present in the returned organization list
- **THEN** the desktop activates that organization without asking the user to select an organization

#### Scenario: Different user signs in on the same desktop
- **WHEN** a confirmed user signs in after a different user used the desktop
- **THEN** the desktop does not apply the previous user's remembered organization

### Requirement: Personal organization first-login default
The desktop SHALL activate the user's personal organization when no valid remembered organization exists. If no personal organization is present, the desktop SHALL use the server-active organization and then the first returned organization as defensive fallbacks.

#### Scenario: First login with multiple organizations
- **WHEN** a user with no remembered selection signs in and the organization list contains a personal organization and one or more team organizations
- **THEN** the desktop activates the personal organization without rendering an organization chooser

#### Scenario: Remembered organization no longer exists
- **WHEN** the user's remembered organization is absent and a personal organization exists
- **THEN** the desktop activates and remembers the personal organization

### Requirement: Automatic managed-provider default
During organization onboarding, the desktop SHALL select the first model of the first organization-managed provider that contains a valid model, preserving the order supplied by Den, without asking the user to select a provider.

#### Scenario: Multiple managed providers are available
- **WHEN** Den returns multiple managed providers with models
- **THEN** the desktop selects the first model of the first returned usable provider and continues onboarding automatically

#### Scenario: First managed provider has no models
- **WHEN** the first returned provider has no valid models and a later provider does
- **THEN** the desktop skips the empty provider and selects the first model of the next usable provider
