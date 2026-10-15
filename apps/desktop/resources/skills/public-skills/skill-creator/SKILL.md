---
name: skill-creator
description: Create or update a skill only in the current Desktop workspace under .opencode/skills/.
---

# Skill Creator

This skill is a template and checklist for creating skills in the current workspace.

## What is a skill?

A workspace skill is a folder under `.opencode/skills/<skill-name>/` anchored by `SKILL.md`.

## Workspace authoring contract

1. Inspect `.opencode/skills/` before writing so an existing exact-name skill is updated instead of duplicated.
2. User-provided valid details take precedence over generic defaults: preserve the requested name, intended behavior, source or content, and workspace-local target. Do not ask again for details the user already supplied.
3. Accept a user-specified target only when its normalized destination is exactly `<current-workspace>/.opencode/skills/<skill-name>/SKILL.md` and its `<skill-name>` matches the valid Skill name. Never override a valid user-specified local target; reject or clarify any target outside the current workspace, outside `.opencode/skills`, or not matching this exact contract.
4. If the user supplies a complete valid `SKILL.md`, use that complete source as-is and preserve its body and content rather than regenerating it.
5. Clarify only missing, conflicting, or invalid details. Otherwise, create or update exactly one `.opencode/skills/<skill-name>/SKILL.md` for the request.
6. When source must be drafted, write complete frontmatter with a matching lower-case hyphenated `name`, a trigger-oriented `description`, and a non-empty instruction body.
7. Maintain one complete file and do not create supporting files or unrelated resources.
8. Validate the completed `SKILL.md`, then re-read it and compare it with the intended complete source before reporting success.
9. Never persist, publish, or save the authored Skill to Cloud or a server.

## Design goals

- Portable: safe to copy between machines
- Reconstructable: can recreate any required local state
- Self-building: can bootstrap its own config/state
- Credential-safe: no secrets committed; graceful first-time setup

## Recommended structure

```
.opencode/
  skills/
    my-skill/
      SKILL.md
```

## Trigger phrases (critical)

The description field is how Claude decides when to use your skill.
Include 2-3 specific phrases that should trigger it.

Bad example:
"Use when working with content"

Good examples:
"Use when user mentions 'content pipeline', 'add to content database', or 'schedule a post'"
"Triggers on: 'rotate PDF', 'flip PDF pages', 'change PDF orientation'"

Quick validation:
- Contains at least one quoted phrase
- Uses "when" or "triggers"
- Longer than ~50 characters

## Frontmatter template

```yaml
---
name: my-skill
description: |
  [What it does in one sentence]

  Triggers when user mentions:
  - "[specific phrase 1]"
  - "[specific phrase 2]"
  - "[specific phrase 3]"
---
```

## Authoring checklist

1. Start with a clear purpose statement: when to use it and what it outputs.
2. Specify inputs, outputs, and any required permissions.
3. Include "Setup" steps if the skill needs local tooling.
4. Add at least two realistic example user prompts.
5. Keep it safe: avoid destructive defaults and ask for confirmation.
6. Validate the file and verify its final contents after creation.
