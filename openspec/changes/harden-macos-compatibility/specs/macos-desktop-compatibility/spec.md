## Purpose

Define a trustworthy macOS desktop support contract so every published JuggleWork artifact runs on its declared operating-system baseline and CPU architecture with compatible native modules and privacy-safe screen capture.

## ADDED Requirements

### Requirement: Complete desktop support begins at macOS 14
The JuggleWork macOS application, its installer metadata, bundled runtime sidecars, and native helpers SHALL declare and enforce macOS 14.0 as the minimum supported operating-system version for the complete desktop product.

#### Scenario: User launches a supported build
- **WHEN** a user installs the macOS desktop application on macOS 14 or later
- **THEN** the application and every required bundled executable are eligible to launch without a minimum-system-version conflict

#### Scenario: User attempts an older macOS release
- **WHEN** a user attempts to launch the desktop application on a macOS version earlier than 14.0
- **THEN** macOS rejects the application using the bundle's declared minimum version instead of allowing a partially functional installation

### Requirement: Published artifacts are architecture-pure
Each architecture-specific macOS artifact SHALL contain only thin Mach-O executables and native modules for its declared CPU architecture.

#### Scenario: Apple Silicon artifact is validated
- **WHEN** the release pipeline packages the arm64 macOS artifact
- **THEN** every bundled Electron binary, sidecar, helper, and native module supports arm64

#### Scenario: Intel artifact is validated
- **WHEN** the release pipeline packages the x64 macOS artifact
- **THEN** every bundled Electron binary, sidecar, helper, and native module supports x86_64

#### Scenario: Mixed architecture is detected
- **WHEN** any required Mach-O file lacks the artifact's declared architecture
- **THEN** the release job fails before publishing the artifact

### Requirement: Native modules match the packaged Electron runtime
Every packaged native Node module SHALL be loadable by the exact Electron runtime and CPU architecture included in the same artifact.

#### Scenario: SQLite native module is checked
- **WHEN** a macOS artifact is built
- **THEN** a packaged-runtime smoke test opens an in-memory database and executes a query successfully

#### Scenario: Terminal native module is checked
- **WHEN** a macOS artifact is built
- **THEN** a packaged-runtime smoke test starts a pseudo-terminal and observes successful output

#### Scenario: ABI mismatch is detected
- **WHEN** a packaged native module targets a different Node module ABI
- **THEN** the release job fails before signing or publishing the artifact

### Requirement: Electron remains within upstream support
The desktop application SHALL use an Electron major that is within the upstream-supported release window at the time the compatibility change is released.

#### Scenario: Desktop dependency is reviewed
- **WHEN** release validation inspects the Electron dependency
- **THEN** it rejects the legacy unsupported Electron 35 release line

### Requirement: Screen capture uses supported macOS APIs
Computer Use SHALL use ScreenCaptureKit for display and window screenshots and SHALL declare a human-readable screen-capture usage description in the responsible application bundle.

#### Scenario: Window screenshot succeeds
- **WHEN** ScreenCaptureKit grants access to a target window
- **THEN** Computer Use returns the screenshot without invoking deprecated Core Graphics capture APIs

#### Scenario: ScreenCaptureKit fails
- **WHEN** ScreenCaptureKit cannot capture the requested content
- **THEN** Computer Use reports screenshot failure without falling back to deprecated capture APIs

#### Scenario: macOS requests screen-recording consent
- **WHEN** macOS presents screen-recording consent for JuggleWork
- **THEN** the application bundle provides a clear explanation of why screen access is needed

### Requirement: macOS release infrastructure remains available
CI and release workflows SHALL use supported macOS runner labels and SHALL retain separate execution paths for Apple Silicon and Intel artifacts.

#### Scenario: Apple Silicon release runs
- **WHEN** the release workflow builds the arm64 artifact
- **THEN** it runs on a supported Apple Silicon macOS runner

#### Scenario: Intel release runs
- **WHEN** the release workflow builds the x64 artifact
- **THEN** it runs on a supported Intel macOS runner rather than cross-packaging host-native dependencies on Apple Silicon

### Requirement: Post-pack validation runs for every architecture
Electron post-pack processing SHALL resolve electron-builder's architecture representation correctly and SHALL select, sign, and validate resources for the packaged target.

#### Scenario: electron-builder supplies an architecture enum
- **WHEN** the post-pack hook receives electron-builder's numeric architecture value
- **THEN** it resolves the corresponding target triple and executes architecture-specific processing
