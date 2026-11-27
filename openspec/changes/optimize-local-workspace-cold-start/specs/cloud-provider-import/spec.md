## MODIFIED Requirements

### Requirement: Engine application is verified per imported model
Desktop SHALL treat an imported cloud provider as applied only when the engine provider list contains that provider and every model ID recorded in the import baseline. A provider that uses a gateway credential SHALL also need to appear in the engine's connected list, when that list is readable. Models the engine lists beyond the baseline SHALL NOT count as a difference.

#### Scenario: Several new providers are imported in one sync
- **WHEN** one cloud provider sync imports two or more providers that the workspace has not imported yet
- **THEN** Desktop writes each provider's configuration without disposing the engine per provider
- **AND** it disposes the engine once after the last provider is written, and verifies engine application after that single dispose
- **AND** the per-provider imports of that sync SHALL NOT mark a separate reload request

#### Scenario: A sync fails after writing configuration but before the final dispose
- **WHEN** at least one provider configuration was written without a dispose and the sync then throws, including because the account or organization changed during the sync
- **THEN** Desktop marks the workspace as needing an engine reload so the idle reload coordinator applies the written configuration
- **AND** the original sync error is not swallowed

#### Scenario: A provider is connected outside a sync
- **WHEN** a user or repair flow connects a single cloud provider outside the batched sync
- **THEN** Desktop disposes the engine and marks the reload as before
