## ADDED Requirements

### Requirement: Projects expose staged episodic production
The workbench SHALL organize production into content and script, assets, directing and storyboard, images, videos, and adoption and delivery while allowing inapplicable detailed steps to be skipped with a recorded reason.

#### Scenario: User advances a confirmed stage
- **WHEN** the current stage has complete persisted output and the user confirms it
- **THEN** the stage is recorded as approved with its input and output versions
- **AND** the next applicable stage becomes available

#### Scenario: User skips an inapplicable step
- **WHEN** a detailed step does not apply and the user explicitly skips it
- **THEN** the skip reason and decision are persisted
- **AND** the system does not fabricate placeholder content to mark the step complete

### Requirement: Content approval, compute authorization, and adoption are distinct
The system MUST store content approval, authorization to consume compute, and adoption of generated results as separate decisions.

#### Scenario: Prompt is approved without generation authorization
- **WHEN** the user approves a prompt or storyboard but has not authorized the displayed generation batch
- **THEN** the system records the content approval
- **AND** no image or video generation request is submitted

#### Scenario: Generation completes
- **WHEN** an authorized media job produces an output
- **THEN** the output enters awaiting-review state
- **AND** it is not marked adopted until the user explicitly selects it

### Requirement: Generation plans are reviewable before submission
Before requesting paid media generation, the workbench SHALL show the model, object and quantity, prompt, references, relevant capabilities, execution count, and known cost or an explicit unknown-cost label.

#### Scenario: User reviews a generation batch
- **WHEN** the user prepares image or video generation
- **THEN** the workbench presents the exact selected model and request parameters
- **AND** submission remains disabled until the user authorizes that batch

#### Scenario: Retry changes the approved scope
- **WHEN** a retry adds outputs, changes the model, prompt, references, duration, or resolution beyond the approved batch
- **THEN** the workbench requires new compute authorization

### Requirement: Upstream changes invalidate dependent work without deleting history
The system SHALL mark downstream outputs stale or pending review when an approved upstream script, storyboard, asset, or adopted media version changes, while preserving prior candidates and decisions.

#### Scenario: Approved script is revised
- **WHEN** the user saves a new version of an approved episode script
- **THEN** dependent directing, storyboard, image, and video records are marked for review according to recorded dependencies
- **AND** their historical files and adoption records remain accessible

### Requirement: Episode progress is independent
The system SHALL track detailed production and delivery state per episode and SHALL NOT equate completion of one episode with completion of the entire project.

#### Scenario: One episode reaches delivery
- **WHEN** all required outputs for an episode are adopted or explicitly skipped and its delivery manifest is created
- **THEN** that episode is marked complete
- **AND** remaining episodes retain their own current stages

### Requirement: Delivery claims reflect actual artifacts
The system SHALL distinguish generated clips, adopted clips, composed media, and exported delivery files and SHALL only label an output according to artifacts that actually exist and validate.

#### Scenario: Project has adopted clips but no composition
- **WHEN** adopted video clips exist but no composed film file has been produced
- **THEN** the workbench describes the deliverable as adopted clips and a manifest
- **AND** it does not claim that a completed film was exported
