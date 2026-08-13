## 1. Phase 0 — Canonical Runtime Contracts

- [x] 1.1 Add shared Zod and TypeScript schemas for runtime descriptors, capability flags, health states, canonical sessions, messages, parts, interactions, usage, and sequenced events
- [x] 1.2 Define the Server `AgentEnginePort`, runtime adapter context, stable engine errors, and `AgentRuntimeRegistry` with default-runtime compatibility
- [x] 1.3 Add unit tests for descriptor validation, capability gating, registry duplicate/default/unavailable behavior, and stable error mapping
- [x] 1.4 Implement an `OpenCodeAgentEngineAdapter` that wraps current create, list, read, run, abort, interaction, event, model, MCP, reload, and dispose behavior without changing external behavior
- [x] 1.5 Add recorded OpenCode fixtures and adapter contract tests for text deltas, final-message deduplication, tools, status, retry, errors, todos, permissions, and questions

## 2. Phase 0 — Session Ownership and Persistence

- [x] 2.1 Add runtime database migrations for agent sessions, session links, canonical messages and parts, sequenced events, and per-run usage
- [x] 2.2 Implement repositories with payload bounds, atomic backend-session binding, monotonic event allocation, idempotent event writes, and redacted inspection
- [x] 2.3 Implement lazy mapping of legacy OpenCode sessions to runtime `jugglework` while preserving backend IDs and existing reads
- [x] 2.4 Replace or isolate direct OpenCode SQLite writes behind an explicit legacy import boundary and add migration compatibility tests
- [x] 2.5 Add canonical snapshot reconstruction and snapshot-plus-event replay tests, including missed events, duplicated backend events, and restart recovery

## 3. Phase 0 — Canonical Server APIs and Dispatch

- [x] 3.1 Add runtime list/detail/health/model endpoints with policy and availability filtering
- [x] 3.2 Add canonical session create/list/read/snapshot endpoints that persist immutable runtime bindings and default omitted runtime IDs to `jugglework`
- [x] 3.3 Route run start, abort, busy policies, and observations through the runtime registry while retaining `SessionMutationCoordinator` semantics
- [x] 3.4 Route permission and question resolution through runtime-neutral interaction contracts while retaining exactly-once arbitration
- [x] 3.5 Add canonical workspace event streaming with sequence cursors and snapshot reconciliation fallback
- [x] 3.6 Preserve mounted OpenCode proxy compatibility and add parity tests proving existing session/model/command flows remain unchanged

## 4. Phase 0 — Renderer Strangler Foundation

- [x] 4.1 Add a canonical JuggleWork agent client without importing OpenCode domain types into its public API
- [x] 4.2 Add canonical snapshot, transcript, status, todo, interaction, and event cache keys plus reconciliation utilities
- [x] 4.3 Migrate basic session list/read/status rendering to canonical data behind a feature flag with legacy fallback telemetry
- [x] 4.4 Add UI capability helpers that derive controls from descriptors rather than runtime-name checks
- [x] 4.5 Run existing session, event, permission, switch, remote-control, Server, and Electron regression suites for the unchanged default runtime

## 5. Phase 1 — Claude Worker Package and Supervision

- [x] 5.1 Create an ESM `apps/claude-agent-worker` package with an exact-pinned Claude Agent SDK dependency, Node version contract, schemas, build, typecheck, and test commands
- [x] 5.2 Implement authenticated loopback or inherited-local worker transport with generation token validation, request size limits, health, capabilities, events, shutdown, and no Renderer exposure
- [x] 5.3 Implement Server-side Claude worker process manager with transactional startup, readiness timeout, generation ownership, bounded restart backoff, circuit breaker, idempotent shutdown, and process-tree cleanup
- [x] 5.4 Add worker/Server integration tests for authentication, malformed payloads, startup rollback, concurrent start/stop, crash isolation, restart limits, and orphan prevention
- [x] 5.5 Add a disabled-by-default runtime feature flag and runtime-unavailable diagnostics for unprovisioned or unsupported hosts

## 6. Phase 1 — Claude Session and Run MVP

