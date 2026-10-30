# Managed media billing readiness

## Purpose
Keep native image/video readiness aligned with the serving gateway's per-model managed billing support.

## Requirements

### Requirement: Managed imports require affirmative serving metadata
Cloud imports SHALL use the response's `provider.managed === true` discriminator to install model-local `managedMediaBilling: {required:true, version:1, supported:boolean, reason?:string}`. Only version 1 with boolean `supported:true` in that response model's config SHALL be affirmative. Missing, malformed or unknown-version metadata SHALL import as unsupported. Catalog backfill and customer-authored provider metadata SHALL NOT supply affirmative support. Import metadata version SHALL advance so existing models are reimported.

#### Scenario: Old server exposes generation capabilities without billing support
- **WHEN** a managed image or video model has generation capabilities but no serving billing flag
- **THEN** import writes required unsupported metadata and native discovery reports `managed_billing_unavailable`
- **AND** ready-model lists and direct native generation do not select it

#### Scenario: Supported gateway model
- **WHEN** the managed response model explicitly has version 1 and boolean supported true
- **THEN** import forces required true and normal adapter/credential readiness still applies

### Requirement: BYOK readiness remains compatible
Nonmanaged imports SHALL NOT install a managed billing requirement. Local BYOK models without that requirement SHALL retain existing adapter and credential readiness semantics.

#### Scenario: BYOK provider supplies custom billing metadata
- **WHEN** a nonmanaged cloud provider's raw config contains managedMediaBilling
- **THEN** import does not copy that metadata or impose managed billing readiness

### Requirement: Billing remains server authoritative
The metadata SHALL be discovery information only. Desktop SHALL NOT determine prices, authorize monetary settlement or bypass server admission using this flag.
