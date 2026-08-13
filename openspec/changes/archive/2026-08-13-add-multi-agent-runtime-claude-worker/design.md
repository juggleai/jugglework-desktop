## Context

See `proposal.md` for motivation. Today Server owns one managed OpenCode process, but OpenCode SDK types and event names still shape Server routes, Renderer state, persistence assumptions, and direct database compatibility code. The default `jugglework` agent is injected through `OPENCODE_CONFIG`; OpenCode owns the agent loop and conversation store. Session run and interaction coordinators are already JuggleWork-owned and are useful engine-neutral foundations.

The official TypeScript Claude Agent SDK is itself a supervisor for a native Claude subprocess. It has a distinct transcript store, session identifiers, event stream, permissions, MCP lifecycle, cancellation semantics, packaging constraints, and credential rules. Server is built for Bun and Node-compatible ESM and can be compiled as a Bun executable, while the SDK and its platform optional packages require a real filesystem path and a supported Node runtime. Renderer must not receive SDK process access or credentials.

The target architecture is therefore one canonical JuggleWork control plane with two adapters: existing managed OpenCode and a separately packaged Claude Agent Worker supervised by Server.

## Goals / Non-Goals

**Goals:**

- Make runtime selection an explicit, immutable session property while preserving existing sessions and the default runtime.
- Move engine-specific message/event translation behind Server-owned adapters and expose canonical APIs to current and future clients.
- Run Claude Agent SDK behind an authenticated independent process boundary with safe lifecycle, credentials, transcript isolation, and packaging.
- Reuse JuggleWork run arbitration, interactions, remote control, MCP configuration, workspace authorization, and product tools where their contracts are engine-neutral.
- Deliver the final architecture incrementally through Phase 0–4 with feature flags and rollback at every phase.

**Non-Goals:**

- Do not replace OpenCode or change the existing default as part of this change.
- Do not make “Claude Agent” an alias for selecting a Claude model inside OpenCode.
- Do not convert a session's backend runtime in place or promise lossless transfer of hidden/tool context across runtimes.
- Do not expose the worker protocol, Claude credentials, or raw SDK objects to Renderer or remote clients.
- Do not require all runtimes to implement identical optional features; capability discovery is part of the contract.
- Do not use Claude.ai consumer subscription login as a product authentication path.

## Decisions

### 1. Server owns a registry of agent engine adapters

Introduce a Server-local `AgentEnginePort` and `AgentRuntimeRegistry`. The port covers descriptor/health, session creation and reads, run start and abort, event subscription, interaction resolution, model discovery, configuration, and shutdown. Dispatch always begins from the persisted public JuggleWork session ID and runtime binding.

`OpenCodeAgentEngineAdapter` initially delegates to the existing SDK clients and preserves existing routes. `ClaudeAgentEngineAdapter` speaks only to the worker. Coordinators remain above both adapters.

Alternative: reproduce OpenCode's HTTP and SSE contract in the Claude worker. Rejected because it would preserve accidental OpenCode coupling, misrepresent unsupported behavior, and make future runtimes harder to add.

### 2. Canonical contracts live in shared JuggleWork types

Add runtime, capability, session, message, part, interaction, usage, and event schemas to `@jugglework/types`. Canonical part variants cover text, reasoning, tool, file, agent/subagent, structured data, and error. Events contain stable public IDs, runtime metadata, and monotonic per-session sequence numbers.

Adapters own backend-to-canonical identity maps. Incremental output updates a canonical part; a later complete backend message finalizes it. Raw payloads are excluded by default and only bounded, redacted metadata can cross the adapter.

Renderer migrates from direct OpenCode types by a strangler pattern: canonical endpoints and sync are added beside legacy proxy paths, then individual reads, events, sends, and interactions move over. Legacy proxy endpoints remain until parity tests pass.

Alternative: create a discriminated union containing complete OpenCode and Claude SDK messages. Rejected because every client would remain coupled to both SDKs and credentials/private fields would be harder to constrain.

### 3. JuggleWork owns public session identity and projection

Add runtime tables to the existing Server runtime SQLite database:

