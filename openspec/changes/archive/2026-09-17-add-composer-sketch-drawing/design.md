## Context

See `proposal.md` for motivation and `specs/composer-sketch-drawing/spec.md` for observable behavior. The React composer currently owns the unified `+` menu and performs image compression and size validation before calling `onAttachFiles`. `SessionSurface` converts accepted browser `File` objects into session-scoped `ComposerAttachment` records, and the send, queue, and steer paths already materialize those attachments into the workspace and model request.

The add menu's first file row and following agent rows are rendered with positional keyboard indexes rather than from one fully data-driven list. The composer component is already large, so embedding a canvas implementation directly in it would further couple menu, prompt, and drawing behavior. No direct drawing library is currently declared by the app package; the `roughjs` lockfile entry is transitive and is not an available sketch editor abstraction.

## Goals / Non-Goals

**Goals:**

- Keep the sketch feature renderer-local until the user completes the drawing.
- Produce a normal image `File` that passes through the exact existing attachment validation and submission path.
- Isolate scene editing, history, input handling, and export from the composer shell.
- Preserve reliable Chinese and multilingual text input, keyboard accessibility, theme behavior, and high-density display output.
- Keep memory and export dimensions bounded.

**Non-Goals:**

- Introducing a new message part, server route, database record, workspace permission, or attachment protocol.
- Persisting an editable sketch source document, reopening an attached sketch for editing, or synchronizing unfinished sketches across restarts.
- Multi-page canvases, collaborative drawing, imported background-image annotation, SVG delivery, or automatic message submission.
- Pixel-perfect partial erasing in the first release; the eraser removes complete hit objects or freehand strokes.

## Decisions

### 1. Treat a completed sketch as an ordinary image attachment

The sketch dialog will return a browser `File` with an initial `image/png` representation and a safe timestamped filename. The composer will pass it through its existing `addAttachments` function, which remains authoritative for image normalization, the 8 MB limit, and the final `onAttachFiles` call. The editor will render an opaque white background before export so any later PNG-to-JPEG normalization cannot turn transparent space black.

This keeps transcript rendering, preview URLs, queue ownership, steering, workspace inbox upload, cleanup, and model file-part behavior unchanged. It also guarantees completion adds an attachment but does not send a message.

**Alternative considered:** add a `sketch` message-part type and teach every send path to handle it. Rejected because downstream behavior only needs image bytes and a new type would duplicate attachment lifecycle logic.

**Alternative considered:** save a PNG directly into the workspace before the user sends. Rejected because it creates files for abandoned drafts and bypasses existing attachment validation and remote-workspace materialization.

### 2. Keep the editor behind a small composer integration boundary

The composer owns `sketchOpen` because it already owns the add menu and private `addAttachments` validation. A new `composer/sketch/` module will expose a `SketchDialog` with `open`, `onOpenChange`, and `onComplete(file)` inputs. Selecting the menu entry closes the menu and opens the dialog; successful completion calls `addAttachments([file])`.

The add section will be rendered from one ordered entry model containing file, sketch, and agents. Keyboard indexing and refs will be derived from that model instead of manually offsetting every row. This reduces the chance that inserting the sketch row makes Enter or Tab activate the wrong item.

**Alternative considered:** host the dialog in `SessionSurface` and add a new callback through the composer props. Rejected because that path would either duplicate or bypass the composer's compression and maximum-size checks.

### 3. Use a retained scene model with a bounded command history

The editor will store drawable elements as serializable scene records rather than storing a bitmap after every pointer event. The initial element union covers freehand strokes, text, lines, arrows, rectangles, and ellipses. Each committed mutation records a bounded history snapshot or command; transient pointer movement does not create history entries. Undo followed by a new edit clears redo.

Selection is single-element in the first release. Supported elements can be moved and resized. The eraser performs hit testing and removes complete objects or strokes so undo/redo remains deterministic and scene ordering does not create destructive-compositing surprises.

The history limit will be a named constant, initially 80 committed states, and history state will be released when the dialog is completed or discarded.

**Alternative considered:** keep full-canvas PNG snapshots for history. Rejected because large high-density canvases make every edit expensive in memory and make individual text or shape transformations impossible.

### 4. Use a focused canvas engine behind an internal adapter

The preferred implementation is Konva with its React integration because it provides retained objects, hit testing, pointer events, selection transforms, and deterministic canvas export while allowing JuggleWork to own all visual controls. Before adding the dependency, implementation must verify the selected versions against React 19, Electron, Vite, type checking, and production packaging. If the React binding is incompatible, a small imperative Konva adapter behind the same sketch component API is the fallback; the behavior contract does not change.

