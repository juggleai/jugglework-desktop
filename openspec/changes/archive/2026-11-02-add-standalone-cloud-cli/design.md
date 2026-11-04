## Context

See `proposal.md` for motivation and `specs/standalone-jugglework-cli/spec.md` for the behavioral contract.

`apps/cli` already provides a native Bun-compiled `jugglework` binary, an embedded `jugglework-server`, managed OpenCode startup, a line-oriented REPL, snapshot streaming, interactions, and NDJSON rendering. It currently resolves OpenCode from a flag, environment, `PATH`, a Desktop installation, or source assets; its release build stages only JuggleWork plugins. It also treats `--server`/`JUGGLEWORK_TOKEN` as runtime credentials and has no Cloud account or organization-provider client.

Desktop already consumes organization provider connection data, but its modules depend on Electron, Vite, browser cookies, local storage, and renderer events. The Cloud login implementation creates a short-lived handoff grant and redirects to a registered custom scheme with a fixed `den-auth` host; it cannot redirect to an arbitrary CLI loopback URL. The Server can receive environment and workspace-config updates but does not currently expose a general host-authorized proxy for OpenCode provider authentication.

## Goals / Non-Goals

**Goals:**

- Preserve one runtime/session authority by continuing to embed or connect to `jugglework-server` rather than moving OpenCode orchestration into the command parser.
- Make released CLI artifacts sufficient to start the runtime on a clean supported machine.
- Keep Cloud account credentials, runtime Server credentials, and provider credentials separate in naming, persistence, transport, and redaction.
- Match Codex CLI's useful terminal and automation contracts while organizing commands around JuggleWork concepts.
- Make provider imports compatible with Desktop reconciliation and safe to retry after partial failure.

**Non-Goals:**

- Reimplementing the OpenCode engine or vendoring its source into the CLI package.
- Requiring Desktop installation, Desktop credential discovery, or Desktop runtime databases.
- Exposing internal app-server protocols, migrations, appearance customization, or novelty commands in the initial public surface.
- Claiming a seamless device-code or loopback login before Cloud supports such a callback contract.
- Making distributed transactions across Cloud, environment storage, OpenCode auth, and runtime config.

## Decisions

### 1. Separate Cloud control-plane commands from runtime commands

Argument parsing will produce a hierarchical command object rather than forcing every operation through the current runtime `execute()` path. Login, logout, account status, organization listing/selection, and read-only Cloud inventory will execute without starting OpenCode or the embedded Server. Task/session commands continue through the runtime. Provider import intentionally composes both clients.

This avoids making account maintenance depend on local engine health and prevents a packaged OpenCode startup cost for read-only Cloud operations. The alternative—starting the embedded runtime for every command—would preserve less code churn but creates unnecessary failure coupling.

### 2. Treat Cloud URL and runtime Server URL as different configuration domains

The Cloud default is the normalized origin `https://work.jugglechat.cn`. Public and authenticated JuggleWork API paths are derived from that origin. The runtime keeps `--server`, `JUGGLEWORK_SERVER_URL`, bearer token, and host token semantics. Cloud uses `--cloud-url`, `JUGGLEWORK_CLOUD_URL`, `JUGGLEWORK_CLOUD_TOKEN` for a non-persistent automation override, and `JUGGLEWORK_CLOUD_ORG`.

The existing `--token` will not be overloaded because doing so makes it impossible to know whether a credential authorizes Cloud account APIs or a workspace runtime.

### 3. Use browser plus one-time-grant paste for the first login contract

`jugglework login` will construct the existing handoff URL with a CLI-specific unregistered custom scheme, open the system browser when possible, print the URL in all cases, and accept either the raw grant or the resulting `jugglework-cli://den-auth?...` link through a hidden prompt or stdin-oriented option. It exchanges that grant through the existing desktop-handoff exchange endpoint and validates the session with the current-user endpoint.

