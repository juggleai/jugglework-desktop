## MODIFIED Requirements

### Requirement: Guided presentation requests create one structured task
The application SHALL collect purpose, audience, outline, slide count, visual template, optional current-file context, and output filename, and SHALL submit one normal session task. Unless the user explicitly asks to generate immediately, the task SHALL first present a concise slide-by-slide outline with each slide’s message and layout through the question tool and wait for confirmation before invoking generation in the same task turn.

#### Scenario: Normal request confirms the story first
- **WHEN** the user asks to create a presentation without saying to generate immediately
- **THEN** the agent proposes a slide-by-slide outline with one core message and one layout per slide through the question tool
- **AND** no PPTX is generated until the user confirms or edits the outline
- **AND** confirmation and generation remain in the original task turn so exact-turn delivery and automatic opening still apply

#### Scenario: Direct generation
- **WHEN** the user explicitly asks to generate directly
- **THEN** the agent may plan internally and invoke the generator without a separate confirmation turn

### Requirement: Bundled generation is editable, varied, and self-contained
The desktop package SHALL include a deterministic presentation generator and skill that run with the packaged Electron Node runtime and require no user-installed package. Version 2 specifications SHALL support the layouts `cover`, `agenda`, `section`, `bullets`, `cards`, `stats`, `comparison`, `process`, `table`, and `summary`. Version 1 specifications SHALL remain supported.

#### Scenario: Installed application works without development tools
- **WHEN** a user installs and launches the desktop application on a supported platform
- **THEN** presentation generation uses the application executable as its Node runtime and the generator and skill under the same installation's Resources directory
- **AND** generation works with no system Node, npm, Python, LibreOffice, or PATH lookup

#### Scenario: Packaging omits or breaks presentation resources
- **WHEN** a desktop package lacks the generator or `SKILL.md`, Electron Node mode cannot execute the generator, or the package-owned generator does not create exactly one valid OOXML output
- **THEN** the after-pack or final package verification fails and the package cannot be released

#### Scenario: Visually structured deck
- **WHEN** a valid version 2 specification uses multiple layouts
- **THEN** the generator creates exactly one editable PPTX
- **AND** the slides use layout-specific editable text, shapes, cell grids, and visual hierarchy rather than one repeated bullet layout
- **AND** the `table` layout remains a visual grid of independently editable text cells rather than promising native PowerPoint table semantics

#### Scenario: Chinese presentation
- **WHEN** slide content contains Chinese
- **THEN** text runs declare `zh-CN` and an East Asian theme font
- **AND** the presentation remains editable in PowerPoint, WPS, and the desktop Office editor

#### Scenario: Content cannot fit
- **WHEN** any visible version 2 text field cannot fit its actual text box at its minimum supported font size
- **THEN** generation fails before writing a PPTX
- **AND** the error identifies the slide and field that must be shortened

#### Scenario: Unsafe text or output filename
- **WHEN** a specification contains invalid XML Unicode or a filename that is unsafe on Windows or macOS
- **THEN** validation fails before writing any output or temporary residue

#### Scenario: Deterministic atomic publication
- **WHEN** the same valid content is generated repeatedly
- **THEN** the PPTX package bytes are deterministic
- **AND** the final visible output appears only after the complete package has been written and validated

#### Scenario: Speaker notes
- **WHEN** a slide includes notes
- **THEN** the PPTX stores them as editable speaker notes associated with that slide
- **AND** the notes slide and notes master contain matching body placeholders with explicit geometry

#### Scenario: Existing version 1 request
- **WHEN** an existing client submits a valid version 1 title/subtitle/bullets specification
- **THEN** the generator continues to create a valid editable PPTX
