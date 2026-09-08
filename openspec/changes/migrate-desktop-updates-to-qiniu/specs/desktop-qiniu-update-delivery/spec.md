## Purpose

Define how JuggleWork desktop discovers, validates, downloads, installs, and recovers from stable, Alpha, and version-targeted updates delivered through the authorized Qiniu CDN rather than GitHub Releases.

## ADDED Requirements

### Requirement: Desktop update feeds use the authorized Qiniu CDN
Packaged desktop clients SHALL resolve update manifests from `https://downloads.jugglechat.cn/jugglework/releases` using the selected channel, current platform, and optional target version, and SHALL NOT silently fall back to GitHub when the Qiniu feed is unavailable.

#### Scenario: Stable channel check
- **WHEN** a packaged macOS client on the stable channel checks for the latest update without a target version
- **THEN** it requests `https://downloads.jugglechat.cn/jugglework/releases/stable/mac/latest-mac.yml`
- **AND** no Cloud access token, cookie, Qiniu credential, or workspace secret is sent with the public CDN request

#### Scenario: Alpha channel check
- **WHEN** a packaged macOS client on the Alpha channel checks for an update
- **THEN** it requests `https://downloads.jugglechat.cn/jugglework/releases/alpha/mac/latest-mac.yml`
- **AND** it applies the existing prerelease comparison rules

#### Scenario: Den selects a specific stable version
- **WHEN** Den selects a stable target version newer than the installed version
- **THEN** the client requests `https://downloads.jugglechat.cn/jugglework/releases/v<version>/mac/latest-mac.yml`
- **AND** it rejects a manifest whose declared version differs from the requested target

#### Scenario: Other desktop platforms resolve their own feed segment
- **WHEN** a packaged Windows or Linux client resolves its update feed
- **THEN** it uses the platform-specific `windows` or `linux` segment rather than the macOS segment
- **AND** a macOS-only migration cannot route another platform to macOS artifacts

### Requirement: macOS automatic updates use a ZIP payload
A macOS update manifest MUST provide a signed ZIP payload compatible with the installed Electron updater, while a DMG MAY be provided for manual installation.

#### Scenario: Matching arm64 update is available
- **WHEN** an arm64 Mac reads a manifest containing architecture-specific files
- **THEN** the updater selects the arm64 ZIP as its automatic installation payload
- **AND** it does not select a DMG, x64 ZIP, or unrelated architecture

#### Scenario: Manifest contains only a DMG
- **WHEN** a macOS manifest does not contain a compatible ZIP
- **THEN** automatic download fails closed before installation
- **AND** the existing application remains runnable

#### Scenario: Same or older version is published
- **WHEN** the manifest version is equal to or older than the installed version
- **THEN** the client does not download or install it as an update

### Requirement: Update integrity and publisher identity are verified
The client SHALL verify the manifest-declared payload integrity and SHALL install only an application signed by the expected JuggleWork publisher identity.

#### Scenario: Payload matches manifest
- **WHEN** the ZIP size and SHA-512 match the selected manifest entry and the contained application has the expected bundle identifier and Apple Team identity
- **THEN** the updater may stage the update for installation

#### Scenario: Payload integrity fails
- **WHEN** the downloaded ZIP differs from the manifest size or SHA-512
- **THEN** the updater rejects the payload and does not invoke the installer

#### Scenario: Publisher identity differs
- **WHEN** the downloaded application is not signed for `com.juggleai.jugglework` by Apple Team `H7PDHSK3C7`
- **THEN** installation fails closed and the currently installed application is retained

### Requirement: Update installation is recoverable
The update flow SHALL preserve the current installation until a verified replacement is ready and SHALL support retry after manifest, network, cache, or installer failure.

#### Scenario: CDN or manifest unavailable
- **WHEN** the selected Qiniu feed is unreachable, missing, malformed, or references a missing object
- **THEN** the check returns no installable update with a diagnosable error
- **AND** it does not switch to an unapproved feed or modify the current installation

#### Scenario: Download is interrupted
- **WHEN** the ZIP download fails or is interrupted
- **THEN** a partial payload is never reported as downloaded
- **AND** a later user retry can perform a fresh check and download

#### Scenario: Verified update installs and restarts
- **WHEN** the update is downloaded and the user chooses install and restart
- **THEN** the application restarts on the new version
- **AND** existing user data, workspace authorization, application identity, and compatible macOS permissions remain associated with the installation

### Requirement: Manual replacement downloads use the Qiniu release inventory
Architecture replacement and manual fallback actions SHALL resolve the appropriate signed DMG from the Qiniu manifest instead of constructing a GitHub release URL.

#### Scenario: Installed architecture differs from the host
- **WHEN** the running application architecture differs from the native macOS architecture and the stable manifest contains a matching DMG
- **THEN** the UI offers that manifest-selected Qiniu DMG as the replacement download

#### Scenario: No matching manual artifact exists
- **WHEN** the manifest contains no compatible DMG
- **THEN** the UI does not offer a fabricated or cross-architecture URL
- **AND** it reports that a compatible download is unavailable

### Requirement: Updates remain monotonic
Stable automatic updates MUST NOT downgrade an installed stable version; recovery from a bad release SHALL use a higher patch version unless an explicitly audited manual recovery procedure is invoked.

#### Scenario: Stable pointer moves backwards
- **WHEN** the stable manifest advertises a version lower than the installed version
- **THEN** the updater ignores it and keeps the installed version

### Requirement: Existing clients receive a bridge update
Clients installed before the Qiniu migration SHALL have a supported path to a Qiniu-enabled bridge version through their existing update feed.

#### Scenario: Stable 1.2.14 client checks GitHub
- **WHEN** an installed stable `1.2.14` client checks its existing GitHub feed after bridge publication
- **THEN** it can discover, verify, download, and install the `1.2.15` bridge release
- **AND** subsequent checks from `1.2.15` use Qiniu

#### Scenario: Bridge client checks the next Qiniu-only release
- **WHEN** the installed bridge version checks for a newer published stable release
- **THEN** discovery, download, and installation complete without a GitHub request
