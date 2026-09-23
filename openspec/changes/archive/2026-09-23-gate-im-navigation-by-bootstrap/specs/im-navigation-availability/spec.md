## ADDED Requirements

### Requirement: IM navigation reflects current-organization bootstrap availability

Desktop SHALL show Chat and Contacts navigation only when authentication is usable, organization capability resolution is not in progress, and a complete server-returned IM bootstrap belongs to the active organization. It SHALL hide both entries together when login or organization switching returns no IM bootstrap, when the bootstrap is invalid, or while the target organization's capability is unresolved.

#### Scenario: Active organization has IM enabled
- **WHEN** login or organization switching returns a complete IM bootstrap for the active organization
- **THEN** Chat and Contacts are both visible

#### Scenario: Active organization has no IM bootstrap
- **WHEN** login or organization switching returns null or incomplete IM data
- **THEN** Chat and Contacts are both hidden

#### Scenario: Organization switch is in progress
- **WHEN** the user starts switching from an IM-enabled organization to another organization
- **THEN** Chat and Contacts are hidden until the target organization's response is applied

#### Scenario: Cached bootstrap belongs to another organization
- **WHEN** persisted IM credentials were issued for an organization other than the active organization
- **THEN** those credentials do not establish IM navigation availability
