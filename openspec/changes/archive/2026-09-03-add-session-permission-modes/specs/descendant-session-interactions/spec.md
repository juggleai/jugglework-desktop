## ADDED Requirements

### Requirement: Root permission configuration governs eligible descendant requests
The system SHALL resolve the authoritative root of every descendant permission request before applying a permission mode or reusable grant. A root session's configuration SHALL apply to eligible descendants without changing the descendant session and request identifiers used for the upstream reply.

#### Scenario: Full access child request
- **WHEN** a hidden child session raises an eligible permission request under a Full access root
- **THEN** the system evaluates Full access using the root session's authoritative configuration
- **AND** sends any one-time upstream approval to the child session's exact request identifier

#### Scenario: Descendant moves outside the configured root
- **WHEN** current authoritative ancestry no longer places a requesting session under the configured root
- **THEN** the root's mode and grants are not used to approve the request

#### Scenario: Descendant ancestry cannot be verified
- **WHEN** the owning server cannot resolve a request's authoritative root ancestry
- **THEN** the request is not automatically approved
- **AND** it is not presented as belonging to an unrelated visible session

#### Scenario: Root mode changes during descendant approval
- **WHEN** a descendant request is awaiting automatic resolution while the root mode changes
- **THEN** the system revalidates root ownership and current mode before dispatching the exact reply
