## Purpose

Define a reproducible and auditable release process that publishes immutable desktop artifacts to Qiniu, promotes channel manifests only after verification, and coordinates bridge and Den version metadata safely.

## ADDED Requirements

### Requirement: Versioned desktop release objects are immutable
Every published desktop version SHALL have an immutable version directory under `jugglework/releases/v<version>/`, and the release process MUST refuse to overwrite an existing versioned object.

#### Scenario: New version publication
- **WHEN** no object exists at the requested version/platform/architecture keys
- **THEN** the process may upload the verified release objects without overwrite

#### Scenario: Versioned key already exists
- **WHEN** any target versioned key already exists
- **THEN** publication stops before modifying that object or promoting a channel manifest

### Requirement: A macOS release contains a complete updater artifact set
A macOS release SHALL publish an updater ZIP, manual-install DMG, generated blockmaps, and `latest-mac.yml`, with the manifest naming every supported architecture and selecting ZIP as the primary path.

#### Scenario: arm64 release artifacts are generated
- **WHEN** an arm64 macOS release is prepared
- **THEN** the version directory contains the arm64 ZIP, ZIP blockmap, DMG, DMG blockmap, and macOS manifest
- **AND** manifest sizes and SHA-512 values match the local artifacts

#### Scenario: Manifest references release files
- **WHEN** the version manifest is finalized
- **THEN** every URL is an absolute HTTPS URL under `downloads.jugglechat.cn`
- **AND** every URL targets the immutable version directory rather than a mutable channel directory

### Requirement: Publication is ordered and serialized
The release process MUST serialize promotion and SHALL publish binary resources before manifests so clients never observe a manifest that references incomplete objects.

#### Scenario: Successful stable publication
- **WHEN** a stable release is published
- **THEN** ZIP/DMG/blockmap objects are uploaded and remotely verified first
- **AND** the immutable version manifest is uploaded only after those objects pass verification
- **AND** the stable manifest is replaced only after version-feed canary verification succeeds

#### Scenario: Concurrent publisher attempts promotion
- **WHEN** another publisher holds the release/promotion lock
- **THEN** the second publisher fails before changing an immutable object or channel manifest

#### Scenario: Failure occurs before channel promotion
- **WHEN** any build, upload, remote verification, or canary step fails
- **THEN** the existing stable/alpha channel manifest remains unchanged

### Requirement: Local and remote release evidence match
The release process SHALL verify local artifacts, Qiniu object metadata, and public CDN downloads before channel promotion and SHALL produce a non-secret audit record.

#### Scenario: Remote objects match local artifacts
- **WHEN** uploaded objects are inspected
- **THEN** Qiniu size and ETag match local values
- **AND** a CDN download matches the manifest SHA-512 and expected size

#### Scenario: CDN behavior is compatible with updater downloads
- **WHEN** the release is verified through `downloads.jugglechat.cn`
- **THEN** HTTPS, MIME type, Content-Length, full GET, and byte-range behavior meet the updater requirements

#### Scenario: Audit evidence is recorded
- **WHEN** publication or promotion completes
- **THEN** the evidence records version, commit, platform, architecture, artifact keys, sizes, SHA-256, SHA-512, Qiniu ETags, signer identity, notarization result, timestamps, and promoted channel
- **AND** it contains no access key, secret key, token, cookie, or signing credential

### Requirement: Stable macOS releases pass signing and notarization gates
Stable macOS channel promotion SHALL require the expected bundle identity, Developer ID Team identity, hardened runtime, successful Apple notarization, stapling, and Gatekeeper acceptance.

Stable `1.2.15` MAY use an explicitly audited one-time exception for notarization, stapling, and Gatekeeper status. The exception SHALL be rejected for any other version and SHALL NOT bypass Developer ID identity, Team identity, hardened runtime, artifact integrity, remote verification, or real-client canary requirements.

Stable `1.2.16` MAY use a separately audited one-time exception for notarization, stapling, and Gatekeeper status, together with a separately audited pre-canary promotion exception so an operator can expose `1.2.16` to the installed `1.2.15` UI and perform the real-client update canary after promotion. Both exceptions SHALL be restricted to stable `1.2.16`; they SHALL NOT bypass Developer ID identity, Team identity, hardened runtime, artifact integrity, immutable publication, Qiniu/CDN verification, promotion locking, cache refresh, or public channel read-back. A present failed or mismatched canary SHALL NOT be ignored, and the successful post-promotion canary SHALL be recorded before the rollout is considered complete.