A CLI-specific scheme prevents an installed Desktop from intercepting the login. Accepting a pasted result supports SSH and other remote terminals. We explicitly reject pretending the current fixed custom-scheme contract can call a loopback listener. A seamless device flow is a later Cloud/Web Console change.

### 4. Persist Cloud profiles in a dedicated protected store

Cloud profiles will live separately from `cli.json`, keyed by normalized deployment origin, with the account session and selected organization. Writes use a same-directory temporary file plus atomic rename. Directories use mode `0700` and files `0600` where supported. An environment token can override persistence for CI but is never written automatically.

This low-dependency design works in native builds on all platforms. OS keychain integration remains a potential follow-up; requiring it now would add platform-specific release and headless-environment complexity. Every output path uses shared secret registration and structural redaction rather than relying only on message conventions.

### 5. Keep provider inventories as separate truth layers

Commands expose:

- `catalog list`: unauthenticated public model metadata.
- `provider list` and `model list`: selected-organization publications.
- `provider import` / `remove`: local import state.
- Runtime status: models loaded by the embedded or connected engine.
- Optional verification: a model is authenticated, enabled, loaded, and executable.

Public catalog calls receive neither bearer nor organization headers. Organization calls send both current and legacy organization headers for compatibility. The renderer labels every layer rather than merging them into one misleading model list.

### 6. Add a host-protected provider-auth bridge to Server

Server will expose host-authorized set/remove operations scoped to a workspace and provider ID. The handler resolves that workspace's authoritative OpenCode client and forwards the credential operation without returning the credential or recording request bodies. CLI connected mode therefore needs the host token for imports.

Directly editing OpenCode's `auth.json` was rejected because its location and schema are engine implementation details, may be shared with another OpenCode installation, and bypass Server authority and audit policy.

### 7. Extract pure Cloud-provider transformation into a shared module

Browser-neutral functions for import eligibility, credential resolution, provider config generation, runtime patches, model metadata allowlisting, gateway mirror environment naming, and `cloudImports.providers` baselines move out of the Desktop renderer domain into a shared package. Desktop and CLI both consume the same transformations; Electron/Vite/local-storage adapters remain Desktop-only.

An import executes in this order: fetch and validate the Cloud connection, validate the provider ID, write protected environment entries, set OpenCode auth, patch runtime provider config, persist the non-secret baseline, reload, and verify visibility. Each stage is idempotent. If a later stage fails, the CLI reports which redacted stages completed and does not blindly remove prior values because they may predate the import.

### 8. Stage OpenCode as a release sidecar rather than compiling it into the Bun executable

Each platform distribution contains:

```text
bin/jugglework[.exe]
sidecars/opencode[.exe]
opencode-plugins/*.js
manifest.json
```

The manifest records CLI, Server, OpenCode, plugin-set, target, and checksums. Runtime resolution prioritizes an explicit development override and then the manifest-declared adjacent sidecar. Released artifacts do not rely on `PATH` or Desktop; source/development mode may retain those fallbacks. Build verification executes the sidecar version command and a packaged-runtime smoke test.

Keeping OpenCode as a sidecar allows independent upstream replacement, license attribution, signature verification, and platform-native execution. Embedding its bytes inside the Bun binary would make updates, integrity checks, and process spawning less transparent.

### 9. Adopt Codex interaction contracts, not its internal taxonomy

Canonical initial commands are:

```text
jugglework [OPTIONS] [PROMPT]
jugglework exec [OPTIONS] [PROMPT]
jugglework login [--grant-stdin]
jugglework login status
jugglework logout
jugglework org list|use
jugglework provider list|import|remove
jugglework model list
jugglework catalog list
jugglework session list|show|resume|fork|queue|rename|archive|unarchive|delete
jugglework workspace list|add|open
jugglework connect list|search|status
jugglework mcp list|get|add|remove|login|logout
jugglework skill list|show
jugglework extension list|show|enable|disable
jugglework doctor
jugglework completion <shell>
```

