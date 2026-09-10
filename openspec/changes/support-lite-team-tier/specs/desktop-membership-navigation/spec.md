## MODIFIED Requirements

### Requirement: Desktop delegates membership upgrades to the server console

Desktop SHALL NOT render or submit its own membership tier-selection dialog. It SHALL recognize `lite_team` as an organization tier and display it as Lite Team. An eligible Personal account SHALL open the server console with `membership=personal`. A Lite Team, Team, or Business organization account SHALL show Upgrade only to an Owner with effective billing-management permission and SHALL open the server console with `membership=team`. The server remains authoritative for the active tenant, visible plan family, selectable tiers, seats, billing period, orders, and payment.

#### Scenario: Server returns Lite Team contracts
- **WHEN** the server returns a `lite_team` organization account, a six-plan `membership-cny-v2` catalog, or a Lite Team organization order
- **THEN** Desktop accepts the contract while preserving tenant-kind and financial validation

#### Scenario: Lite Team Owner chooses Upgrade
- **WHEN** a Lite Team organization Owner with billing permission clicks Upgrade
- **THEN** Desktop opens `/jwork/console/dashboard/?membership=team` on the configured server
- **AND** Desktop does not render a local plan selector

#### Scenario: Lite Team non-Owner opens the account menu
- **WHEN** a Lite Team organization Admin or Member opens the Desktop account menu
- **THEN** no membership Upgrade action is shown
