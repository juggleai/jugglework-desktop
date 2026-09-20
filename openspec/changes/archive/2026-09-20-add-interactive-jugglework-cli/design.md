## Context

`jugglework-server` can already start a managed OpenCode process, serialize session mutations, expose session snapshots and pending interactions, and shut down transactionally. Its current command only hosts the HTTP service. The retired bare `jugglework` orchestrator had unrelated daemon/TUI responsibilities and is not a compatibility target.

## Goals / Non-Goals

**Goals:**

- Make `jugglework` useful from a terminal with no manual REST calls.
- Keep Server as the sole runtime and session authority.
- Work both as a standalone local command and as a client of an existing Server.
- Preserve run, permission, question, and abort semantics already used by Desktop.
- Keep output readable in a TTY and deterministic for scripts.

**Non-Goals:**

- Reintroducing the old orchestrator, daemon management, sandbox launcher, or interactive full-screen TUI.
- Reimplementing OpenCode execution in the CLI.
- Automatically discovering or extracting secret Desktop credentials.
- Publishing binaries or npm packages as part of this source change.

## Decisions

### 1. Add a separate `@jugglework/cli` package with the `jugglework` bin

The CLI is a product client, not another mode in `jugglework-server`. It imports the Server's public `startEmbeddedServer` API for local mode and uses HTTP for all task operations. This keeps one mutation authority while allowing the CLI parser, terminal rendering, and release cadence to remain independent.

### 2. Local mode embeds Server and managed OpenCode

Without `--server`, the CLI resolves the workspace from `--workspace` or the current directory, locates OpenCode from `--opencode-bin`, environment, PATH, the installed Desktop sidecar, or the source checkout, then starts Server on loopback port zero with generated in-memory credentials. CLI runtime state uses a CLI-specific runtime database path so it does not contend with Desktop's runtime database.

With `--server`, the CLI never starts or stops that Server and requires an explicit token from a flag, environment variable, or CLI config file. It selects `--workspace-id`, a workspace matching the requested path, or the only available workspace.

### 3. Poll authoritative snapshots and interactions

The first implementation uses bounded snapshot polling rather than building a second SSE projection stack. It prints only appended assistant text, observes busy/idle transitions back into the run coordinator, and polls the root interaction snapshot. Permission and question replies use existing APIs. Snapshot polling is acceptable for a terminal client and is easy to recover after transient network failure.

### 4. Interactive and one-shot modes share one session controller

`jugglework [prompt]` creates a session, runs once, prints the result, and exits. Bare `jugglework` enters a line-oriented REPL. `jugglework resume [session]` resumes by exact ID or interactively selects from recent sessions. Slash commands provide new, sessions, resume, status, stop, help, and exit without requiring a full-screen terminal UI.

### 5. Ctrl-C is contextual

During a run, the first Ctrl-C sends an authenticated run abort and keeps the interactive CLI alive. At an idle prompt, Ctrl-C exits. A second signal during shutdown forces process termination. Locally embedded Server and OpenCode receive a bounded graceful shutdown on normal exit and signals.

### 6. Permission defaults fail closed

Sessions default to request-approval. `--full-access` is explicit, requires the host credential in connected mode, sends the versioned acknowledgement, and fails if Server policy rejects it. Interactive permission requests allow once, session grant, or reject; non-interactive mode fails with a clear actionable error unless an explicit policy allows progress.

### 7. Native builds are self-contained release inputs

Bun compile produces platform binaries. Release staging must place required JuggleWork plugin assets beside the binary or point `JUGGLEWORK_EXTENSIONS_PLUGIN_DIR` at packaged assets. Cross-platform build scripts create deterministic target names; installation into PATH remains an explicit release/install step.

## Risks / Trade-offs

- [Polling adds latency and requests] → Use a short active interval, back off while idle, and stop immediately at authoritative terminal state.
- [Snapshot text can be revised rather than appended] → Track message/part identity and redraw only the affected terminal segment when safe; fall back to a newline replacement notice.
- [Standalone configuration differs from Desktop] → Support existing Server connection and standard OpenCode configuration; do not copy Desktop secrets implicitly.
- [Ctrl-C races with natural completion] → Abort by run ID and treat already-idle/run-mismatch responses as successful termination.
- [Compiled binary cannot find plugin assets] → Validate the staged asset directory during startup and fail with an installation-specific error before starting a task.

## Migration Plan

The new command is additive. Build and test it from the monorepo, then stage native binaries and plugin assets in release outputs. Existing Desktop and `jugglework-server` behavior remains unchanged. Rollback removes the CLI artifact without changing sessions or runtime storage.
