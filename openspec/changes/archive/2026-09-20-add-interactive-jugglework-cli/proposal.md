## Why

JuggleWork has a functional headless Server CLI and task APIs, but users cannot run an agent task from a terminal without manually starting services and composing HTTP requests. The installed desktop application also does not expose a `jugglework` command, leaving no Codex-style interactive workflow for terminal users.

## What Changes

- Add a user-facing `jugglework` command with interactive and one-shot task modes.
- Default local mode to the current directory, start an embedded JuggleWork Server plus managed OpenCode, and clean both up on exit.
- Support connecting to an existing local or remote JuggleWork Server with explicit URL and credentials.
- Stream assistant text, show concise run state, handle permission and question interactions, and let Ctrl-C stop the active run without corrupting the session.
- Add session listing, resume, new-session, status, stop, help, and exit commands.
- Support model, agent, workspace, permission mode, structured JSON output, and non-interactive operation where applicable.
- Build native `jugglework` binaries and document installation without reviving legacy orchestrator flags or TUI semantics.

## Capabilities

### New Capabilities

- `interactive-jugglework-cli`: Terminal task submission, interactive session control, runtime connection or startup, output streaming, interactions, configuration, and distribution under the `jugglework` command.

### Modified Capabilities

None.

## Impact

- Adds a new CLI workspace package and executable named `jugglework`.
- Reuses the public `jugglework-server` library and HTTP API rather than duplicating session execution logic.
- Adds CLI packaging, cross-platform binary build support, tests, and user documentation.
- May add a small Server read-model adjustment only if required for reliable terminal run completion; no legacy orchestrator state is restored.
