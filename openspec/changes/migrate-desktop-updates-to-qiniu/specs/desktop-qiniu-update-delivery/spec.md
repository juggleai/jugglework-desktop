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

#### Scenario: Windows stable channel check
- **WHEN** a packaged Windows x64 or arm64 client on the stable channel checks without a target version
- **THEN** it requests `https://downloads.jugglechat.cn/jugglework/releases/stable/windows/latest.yml`
- **AND** both architectures use the same channel manifest URL

#### Scenario: Den selects a specific Windows version
- **WHEN** Den selects a stable Windows target version newer than the installed version
- **THEN** the client requests `https://downloads.jugglechat.cn/jugglework/releases/v<version>/windows/latest.yml`
- **AND** it rejects a manifest whose declared version differs from the requested target

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
The client SHALL verify the manifest-declared payload integrity and SHALL install only an application signed by the expected platform-specific JuggleWork publisher identity.

#### Scenario: Payload matches manifest
- **WHEN** the ZIP size and SHA-512 match the selected manifest entry and the contained application has the expected bundle identifier and Apple Team identity
- **THEN** the updater may stage the update for installation

#### Scenario: Payload integrity fails
- **WHEN** the downloaded ZIP differs from the manifest size or SHA-512
- **THEN** the updater rejects the payload and does not invoke the installer

#### Scenario: Publisher identity differs
- **WHEN** the downloaded application is not signed for `com.juggleai.jugglework` by Apple Team `H7PDHSK3C7`
- **THEN** installation fails closed and the currently installed application is retained

#### Scenario: Windows Authenticode identity matches
- **WHEN** a Windows installer matches the manifest size and SHA-512, carries a valid SHA-256 Authenticode signature, has an approved `publisherName`, and has a trusted RFC 3161 timestamp
- **THEN** the updater may stage that native-architecture installer

#### Scenario: Windows signature or timestamp differs
- **WHEN** the Windows installer is unsigned, its publisher is not approved, its signature chain or digest is invalid, or its trusted timestamp is missing or invalid
- **THEN** installation fails closed without invoking the installer
- **AND** the currently installed application is retained

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
- **AND** an authenticated non-personal organization with a missing or stale local IM bootstrap can reprovision it and open Chat and Contacts after restart

### Requirement: Windows clients select only their native architecture
The shared Windows `latest.yml` SHALL describe both x64 and arm64 installers under immutable architecture-specific paths. Its `files` array SHALL be authoritative, and the published manifest MUST NOT contain top-level `path` or `sha512`. Before `NsisUpdater` receives a candidate, the Windows runtime SHALL validate the complete shared inventory, select exactly the entry matching its native packaged architecture, replace the in-memory `files` inventory with that entry, and inject that entry's immutable URL and SHA-512 as the in-memory `path` and `sha512`. Those runtime-only selection fields MUST NOT be written back to or required from the shared manifest.

#### Scenario: Windows x64 checks a dual-architecture manifest
- **WHEN** an x64 package reads a shared manifest containing valid x64 and arm64 entries
- **THEN** it validates both authoritative `files` entries and selects only the x64 signed EXE
- **AND** it injects only the verified x64 entry into the in-memory native-updater selection
- **AND** it does not download or execute the arm64 installer

#### Scenario: Windows arm64 checks a dual-architecture manifest
- **WHEN** an arm64 package reads a shared manifest containing valid x64 and arm64 entries
- **THEN** it validates both authoritative `files` entries and selects only the arm64 signed EXE
- **AND** it injects only the verified arm64 entry into the in-memory native-updater selection
- **AND** it does not download or execute the x64 installer through emulation

#### Scenario: Shared manifest contains top-level selection fields
- **WHEN** the published shared manifest contains top-level `path` or `sha512`
- **THEN** publication or packaged verification rejects it as architecture-biased
- **AND** the client does not rely on those fields to select a Windows installer

#### Scenario: Native entry is missing or ambiguous
- **WHEN** the shared manifest omits the client's architecture, duplicates it, points it outside the requested immutable version, or maps it to another architecture
- **THEN** the update fails closed before installer download or execution
- **AND** the current installation remains runnable

### Requirement: Pending updates do not install on ordinary exit
The desktop updater SHALL keep automatic installation on application quit disabled. A downloaded update MUST NOT install because the user closes all windows, chooses the ordinary Quit action, signs out of the operating system, shuts down, or restarts the machine. Only a current explicit `Install and restart` action may invoke the updater's native installer.

#### Scenario: User exits after downloading an update
- **WHEN** a verified update is pending and the application exits without an accepted `Install and restart` request
- **THEN** the process exits without invoking the native installer
- **AND** the installed version remains unchanged on the next launch

