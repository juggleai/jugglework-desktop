## Context

See proposal.md. Historical synthetic error messages and the live error fallback already share one error-card component in the message list. The earlier API-route attachment filter cannot cover genuinely missing files.

## Goals / Non-Goals

**Goals:** Hide missing-file cards consistently for history and live events without deleting errors or changing execution state.

**Non-Goals:** Automatically resume failed tasks, alter attachment inference, hide tool details, suppress generic 404/model/permission/network errors, or rebuild installers.

## Decisions

- Extract the existing shared error card into a small testable component and apply the display guard there. This covers both callers without changing session sync or stored messages.
- Match explicit leading missing-file diagnostics, including file-read ENOENT, rather than arbitrary text containing `not found`. Missing executable/spawn errors stay visible.
- Return no markup for matching errors, including suggestion lines. Keep all other error markup unchanged.

## Risks / Trade-offs

- False positives → anchored patterns and negative tests for permission, model, network and spawn failures.
- Hidden diagnostics do not fix the underlying operation → keep stored errors and task status intact; this is a display-only change.
