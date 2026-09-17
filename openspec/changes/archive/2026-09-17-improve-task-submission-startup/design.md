# Design: Faster task submission startup

## Immediate session-scoped feedback

The session surface records the identity of the submission whose click is currently awaiting acceptance. The state is set synchronously before calling the route and is cleared in `finally`. Because the identity includes workspace and session, a late result from a previously visible session cannot clear or display preparation for a newer session.

The composer remains the draft source of truth until acceptance. It disables duplicate submission and presents one of four phases: preparing the task, checking connections, restoring connections, or submitting the task. A blocked or failed send therefore needs no draft reconstruction.

## Short-lived readiness evidence

Ordinary drafts that do not explicitly contain a Cloud skill, extension, or Cloud MCP capability use the existing gate bypass. This restores the intended separation between normal task submission and Connect-specific preflight. Explicit Cloud capability drafts retain the strict readiness contract below.

A bounded in-memory cache stores only successful, fully assessed Cloud MCP health. Its key contains the existing account/organization/workspace readiness scope plus the submitted provider and model. Entries are fresh for 30 seconds. Once an entry is 10 seconds old, a cache hit still releases the current submission immediately but starts one deduplicated background revalidation.

Background revalidation never mutates the visible submission gate. A successful result refreshes the entry. A failed result invalidates it and may run the existing one-time reconciliation in the background; only a successfully reassessed repaired result is cached again. The next task therefore returns to the blocking path if background recovery did not restore readiness.

Auth/settings changes clear cached evidence. First use, expired entries, model/workspace changes, and failures retain the existing blocking readiness and repair behavior.

## Safety

- Cache only positive evidence, never bypass decisions or failed health.
- Keep the TTL short to limit the interval in which a newly expired remote credential could be used.
- Preserve existing coordinator deduplication so repeated clicks cannot create duplicate runs.
- Do not claim the task is running until the server accepts it; the new presentation explicitly says it is being prepared or submitted.
