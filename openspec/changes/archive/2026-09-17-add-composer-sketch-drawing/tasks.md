## 1. Canvas Foundation

- [x] 1.1 Verify Konva and its React integration against React 19, Electron, Vite, type checking, and production bundling; add the smallest compatible dependency set or use the documented imperative adapter fallback.
- [x] 1.2 Add the isolated `composer/sketch` module with serializable element types, tool state, selection state, logical canvas coordinates, and named resource limits.
- [x] 1.3 Implement bounded undo and redo history with commit-boundary snapshots, redo-branch invalidation, and state cleanup on terminal close.
- [x] 1.4 Add focused unit tests for element creation, empty/dirty detection, history bounds, undo/redo branching, and immutable scene updates.

## 2. Sketch Editing and Export

- [x] 2.1 Implement responsive canvas rendering and pointer handling for freehand strokes, straight lines, arrows, rectangles, and ellipses using the selected color and stroke width.
- [x] 2.2 Implement single-element selection, move and resize transforms, deterministic hit testing, and reversible object/stroke erasing.
- [x] 2.3 Implement a positioned DOM text editor with commit/cancel behavior and reliable composition-event handling for Chinese and other input methods.
- [x] 2.4 Implement opaque-white image export with bounded output dimensions, a safe timestamped filename, asynchronous busy/error states, and unchanged scene recovery after export failure.
- [x] 2.5 Add focused tests for drawing tools, transform commits, object erasing, multilingual text commit, white-background export, output bounds, and export failure.

## 3. Full-Window Sketch Dialog

- [x] 3.1 Build the bounded responsive dialog with a white drawing surface, close control, centered tool palette, undo/redo controls, stroke-width control, color palette, and completion action.
- [x] 3.2 Apply light/dark theme tokens to editor chrome while keeping the canvas white, and provide active, hover, focus, disabled, and busy states for every control.
- [x] 3.3 Add accessible names, focus containment, deterministic tab order, tooltips, platform-standard undo/redo shortcuts, and pointer-friendly target sizes.
- [x] 3.4 Implement empty-sketch completion blocking plus nested discard confirmation for close and Escape, preserving the scene when the user continues editing.
- [x] 3.5 Add component tests for dialog focus, keyboard shortcuts, theme states, empty completion, dirty discard, continue editing, duplicate-completion prevention, and error recovery.
- [x] 3.6 Bound the regular-window editor size, add a compact bottom-aligned layout with scaled controls, and prevent the desktop shell from resizing below its supported compact dimensions.

## 4. Composer and Attachment Integration

- [x] 4.1 Extend the composer add-entry model with a sketch entry directly below file and refactor add-section rendering and keyboard indexes to derive from one visible ordered list.
- [x] 4.2 Open the sketch dialog from pointer or keyboard activation, close the add menu, and mirror the existing attachment-disabled state and reason.
- [x] 4.3 Route a completed sketch `File` through the existing `addAttachments` function so image compression, size limits, preview creation, removal, cleanup, workspace materialization, sending, queueing, and steering remain unchanged.
- [x] 4.4 Add all required locale keys for the sketch menu, tools, actions, discard confirmation, and errors across every supported locale.
- [x] 4.5 Add composer integration tests for menu order, arrow/Enter/Tab activation, disabled behavior, attachment creation without automatic submission, draft-text preservation, removal, queue, and steer flows.

## 5. Validation and Cross-Platform Acceptance

- [x] 5.1 Run focused sketch and composer test suites, app type checking, strict i18n coverage, and a production renderer build. Focused tests, type checking, and production build pass; strict i18n was executed and remains blocked by repository-wide legacy locale gaps, while all 26 keys added by this change are present in every supported locale.
- [x] 5.2 Verify the packaged dependency graph and confirm the sketch feature does not add a second general-purpose whiteboard editor or expose new renderer-to-main-process privileges.
- [x] 5.3 Manually exercise mouse, trackpad, keyboard, Chinese IME, resizing, high-DPI export, light/dark themes, and attachment submission on macOS.
- [x] 5.4 Manually exercise pointer, keyboard, display scaling, light/dark themes, and attachment submission on Windows.
