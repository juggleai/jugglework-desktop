## Purpose

Defines how a user creates a visual sketch inside the active conversation, edits it safely, and adds the completed result to the composer through the existing image-attachment experience.

## ADDED Requirements

### Requirement: Expose sketch drawing from the composer add menu
The system SHALL present a `绘制草图` action directly below the existing file action in the conversation composer's add menu. The sketch action SHALL follow the same attachment-availability policy as image attachments.

#### Scenario: Open sketch editor
- **WHEN** a user opens the composer add menu and activates `绘制草图`
- **THEN** the add menu closes and a sketch editor opens for the active conversation

#### Scenario: Attachments are unavailable
- **WHEN** the current conversation cannot accept image attachments
- **THEN** the sketch action is disabled and exposes the same actionable unavailability reason as the file action

#### Scenario: Navigate the add menu with a keyboard
- **WHEN** a user navigates the add menu with arrow keys and activates the sketch action with Enter or Tab
- **THEN** focus order and selection correspond to the visible menu order without activating an adjacent item

### Requirement: Provide an accessible focused sketch workspace
The system SHALL present the sketch editor as a focus-contained, viewport-responsive dialog with a white drawing surface and controls for close, tool selection, stroke width, color, undo, redo, and completion. On a regular desktop window, the dialog SHALL remain bounded and centered with the active task visible around it. On the supported compact window size, it SHALL shrink into a bottom-aligned workspace that leaves part of the main application visible above it. The desktop application SHALL prevent resizing below the compact layout's supported minimum dimensions. The editor SHALL support mouse, trackpad, and pointer input on supported desktop platforms.

#### Scenario: Open editor in a regular desktop window
- **WHEN** the sketch editor opens in a regular-sized application window
- **THEN** it uses a bounded centered size and leaves the surrounding task interface visible

#### Scenario: Resize to the compact application layout
- **WHEN** the user shrinks the application window to its supported minimum dimensions
- **THEN** the sketch editor shrinks with it, aligns to the bottom, preserves usable controls, and leaves the upper portion of the application visible

#### Scenario: Attempt to resize below the compact layout
- **WHEN** the user continues dragging an application window edge below the supported compact dimensions
- **THEN** the native window stops resizing before the shell or sketch workspace becomes unusable

#### Scenario: Open editor in a light theme
- **WHEN** the current app theme is light and the sketch editor opens
- **THEN** its dialog controls, backdrop, active tool state, and white drawing surface are visually distinguishable

#### Scenario: Open editor in a dark theme
- **WHEN** the current app theme is dark and the sketch editor opens
- **THEN** the surrounding dialog controls adapt to the dark theme while the exported drawing surface remains white

#### Scenario: Use the editor without a pointer
- **WHEN** a keyboard user tabs through the editor or invokes supported shortcuts
- **THEN** every action has an accessible name, visible focus state, and deterministic focus order

### Requirement: Create and manipulate sketch content
The system SHALL let the user create freehand strokes, text, straight lines, arrows, rectangles, and ellipses; select and transform drawable elements; remove complete strokes or elements with an eraser; and choose stroke color and width.

#### Scenario: Draw a freehand stroke
- **WHEN** the pen tool is active and the user drags across the drawing surface
- **THEN** the editor creates a stroke using the selected color and width

#### Scenario: Enter multilingual text
- **WHEN** the text tool is active and the user enters text using an input method editor
- **THEN** the committed text is rendered at the chosen location without losing composed characters

#### Scenario: Add a basic shape
- **WHEN** the user selects a supported shape and drags on the drawing surface
- **THEN** the editor creates that shape using the selected visual properties

#### Scenario: Select and transform an element
- **WHEN** the selection tool is active and the user selects an existing drawable element
- **THEN** the editor exposes its selection state and permits supported move or resize operations

#### Scenario: Erase content
- **WHEN** the eraser tool passes over a drawable stroke or element
- **THEN** the complete hit stroke or element is removed as one reversible edit

### Requirement: Preserve reversible editing history
The system SHALL maintain bounded undo and redo history for content-changing sketch operations and SHALL expose disabled states when either operation is unavailable.

#### Scenario: Undo an edit
- **WHEN** at least one reversible edit exists and the user activates undo
- **THEN** the most recent edit is reverted and becomes available for redo

#### Scenario: Redo an edit
- **WHEN** an edit was undone and no conflicting edit has occurred
- **THEN** activating redo reapplies that edit

#### Scenario: Branch after undo
- **WHEN** the user undoes an edit and then makes a new content-changing edit
- **THEN** the previous redo branch is discarded

### Requirement: Protect unfinished sketch content
The system SHALL distinguish an empty sketch from a dirty sketch, SHALL prevent completion of an empty sketch, and SHALL require confirmation before discarding dirty content.

#### Scenario: Complete an empty sketch
- **WHEN** the drawing contains no drawable content
- **THEN** the completion action is disabled

#### Scenario: Close an empty sketch
- **WHEN** the drawing contains no drawable content and the user closes the editor
- **THEN** the editor closes without a discard prompt and changes no composer content

#### Scenario: Close a dirty sketch
- **WHEN** the drawing contains drawable content and the user closes the editor or presses Escape
- **THEN** the system asks the user to continue editing or discard the sketch

#### Scenario: Keep editing after discard prompt
- **WHEN** the discard prompt is visible and the user chooses to continue editing
- **THEN** the editor returns to the unchanged sketch

### Requirement: Attach a completed sketch through the existing image flow
The system SHALL render a completed sketch onto an opaque white background, produce a valid image file, and submit that file to the existing composer attachment pipeline. Completing a sketch MUST NOT automatically send, queue, or steer a message.

#### Scenario: Complete a non-empty sketch
- **WHEN** the drawing contains drawable content and the user activates completion
- **THEN** the editor closes and the composer displays one removable image attachment representing the rendered sketch

#### Scenario: Continue composing after completion
- **WHEN** a completed sketch has been attached
- **THEN** existing draft text remains unchanged and the user can add text or more attachments before submitting

#### Scenario: Send a sketch normally
- **WHEN** a user submits a message containing a completed sketch attachment
- **THEN** the sketch follows the same validation, preview, workspace materialization, and model file-part behavior as an attached image

#### Scenario: Queue or steer with a sketch
- **WHEN** the active run causes a draft containing a sketch to be queued or steered
- **THEN** the sketch remains associated with that draft and follows the existing attachment lifecycle for the selected submission action

#### Scenario: Sketch export fails
- **WHEN** the drawing cannot be rendered into an acceptable image file
- **THEN** the editor remains open, preserves the sketch, and displays an actionable non-secret error

### Requirement: Limit sketch resource usage
The system SHALL bound editing history and exported image dimensions so extended drawing does not cause unbounded renderer memory growth or bypass existing attachment limits.

#### Scenario: History reaches its limit
- **WHEN** new edits exceed the configured history capacity
- **THEN** the oldest reversible states are discarded while current content remains intact

#### Scenario: Large display or high pixel density
- **WHEN** the editor runs on a large or high-density display
- **THEN** the exported image preserves legible content within the existing image-dimension and attachment-size policies
