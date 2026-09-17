## Why

Users currently need to leave JuggleWork or prepare an external image when a task is easier to explain visually. An integrated sketch editor lets them draw annotations, layouts, and simple diagrams without leaving the active conversation, while reusing the existing image-attachment workflow for delivery to the model.

## What Changes

- Add a `绘制草图` entry directly below `文件` in the conversation composer's `+` menu.
- Open an accessible, viewport-responsive sketch editor with selection, freehand drawing, text, basic shapes, erasing, stroke width, colors, undo, and redo.
- Export a completed non-empty sketch as a white-background PNG and add it to the current composer as an ordinary image attachment without sending it automatically.
- Reuse the existing image validation, compression, preview, queue, steer, upload, and message-send paths instead of introducing a new message-part or server API.
- Protect unfinished work with explicit discard confirmation and provide keyboard and pointer interactions suitable for macOS and Windows.

## Capabilities

### New Capabilities

- `composer-sketch-drawing`: Create, edit, discard, export, and attach an in-conversation sketch through the existing composer attachment flow.

### Modified Capabilities

None.

## Impact

- Conversation composer `+` menu structure, keyboard navigation, and localized labels.
- New renderer-side sketch dialog, canvas model, history, toolbar, and PNG export utilities.
- Existing `ComposerAttachment` ingestion and image compression path, without changing its public data shape.
- A new focused canvas dependency may be added after React 19 and Electron compatibility is verified.
- Component, reducer/model, attachment-integration, accessibility, theme, and cross-platform pointer tests.
- No server endpoint, database schema, workspace file policy, or migration change.
