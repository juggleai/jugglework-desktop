## Purpose

Lets a user configure an automation to trigger from GitHub activity (pull requests, issues, reviews, comments) instead of a clock, including which repository/events matter, how the run should be permitted, and how the device learns about a matching event.

## ADDED Requirements

### Requirement: Trigger-kind selection
The automation editor's execution-frequency step SHALL offer a `定时` / `事件触发` choice before showing schedule or event configuration. Selecting `事件触发` SHALL replace the `周期/按间隔/单次` controls with the event-trigger configuration flow. Switching away from a filled-in event configuration back to `定时` SHALL require discard confirmation before the event draft is cleared.

#### Scenario: User switches from event to scheduled mid-edit
- **WHEN** a user has filled in repository, event types, and filters under `事件触发` and then selects `定时`
- **THEN** the editor asks for discard confirmation before clearing the event-trigger draft, and canceling the confirmation keeps `事件触发` selected with the draft intact

### Requirement: Event-trigger source configuration
The event-trigger configuration flow SHALL require a connector (an authorized GitHub connection), a repository already bound as a connector instance for that connector, and at least one selected event type from a user-story-labeled matrix (not raw GitHub event/action names). It SHALL provide optional, collapsed-by-default advanced filters split into a common group (label, author allow/deny list, mention text, keyword) and a GitHub-specific group (branch base/head glob, changed-path glob), so a future non-GitHub event provider can extend the common group without restructuring it.

When the flow completes successfully, it SHALL include a `github-app` entry in the automation's connector selection representing run-bound write-back authority as the organization's GitHub App identity, distinct from any personal `local-mcp`/`cloud`/`directory` connector — this entry carries no credential itself; it only marks that the automation is authorized to request a per-run grant at execution time (see the execution capability).

#### Scenario: Saving without any event type selected
- **WHEN** a user attempts to save an event-trigger draft with zero event types checked
- **THEN** save is blocked and the event-type matrix is highlighted as the incomplete field

#### Scenario: Repository not yet bound
- **WHEN** a user selects a connector whose target repository has no connector-instance binding yet
- **THEN** the repository selector shows a `绑定此仓库` inline action instead of a dead end, and completing that action returns focus to the editor with all previously filled event-trigger fields intact

#### Scenario: Organization has not installed the GitHub App
- **WHEN** the selected connector's organization has no GitHub App installation
- **THEN** the editor shows an explanation and a `生成安装请求` action instead of an unexplained empty connector list

### Requirement: Blocked-draft persistence and resume notification
When save is blocked solely because the target organization has not installed the GitHub App or the target repository is not yet bound, the editor SHALL allow the draft to be saved locally in a `blocked-on-readiness` state without passing full validation, retaining every field filled so far. When the server-reported readiness for that organization/repository later becomes `ready`, the device SHALL notify the user who saved the blocked draft, and that notification SHALL deep-link back into the draft's event-configuration step with all fields intact.

#### Scenario: User closes the editor while blocked
- **WHEN** a user with a draft blocked on repository binding closes the editor without completing the block themselves
- **THEN** the draft is retained in a `blocked-on-readiness` state, discoverable from the automation list, with every previously filled field intact

#### Scenario: Blocking condition clears while the user is away
- **WHEN** the blocked draft's target repository becomes bound (by an admin, potentially days later)
- **THEN** the user who created the draft receives a notification that deep-links into the draft's event-configuration step with all fields intact

### Requirement: Input-trust-level-based permission tiering
The permission step SHALL resolve an `inputTrustLevel` of `open` or `restricted` for the selected event source, computed by the GitHub adapter from the repository's visibility (public → `open`, private → `restricted`); shared tiering logic SHALL depend only on this resolved level, never on repository visibility directly. When the level is `open`, the permission step SHALL default to and lock a restrictive read-plus-comment tier; escalating to the existing full-access profile SHALL require an additional explicit confirmation distinct from the standard full-access acknowledgement, with copy stating the automation can be triggered by any external actor. When the level is `restricted`, the editor SHALL offer the existing two-tier permission choice unchanged.

#### Scenario: Public repository selected
- **WHEN** a user selects a public repository for an event trigger
- **THEN** the resolved input trust level is `open`, the permission step defaults to the restrictive tier, and full-access requires a second, distinctly worded confirmation before it can be selected

#### Scenario: Private repository selected
- **WHEN** a user selects a private repository for an event trigger
- **THEN** the resolved input trust level is `restricted` and the permission step behaves identically to the existing scheduled-automation permission choice

### Requirement: Delivery-mode selection
The event-trigger configuration SHALL offer a delivery-mode control with three options — `自动`（default）, `强制 IM 推送`, `强制轮询` — and SHALL query a server readiness signal to determine and display which channel `自动` currently resolves to. When the organization has no server-side event capability available at all (self-hosted deployment without a usable GitHub App), the control SHALL narrow to a single disabled `设备直连轮询` option with an explanation.

#### Scenario: SaaS organization with webhook capability
- **WHEN** the server readiness probe reports IM delivery is available
- **THEN** `自动` displays as resolving to IM push, and the user can still force polling instead

#### Scenario: Private deployment without webhook capability
- **WHEN** the server readiness probe reports no webhook/App capability for the deployment
- **THEN** the delivery-mode control shows only the disabled device-polling option with an explanation of why the other options are unavailable

### Requirement: Pre-enable frequency and cost estimate
Before an event-trigger automation can be enabled, the editor SHALL display an estimated trigger frequency derived from the repository's recent activity and SHALL let the user set an optional per-hour trigger cap. Saving without setting a cap SHALL leave the automation uncapped but the estimate SHALL still be shown.

#### Scenario: User enables without setting a cap
- **WHEN** a user confirms enabling an event-trigger automation without entering a per-hour cap
- **THEN** the automation is saved as enabled with no cap and the estimate remains visible in the confirmation the user saw before confirming

#### Scenario: User sets a cap
- **WHEN** a user enters a per-hour cap before confirming
- **THEN** the cap value is persisted on the automation definition and used by the execution capability's rate limiting
