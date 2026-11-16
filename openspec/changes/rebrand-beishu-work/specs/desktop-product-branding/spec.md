## ADDED Requirements

### Requirement: User-visible product name
The desktop application SHALL display the product name `北数Work` on every user-visible surface and SHALL keep internal identities that existing installs, packaging, or code matching depend on.

#### Scenario: No organization brand name is configured
- **WHEN** the desktop bootstrap config has no `brandAppName`
- **THEN** windows, the application menu, the tray, the sign-in page, and the document title display `北数Work`

#### Scenario: An organization brand name is configured
- **WHEN** the desktop bootstrap config provides `brandAppName`
- **THEN** the configured name replaces `北数Work` on those surfaces

#### Scenario: Server sends the upstream default brand name
- **WHEN** the desktop policy or the desktop bootstrap config sets `brandAppName` to `JuggleWork` (any case), which is the server's default rather than an organization brand
- **THEN** the name is treated as unset and windows, the application menu, the sign-in page, and the document title display `北数Work`

#### Scenario: Internal identities stay stable
- **WHEN** the application starts, updates, or registers OS integrations
- **THEN** the app ID, protocol scheme, userData path, packaged product name, bundle and executable file names, and on-disk Documents folders are unchanged from JuggleWork

### Requirement: Localized first-launch sign-in page
The full-screen sign-in page SHALL render its title, call to action, and introduction panel through i18n in the active locale and SHALL show a product logo.

#### Scenario: Chinese system language
- **WHEN** a user first launches the app with a Chinese system language
- **THEN** the sign-in page shows Chinese copy and the 北数Work introduction

#### Scenario: No organization logo is configured
- **WHEN** the desktop bootstrap config has no `brandLogoUrl`
- **THEN** the sign-in page shows the bundled application logo without loading remote assets
