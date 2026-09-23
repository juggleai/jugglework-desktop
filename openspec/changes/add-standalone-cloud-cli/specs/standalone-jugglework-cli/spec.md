## Purpose

Provide a self-contained, secure, and scriptable Codex-style JuggleWork terminal client that can authenticate to JuggleWork Cloud, use organization-managed model providers, and run without JuggleWork Desktop or a separately installed OpenCode.

## ADDED Requirements

### Requirement: The CLI uses the production Cloud deployment by default

The CLI SHALL use `https://work.jugglechat.cn` as its default JuggleWork Cloud base URL. It SHALL allow an explicit Cloud URL override without conflating the Cloud control plane with a local or remote JuggleWork runtime Server.

#### Scenario: Default Cloud command
- **WHEN** the user runs a Cloud account or organization command without a Cloud URL override
- **THEN** the CLI sends the request to the API rooted at `https://work.jugglechat.cn`

#### Scenario: Runtime Server is overridden
- **WHEN** the user supplies `--server` for an existing JuggleWork runtime
- **THEN** the value affects runtime task APIs only
- **AND** does not change the Cloud deployment used for account or organization requests

### Requirement: A user can authenticate without Desktop

The CLI SHALL support login, login status, and logout without requiring JuggleWork Desktop. Login SHALL use the deployment's supported browser authorization contract, exchange only a short-lived one-time grant for a session, and SHALL provide a copy-and-paste fallback that works over remote terminals.

#### Scenario: Browser-assisted handoff login
- **WHEN** an unauthenticated user runs `jugglework login` in a human terminal
- **THEN** the CLI opens or prints the Cloud sign-in URL
- **AND** asks for the resulting one-time grant or handoff link when an automatic callback is unavailable
- **AND** exchanges the grant before reporting login success

#### Scenario: Unauthenticated bare interactive launch
- **WHEN** a user without a saved Cloud profile or environment Cloud token runs bare `jugglework` in a capable local terminal
- **THEN** the CLI shows a selectable sign-in screen before starting the runtime
- **AND** offers browser-assisted handoff, paste-only handoff for another device, and an explicit continue-without-Cloud choice
- **AND** never advertises unsupported device-code or direct API-key authentication
- **AND** accepts the one-time grant or handoff link without echoing it in the terminal
- **AND** proceeds to the interactive runtime after a successful login or an explicit continue choice

#### Scenario: Automation and connected runtime bypass onboarding
- **WHEN** the user supplies a prompt, runs an explicit command, uses JSON/non-TTY execution, or connects to an existing Server
- **THEN** the CLI does not open the interactive sign-in screen

#### Scenario: Login status for automation
- **WHEN** the user runs `jugglework login status`
- **THEN** the CLI exits with status zero only when the selected Cloud profile has a valid authenticated user
- **AND** exits non-zero without printing stored credential material when authentication is missing or invalid

#### Scenario: Logout
- **WHEN** the user runs `jugglework logout`
- **THEN** the CLI invalidates the Cloud session when supported and removes the selected local credential profile

### Requirement: Cloud credentials are isolated and protected

The CLI SHALL keep Cloud credentials separate from runtime Server tokens, SHALL key persisted profiles by normalized Cloud deployment, SHALL restrict credential storage to the current user where supported, and SHALL never expose tokens or provider secrets in normal, JSON, debug, or error output.

#### Scenario: Multiple deployment profiles
- **WHEN** the user logs into two explicitly different Cloud deployments
- **THEN** each deployment retains an independent account and selected organization profile

#### Scenario: Redacted failure
- **WHEN** Cloud authentication or a provider request fails
- **THEN** output may include the deployment, request class, HTTP status, and reference identifier
- **AND** excludes bearer tokens, one-time grants, API keys, and provider credential values

### Requirement: The CLI selects an account-scoped default organization

After login, the CLI SHALL select a valid organization using the account's Cloud active choice, then the account's remembered local choice, then the first organization returned by Cloud. The CLI SHALL list available organizations, allow explicit selection by an unambiguous identifier or slug, and synchronize explicit changes with Cloud so Desktop and CLI see the same active organization. Local organization history SHALL be scoped by confirmed user and retained across logout without retaining credentials.

