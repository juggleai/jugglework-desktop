## ADDED Requirements

### Requirement: Freeform canvas and assistant work does not imply workflow decisions
Canvas mutations, document edits, assistant prose, tool completion, and subagent completion SHALL NOT by themselves approve content, authorize compute, skip a stage, adopt a candidate, or mark an episode delivered.

#### Scenario: Agent says a storyboard is approved
- **WHEN** an assistant response states that a storyboard is ready or approved
- **THEN** the workflow remains pending until the user performs the explicit content-approval action

#### Scenario: Agent creates generation nodes
- **WHEN** a canvas call creates configured image or video nodes
- **THEN** no compute authorization is recorded and no paid generation begins

### Requirement: Workspace entities retain workflow dependency links
Workflow records SHALL reference stable canvas, node, document, asset, generation, and adoption IDs with observed revisions so relevant upstream edits can mark downstream decisions stale without deleting history.

#### Scenario: Approved source document changes
- **WHEN** a document revision used by an approved script is replaced
- **THEN** dependent records are marked stale or pending review according to their recorded links
- **AND** prior approvals, candidates, and adopted artifacts remain inspectable

#### Scenario: Unrelated canvas changes
- **WHEN** a node outside a workflow record's dependency closure moves or changes
- **THEN** the unrelated workflow record is not invalidated solely by that edit

### Requirement: Assistant interactions can propose but not execute protected transitions
The Agent SHALL present protected workflow transitions as explicit human interactions using the existing approval, authorization, skip, adoption, and delivery contracts, and SHALL NOT invoke those transitions as ordinary canvas tools.

#### Scenario: Agent recommends adopting a candidate
- **WHEN** the Agent identifies a preferred generated candidate
- **THEN** it can open or propose the review interaction
- **AND** only the user's explicit adoption action changes the adoption record

#### Scenario: User declines a proposed transition
- **WHEN** the user rejects or dismisses an Agent-proposed approval, authorization, skip, adoption, or delivery action
- **THEN** the protected workflow state remains unchanged
- **AND** the denial is available to the waiting turn as an interaction result