```text
agent_sessions(
  id PK, workspace_id, runtime_id, backend_session_id NULL,
  title, canonical_cwd, status, config_snapshot_json,
  created_at, updated_at, last_error_json NULL
)
agent_session_links(source_session_id, target_session_id, link_type, context_digest, created_at)
agent_messages(id PK, session_id, backend_message_id NULL, role, parent_id NULL, created_at, completed_at NULL, metadata_json)
agent_parts(id PK, session_id, message_id, backend_part_id NULL, ordinal, type, state, payload_json, updated_at)
agent_events(session_id, sequence, event_id UNIQUE, type, payload_json, created_at)
agent_run_usage(run_id, session_id, payload_json, created_at)
```

Large raw transcript bodies remain in backend stores; canonical payloads are size-bounded. OpenCode sessions without mappings are lazily overlaid as runtime `jugglework` and can be backfilled without changing their backend IDs. Direct writes to OpenCode SQLite are removed or isolated behind an explicit legacy importer before Claude becomes generally available.

Alternative: use OpenCode IDs as all public IDs and create a separate namespace only for Claude. Rejected because ID ownership would remain engine-specific and collisions/migrations would be difficult.

### 4. Runtime binding is immutable; cross-runtime continuation is a fork

Session creation accepts `runtimeId`, defaulting to `jugglework` for compatibility. A session stores a validated configuration snapshot, while mutable user defaults only influence later sessions.

“Continue with Claude Agent” requires an idle source, creates a linked target, and seeds a bounded migration artifact containing attributed user/assistant text, selected files or artifact pointers, and an explicit summary. It excludes pending interactions, executable tool results, hidden prompts, credentials, and backend compaction state. The user reviews the context before a first target run.

Alternative: replay all source messages and tool objects into Claude. Rejected because tool schemas and trust decisions differ, payloads may contain secrets, and replay could imply actions occurred in the target runtime.

### 5. Claude Agent SDK runs in a dedicated Node worker

Create `apps/claude-agent-worker` as ESM, with an exact SDK version and a narrow local API. Server launches it as a managed child, passing a loopback address or inherited local transport, one random generation token, a JuggleWork data directory, resolved Claude executable path, and a minimal environment. The worker never accepts a renderer or cloud bearer token.

Initial worker endpoints/messages cover health/capabilities, session run, abort/close, interaction response, event stream, configuration refresh, and shutdown. Every request has schema and byte limits. Server owns restart backoff and process-tree cleanup; worker owns SDK `Query` handles and Claude descendants.

Electron and headless launchers provision Node and the SDK platform binary. Electron packages the native binary outside ASAR and supplies `pathToClaudeCodeExecutable`. Release tests exercise installed artifacts per architecture. The worker remains optional so OpenCode-only installs and unsupported platforms continue to start.

Alternative: import the SDK into Server. Rejected because Server's Bun single-binary path conflicts with optional native asset resolution and an SDK or native crash would expand Server's failure domain.

Alternative: invoke `claude -p` directly. Rejected because the SDK already encapsulates streaming control, typed events, permissions, resume, cancellation, and MCP while still retaining a subprocess boundary.

### 6. Phase 1 uses resumable run-per-query execution

For the baseline, each user turn creates one SDK `query()` using an explicit `resume` ID after the first turn, `includePartialMessages: true`, an application `AbortController`, bounded turns/budget/time, explicit `cwd`, `settingSources: []`, and `strictMcpConfig: true`. The Claude Code system prompt preset is extended with JuggleWork product and security instructions.

This yields simple process reclamation and crash recovery. Busy policy supports reject and the existing durable enqueue path. It does not advertise steer. Phase 4 can introduce prewarmed or resident streaming sessions, `interrupt()`, and steering behind capabilities and an idle TTL, while preserving run-per-query as fallback.

Alternative: resident SDK Query from the first release. Rejected because it increases process count, memory, approval cleanup, reconnect, and crash ambiguity before baseline persistence is proven.

### 7. Security policy precedes runtime approval

Claude `canUseTool` bridges unresolved human decisions into the existing interaction coordinator, but mandatory authorization lives in `PreToolUse` and tool handlers because auto-approved calls can bypass `canUseTool`. Policy canonicalizes filesystem paths, resolves symlinks, checks authorized roots and sensitive locations, validates commands/network destinations, enforces actor scope, and can narrow tool input.

