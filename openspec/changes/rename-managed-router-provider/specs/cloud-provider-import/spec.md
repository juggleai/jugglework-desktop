# Cloud provider import delta

## Requirements

### Requirement: Desktop recognizes both managed router generations
Desktop SHALL recognize `managedIdentity=jwork_router` as the canonical managed routing identity and SHALL recognize the legacy `juggle_router` managed discriminator when the canonical field is absent.

#### Scenario: New Desktop connects to old Server
- **WHEN** the provider payload has the legacy managed discriminator and omits canonical managed identity
- **THEN** Desktop continues treating it as the managed router provider

### Requirement: Provider rename preserves workspace identity
Desktop SHALL keep the Cloud provider row ID as the local provider key when the managed provider display identity changes from JuggleRouter to JWorkRouter.

#### Scenario: Imported provider is renamed
- **WHEN** a previously imported managed provider is returned with the same Cloud row ID and the JWorkRouter display identity
- **THEN** Desktop updates the provider in place and preserves fully-qualified model references

### Requirement: Ordinary JuggleRouter remains independent
Desktop SHALL NOT classify a provider as managed based only on the name or public provider ID `JuggleRouter`.

#### Scenario: Both providers are available
- **WHEN** a workspace receives managed JWorkRouter and an ordinary JuggleRouter provider
- **THEN** it imports them under separate provider keys and does not apply managed-points policy to the ordinary provider
