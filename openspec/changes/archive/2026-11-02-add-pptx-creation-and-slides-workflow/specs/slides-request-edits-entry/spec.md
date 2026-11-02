## ADDED Requirements

### Requirement: Slides-specific request edits affordance
The native PPTX page SHALL display a recognizable Slides “Request edits / 请求修改” affordance for a supported selected shape or text range while Word and Sheet retain their existing generic Office selection entry.

#### Scenario: Show the Slides entry
- **WHEN** a user selects a supported PPTX text shape or non-empty text range
- **THEN** the page shows a compact Slides-labeled request-edits control with presentation iconography and a stable action identifier

#### Scenario: Hide for unsupported selection
- **WHEN** the selection is a collapsed text caret, unsupported grouped object, notes content, or another unresolvable target
- **THEN** the page does not present the action as executable

### Requirement: Preserve verified selection editing
The Slides-specific affordance SHALL use the existing fixed selection reference, host-side tool restriction, write-back verification, save, and artifact delivery path without directly invoking slide tools from the page.

#### Scenario: Submit a selected-shape edit
- **WHEN** the user selects a supported shape, requests a change, and sends it
- **THEN** the request is bound to the captured document generation and selection reference, and any write is constrained and read back before it can be saved or delivered

#### Scenario: Reject a stale selection
- **WHEN** the document generation or proven selected content changes before execution
- **THEN** the host rejects the stale reference instead of applying the request to the current visual selection or a similar shape
