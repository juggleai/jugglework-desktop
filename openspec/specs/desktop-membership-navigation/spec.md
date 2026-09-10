# desktop-membership-navigation Specification

## Purpose

Define how Desktop delegates membership plan selection to the authoritative JuggleWork Server console.

## Requirements

### Requirement: Desktop delegates membership upgrades to the server console

Desktop SHALL NOT render or submit its own membership tier-selection dialog. An eligible Personal account SHALL open the server console with `membership=personal`. An organization account SHALL show Upgrade only to an Owner with effective billing-management permission and SHALL open the server console with `membership=team`. The server remains authoritative for the active tenant, visible plan family, selectable tiers, seats, billing period, orders, and payment.

#### Scenario: Personal member chooses Upgrade
- **WHEN** an eligible Personal member clicks Upgrade in Desktop
- **THEN** Desktop opens `/jwork/console/dashboard/?membership=personal` on the configured server
- **AND** Desktop does not render a local tier-selection dialog

#### Scenario: Team Owner chooses Upgrade
- **WHEN** a Team or Business organization Owner with billing permission clicks Upgrade
- **THEN** Desktop opens `/jwork/console/dashboard/?membership=team` on the configured server

#### Scenario: Team non-Owner opens the account menu
- **WHEN** an organization Admin or Member opens the Desktop account menu
- **THEN** no membership Upgrade action is shown
