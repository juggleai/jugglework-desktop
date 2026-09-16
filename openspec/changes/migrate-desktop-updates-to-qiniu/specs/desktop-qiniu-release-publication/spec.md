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

Stable `1.2.17` MAY use a separately audited one-time exception for notarization, stapling, and Gatekeeper status only. The exception SHALL be restricted to exact stable `1.2.17` and SHALL NOT bypass a successful lower-version canary, Developer ID identity, Team identity, bundle identity, hardened runtime, artifact integrity, immutable publication, Qiniu/CDN verification, promotion locking, cache refresh, or public channel read-back.

Stable `1.2.18` MAY use separately audited one-time exceptions for notarization, stapling, and Gatekeeper status and for the local macOS canary. Both exceptions SHALL be restricted to exact stable `1.2.18` and SHALL NOT apply to Windows or bypass Developer ID identity, Team identity, bundle identity, hardened runtime, package inventory, artifact integrity, immutable publication, Qiniu/CDN verification, promotion locking, cache refresh, or public channel read-back.

Exact stable macOS `1.2.18` MAY retain the promoted channel object's observed `Cache-Control: public, max-age=31536000` under a separately audited operator exception. This exception SHALL NOT apply to another version, channel, platform, or object, and SHALL NOT permit different manifest bytes, a missing CDN refresh, a digest mismatch, or an absent public read-back.

Exact stable macOS `1.2.19` MAY use separately audited one-time exceptions for notarization, stapling, and Gatekeeper status and for the local installation canary. Both exceptions SHALL be restricted to exact stable macOS `1.2.19`, SHALL NOT apply to Windows, and SHALL NOT bypass Developer ID identity, Team identity, bundle identity, hardened runtime, package inventory, artifact integrity, immutable publication, Qiniu/CDN byte verification, controlled channel cache metadata, promotion locking, cache refresh, public channel read-back, or serialized Den exposure.

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

#### Scenario: Explicit 1.2.17 notarization exception
- **WHEN** an operator authorizes unnotarized stable `1.2.17` publication
- **THEN** tooling accepts a signed candidate only with an audited reason scoped to `stable-1.2.17-only`
- **AND** it still requires a passed `1.2.16 → 1.2.17` canary and every non-Apple publication gate
- **AND** it rejects the exception for any other version or channel

#### Scenario: Explicit 1.2.18 macOS exceptions
- **WHEN** an operator authorizes unnotarized stable `1.2.18` publication without a local macOS canary
- **THEN** tooling accepts a signed candidate only with separate audited notarization and pre-canary reasons scoped to `stable-1.2.18-only`
- **AND** it still requires every non-Apple and non-canary publication gate
- **AND** it rejects both exceptions for Windows, every other version, and every other channel

#### Scenario: Explicit 1.2.18 channel-cache exception
- **WHEN** exact stable macOS `1.2.18` has been promoted with the verified immutable manifest bytes and its mutable object inherits a one-year public cache response header
- **THEN** an operator MAY explicitly authorize continuing the rollout without changing that header
- **AND** the system still requires CDN refresh and exact public digest and length read-back
- **AND** the exception is invalid for every other coordinate

#### Scenario: Explicit 1.2.19 macOS release exceptions
- **WHEN** an operator authorizes exact stable macOS `1.2.19` without production notarization or a local installation canary
- **THEN** tooling accepts a signed candidate only with separate audited reasons scoped to `stable-1.2.19-only`
- **AND** it still requires every signing, package, immutable publication, CDN byte, controlled cache metadata, lock, refresh, and public read-back gate
- **AND** it rejects the exceptions for Windows, every other version, and every other channel

### Requirement: Channel manifests have controlled cache behavior
Mutable stable/alpha manifests SHALL use short-lived or revalidation-required caching, while immutable version objects SHALL use long-lived immutable caching.

#### Scenario: Version object caching
- **WHEN** a versioned artifact or version manifest is served
- **THEN** it may be cached long-term as immutable content

#### Scenario: Channel promotion
- **WHEN** stable or alpha manifest content changes
- **THEN** the object is updated only after all gates pass
- **AND** while holding the promotion lock, its cache metadata is conditionally set to `no-cache, no-store, must-revalidate` against the post-upload hash, size, and `putTime`
- **AND** the object bytes and resulting `cacheControl` are verified before refresh
- **AND** the CDN cache is refreshed or purged and the public response is read back until the new content is observed
- **AND** an indeterminate overwrite or failed metadata, read-back, or durable-evidence step retains the lock for audited recovery

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

