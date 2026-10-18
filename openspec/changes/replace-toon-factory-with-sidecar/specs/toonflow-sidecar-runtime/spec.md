## ADDED Requirements

### Requirement: Navigation exposes the managed Toonflow surface
JuggleWork SHALL display “漫剧工厂” directly below Code Review in the left navigation overflow menu and SHALL allow users to pin or unpin it using the same persistent rail behavior as other pinnable applications.

#### Scenario: User pins the factory
- **WHEN** a user selects the pin action for 漫剧工厂
- **THEN** the item appears in the primary left rail and remains pinned after application restart

#### Scenario: Overflow ordering
- **WHEN** 漫剧工厂 is not pinned and the user opens the overflow menu
- **THEN** it appears directly below Code Review

### Requirement: Sidecar replaces the native Toon Factory destination
Opening the Toon Factory navigation destination SHALL show the managed Toonflow v2 sidecar and SHALL NOT mount or start the native React Toon Factory runtime.

#### Scenario: User opens the factory
- **WHEN** the user activates 漫剧工厂
- **THEN** JuggleWork starts or reveals the workspace-bound sidecar view without starting the native Toon Factory surface

### Requirement: Runtime authority is workspace-bound
The Desktop runtime SHALL bind each sidecar process, data directory, browser partition, broker capability, and status response to exactly one JuggleWork workspace, and MUST destroy stale authority before switching workspaces.

#### Scenario: User switches workspaces
- **WHEN** workspace A owns the running sidecar and the user opens 漫剧工厂 in workspace B
- **THEN** Desktop stops and destroys the workspace A runtime before creating a workspace B runtime with separate data, storage, and tokens

#### Scenario: Stale broker token is reused
- **WHEN** a request presents a token issued for a previous workspace or runtime instance
- **THEN** JuggleWork rejects the request without accessing models, files, or native capabilities

### Requirement: The embedded page is sandboxed
Desktop MUST load Toonflow in a dedicated sandboxed `WebContentsView` with context isolation, Node integration disabled, permissions denied by default, restricted navigation, and no access to the main-window preload API.

#### Scenario: Page requests a desktop permission
- **WHEN** the Toonflow page requests an Electron permission not explicitly mediated by the managed bridge
- **THEN** Desktop denies the request

### Requirement: Local transport is authenticated and loopback-only
The sidecar SHALL bind to an operating-system assigned loopback port and SHALL authenticate browser and broker traffic with per-instance capabilities that are never placed in URLs, logs, portable projects, or browser storage.

#### Scenario: Unauthenticated local process calls the sidecar
- **WHEN** a process sends an API request without the active instance credential
- **THEN** the sidecar rejects it before executing the route

### Requirement: Managed mode disables independent extension authority
Managed mode MUST skip Toonflow provider onboarding and MUST server-side reject provider, marketplace, dynamic tool/node/extension/agent installation, external MCP/A2A exposure, mobile-link, and developer operations. Only build-staged, integrity-verified resources SHALL execute.

#### Scenario: Caller bypasses the hidden marketplace UI
- **WHEN** a caller invokes a disabled plugin installation endpoint directly
- **THEN** the managed sidecar rejects the request and does not download or execute code

#### Scenario: First managed launch
- **WHEN** a workspace opens the managed sidecar for the first time
- **THEN** the application opens the project home without showing TF-Router login or private-provider setup

### Requirement: Lifecycle cleanup is bounded
Desktop SHALL provide serialized open, hide, close, restart, status, and dispose behavior, and MUST terminate the view, child process tree, tokens, listeners, timers, and broker state on workspace switch, sign-out, permission revocation, update, explicit close or idle shutdown, and application exit.

#### Scenario: Application exits with an active generation view
- **WHEN** JuggleWork exits while the sidecar is active
- **THEN** Desktop attempts graceful shutdown within a bounded timeout and then terminates the process tree without leaving an orphan listener or process

### Requirement: Sidecar builds are reproducible and verifiable
A clean checkout SHALL build the pinned Toonflow module without pre-existing nested dependencies, and packaged artifacts MUST include a checksum-verified target Bun runtime, server, Web assets, approved resources, inventory manifest, executable permissions, and platform signing evidence.

#### Scenario: CI builds after a Toonflow module change
- **WHEN** tracked Toonflow module or sidecar integration files change
- **THEN** Electron CI runs the clean sidecar build and packaged verification jobs

#### Scenario: Wrong-architecture Bun is staged
- **WHEN** package verification detects a Bun executable that does not match the package target
- **THEN** the build fails before publication