The initial mode is `default`; `bypassPermissions` is disabled. Sandboxing, where supported, uses fail-closed startup, disables unsandboxed command escape, and is treated as defense in depth rather than the only boundary. Headless runs use explicit preapproval/deny/timeouts. Audit records are redacted.

Alternative: reuse Claude's UI or settings rules as the product security boundary. Rejected because Renderer/remote arbitration, workspace authorization, and organizational policy must remain JuggleWork-controlled.

### 8. JuggleWork tools and MCP are exposed through a controlled SDK MCP server

The worker builds an in-process SDK MCP server with narrow handlers for JuggleWork context, query, execute, bounded search, skill retrieval, and artifacts. Handlers call Server using a worker-only scoped credential and revalidate workspace/session/actor information. They do not receive broad Electron or Server objects.

Existing workspace MCP configuration is translated by the Claude adapter. Only policy-approved entries are passed; unknown project/user settings remain disabled by default. OAuth occurs in JuggleWork and runtime access uses an approved token/header mechanism. Runtime health reports MCP initialization and pending/failure states.

Alternative: enable Claude's default setting sources and `.mcp.json`. Rejected because behavior would vary by host and could expose unreviewed tools or credentials.

### 9. Credentials are brokered and environments are minimal

BYOK credentials remain in the existing approved OS secret facility. Enterprise credentials may come from short-lived gateway, Bedrock, Vertex, or Foundry brokers in later phases. Renderer receives only readiness/error categories. Worker and Claude environments are constructed from an allowlist rather than blindly inheriting `process.env`; secrets are scrubbed from debug output and canonical state.

Claude transcript/config storage is rooted under JuggleWork application data per profile and never defaults to a user's standalone `~/.claude`. Canonical projection is the product read model; Claude JSONL remains the backend resume source and is not parsed by Renderer.

### 10. APIs and UI are capability-driven

Add canonical Server endpoints under a versioned agent/session surface while keeping legacy mounted OpenCode routes during migration. Runtime descriptors drive the Agent picker and controls. Runtime, agent profile, and model are separate fields. Split panes can use different runtimes.

Runtime unavailable errors are explicit and never silently fall back. Diagnostics categorize provisioning, worker, SDK/binary, credentials, provider, MCP, policy, timeout, and crash. Usage is stored per run; Claude cost values are labelled estimates and cumulative values are deduplicated.

### 11. Reliability uses generation-aware ownership and event replay

Worker and Query handles carry execution generations. Startup is transactional, shutdown idempotent, and restarts use bounded exponential backoff plus a circuit breaker. A worker crash never automatically replays a possibly mutating turn; the run becomes interrupted/ambiguous and requires explicit retry.

Canonical events are persisted before or atomically with publication and have per-session sequence. SSE reconnect uses a cursor when possible and snapshot reconciliation otherwise. Contract tests feed recorded OpenCode and Claude fixtures through adapters and assert identical canonical outcomes for shared behavior.

### 12. Phase 4 advanced behavior remains reversible

Prewarming, resident sessions, steering, dynamic model/permission changes, subagent trees, plan mode, file checkpointing, rewind, Claude-native fork, and additional cloud providers each have independent capability flags and policy gates. They cannot become prerequisites for baseline create/resume/stream/approve/abort.

The runtime adapter consumes initialization capabilities instead of relying only on SDK version strings. The SDK version is exact-pinned, changed through an explicit compatibility test, and the bundled CLI version is recorded in diagnostics.

## Risks / Trade-offs

