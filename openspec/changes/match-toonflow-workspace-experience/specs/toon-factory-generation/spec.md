## ADDED Requirements

### Requirement: Canvas nodes and assistant tools share the durable generation lifecycle
Generation initiated from a canvas node or project assistant tool SHALL create or address the same persisted Toon generation records, idempotent jobs, progress, review, adoption, and artifact validation used by the existing workbench.

#### Scenario: Assistant prepares image generation
- **WHEN** an allowed assistant tool creates an image request for a node
- **THEN** the request is persisted with project, conversation, tool-call, canvas, node, prompt, reference, model, and parameter provenance
- **AND** no provider submission occurs until exact human authorization is recorded

#### Scenario: Canvas and assistant observe the same job
- **WHEN** an authorized job is running and both its node and assistant conversation are open
- **THEN** both surfaces show progress derived from the same durable job ID
- **AND** leaving either surface does not cancel or duplicate the job

### Requirement: Human authorization is required for each paid execution scope
Paid image or video submission MUST require explicit human authorization of the exact model, object and quantity, prompt, references, parameters, execution count, and known cost or unknown-cost label, regardless of Agent tool permission or conversational wording.

#### Scenario: User tells the Agent to continue
- **WHEN** a conversation contains assent but no exact compute-authorization record exists
- **THEN** the Agent may prepare the generation plan but no paid request is submitted

#### Scenario: Authorized plan changes
- **WHEN** model, prompt, references, quantity, duration, resolution, or execution count changes after authorization
- **THEN** the prior authorization is invalid for the changed plan
- **AND** fresh human authorization is required

### Requirement: Tool retries preserve idempotency and unknown-submission safety
Assistant and node generation calls SHALL use stable client request IDs, return existing outcomes for equivalent retries, and SHALL NOT automatically resubmit a request in `submission_unknown` state.

#### Scenario: Tool result response is lost
- **WHEN** a paid submission may have succeeded but the assistant does not receive its response
- **THEN** retry reconciles the stable request ID
- **AND** does not create a second paid submission

#### Scenario: Unknown submission cannot be reconciled yet
- **WHEN** the provider outcome remains uncertain
- **THEN** the job remains `submission_unknown` with a human-visible recovery action
- **AND** Agent continuation cannot bypass that state

### Requirement: Generated artifacts enter review rather than mutating adopted state
Outputs created by canvas or assistant generation SHALL become reviewable candidates and SHALL NOT replace node assets, workflow approvals, or adopted outputs until the user explicitly adopts a candidate.

#### Scenario: Assistant-generated video completes
- **WHEN** a video tool job returns a validated artifact
- **THEN** it appears as an awaiting-review candidate in the assistant, node, and asset views
- **AND** the current adopted clip remains unchanged until explicit adoption