Excalidraw and tldraw are not selected because their editor chrome, document model, persistence expectations, and bundle surface are much broader than this feature. A raw Canvas 2D implementation is not selected because reliable text, selection transforms, hit testing, and high-density resizing would recreate substantial scene-graph functionality.

### 5. Use a DOM text editor overlay for text entry

Activating the text tool creates a positioned HTML text input or textarea over the canvas. Composition events remain in the DOM until the user commits or cancels, after which the final text becomes a canvas element. This is required for Chinese and other input method editors; routing composition directly through canvas key handlers is unreliable.

The overlay follows canvas scaling and is removed when the dialog closes, the tool changes, or the text is committed. Empty committed text creates no scene element or history state.

### 6. Separate logical scene coordinates from viewport and export pixels

Elements are stored in logical canvas coordinates. The visible stage fits the available dialog area and recalculates its presentation scale on resize without changing the scene. Export creates an offscreen white surface and renders the same logical scene within the existing 2048-pixel image policy, with sufficient pixel density for text and lines.

This avoids blurry Retina output while preventing a maximized or scaled desktop window from creating an unbounded image. The resulting file still enters the existing compressor, which may normalize large PNGs before attachment.

### 7. Build on the existing dialog and design-system semantics

The editor uses the app's Base UI dialog primitives for portal placement, focus containment, Escape handling, and backdrop behavior. On regular desktop windows it is a centered, bounded workspace rather than a near-full-window surface, so the current task remains visible around it. Its width and height shrink with the available viewport. At the compact shell breakpoint it becomes a bottom-aligned sheet that preserves a visible band of the main application above the editor. The desktop shell also defines a 480 by 600 logical-pixel minimum window size so this compact composition cannot collapse indefinitely. The white drawing surface is invariant across themes; surrounding controls use existing theme tokens, visible focus rings, tooltips, and active/disabled states.

Pointer targets will be at least 36 CSS pixels with a 44-pixel effective interaction area where space permits. Every icon-only button receives an accessible name. Undo and redo support platform-standard shortcuts, and the dialog does not bind text-tool composition keystrokes as global shortcuts.

### 8. Confirm destructive close and keep export failure recoverable

Scene content determines whether the editor is empty or dirty. Closing an empty scene exits immediately. Closing a dirty scene opens a confirmation dialog above the editor; continuing restores focus to the sketch, while discarding releases editor state and attaches nothing.

Completion is disabled for an empty scene. Export is asynchronous and has a visible busy state that prevents duplicate completion. If export or attachment preprocessing fails, the dialog stays open with the unchanged scene and an actionable error rather than silently closing.

## Risks / Trade-offs

- **[Canvas dependency conflicts with React 19 or Electron packaging]** → Verify a minimal production build and package before integrating tools; keep the sketch surface behind an adapter so imperative Konva remains a fallback.
- **[Large scenes consume excessive memory]** → Store vector-like records, commit history only at operation boundaries, cap history at 80 states, bound export dimensions, and clear dialog state on terminal close.
- **[Text input loses IME composition]** → Use a positioned DOM editor and add composition-event coverage for Chinese input.
- **[Responsive resizing shifts content or export bounds]** → Preserve logical coordinates and test resize plus high-DPI export independently from CSS layout.
- **[A compact app window lets editor controls overlap]** → Bound the desktop window, reduce compact control footprints, allow the color row to scroll, and keep the editor bottom-aligned below a visible application header.
- **[Menu insertion breaks keyboard activation]** → Refactor the add section into one ordered model and test pointer plus arrow/Enter/Tab selection.
- **[Export preprocessing changes PNG to JPEG]** → Render an opaque white background and treat the observable contract as an image attachment, not a guaranteed final encoding.
- **[Object-level erasing is less granular than a pixel eraser]** → Make the behavior explicit in the first release; a future geometric stroke-splitting implementation can preserve the same tool surface.

## Migration Plan

1. Add the canvas dependency only after a React 19/Electron/Vite build check succeeds.
2. Introduce the isolated scene model, history, export utility, and focused tests without exposing the menu entry.
3. Add the sketch dialog and interactions, then connect completion to the existing attachment ingestion callback.
4. Add the menu entry, data-driven keyboard navigation, localized strings, and integration tests.
5. Run type checking, strict i18n coverage, focused unit/component tests, and macOS/Windows manual pointer and high-DPI checks.

Rollback removes the menu entry and sketch module. Existing completed sketches remain ordinary image attachments and require no data migration or cleanup.