#### Scenario: First login
- **WHEN** a user logs in and neither Cloud nor that account's local history identifies a valid organization
- **THEN** the CLI selects the first organization returned by Cloud and persists it

#### Scenario: Returning account
- **WHEN** a user logs in again and the Cloud account reports a valid active organization
- **THEN** the CLI selects that organization even when a different account used the same deployment previously

#### Scenario: Select organization
- **WHEN** the user runs `jugglework org use <id-or-slug>` with one unambiguous match
- **THEN** subsequent provider and model commands use that organization
- **AND** the selected organization is updated through Cloud's active-organization API

#### Scenario: Selected membership was removed
- **WHEN** the persisted organization is no longer present in the current user's memberships
- **THEN** the CLI clears or ignores that selection
- **AND** falls back to the first available organization unless an explicit invalid override was requested

### Requirement: Organization provider and model inventory is truthful

The CLI SHALL distinguish public catalog metadata, providers and models published to the selected organization, providers imported into the local runtime, models loaded by the current engine, and models verified as executable. It SHALL not describe public catalog presence as organization entitlement or runtime availability.

#### Scenario: List organization providers
- **WHEN** an authenticated user with a selected organization runs the provider-list command
- **THEN** the CLI displays only providers published to that organization
- **AND** does not display provider credentials

#### Scenario: List public catalog
- **WHEN** the user requests public catalog metadata
- **THEN** the request omits Cloud bearer and organization headers
- **AND** output labels the entries as catalog metadata rather than available providers

### Requirement: A selected Cloud provider can be imported safely

The CLI SHALL be able to import a supported organization provider into the selected CLI runtime using host-authorized runtime APIs. It SHALL store provider authentication through the runtime authority rather than editing OpenCode credential files directly, SHALL persist non-secret import metadata for reconciliation, and SHALL make retries idempotent.

#### Scenario: Import succeeds
- **WHEN** the user imports an organization provider and has sufficient runtime host authority
- **THEN** required protected environment values, provider authentication, runtime provider configuration, and import metadata are applied
- **AND** the CLI verifies that the provider is visible to the runtime

#### Scenario: Import is only partially applied
- **WHEN** a later import stage fails after an earlier stage succeeded
- **THEN** the CLI reports a redacted partial-state error and safe retry instructions
- **AND** does not blindly delete values that may have existed before the import

#### Scenario: Connected runtime lacks host authority
- **WHEN** provider import targets an existing runtime without valid host authority
- **THEN** the command fails before disclosing or writing provider credentials

### Requirement: The released CLI contains its execution engine

Every supported native CLI release SHALL contain a compatible OpenCode executable and the required JuggleWork OpenCode plugin assets. A normal task invocation on a supported clean machine SHALL not depend on JuggleWork Desktop, a global OpenCode installation, or a network download of executable runtime components.

#### Scenario: Clean-machine task
- **WHEN** a user installs a released CLI artifact on a supported machine with no Desktop and no OpenCode in `PATH`
- **THEN** `jugglework "inspect this directory"` starts the packaged runtime and can execute the task after required model authentication is available

#### Scenario: Distribution is incomplete
- **WHEN** the packaged OpenCode executable or a required plugin asset is missing, incompatible, or not executable
- **THEN** startup fails before creating a task session
- **AND** the error identifies the installation as incomplete without searching for Desktop as a required fallback

### Requirement: Interactive and executable modes follow stable contracts

Bare `jugglework` SHALL open the interactive experience, `jugglework [prompt]` SHALL start interactively with the prompt, and `jugglework exec [prompt]` SHALL provide a deterministic non-interactive mode. The CLI SHALL preserve a searchable slash-command surface and session continuation without requiring a full-screen Desktop application.

#### Scenario: Bare invocation
- **WHEN** the user runs `jugglework` in a capable terminal and has completed or explicitly skipped any sign-in choice
- **THEN** the CLI opens an interactive session for the current workspace
- **AND** exposes contextual commands for model, organization, status, permissions, sessions, Connect, skills, extensions, diagnostics, and exit

