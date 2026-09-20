## 1. CLI Package and Contract

- [x] 1.1 Add the `@jugglework/cli` workspace package with `jugglework` bin, build, typecheck, test, and native target scripts.
- [x] 1.2 Implement strict argument parsing, help/version, config/env precedence, secret redaction, TTY detection, and stable exit codes.
- [x] 1.3 Implement OpenCode and plugin-asset resolution for source, PATH, installed Desktop, and staged native distributions.

## 2. Runtime and API Client

- [x] 2.1 Implement local embedded Server startup with current-directory workspace, CLI-specific runtime storage, generated credentials, and bounded cleanup.
- [x] 2.2 Implement explicit existing-Server connection, health validation, authentication, and deterministic workspace selection.
- [x] 2.3 Implement the typed HTTP client for sessions, snapshots, active runs, abort, permission modes, and interaction replies.

## 3. Task and Session Controller

- [x] 3.1 Implement session creation, one-shot execution, model/agent prompt options, run admission, and final exit status.
- [x] 3.2 Implement snapshot-based incremental assistant text rendering, retry/wait status, run observation, and fast-completion handling.
- [x] 3.3 Implement recent-session listing and exact/interactive resume.
- [x] 3.4 Implement contextual Ctrl-C and stop behavior with graceful owned-runtime shutdown.

## 4. Interactive Experience

- [x] 4.1 Implement the line-oriented REPL and `/help`, `/new`, `/sessions`, `/resume`, `/status`, `/stop`, and `/exit` commands.
- [x] 4.2 Implement interactive permission and question rendering and replies without silent approval in non-interactive mode.
- [x] 4.3 Implement explicit Full access activation using the Server's versioned acknowledgement and host authority.
- [x] 4.4 Implement human and NDJSON renderers with non-TTY/no-color behavior.

## 5. Packaging, Tests, and Documentation

- [x] 5.1 Add parser, config, resolver, API-client, renderer, interaction, Ctrl-C, and session-controller unit tests.
- [x] 5.2 Add mock-Server integration tests for one-shot, interactive follow-up, resume, fast completion, abort, permission, question, and failure paths.
- [x] 5.3 Build and smoke-test the native macOS binary and verify release staging detects missing OpenCode/plugin assets before task execution.
- [x] 5.4 Document source usage, local and connected modes, configuration, commands, permissions, security, and packaging limitations.
- [x] 5.5 Run CLI tests/typecheck, Server regression tests, OpenSpec strict validation, and repository diff hygiene checks. CLI validation passed with 46 tests, typecheck, native build/smoke, package-content verification, and strict OpenSpec/diff checks. Focused affected Server lifecycle/logging tests passed; the full Server suite retained pre-existing failures reproduced from a clean `6df226b25` worktree (runtime config built-in Computer Use expectation, media-generation SQLite contention, missing generated desktop runtime in the isolated worktree, and video-generation steering instruction fixtures), with no new CLI-specific regression.
