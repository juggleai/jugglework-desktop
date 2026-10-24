## Context

JuggleWork already treats PPTX as an editable Office format. `OfficeEditor` hosts a sandboxed native slide page, `OfficeDocuments` owns model identity and saving, `slide_*` tools provide Agent edits, selection references constrain targeted edits, and artifact delivery publishes files only after successful save and inspection. The remaining gaps are product entry points: `OfficeDocuments.create` only creates DOCX, there is no guided presentation-generation flow, and the PPTX selection affordance still looks like a generic Office AI action.

The implementation spans React, the local JuggleWork Server, Electron, bundled resources, and the native Office wrapper. It must preserve local-workspace authorization, keep Office lifecycle tools hidden from the Agent, avoid touching unrelated uncommitted Review changes, and remain usable without installing packages at runtime.

## Goals / Non-Goals

**Goals:**

- Let a user create a blank `.pptx` through a host-owned action and immediately edit it in the existing Office editor.
- Let a user start a guided presentation-generation task from the active session, optionally using the active workspace file as source context.
- Generate a valid editable PPTX reproducibly, publish it through authoritative artifact delivery, and automatically open only the result of that explicit workflow.
- Present a recognizable Slides “Request edits / 请求修改” entry for selected PPTX content without weakening target binding or verification.
- Keep each feature covered by focused unit or integration tests.

**Non-Goals:**

- A new collaborative cloud Deck model, CRDT editing, comments, or multi-user presence.
- Replacing the native Office PPTX editor or implementing a React PPTX renderer.
- Importing `.potx`, `.key`, `.odp`, legacy `.ppt`, or macro-enabled presentation formats.
- Exposing `create_slide`, `open_file`, `save_file`, or other Office lifecycle tools to the Agent.
- Automatically opening arbitrary generated files or changing the default no-auto-open behavior for normal artifacts.

## Decisions

### Host creation is selected by a validated extension

`POST /workspace/:id/office/create` remains the only creation endpoint. `OfficeDocuments.create` maps `.docx` to `create_doc` and `.pptx` to `create_slide`, checks that the real engine tool exists, waits for a format-specific content query to prove readiness, saves the temporary model to the resolved workspace path, closes it, and opens the saved file through the normal document lifecycle.

This avoids a conflicting `kind` request field and keeps extension, output format, and file path consistent. CSV/XLSX creation remains unavailable.

### User-facing creation goes through Electron path resolution

The desktop bridge owns the native save dialog and workspace-relative path conversion. Both the file window and the session Files panel invoke a finite `docx | pptx` create action. The renderer does not recreate Windows drive, path traversal, or symlink boundary logic.

### Presentation generation is an ordinary structured session turn

The dialog creates a normal `ComposerDraft` containing the user-visible request, a bundled presentation skill reference, and an optional file part for the active workspace file. Submission reuses the existing composer/session path instead of calling OpenCode directly, preserving model selection, permissions, busy-state checks, attachment handling, analytics, and turn ownership.

### The generator is bundled and deterministic

A bundled presentation skill invokes a version-controlled Node generator through `jugglework_artifact_generate`. The generator writes a valid editable PPTX into `JUGGLEWORK_ARTIFACT_DIR`; it does not install dependencies, invoke a shell, call Office lifecycle tools, or register files by parsing stdout. A small in-repo OOXML generator is preferred for the initial constrained template set so installation remains self-contained.

The MVP supports a defined set of layouts and editable text/shape elements. More advanced charts, animations, and arbitrary template import remain outside this change.

### Explicit generation turns receive a stable identity

The presentation flow supplies a stable message/turn ID through the existing start submission. Artifact delivery already uses that identity as `TurnDelivery.turnId`. The UI observes the exact delivery and does not search for the latest `.pptx` or parse the assistant reply.

### Automatic opening is scoped to explicit presentation creation

Normal generated file auto-open remains disabled. A one-shot presentation coordinator may open the single PPTX in the exact successful turn using an explicit `presentation-creation` intent. It consumes `sessionId + turnId + artifactId` once. Failed, partial, missing, or ambiguous deliveries are not opened automatically.

### The PPTX edit entry changes presentation, not execution semantics

For `kind === "slide"`, the injected Office selection button uses a Presentation icon, Slides label, amber styling, and “Request edits / 请求修改” copy. The existing synchronous selection read, capture handshake, fixed reference, composer append/send, host-side range guard, write-back proof, save, and delivery code remain unchanged. Tests locate the action through a stable data attribute rather than localized button text.

## Risks / Trade-offs

- **Bundled OOXML generator initially supports a constrained layout set** → Keep the generator schema explicit, validate the resulting ZIP/package structure, and open generated fixtures through the real Office engine in optional native tests.
- **PPTX creation tool may differ across native engine versions** → Gate creation on the actual `tools/list` result and return a specific unavailable error.
- **Generating and opening a file may race with user navigation** → Bind to the exact turn, consume once, and do not infer from the newest artifact. If the exact turn is not uniquely successful, leave the file card for manual opening.
- **Shared API client file contains unrelated uncommitted Review work** → Apply a local Office-only patch and verify the focused diff; do not format or stage unrelated hunks.
- **Bilingual copy is longer inside the native page** → Use a compact two-part label and viewport-bound positioning; retain the generic entry for Word and Sheet.
- **A generic presentation prompt may produce unsupported script input** → Validate a strict JSON generation spec and enforce page/text/image limits before generating OOXML.

## Migration Plan

1. Ship the server creation support and desktop create action behind existing Office capability checks.
2. Ship the bundled skill/generator and guided flow together so no prompt references a missing generator.
3. Keep all existing Office and artifact records compatible; no data migration is required.
4. Roll back by removing the new UI entries and PPTX creation mapping. Existing generated or created PPTX files remain ordinary workspace files and continue to open through the existing editor.

## Open Questions

- Native Office verification depends on the matching packaged engine and remains an optional environment-gated test.
- Rich chart generation and binary template ingestion should be addressed by a later change after the basic editable PPTX workflow is stable.
