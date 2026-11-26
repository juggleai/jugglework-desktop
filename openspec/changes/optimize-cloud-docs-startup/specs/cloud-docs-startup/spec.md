## ADDED Requirements

### Requirement: Enable startup optimizations by default
Desktop SHALL enable main-window live restoration and startup warmup by default. Setting `JUGGLEWORK_DOCS_LIVE_RESUME=0` or `JUGGLEWORK_DOCS_STARTUP_WARMUP=0` SHALL disable only that feature on the next process launch.

#### Scenario: Host reloads before claiming a warmup
- **WHEN** the host reloads before a hidden warmup is claimed
- **THEN** Desktop cancels and cleans up the warmup using the save barrier
- **AND** it does not offer that warmup as a live restoration candidate

### Requirement: Restore a live document after host reload
Desktop SHALL detach rather than destroy eligible main-window document views during renderer reload, and SHALL reattach only after fresh current-session authorization and exact owner, scope and host-binding validation. A successful restore SHALL NOT bootstrap or create another native document view.

#### Scenario: Reload with unsaved input
- **WHEN** the host renderer reloads while a document has accepted unsaved input
- **THEN** Main hides and retains that instance and its save operations
- **AND** after successful current authorization the new host restores the same instance without replaying business commands

#### Scenario: An old host callback arrives
- **WHEN** a detached renderer sends a late close, bounds or reference result after a new binding is established
- **THEN** Main rejects it without altering the new host or retained document

### Requirement: Revalidate without changing the native session
Docs SHALL consume a fresh normal launch grant for each resume attempt and verify its current authority, native session, member generation, presentation and actual scope without replacing cookies, issuing a new native session or modifying document content. Old ready states and cached content SHALL NOT establish authorization.

#### Scenario: Membership or scope changes
- **WHEN** resume detects an invalid membership, changed source session or mismatched document scope
- **THEN** the old view remains hidden and cannot be claimed
- **AND** fallback and cleanup preserve existing draft and save barriers without reusing a consumed grant

### Requirement: Bounded restart warmup
Desktop SHALL use existing isolated caches and at most one recent authorized home locator after full restart. Historical document locators SHALL NOT trigger startup warmup; live restoration SHALL continue to use the actual retained document route. Warmup SHALL start only after current identity and the interactive main window are established, SHALL share the same pending instance with a matching user open, and SHALL NOT bypass authorization or start business writes.

#### Scenario: Immediate click while warmup is pending
- **WHEN** a user opens the same target while its startup warmup is still pending
- **THEN** both paths use a single pending operation and native instance, and ownership can transfer once the instance is registered without waiting for command-ready
- **AND** authorization and command-ready govern native visibility, and late cancellation of the original warmup cannot close the claimed foreground instance

#### Scenario: User open happens before warmup
- **WHEN** a user explicitly opens any document before the startup warmup begins
- **THEN** the pending startup warmup is cancelled and cannot create another full-page instance

#### Scenario: A competing handoff shares the warmup session
- **WHEN** a non-warmup view is opened with the same native partition and Docs origin as an unclaimed warmup
- **THEN** the warmup is cancelled and cleared after save confirmation before the new handoff starts
- **AND** a main-window request waiting for this confirmation expires if its host reloads or closes all cloud document views for an authority change

#### Scenario: Logout or unused warmup
- **WHEN** identity changes or a warmup remains unused past its limit
- **THEN** it cannot become visible or deliver late results
- **AND** cleanup waits for existing save confirmation and never discards unconfirmed drafts

### Requirement: Preserve cache and persistence boundaries
Recovery metadata SHALL NOT contain tokens, grants, cookies, context IDs, content or screenshots. Desktop SHALL preserve account-isolated native storage and existing collaboration, loss-of-access and save semantics during recovery and fallback.

#### Scenario: No safe cached document is available
- **WHEN** the application restarts without an authorized usable local snapshot
- **THEN** it follows normal authorized initialization rather than displaying stale content or reporting readiness early

### Requirement: Observe content readiness independently
Content presentation signals SHALL be optional, correlated to the current instance, context, document and observation, and SHALL NOT change command-ready or persistence ACK semantics. Diagnostics SHALL separate cold start, warm start, live restoration and warmup and SHALL omit credentials and document identifiers.

#### Scenario: A stale presentation signal arrives
- **WHEN** navigation or retry has changed the target or observation
- **THEN** a late presentable signal does not remove the current loading state or establish save completion

#### Scenario: Claim an already presentable view
- **WHEN** a new host requests current content state with a new observation after subscriptions are installed
- **THEN** Docs re-evaluates the current document or home list and replies without remounting it
- **AND** a previously completed warmup does not require another mount event to become visible

#### Scenario: Resume capability is absent
- **WHEN** the Docs service does not support resume
- **THEN** Desktop uses existing authorized bootstrap with save and shared-partition context protection
- **AND** existing command-ready presentation and Docs internal loading remain available

#### Scenario: Only content-state capability is absent
- **WHEN** resume is supported but content-state is not
- **THEN** authorized live restoration remains available without another bootstrap
- **AND** existing presentation is preserved and content timing is recorded as unsupported rather than left waiting indefinitely

#### Scenario: Supported observation is unavailable
- **WHEN** a content-state query receives no response within five seconds or a hidden warmup has not yet received a paint opportunity
- **THEN** authorized native visibility does not wait for content-state and uses the existing presentation path
- **AND** a query timeout records unavailable timing without fabricating presentable, bootstrapping again or creating another instance

### Requirement: Launch without redundant configuration discovery
Desktop SHALL obtain the current Docs origin from the Work launch response for both fresh opens and live restoration. Work feature and membership checks SHALL remain authoritative.

#### Scenario: Work rejects launch
- **WHEN** Work disables Docs or rejects the current identity
- **THEN** Desktop reports the existing failure without probing another origin or bypassing authorization
