# Design

Desktop treats the Cloud row ID as provider ownership identity and keeps that behavior unchanged. New Server payloads continue using `source=juggle_router` for old clients and add `managedIdentity=jwork_router`; old Server payloads omit the new field. A shared helper recognizes the canonical value first and falls back to legacy `managedKind` or `source` only when the canonical field is absent.

Display names and public provider IDs are not authorization signals. An ordinary provider named JuggleRouter remains ordinary unless managed metadata identifies it otherwise. Reimport uses the unchanged Cloud row ID and updated provider fingerprint, preserving auth, gateway mirror ownership, default model, session model, and historical model references.
