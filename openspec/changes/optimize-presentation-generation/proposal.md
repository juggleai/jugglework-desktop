# Change: Improve presentation planning and visual layout generation

## Why
The bundled presentation generator currently renders every slide as the same title-and-bullets page. It creates a valid editable PPTX, but it cannot express a coherent story through cover, section, comparison, process, metric, table, and conclusion layouts. Fixed text boxes also allow long Chinese content to overflow.

## What Changes
- Add a version 2 presentation specification with ten deterministic editable layouts: cover, agenda, section, bullets, cards, stats, comparison, process, table, and summary.
- Keep version 1 specifications working without changes.
- Give each bundled theme a complete color palette plus explicit Chinese and Latin fonts.
- Validate layout-specific content before writing, select a safe font size from weighted Chinese/Latin text length, and reject content that cannot fit at 14pt with a field-specific error.
- Support editable speaker notes.
- Change the presentation-generation prompt and bundled skill so the model plans a coherent story, chooses varied layouts, and normally confirms the outline through the question tool in the same task turn before generation. This preserves the existing exact-turn automatic-open contract. “Directly generate” requests may skip confirmation.
- Continue to use the packaged Electron Node runtime, the trusted generator alias, one controlled generation call, one delivered PPTX, and the existing automatic-open coordinator.

## Impact
- Affected capability: `session-presentation-generation`
- Affected files: bundled presentation skill/generator, presentation request prompt, home presentation starter prompt, focused desktop/app/server tests
- No new runtime dependency and no package-size increase beyond source changes