#### Scenario: Stable candidate is fully trusted
- **WHEN** codesign deep verification, notarization, stapling, and Gatekeeper assessment pass for the candidate
- **THEN** the candidate may proceed to version-feed canary and stable promotion

#### Scenario: Notarization credentials or result are unavailable
- **WHEN** notarization cannot be performed or Gatekeeper rejects the candidate
- **THEN** the release may remain a local or unpublished candidate
- **AND** it MUST NOT replace the stable channel manifest

#### Scenario: Explicit 1.2.15 migration exception
- **WHEN** an operator supplies the audited notarization-exception reason for stable `1.2.15`
- **THEN** promotion may proceed without notarization, stapling, and Gatekeeper acceptance only after all remaining gates pass
- **AND** the same exception fails closed for every other version or channel

#### Scenario: Explicit 1.2.16 live-upgrade exceptions
- **WHEN** an operator separately authorizes unnotarized stable `1.2.16` publication and promotion before its real `1.2.15` client canary
- **THEN** promotion may proceed only after Developer ID, Team, hardened-runtime, immutable-object, and public-CDN evidence pass
- **AND** both audited exception reasons are recorded with scope `stable-1.2.16-only`
- **AND** the exceptions fail closed for Alpha, every other version, missing or short reasons, invalid signing identity, mismatched artifacts, or an existing failed canary
- **AND** a real installed `1.2.15` client SHALL subsequently discover, download, install, and restart into `1.2.16`, and that result SHALL be recorded before rollout completion

### Requirement: Channel manifests have controlled cache behavior
Mutable stable/alpha manifests SHALL use short-lived or revalidation-required caching, while immutable version objects SHALL use long-lived immutable caching.

#### Scenario: Version object caching
- **WHEN** a versioned artifact or version manifest is served
- **THEN** it may be cached long-term as immutable content

#### Scenario: Channel promotion
- **WHEN** stable or alpha manifest content changes
- **THEN** the object is updated only after all gates pass
- **AND** the CDN cache is refreshed or purged and the public response is read back until the new content is observed

### Requirement: Den version metadata is announced after publication
Den SHALL NOT advertise a desktop version as published/latest before its Qiniu version feed is complete and a real client canary has installed it.

#### Scenario: Candidate is not yet promoted
- **WHEN** Qiniu artifacts exist but version-feed canary or stable promotion has not completed
- **THEN** Den published/latest metadata remains unchanged

The explicitly audited stable `1.2.16` live-upgrade exception MAY reverse the canary and announcement order only so an installed `1.2.15` client can exercise the normal Den-selected UI path. This exception is not reusable for another version.

#### Scenario: Stable promotion succeeds
- **WHEN** the stable manifest is publicly verified and canary installation succeeds
- **THEN** the existing Den administration path may add the version to published inventory and advance latest version
- **AND** organization allowlists are changed only by an explicitly authorized policy action

### Requirement: Desktop updater publication is Qiniu-only
The first Qiniu-enabled release and every subsequent desktop updater release SHALL publish updater artifacts and manifests only through Qiniu.

#### Scenario: Stable 1.2.15 release
- **WHEN** `1.2.15` passes Qiniu version-feed canary validation and stable promotion gates
- **THEN** its updater artifacts and manifests are available from Qiniu
- **AND** no GitHub desktop updater assets or manifest are published

#### Scenario: Future stable or Alpha release
- **WHEN** a later stable or Alpha desktop release is published
- **THEN** its update discovery and payload delivery use Qiniu only

### Requirement: Release tooling is safe to operate repeatedly
The publication workflow SHALL support dry-run, resume, and verification-only modes without making secrets or partial promotion implicit.

#### Scenario: Dry run
- **WHEN** an operator requests dry-run
- **THEN** the workflow validates inputs and prints planned keys/actions without uploading, promoting, or updating Den

#### Scenario: Resume after partial immutable upload
- **WHEN** a prior attempt uploaded some matching immutable objects but did not promote a channel
- **THEN** verification-only/resume can confirm exact matches and continue safely
- **AND** any mismatch fails instead of overwriting the object