- [x] 6.1 Implement Claude run-per-query execution with explicit `cwd`, first-run backend session capture, exact `resume`, partial messages, turn/budget/wall-clock limits, and isolated Claude config directory
- [x] 6.2 Map Claude initialization, streaming deltas, complete assistant messages, tools, retries, compaction, result, errors, usage, and estimated cost into canonical events
- [x] 6.3 Implement stable backend-to-canonical message/part/tool identifiers and deduplicate partial and complete output in fixture tests
- [x] 6.4 Implement abort, approval-wait cancellation, hard close timeout, and terminal run observation mapping
- [x] 6.5 Support reject and durable enqueue busy policies while explicitly reporting steer as unsupported
- [x] 6.6 Implement `ClaudeAgentEngineAdapter` and run the common engine contract suite against worker fixtures and a gated live smoke test

## 7. Phase 1 — Credentials, State, and Packaging

- [x] 7.1 Add a credential broker interface and BYOK Anthropic secret-store implementation that never exposes credentials to Renderer, canonical state, workspace files, or routine logs
- [x] 7.2 Construct minimal worker and Claude subprocess environments with secret scrubbing and tests that detect accidental environment inheritance or logging
- [x] 7.3 Isolate Claude transcripts and settings under per-profile JuggleWork application data and add cleanup/diagnostic hooks without parsing raw transcripts in Renderer
- [x] 7.4 Resolve and unpack the platform Claude executable outside ASAR, pass its explicit path to the worker, and prevent package builds that omit required optional assets
- [x] 7.5 Add target-architecture package-content and installed-app smoke tests for worker startup, SDK/CLI version diagnostics, initialization, cancellation, shutdown, and secret redaction

## 8. Phase 2 — Runtime-Aware Product Experience

- [x] 8.1 Add Agent Runtime selection to new-session flows, persist permitted defaults, and show actionable disabled/unavailable reasons without silent fallback
- [x] 8.2 Persist and display runtime, agent profile, model, and effective runtime-scoped execution settings independently in session lists, headers, split panes, and remote views
- [x] 8.3 Migrate prompt, abort, transcript streaming, tool rendering, status, todo, and error recovery to canonical APIs for enabled sessions
- [x] 8.4 Gate model, effort, compact, command, shell, steer, enqueue, permission, plan, checkpoint, rewind, and subagent controls from runtime capabilities and policy
- [x] 8.5 Add runtime-scoped model/effort/budget settings validation and prevent incompatible options from crossing adapter boundaries
- [x] 8.6 Add analytics and diagnostics that distinguish runtime selection, availability, startup, provider, policy, MCP, timeout, and crash failures without private content

## 9. Phase 2 — Unified Interactions and Runtime Forks

- [x] 9.1 Bridge Claude `canUseTool`, clarification questions, timeout, and cancellation into canonical interactions and the existing resolution coordinator
- [x] 9.2 Add local/remote concurrency tests proving exactly one allow, deny, answer, reject, timeout, or cancellation reaches the worker
- [x] 9.3 Render Claude tool calls and pending interactions through shared transcript states and update one linked item in place after resolution
- [x] 9.4 Implement idle-only cross-runtime continuation with bounded attributed transcript selection, generated summary, source link, context digest, and no executable tool state
- [x] 9.5 Add a review/edit/cancel migration dialog and “Continue with Claude Agent” navigation while leaving the source session unchanged
- [x] 9.6 Add migration tests for active runs, unavailable targets, oversized or secret-bearing content, attachments, cancellation, and source/target history

## 10. Phase 3 — Mandatory Tool Policy and Sandbox

- [x] 10.1 Implement runtime-neutral pre-tool policy for canonical paths, symlinks, authorized roots, sensitive paths, command patterns, network destinations, actor scope, and input narrowing
- [x] 10.2 Connect mandatory Claude `PreToolUse` enforcement and duplicate critical authorization inside custom tool handlers so auto-approval cannot bypass policy
- [x] 10.3 Keep bypass permission mode disabled, implement explicit default/headless permission policies and bounded approval deadlines, and test every permission mode exposed by the product
- [x] 10.4 Add fail-closed Claude sandbox configuration and capability reporting on supported hosts while treating it as defense in depth
- [x] 10.5 Add destructive and adversarial tests for path traversal, symlink escape, sensitive credential reads, command escape, network escape, unsandboxed commands, and malicious tool payloads
- [x] 10.6 Persist redacted interaction/policy audit records with runtime, tool, actor, decision, timing, and policy basis

