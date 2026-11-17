## ADDED Requirements

### Requirement: Hidden Contacts and Toon Factory entries
The application navigation rail SHALL NOT show the Contacts button or the Toon Factory More-menu entry while their navigation flags are off.

#### Scenario: Contacts flag off
- **WHEN** Messages is available and `CONTACTS_NAVIGATION_ENABLED` is false
- **THEN** the rail shows the Messages button but no Contacts button
- **AND** Contacts remains reachable from inside the Messages view

#### Scenario: Toon Factory flag off with a stale pin
- **WHEN** `TOON_FACTORY_NAVIGATION_ENABLED` is false and the stored pins include `toon-factory`
- **THEN** the More menu shows no Toon Factory row or pin action
- **AND** the rail shows no pinned Toon Factory button

### Requirement: Default pinned destinations
The rail SHALL pin Tasks, Calendar, and Meetings by default until the user saves a pin choice.

#### Scenario: First launch
- **WHEN** no pin choice has been stored
- **THEN** Tasks, Calendar, and Meetings appear as pinned rail buttons, with Meetings following the existing Messages availability rule

#### Scenario: User removes all pins
- **WHEN** the user unpins every destination
- **THEN** the stored empty list is respected and the defaults are not restored
