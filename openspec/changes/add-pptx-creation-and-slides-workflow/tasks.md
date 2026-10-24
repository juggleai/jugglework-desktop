## 1. Host PPTX Creation

- [x] 1.1 Extend `OfficeDocuments.create` to create DOCX or PPTX with real tool capability and format-specific readiness checks
- [x] 1.2 Add focused Server tests for PPTX creation, unavailable tools, existing targets, failure cleanup, and unsupported formats
- [x] 1.3 Add typed desktop creation actions for Word and PowerPoint using host-owned native path resolution
- [x] 1.4 Add Word and PowerPoint creation controls to the file window and session Files surface, opening successful results in the existing editor
- [x] 1.5 Add focused bridge and UI tests for creation, cancellation, path rejection, and opening the created PPTX

## 2. Presentation Generation Workflow

- [x] 2.1 Add versioned presentation templates, request validation, prompt construction, and an optional structured current-file source
- [x] 2.2 Add a guided presentation creation dialog and route its submission through the existing session composer pipeline with a stable turn ID
- [x] 2.3 Add a bundled presentation skill and self-contained generator that writes a validated editable PPTX through `jugglework_artifact_generate`
- [x] 2.4 Add exact-turn delivery observation and one-shot automatic opening for the single successful PPTX while preserving normal artifact no-auto-open behavior
- [x] 2.5 Add prompt, dialog, generator, delivery-coordinator, and open-target tests for success, failure, ambiguity, and deduplication

## 3. Slides Request Edits Entry

- [x] 3.1 Add a Slides-specific Presentation icon and `Slides · Request edits / 请求修改` affordance with a stable action identifier to the native PPTX selection UI
- [x] 3.2 Update isolated-page verification to assert the Slides entry while retaining capture, submit, fixed-reference, save, and delivery behavior
- [x] 3.3 Update Office selection design documentation to describe the Slides-specific product entry and unchanged safety boundary

## 4. Verification

- [ ] 4.1 Run focused Server, App, Electron, generator, artifact-delivery, and Office-selection tests
- [ ] 4.2 Run relevant type checks and record unrelated baseline failures without modifying unrelated Review work
- [ ] 4.3 Inspect the final diff to confirm only intended Slides/Office files and the new OpenSpec change are included
