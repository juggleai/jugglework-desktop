## ADDED Requirements

### Requirement: Guided presentation request
The session surface SHALL provide a guided presentation creation flow that collects purpose, audience, outline, slide count, visual template, output filename, and an optional active workspace file, then submits the request through the existing structured session composer path.

#### Scenario: Create from current session
- **WHEN** a user completes the presentation dialog in an idle session without selecting a source file
- **THEN** the application submits one ordinary user turn that uses the current session history and identifies the bundled presentation generation capability

#### Scenario: Include the active file
- **WHEN** a supported active workspace file exists and the user includes it
- **THEN** the submitted draft contains a structured file part for the exact active path instead of only mentioning its name in plain text

#### Scenario: Cancel the dialog
- **WHEN** the user dismisses the presentation dialog before submission
- **THEN** no Agent turn starts, no composer draft is destroyed, and no output file is created

### Requirement: Reproducible editable PPTX generation
The presentation capability SHALL create a valid editable `.pptx` with a bundled version-controlled generator executed through `jugglework_artifact_generate`, without runtime package installation or direct Office lifecycle calls.

#### Scenario: Successful generation
- **WHEN** the Agent supplies a valid bounded slide specification to the bundled generator
- **THEN** the generator writes a valid PPTX into the assigned artifact directory and artifact delivery associates it with the originating user turn

#### Scenario: Failed generation
- **WHEN** the generator exits unsuccessfully or produces an invalid presentation package
- **THEN** artifact delivery does not publish the residue as a completed presentation

### Requirement: Scoped automatic opening
The application SHALL automatically open a generated PPTX only when it belongs to the exact explicit presentation creation turn and that turn completes successfully with one unambiguous PPTX artifact.

#### Scenario: Open the exact generated presentation
- **WHEN** the exact presentation turn changes to `ready` with one PPTX artifact
- **THEN** the application opens that artifact once through `FilesPanel -> FileViewer -> OfficeEditor`

#### Scenario: Do not infer another result
- **WHEN** another turn produces a PPTX, the target turn is partial or failed, or the target turn contains zero or multiple PPTX files
- **THEN** the application does not guess a file to open automatically

#### Scenario: Preserve normal artifact behavior
- **WHEN** a file is generated outside the explicit presentation creation flow
- **THEN** the existing no-auto-open behavior remains unchanged