### Requirement: A Windows release contains both signed architectures
A rollout-eligible Windows version SHALL publish Authenticode-signed x64 and arm64 NSIS EXEs, post-signing blockmaps, and one shared immutable `latest.yml`. The two installer pairs SHALL use architecture-specific immutable paths under `jugglework/releases/v<version>/windows/<arch>/`, while the manifest SHALL use `jugglework/releases/v<version>/windows/latest.yml`.

#### Scenario: Complete Windows release is assembled
- **WHEN** a Windows version is prepared for publication
- **THEN** it contains exactly one signed x64 EXE and its post-signing blockmap
- **AND** it contains exactly one signed arm64 EXE and its post-signing blockmap
- **AND** its shared manifest declares the same version and lists both architectures using absolute HTTPS URLs under the immutable version directory
- **AND** every manifest size and SHA-512 value matches the final signed EXE

#### Scenario: One architecture is absent or invalid
- **WHEN** either architecture is missing, unsigned, signed by a different publisher, or fails local verification
- **THEN** the shared Windows manifest is not published
- **AND** the stable Windows channel is not promoted

### Requirement: Windows blockmaps and manifests describe post-signing bytes
The publication workflow MUST Authenticode-sign each Windows EXE before generating the publishable blockmap and SHALL generate the shared manifest only after both signatures and post-signing blockmaps pass verification. Pre-signing blockmaps, checksums, sizes, and manifests MUST NOT be published.

#### Scenario: Signing changes an installer
- **WHEN** Authenticode signing completes for an x64 or arm64 EXE
- **THEN** the workflow discards any blockmap and metadata derived from the unsigned EXE
- **AND** it rebuilds the architecture's blockmap from the signed EXE
- **AND** it computes the manifest size and SHA-512 from that same signed EXE

#### Scenario: Pre-signing metadata is supplied for upload
- **WHEN** an installer hash, size, blockmap, or manifest was produced before the final signature
- **THEN** publication fails before any immutable upload or channel promotion

### Requirement: Windows signatures have an approved publisher and timestamp
Every rollout-eligible Windows EXE SHALL carry a valid SHA-256 Authenticode signature whose certificate subject matches the release-configured `publisherName` allowlist and the installed application's expected publisher. Its certificate chain SHALL validate under Windows trust policy, and the signature SHALL carry a valid trusted RFC 3161 timestamp made while the signing certificate was valid. The x64 and arm64 EXEs SHALL resolve to the same approved publisher identity.

#### Scenario: Authenticode trust passes
- **WHEN** both signed EXEs are verified before immutable upload
- **THEN** their publisher subjects match the configured allowlist and each other
- **AND** their signature digests, certificate chains, and RFC 3161 timestamps validate
- **AND** evidence records subject, issuer, serial number, SHA-256 thumbprint, certificate validity, digest algorithm, timestamp authority, and timestamp time without recording credentials

#### Scenario: Signature or timestamp trust fails
- **WHEN** either EXE is unsigned, has an unapproved publisher, has an invalid chain or digest, lacks a trusted timestamp, or was timestamped outside the certificate validity period
- **THEN** the version remains an unpromotable candidate
- **AND** no Windows immutable manifest, stable pointer, or Den metadata is changed

### Requirement: Windows uses one shared immutable and channel manifest
The Windows x64 and arm64 inventory SHALL be merged deterministically into one immutable `v<version>/windows/latest.yml`. The manifest `files` array SHALL be the authoritative signed-installer inventory. The shared manifest MUST NOT contain top-level `path` or `sha512`, or architecture-selector fields that bias the shared bytes toward one architecture. Stable promotion SHALL publish those exact verified bytes as `stable/windows/latest.yml`; it MUST NOT independently regenerate, filter, or partially update the channel manifest.

#### Scenario: Shared manifest is finalized
- **WHEN** both final signed installers and blockmaps have passed verification
- **THEN** one deterministic manifest lists exactly one immutable x64 installer URL and one immutable arm64 installer URL
- **AND** each `files` entry carries the matching final signed EXE size and SHA-512
- **AND** the manifest contains no top-level `path` or `sha512`
- **AND** duplicate architecture entries, mutable artifact URLs, cross-version URLs, relative URLs, and inconsistent versions are rejected

#### Scenario: Stable pointer is promoted
- **WHEN** all Windows promotion gates pass
- **THEN** `stable/windows/latest.yml` is replaced with bytes whose digest exactly matches the verified immutable version manifest
- **AND** the mutable manifest receives revalidation-required caching, CDN refresh, and public digest read-back