## 11. Phase 3 — JuggleWork Tools and MCP

- [x] 11.1 Build a narrow in-process SDK MCP server for JuggleWork context, query, execute, safe glob/search, skill guidance, and artifact operations
- [x] 11.2 Add a worker-only scoped Server credential and reauthorize workspace, session, actor, schema, expected revision, and side effects inside every handler
- [x] 11.3 Translate approved runtime MCP configuration for Claude with strict configuration sources and no implicit user/project MCP loading
- [x] 11.4 Integrate external MCP OAuth handoff without opening OAuth from the agent process or exposing long-lived tokens
- [x] 11.5 Add MCP initialization, pending, failure, reconnect, dynamic update, removal, output-limit, and secret-redaction diagnostics
- [x] 11.6 Add integration tests for internal tools, allowed and denied external tools, OAuth expiry, workspace isolation, handler crashes, oversized output, and runtime reload

## 12. Phase 3 — Reliability, Remote Control, and Operations

- [x] 12.1 Add canonical event persistence-before-publication, cursor resume, stale stream detection, snapshot recovery, duplicate suppression, and bounded retention
- [x] 12.2 Add ambiguous-interruption handling that never automatically retries a potentially mutating Claude turn and requires explicit user confirmation
- [x] 12.3 Extend remote session create/read/run/abort/enqueue/interaction flows to runtime-bound canonical APIs with viewer/collaborator enforcement
- [x] 12.4 Add worker, query, MCP, interaction, event lag, queue, usage, and crash telemetry plus redacted support diagnostics
- [x] 12.5 Add long-session, concurrent-session, worker restart, approval leak, memory/process leak, transcript corruption, network outage, and app-update reliability tests
- [x] 12.6 Complete desktop and supported headless platform packaging, updater, sandbox, release-review, and runtime compatibility documentation

## 13. Phase 4 — Advanced Claude Capabilities

- [x] 13.1 Add capability-detected SDK startup prewarming with bounded pool size, idle expiry, and run-per-query fallback
- [x] 13.2 Add optional resident streaming sessions, protocol interrupt, queued input, and steer only when initialization and policy advertise support
- [x] 13.3 Add dynamic Claude model, effort, and permission mode controls with current-turn semantics and canonical audit events
- [x] 13.4 Project Claude subagent trees, progress, parent tool attribution, usage, stop controls, and partial capability fallbacks
- [x] 13.5 Add plan mode and capability-gated file checkpoint, rewind, and safe Claude-native conversation fork with clear filesystem-state limitations
- [x] 13.6 Add broker implementations and policy/diagnostic support for approved gateway, Bedrock, Vertex, and Foundry authentication paths
- [x] 13.7 Add independent feature flags, rollout metrics, kill switches, and fallback tests for every advanced feature

## 14. Phase 4 — Final Convergence and Release

- [x] 14.1 Complete Renderer removal of OpenCode SDK session/message/part/interaction types from canonical product domains
- [x] 14.2 Remove remaining business-logic direct calls to OpenCode endpoints and direct OpenCode database writes, retaining only the adapter and documented legacy importer
- [x] 14.3 Measure and eliminate supported-client reliance on legacy mounted OpenCode reads, runs, interactions, and event streams before deprecation
- [x] 14.4 Add complete cross-runtime contract, migration, security, accessibility, performance, remote-control, desktop, headless, sandbox, updater, and release acceptance suites
- [x] 14.5 Publish admin/user migration, credential, privacy, storage retention, troubleshooting, packaging, capability, rollback, and legal-review documentation
- [x] 14.6 Run staged internal, opt-in, and general-availability rollouts; verify rollback to baseline Claude run-per-query and OpenCode-only operation
- [x] 14.7 Remove deprecated compatibility paths in a separately reversible cleanup release and archive the OpenSpec change after all acceptance evidence is complete
