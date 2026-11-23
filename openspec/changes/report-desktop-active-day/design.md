# Design

## Context

The business server owns date attribution, authentication and durable deduplication. Desktop reuses its validated cloud session and Den transport.

## Goals / Non-Goals

- Keep reporting separate from normal auth failures and avoid sending a description of the interaction.
- Do not add server schema changes, session heartbeats, or a cross-window lock.

## Decisions

- Observe trusted pointer and keyboard events at the document level rather than counting renders or instrumenting individual tools. Check the live session settings again before dispatch.
- Use the raw Den response path so a delayed error cannot initiate sign-out. Electron uses the existing main-process fetch bridge with ambient credentials omitted; the web fallback limits the referrer to the origin.
- Keep in-flight and retry state in memory. A local receipt stores deployment and account pairs for the most recently acknowledged UTC day, not tokens. After a failure wait 30 or 60 seconds for fresh interaction; stop after three attempts per window for the day.

## Risks / Trade-offs

- [Multiple windows or skew near UTC midnight] → Local suppression is best effort; the server determines the date and deduplicates writes.
- [Older server or unavailable writer] → Reporting is best effort. Roll back only the Desktop integration if needed; no migration is required.
