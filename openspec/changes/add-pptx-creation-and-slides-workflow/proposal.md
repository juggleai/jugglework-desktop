## Why

JuggleWork can open, edit, and safely save existing PPTX files, but users cannot create a blank presentation, launch a guided presentation-generation task, or clearly discover the existing selection-bound AI editing workflow from the Slides surface. Completing those three entry points turns the existing Office engine, artifact delivery, and selection-proof infrastructure into a coherent PPTX-first product workflow without exposing document lifecycle tools to the Agent.

## What Changes

- Extend the host-owned Office create operation to create either a blank DOCX or a blank PPTX according to the requested workspace-relative extension, while retaining path, permission, ownership, save, and lifecycle checks.
- Add Word and PowerPoint creation actions to the Files experience and open a successfully created file through the existing `FilesPanel -> FileViewer -> OfficeEditor` path.
- Add a guided “Create presentation” flow for an existing session. It collects purpose, audience, outline, slide count, visual template, output name, and an optional currently open source file, then submits one structured Agent request through the existing session/composer pipeline.
- Add a bundled, reproducible presentation generator and skill that produce a valid editable PPTX through `jugglework_artifact_generate`, so delivery remains tied to the real user turn and failed residue is not published.
- Bind an explicit presentation-generation request to a stable turn ID, observe the authoritative artifact delivery for that turn, and automatically open the single delivered PPTX only for that explicit workflow.
- Give PPTX selections a visible Slides-specific “Request edits / 请求修改” entry while preserving the existing frozen selection reference, host-side range validation, write-back verification, save, and delivery behavior.

## Capabilities

### New Capabilities
- `host-pptx-creation`: Host-owned creation of blank PPTX files and user-facing Office creation actions.
- `session-presentation-generation`: Guided creation of an editable PPTX from the current session and optional current file, with template selection, artifact delivery, and scoped automatic opening.
- `slides-request-edits-entry`: A Slides-specific product entry for the existing selection-bound Office AI editing workflow.

### Modified Capabilities

None.

## Impact

- Office document lifecycle and route implementation under `apps/server/src/office`.
- Desktop file-window creation IPC and shared file-window contracts.
- Session Files UI, composer submission metadata, artifact-delivery query consumption, and PPTX opening behavior in `apps/app`.
- A bundled presentation skill/generator resource distributed with the desktop app.
- Office page selection UI and its isolated-page verification script.
- Targeted Server, App, Electron, artifact delivery, and selection-editing tests.
- Existing uncommitted PR Review work is unrelated and must not be modified or reformatted.
