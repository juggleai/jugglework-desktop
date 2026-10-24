---
name: presentation-generator
description: Generate an editable PowerPoint when the user asks to "create a presentation", "make slides", or "build a deck".
---

# Presentation Generator

Create exactly one editable `.pptx` with the bundled deterministic generator. Do not install packages, invoke a shell, call Office lifecycle tools, or call `jugglework_artifact_register`.

## Input schema

Convert the user's request and any attached source file into one compact JSON object:

```json
{
  "version": 1,
  "template": "executive",
  "outputName": "quarterly-update.pptx",
  "slides": [
    {
      "title": "Quarterly update",
      "subtitle": "Leadership review",
      "bullets": ["First key point", "Second key point"]
    }
  ]
}
```

- `version` must be `1`.
- `template` must be `executive`, `editorial`, or `minimal` (all template version 1).
- `outputName` must be a filename ending in `.pptx`, never a path.
- `slides` must contain 1-30 entries.
- Every slide needs a non-empty title of at most 200 characters.
- `subtitle` is optional and at most 500 characters.
- `bullets` is optional, contains at most 12 strings, and each string is at most 500 characters.
- Keep all user-facing text in editable text boxes. Do not encode text into images.

## Generate

Call `jugglework_artifact_generate` exactly once. Use the absolute `generate-presentation.mjs` path next to this `SKILL.md`, not a copied script and not a relative path.

```json
{
  "program": "node",
  "args": ["<absolute-skill-directory>/generate-presentation.mjs", "--spec-json", "<compact-json>", "--output", "<outputName>"],
  "outputs": ["<outputName>"],
  "timeoutMs": 60000
}
```

The host supplies `JUGGLEWORK_ARTIFACT_DIR` and collects the successful output. Do not make a second generation call, even if the first call fails. Report the failure instead. Return only the single delivered PPTX as the presentation result.