High-frequency compatibility aliases such as `resume`, `fork`, and `sessions` can remain, but help presents the grouped hierarchy. Bare invocation enters the TUI/interactive shell; `exec` is the strict automation boundary. The initial slash-command palette is compact and contextual: `/model`, `/org`, `/permissions`, `/status`, `/plan`, `/new`, `/sessions`, `/resume`, `/fork`, `/workspace`, `/connect`, `/mcp`, `/skills`, `/extensions`, `/compact`, `/copy`, `/doctor`, `/logout`, and `/exit`.

### 10. Make `exec` a Unix-stable interface

In plain `exec`, progress is stderr and only the final answer is stdout. `--json` makes stdout NDJSON-only. With no prompt, stdin is the prompt; with both a positional prompt and piped stdin, the latter is a separate context block. `--output-last-message` and `--output-schema` support pipelines. Non-interactive mode never opens permission or question prompts.

This deliberately differs from the current one-shot renderer, which can put lifecycle text on stdout. Interactive invocation remains human-oriented and backward-compatible where practical; automation should migrate to explicit `exec`.

### 11. Deliver in compatibility-preserving slices

The parser will preserve current top-level positional prompts, `resume`, `sessions`, `status`, and existing runtime flags. New commands are additive. Cloud-only commands and packaged OpenCode can land before the richer TUI and full session command tree. Every intermediate release must keep help and error output truthful about implemented commands.

## Risks / Trade-offs

- [The current handoff login is less seamless than Codex device auth] → Clearly guide browser-and-paste, accept full links or raw grants, keep grants short-lived and single-use, and add device/loopback auth only after a server contract exists.
- [Plaintext session storage is weaker than an OS keychain] → Restrict permissions, isolate profiles, support ephemeral environment tokens, redact structurally, and evaluate keychain storage as a later selectable backend.
- [Native artifacts become substantially larger] → Publish per-platform archives, checksum every component, and keep OpenCode as a replaceable sidecar rather than duplicating it in multiple binaries.
- [CLI and Desktop can race while importing the same provider] → Use the shared baseline format, idempotent operations, authoritative Server mutations, and post-write runtime verification.
- [Import is not transactionally atomic] → Report completed stages and retry safely; never perform destructive rollback without captured prior state.
- [OpenCode credentials may still share its default user data directory] → Document the behavior for the first release and decide isolation as an explicit migration, because changing it silently would hide existing credentials.
- [A large Codex-like surface can become inconsistent] → Keep a small P0 command set, hierarchical help, contextual availability, command-contract tests, and feature-gate unfinished groups rather than exposing stubs.
- [Provider APIs can change independently of CLI releases] → Normalize responses in one Cloud client, include reference IDs in redacted errors, and contract-test against fixtures from the production API schema.

## Migration Plan

1. Add Cloud URL normalization, client, protected profile storage, login/logout/status, and organization selection without touching task startup.
2. Add read-only catalog/provider/model inventory and prove Cloud-only commands never resolve or start OpenCode.
3. Add the Server provider-auth bridge and extract shared provider transformations.
4. Add idempotent provider import/remove and runtime visibility verification.
5. Stage OpenCode sidecars and manifests in per-platform build artifacts; validate licenses, signatures, checksums, and clean-machine smoke tests.
6. Add `exec` stdout/stderr semantics, grouped commands, diagnostics, completion, and incremental interactive commands while retaining current aliases.
7. Publish as a canary channel, test login/provider import/task execution without Desktop, then promote.

Rollback disables the new release channel and restores the previous CLI artifact. Cloud profiles remain inert local files, imported provider configuration remains reconcilable by Desktop, and existing sessions/runtime databases require no schema rollback.

## Open Questions

- Whether production releases will use an OS keychain backend by default after the initial protected-file implementation.
- Whether OpenCode user data should be isolated per CLI profile in a later migration or intentionally shared with a user's normal OpenCode installation.