### Requirement: Promotion locks are independent by platform and channel
Each mutable desktop channel manifest SHALL have its own cooperative non-overwrite promotion lock. In particular, `stable/windows`, `stable/mac`, and `alpha/mac` SHALL use independent lock keys, and one `stable/windows` lock SHALL serialize the complete shared x64/arm64 pointer update through CDN read-back. A participating publisher SHALL verify the lock it uploaded and, immediately before replacing the channel manifest, SHALL optimistically recheck lock ownership and the expected previous channel digest. This protocol MUST NOT be represented as a Qiniu/provider atomic compare-and-swap guarantee.

#### Scenario: Windows and macOS promotions overlap
- **WHEN** a publisher holds the `stable/windows` lock and another publisher promotes `stable/mac`
- **THEN** the independent macOS promotion may proceed
- **AND** no second publisher may modify `stable/windows/latest.yml` until the Windows lock is released or explicitly recovered

#### Scenario: Competing Windows promotion
- **WHEN** another cooperating publisher owns the `stable/windows` lock
- **THEN** the contender fails before changing cache metadata or channel bytes
- **AND** the lock evidence identifies the expected prior digest, candidate digest, owner, and acquisition time

#### Scenario: Lock ownership or channel digest changes
- **WHEN** the lock size/ETag no longer identifies the publisher's lock or the current channel digest differs from the digest observed at acquisition
- **THEN** promotion fails before channel replacement
- **AND** the workflow does not claim that the provider supplied atomic CAS

### Requirement: Windows stable promotion requires native dual-architecture canaries
Stable Windows promotion SHALL require successful targeted-feed canaries on one physical x64 Windows machine and one physical arm64 Windows machine. Both canaries SHALL install from the exact shared immutable manifest proposed for stable; CI checks, virtual machines, emulation, and cross-architecture execution SHALL NOT substitute for either native canary.

#### Scenario: Both physical canaries pass
- **WHEN** supported lower signed versions on physical x64 and arm64 machines check the immutable target feed
- **THEN** each client selects only its native signed EXE, downloads it, explicitly installs and restarts, and reports the intended higher version
- **AND** each result verifies Authenticode publisher identity, manifest digest, user data, workspace authorization, and required application behavior
- **AND** the release may proceed to stable Windows promotion

#### Scenario: A canary is absent or fails
- **WHEN** either architecture lacks a physical-machine result or observes a wrong architecture, wrong publisher, failed install, failed restart, or mismatched manifest digest
- **THEN** `stable/windows/latest.yml` and Den metadata remain unchanged

### Requirement: Windows rollout orders stable promotion before Den announcement
Normal Windows rollout SHALL complete immutable publication, CDN verification, both native canaries, stable promotion, cache refresh, and public stable-manifest digest read-back before Den advertises the version. Den updates SHALL be applied and read back in China first and overseas second. Organization allowlists SHALL remain separate explicitly authorized policy actions.

#### Scenario: Stable promotion and Den announcement succeed
- **WHEN** both canaries pass and the `stable/windows` lock is acquired against the expected previous digest
- **THEN** the workflow promotes and publicly verifies `stable/windows/latest.yml` before changing Den
- **AND** it updates and verifies China Den before overseas Den
- **AND** the evidence records each completed boundary in order

#### Scenario: Den update fails after stable promotion
- **WHEN** the stable manifest is publicly verified but a Den update or read-back fails
- **THEN** the stable pointer is not moved backwards
- **AND** rollout pauses until Den metadata is safely repaired or a higher patch is released

### Requirement: The unsigned Windows 1.2.17 candidate remains immutable history
The existing unsigned Windows ARM64 `1.2.17` EXE, blockmap, and immutable version manifest SHALL remain historical candidate evidence. They MUST NOT be overwritten, re-signed in place, completed under the same version, or promoted to `stable/windows/latest.yml`. The first formal signed dual-architecture Windows rollout SHALL use a version greater than `1.2.17`.

#### Scenario: Operator attempts to repair 1.2.17 in place
- **WHEN** publication targets any existing Windows `v1.2.17` key with replacement signed bytes or a merged manifest
- **THEN** immutable preflight rejects the operation without overwrite
- **AND** stable and Den metadata remain unchanged

#### Scenario: Formal Windows rollout is prepared
- **WHEN** a production Windows release is selected for the dual-architecture workflow
- **THEN** its version is greater than `1.2.17`
- **AND** the `1.2.17` unsigned candidate remains recorded as unpromoted evidence
