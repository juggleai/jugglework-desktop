## Why

The current `jugglework` command can run terminal tasks, but a fresh machine still needs a separately installed OpenCode binary and cannot sign in to JuggleWork Cloud to discover and use organization-managed model providers. A standalone, Codex-style CLI should work without JuggleWork Desktop, use `https://work.jugglechat.cn` by default, and provide one coherent interactive and scriptable product surface.

## What Changes

- Make the CLI distribution self-contained by staging a supported OpenCode sidecar and required JuggleWork OpenCode plugins for every released platform.
- Add JuggleWork Cloud account commands with browser-assisted login, logout, status, persisted deployment profiles, and organization selection.
- Default the Cloud control-plane address to `https://work.jugglechat.cn`, while keeping the local embedded runtime and explicit `--server` connection as separate concepts.
- Retrieve organization-published providers and models after login and import a selected provider into the CLI-owned OpenCode runtime without exposing provider credentials.
- Evolve the command and interaction model around Codex CLI's strongest contracts: bare-command interactive mode, positional prompts, a dedicated `exec` mode, session lifecycle commands, contextual slash commands, deterministic stdout/stderr behavior, NDJSON automation, completion, and redacted diagnostics.
- Keep Desktop optional: a clean installation of the CLI SHALL be able to authenticate, select an organization, start its packaged runtime, and execute a task.
- Treat seamless device-code or loopback login as a Cloud API enhancement; until that contract is available, support the existing one-time handoff grant through a safe browser-and-paste flow.

## Capabilities

### New Capabilities

- `standalone-jugglework-cli`: Distribution, Cloud authentication, organization/provider discovery, embedded OpenCode execution, Codex-style command hierarchy, interactive behavior, automation contracts, and diagnostics for the standalone `jugglework` command.

### Modified Capabilities

None.

## Impact

- Extends `apps/cli` argument parsing, command dispatch, credential storage, Cloud API access, provider import, interactive UX, tests, and documentation.
- Changes CLI release staging so each native artifact includes a matching OpenCode executable plus JuggleWork plugin assets; released CLI artifacts become larger.
- Reuses `jugglework-server` as the local runtime authority and requires a host-protected provider-auth API so the CLI never edits OpenCode credential files directly.
- Reuses and extracts browser-neutral provider transformation logic currently owned by the Desktop renderer.
- Depends on existing JuggleWork Cloud endpoints for handoff exchange, account and organization discovery, provider connection data, and public model metadata.
- A future seamless device/loopback authorization flow will require coordinated JuggleWork Cloud and web-console changes outside this repository.
