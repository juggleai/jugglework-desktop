---
name: presentation-generator
description: Plan and generate one polished, logically structured, editable PowerPoint. Use for new deck creation; use Office slide tools for targeted edits to an already open deck.
---

# Presentation Generator

Create exactly one editable `.pptx` with 北数Work's bundled deterministic generator. Do not install packages, invoke a shell, call Office lifecycle tools, or call `jugglework_artifact_register`.

## Plan the story first

Unless the user explicitly says to generate directly, first build a compact slide-by-slide outline, then use the `question` tool in the same task turn to show that outline and ask whether to generate or revise it. For every slide show its core message (one message per slide) and intended layout. Lead with the conclusion or decision, organize supporting evidence into sections, and finish with implications or next steps. Do not invoke generation until the question is answered with confirmation.

When the user confirms through that interaction, continue the same turn, produce the v2 JSON, and call the generator. Keeping confirmation in the same turn preserves 北数Work's exact delivery identity and automatic opening. If the user explicitly asks to generate directly, skip the question and generate immediately.

## Design rules

- Use `cover` once at the start and `summary` once at the end when the deck is long enough.
- Vary layouts; do not use the same content layout on more than two consecutive slides.
- Use `section` only for meaningful transitions, not as filler.
- Use `stats` for a few important numbers, `comparison` for alternatives or before/after, `process` for ordered stages, and `table` only when exact values matter.
- Use message-led titles (for example, “续费推动增长质量改善”), not generic labels (“经营分析”).
- Keep content concise. If validation says a field does not fit, report the field and ask for shorter content; do not create a second output file.
- Write the outline, question, slide text, notes, and final response in the user's language unless they explicitly request another language.
- Every user-facing element remains editable. Never encode text into images.
- Do not invent facts. Distinguish assumptions or recommendations from source facts.

## Version 2 schema

```json
{
  "version": 2,
  "template": "executive",
  "outputName": "quarterly-update.pptx",
  "slides": []
}
```

- `template`: `executive`, `editorial`, or `minimal`.
- `outputName`: one cross-platform-safe filename ending in `.pptx`, never a path. Do not use `<>:"/\\|?*`, trailing dots/spaces, `.`/`..`, or Windows device names such as `CON`, `NUL`, `COM1`, or `LPT1`.
- `slides`: 1-30 entries.
- Every slide has `layout`, `title`, and optional `notes` (speaker notes, max 4000 characters).

Choose exactly one shape for each slide; do not add fields from another layout:

```jsonc
{ "layout": "cover", "title": "…", "subtitle": "…", "kicker": "…", "notes": "…" }
{ "layout": "agenda", "title": "…", "items": ["…"] }
{ "layout": "section", "title": "…", "subtitle": "…", "sectionNumber": "01" }
{ "layout": "bullets", "title": "…", "takeaway": "…", "bullets": ["…"] }
{ "layout": "cards", "title": "…", "cards": [{ "title": "…", "body": "…" }] }
{ "layout": "stats", "title": "…", "stats": [{ "value": "+18%", "label": "收入增长", "detail": "…" }] }
{ "layout": "comparison", "title": "…", "left": { "title": "过去", "items": ["…"] }, "right": { "title": "现在", "items": ["…"] } }
{ "layout": "process", "title": "…", "steps": [{ "title": "…", "body": "…" }] }
{ "layout": "table", "title": "…", "columns": ["…"], "rows": [["…"]] }
{ "layout": "summary", "title": "…", "takeaway": "…", "actions": ["…"] }
```

Limits: agenda 1-8 items; bullets 1-7; cards 1-4; stats 1-4; each comparison side 1-6 items; process 2-6 steps; table 2-6 columns and 1-8 rows; summary 1-5 actions. Each table row must match the column count. These are structural maxima, not content targets: use short message-led titles, phrases rather than paragraphs, no more than two lines for narrow labels/actions, and compact table cells. The generator rejects any text that still does not fit at the layout's minimum readable size.

Version 1 title/subtitle/bullets specifications remain accepted for existing callers, but new work must use version 2.

## Generate

Call `jugglework_artifact_generate` exactly once. Use the host-owned `jugglework:presentation-generator` program alias. The host resolves the alias to the packaged Electron Node runtime and trusted generator; do not use `node`, a copied script, a relative path, or any other executable.

```json
{
  "program": "jugglework:presentation-generator",
  "args": ["--spec-json", "<compact-json>", "--output", "<outputName>"],
  "outputs": ["<outputName>"],
  "timeoutMs": 60000
}
```

The host supplies `JUGGLEWORK_ARTIFACT_DIR` and collects the successful output. Do not make a second generation call, even if the first call fails. Return only the single delivered PPTX as the presentation result.