#### Scenario: Slash command discovery
- **WHEN** the user types `/` at the interactive prompt
- **THEN** the CLI immediately lists the commands it actually supports, with short descriptions
- **AND** Up/Down selects a listed command, Enter executes it, and continued typing filters the list

#### Scenario: Model selection
- **WHEN** the user runs `/model` without arguments in the interactive prompt
- **THEN** the CLI lists connected chat-capable models from the active workspace runtime
- **AND** the user can select a model and one of its reported reasoning variants with Up/Down and Enter
- **AND** cancelling either picker leaves the current model unchanged

#### Scenario: Model context
- **WHEN** the CLI enters an interactive workspace with a configured model
- **THEN** it shows the provider, model, and requested reasoning effort from CLI selection or workspace configuration
- **AND** the active model and reasoning effort remain directly below the input cursor while composing
- **AND** labels values not reported by the Server as runtime defaults rather than inventing them

#### Scenario: Interactive task in progress
- **WHEN** a user submits a task in the interactive session
- **THEN** the CLI shows the submitted instruction, elapsed working state, and the configured model and workspace context
- **AND** Escape requests cancellation of the active Server run
- **AND** streaming output remains visible while the task runs
- **AND** the prompt returns only after the task finishes or stops, so no inactive input field is presented as usable
- **AND** tool status and assistant text appear as distinct terminal-readable output

#### Scenario: Explicit execution mode
- **WHEN** the user runs `jugglework exec "run focused tests"`
- **THEN** the command runs one task without entering a prompt loop
- **AND** exits with a result-appropriate status

#### Scenario: Standard input accompanies an instruction
- **WHEN** `jugglework exec` receives both a positional instruction and piped standard input
- **THEN** the positional text remains the instruction
- **AND** the piped text is supplied as separate task context

### Requirement: Automation output is composable

In execution mode the CLI SHALL write the final assistant response to stdout, operational progress to stderr, and no human decoration to stdout. JSON mode SHALL produce newline-delimited event objects. The CLI SHALL support writing the final message separately and requesting schema-constrained final output.

#### Scenario: Plain scripted execution
- **WHEN** a successful `jugglework exec` command runs without JSON mode
- **THEN** stdout contains only the final assistant response
- **AND** progress and diagnostics are written to stderr

#### Scenario: JSON execution
- **WHEN** `--json` is supplied to execution mode
- **THEN** stdout contains only NDJSON lifecycle and result records
- **AND** consumers are not required to parse terminal control sequences or human progress text

### Requirement: Sessions have a discoverable lifecycle

The CLI SHALL support listing, showing, resuming, forking, queueing, renaming, archiving, unarchiving, and deleting persisted sessions. Destructive deletion SHALL require confirmation unless an explicit, unambiguous force form is used.

#### Scenario: Resume recent work
- **WHEN** the user runs a resume command without an exact session identifier in an interactive terminal
- **THEN** the CLI presents a recent-session picker scoped to the current workspace by default

#### Scenario: Delete by ambiguous name
- **WHEN** a delete target is not an unambiguous identifier
- **THEN** the CLI refuses force deletion and requests an explicit selection

### Requirement: Safety controls remain explicit

The CLI SHALL keep technical sandbox scope distinct from approval policy, SHALL default to a policy that does not silently approve sensitive local or connected-service actions, and SHALL make dangerous bypasses explicit and conspicuously named.

#### Scenario: Non-interactive task needs approval
- **WHEN** execution mode reaches an action not allowed by its configured policy
- **THEN** the task fails or emits a machine-actionable approval-required event
- **AND** does not silently grant the action

### Requirement: Diagnostics and help are safe and discoverable

The CLI SHALL provide hierarchical help, shell completion generation, version reporting, and a doctor command. Doctor output SHALL diagnose Cloud login, organization selection, packaged runtime assets, workspace access, Server health, provider visibility, and configuration while remaining redacted in both human and JSON modes.

#### Scenario: Redacted doctor report
- **WHEN** the user runs `jugglework doctor --json`
- **THEN** stdout contains a machine-readable diagnostic report with pass, warning, and failure checks
- **AND** contains no recoverable token, grant, provider key, or secret environment value
