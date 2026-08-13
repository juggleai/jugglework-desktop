## Why

JuggleWork Desktop currently presents an agent-oriented product but delegates every conversation to a single OpenCode runtime whose types, persistence, events, and tools reach into both Server and Renderer. To support a real Claude Agent—not merely a Claude model behind OpenCode—JuggleWork needs a runtime-neutral control plane and an independently supervised Claude Agent Worker without regressing the existing default agent.

## What Changes

- Introduce a JuggleWork-owned agent runtime contract, canonical session/message/event/interaction schemas, runtime capability discovery, and engine dispatch while retaining the existing JuggleWork/OpenCode agent as the default.
- Bind each session to one immutable runtime. Creating a session accepts an explicit runtime selection; “continue with another agent” creates a linked fork rather than mutating incompatible backend state in place.
- Add an independently packaged Node worker using the official `@anthropic-ai/claude-agent-sdk`, supervised by JuggleWork Server over authenticated loopback IPC/HTTP and isolated from Renderer credentials and process capabilities.
- Add Claude session creation, explicit resume, streaming text and tool events, abort/close, usage reporting, canonical persistence, crash recovery, and bounded busy-session behavior.
- Bridge Claude permission and question requests into the existing JuggleWork interaction arbitration and enforce workspace/security policy before tool execution.
- Expose JuggleWork context, query, execute, safe filesystem, skills, and configured external MCP capabilities to Claude through a controlled SDK MCP server and runtime-specific configuration translation.
- Add runtime-aware Agent and Model selection, capability-gated controls, session runtime badges, and a guided “Continue with Claude Agent” fork flow.
- Extend desktop/headless packaging, credential brokering, sandbox policy, diagnostics, telemetry, remote control, and cross-platform verification for the worker and bundled Claude executable.
- Deliver the change in Phase 0 through Phase 4: runtime boundary, Claude MVP, unified UI/interactions, MCP/reliability, and advanced runtime capabilities, ending in the recommended multi-runtime architecture.
- Preserve compatibility for existing OpenCode sessions and APIs during migration; removal of legacy OpenCode-shaped Renderer paths occurs only after canonical APIs have equivalent coverage.

## Capabilities

### New Capabilities
- `multi-agent-runtime-control`: Runtime registry, immutable session/runtime binding, canonical schemas, capability discovery, engine-neutral APIs, and linked cross-runtime forks.
- `claude-agent-worker`: Independently supervised Claude Agent SDK worker, session/run lifecycle, streaming, resume, cancellation, persistence, credentials, packaging, and recovery.
- `agent-runtime-interactions`: Runtime-neutral permissions, questions, tool policy enforcement, MCP/tool exposure, and deterministic resolution across local and remote actors.
- `agent-runtime-experience`: Runtime-aware creation and model selection, capability-gated session controls, runtime identity, migration UX, diagnostics, usage, and advanced Claude features.

### Modified Capabilities
- `server-owned-runtime`: Extend Server runtime authority from one managed OpenCode engine to a registry of managed agent engines, including the independent Claude Agent Worker lifecycle.

## Impact

- **Server:** session routes/read models, run and interaction coordinators, runtime stores, managed process lifecycle, MCP translation, canonical event delivery, and remote-control adapters.
- **Renderer:** removal of direct OpenCode domain assumptions from session state over time; runtime-aware creation, model controls, event projection, tool rendering, and migration UX.
- **Desktop/headless:** worker provisioning, platform binary packaging, shutdown, diagnostics, sandbox compatibility, secrets, updater/package-content checks, and process leak tests.
- **Data:** new JuggleWork-owned session/runtime mappings, canonical message/event projections, configuration snapshots, backend resume identifiers, and cross-runtime links; existing OpenCode storage remains readable.
- **Dependencies:** exact-version `@anthropic-ai/claude-agent-sdk` and its platform optional packages in the worker distribution, plus explicit Node runtime requirements.
- **Security and operations:** API/cloud credentials remain outside Renderer and workspace files; loopback worker transport is authenticated; Claude settings and transcript storage are isolated under JuggleWork application data; rollout requires feature flags and runtime health/capability reporting.