- [Canonical projection temporarily duplicates backend storage] → Bound payload sizes, retain backend transcripts as resume authority, add retention/migration jobs, and measure database growth before general availability.
- [Large strangler migration leaves two client paths] → Establish contract tests first, migrate one operation family at a time, instrument legacy route use, and delete only after parity and a deprecation window.
- [Worker crash after a mutating tool has ambiguous outcome] → Never automatic-retry interrupted turns; preserve tool progress, show an ambiguity warning, and require user confirmation.
- [SDK patch and bundled CLI change rapidly] → Pin exact versions, inspect initialization capabilities, keep fixture/installed-package tests, and roll out version changes separately.
- [Electron ASAR or package manager omits native binaries] → Explicitly unpack assets, resolve executable paths, prohibit omission of required optional packages, and run per-target installation smoke tests.
- [Node worker increases distribution size] → Keep it optional and runtime-gated; package only target architecture assets; quantify impact in release review.
- [Claude sandbox differs by platform and does not cover every tool] → Enforce JuggleWork policy independently, report sandbox capability, fail closed where required, and gate unsupported high-risk modes.
- [MCP handlers run with host process privilege] → Keep handlers narrow, reauthorize every invocation, avoid broad object access, and run destructive integration tests in isolated workspaces.
- [Cross-runtime summaries omit important context] → Make migration context inspectable/editable, retain a source link, and never present it as a lossless conversion.
- [Cost estimates are mistaken for billing] → Label estimates, store source/scope, deduplicate cumulative fields, and use authoritative provider APIs for billing decisions.

## Migration Plan

### Phase 0 — Runtime boundary

1. Add canonical shared schemas, runtime descriptors, registry, and adapter contract.
2. Implement an OpenCode adapter around existing calls and contract tests without changing default behavior.
3. Add runtime/session mapping and canonical projection migrations with lazy legacy OpenCode binding.
4. Add canonical read/run/event routes beside existing mounted OpenCode routes.
5. Migrate Renderer session reads and status incrementally; retain legacy fallback and measure it.

Rollback: disable canonical routes and registry dispatch; existing OpenCode data and paths remain authoritative.

### Phase 1 — Claude Worker MVP

1. Add the optional Node worker package, authenticated transport, process manager, health, and installed-asset checks.
2. Implement explicit create/resume, run-per-query streaming, event mapping, usage, abort, limits, transcript isolation, and BYOK credential broker.
3. Add Claude adapter and feature flag; expose only internal/developer runtime selection initially.
4. Verify worker crash, shutdown, no-orphan, credential redaction, and package behavior.

Rollback: disable the Claude runtime flag and worker startup. Canonical Claude projections remain read-only.

### Phase 2 — Unified UI and interactions

1. Add runtime picker, badges, runtime-scoped models/settings, capability-gated controls, and canonical transcript/tool projection.
2. Bridge Claude approvals/questions to the interaction coordinator and complete local/remote exactly-once tests.
3. Add explicit cross-runtime continuation with previewed migration context.
4. Enable a limited opt-in cohort.

Rollback: hide Claude creation and continuation while preserving reads and exports of created sessions.

### Phase 3 — MCP, security, and reliability

1. Add controlled JuggleWork SDK MCP tools and external MCP translation/OAuth handoff.
2. Complete mandatory pre-tool policy, sandbox capability reporting, headless policy, and redacted audit.
3. Add event replay/cursors, restart circuit breaker, transcript repair diagnostics, telemetry, remote-control parity, and scale/process leak tests.
4. Complete supported desktop/headless platform packaging and staged general availability.

Rollback: disable external MCP or individual tool families independently; use basic Claude chat/filesystem mode or disable Claude mutations.

### Phase 4 — Advanced capabilities and final convergence

1. Add optional prewarm/resident sessions, interrupt/steer, dynamic model/permission changes, and fallback to run-per-query.
2. Add subagent projection, plan mode, checkpoint/rewind, native fork where safe, and additional enterprise provider brokers.
3. Finish Renderer migration off OpenCode SDK domain types and remove direct OpenCode database writes.
4. Deprecate and remove legacy OpenCode-shaped client paths after telemetry confirms no supported caller remains.
5. Run full Server, Desktop, headless, sandbox, remote-control, updater, release, migration, and security verification.

Rollback: each advanced capability is independently disabled; canonical sessions and baseline engine adapters remain. Legacy paths are removed only in a separately reversible cleanup release after the compatibility window.

## Open Questions

- Which desktop operating systems and architectures must include Claude Agent in the first public package, versus reporting it as unsupported?
- Will the first cohort use only BYOK Anthropic credentials, or is a JuggleWork gateway credential broker available for Phase 1 validation?
- What default canonical event retention and Claude transcript cleanup periods satisfy product recovery needs and organization policy?