#### Scenario: User explicitly installs and restarts
- **WHEN** the renderer submits the current valid installation identity through `Install and restart`
- **THEN** Main waits for the managed runtime and packaged sidecars to stop before the native installer is launched
- **AND** Main marks explicit update-quit intent immediately before invoking the native installer
- **AND** ordinary close-to-tray handling does not block that installer-owned exit and restart

#### Scenario: Pre-install runtime shutdown fails
- **WHEN** the managed runtime cannot be stopped before the native installer is launched
- **THEN** Main does not invoke the native installer
- **AND** it restores the downloaded candidate so the user can retry the explicit installation request

### Requirement: Installation requests are fenced by update identity
Main SHALL issue an opaque, process-local, single-use `updateId` for an available update and bind it to the selected channel or target version, manifest identity, version, architecture, and payload identity. Download and `Install and restart` requests SHALL carry the matching ID. Main MUST reject a missing, unknown, stale, mismatched, or consumed ID without quitting or invoking the installer.

#### Scenario: Current update identity completes installation
- **WHEN** a download completes for the current `updateId` and the user submits that same ID through `Install and restart`
- **THEN** Main consumes the ID exactly once and may invoke the verified native installer

#### Scenario: A newer check supersedes the UI state
- **WHEN** the channel, target version, manifest, architecture, or selected payload changes after the renderer retained an earlier `updateId`
- **THEN** Main invalidates the earlier ID
- **AND** an install request carrying that stale ID returns a diagnosable rejection without quitting or invoking the installer

#### Scenario: Update state is invalidated
- **WHEN** a new check starts, the channel or target changes, updater verification or download fails, another download supersedes the pending one, installation completes, or the desktop process restarts
- **THEN** any previously issued `updateId` cannot authorize installation

#### Scenario: Install request is replayed
- **WHEN** an already-consumed `updateId` is submitted again
- **THEN** Main rejects the replay and does not invoke the installer a second time

### Requirement: Windows upgrades preserve the deployed installer identity
The Windows package SHALL use electron-builder's standard NSIS installer with the frozen application GUID `6fbd4568-b529-5610-b7ba-24eb7d10b064`. A machine containing only the exact one-off Windows `1.2.18` installation under `%LOCALAPPDATA%\Programs\JuggleWork` SHALL be migrated in place through its legacy uninstaller before the replacement is extracted. The migration MUST NOT accept a different version, path, incomplete installation, or an already-present standard installation as the legacy source.

#### Scenario: Exact legacy 1.2.18 installation is upgraded
- **WHEN** the legacy uninstall and private registry keys both identify version `1.2.18` at `%LOCALAPPDATA%\Programs\JuggleWork` and the expected executable and uninstaller exist
- **THEN** the standard installer creates marked temporary bridge values, removes that installation through its uninstaller, installs the replacement at the same location under the frozen standard GUID, and removes the migration markers after standard registration
- **AND** user data outside the installation directory remains preserved

#### Scenario: Legacy identity is ambiguous or incomplete
- **WHEN** the legacy version, registry paths, uninstall command, executable, or uninstaller does not exactly match the recognized `1.2.18` layout, or the standard GUID already has an installation location
- **THEN** the installer does not treat that path as the legacy migration source
- **AND** it does not recursively remove a registry-supplied arbitrary directory

#### Scenario: Legacy migration is interrupted before standard registration
- **WHEN** an installer attempt leaves its marked temporary bridge values but does not complete replacement installation
- **THEN** the next installer attempt removes only those marked bridge values before evaluating the legacy identity again
- **AND** registry changes made after the interruption cannot bypass the exact legacy validation

#### Scenario: Migration marker remains after standard registration
- **WHEN** standard registration wrote its `DisplayVersion` before an installer interruption left the migration marker behind
- **THEN** the next installer removes only the stale marker
- **AND** it preserves the completed standard installation location and uninstall command

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

### Requirement: Qiniu-enabled clients do not use GitHub update feeds
Clients that include this migration SHALL use Qiniu for all subsequent update discovery and payload downloads. Publishing an automatic migration for clients pinned to the retired GitHub updater feed is outside this change's scope.

#### Scenario: Qiniu-enabled client checks for an update
- **WHEN** an installed Qiniu-enabled client checks stable, Alpha, or a targeted version feed
- **THEN** manifest and payload requests use the authorized Qiniu CDN
- **AND** no GitHub updater request or fallback occurs

#### Scenario: 1.2.15 checks the next Qiniu-only release
- **WHEN** installed version `1.2.15` checks for a newer published stable release
- **THEN** discovery, download, and installation complete without a GitHub request
