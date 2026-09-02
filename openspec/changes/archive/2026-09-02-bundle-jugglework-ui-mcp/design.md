## Context

See `proposal.md` for the production failure. `packages/jugglework-ui-mcp/index.mjs` is an ESM stdio server that depends on `@modelcontextprotocol/sdk` and `zod`, then proxies tool calls to the authenticated loopback bridge described by `jugglework-ui-control.json`. Development mode already runs the source checkout, while packaged mode returns `npx -y jugglework-ui-mcp`. Electron packaging currently copies OpenCode sidecars and the Computer Use helper but no UI MCP resource.

The packaged Electron executable has already been validated with `ELECTRON_RUN_AS_NODE=1` for native-module smoke tests. That provides a versioned JavaScript runtime on all target machines without relying on a system Node installation.

## Goals / Non-Goals

**Goals:**

- Produce one deterministic, architecture-independent JavaScript file containing the UI MCP and its JavaScript dependencies.
- Run that file with the exact Electron runtime shipped in the same application artifact.
- Use the same resource layout and command model across macOS, Windows, and Linux.
- Make missing or non-runnable UI MCP resources a build/release failure.

**Non-Goals:**

- Remove the npm package metadata or the optional npm publishing workflow used by third-party MCP clients.
- Change the MCP tools, bridge authentication protocol, discovery-file schema, or Desktop remote-control WebSocket protocol.
- Add native code or per-architecture UI MCP binaries.

## Decisions

### Bundle the MCP into a single ESM resource at build time

Use a pinned build dependency to bundle the entry point for Node's platform, including the MCP SDK and zod, into `apps/desktop/resources/jugglework-ui-mcp/index.mjs`. The output is generated and removed/replaced on each Desktop build; it is not a manually maintained copy.

Alternative: copy `index.mjs` plus its `node_modules` dependency tree. That preserves package boundaries but makes pnpm symlink layout, production dependency pruning, and Electron-builder inclusion fragile. A single file is easier to audit and verify.

Alternative: publish and cache the npm package. That still leaves first-run/network/registry failure modes and does not satisfy offline installation.

### Use the packaged Electron executable in Node mode

In production, Desktop copies the verified bundle from `process.resourcesPath` into a versioned path under the current application profile, then command resolution returns `[application runtime, <profile>/runtime/jugglework-ui-mcp/<version>/index.mjs]` and config supplies `ELECTRON_RUN_AS_NODE=1`. The stable profile copy prevents Linux AppImage mount paths from expiring after restart. AppImage uses the original `APPIMAGE` executable as its stable runtime; normal installed builds use `process.execPath`. Development keeps using the repository source entry point with the development Electron runtime.

The connection store performs a bounded idempotent repair only for a local workspace backed by the exact live embedded server connection. It recognizes the exact legacy npm command and prior app-managed versioned profile commands, re-reads authoritative runtime-DB state immediately before a conditional server-side merge, preserves unrelated fields and environment keys, and aborts if the workspace, server identity, command, type, or enabled state changes concurrently. It does not provision a missing entry, touch a project/global or custom command, write desktop paths into a remote workspace, or override `enabled: false`.

Alternative: ship a separate Node binary. That increases artifact size, patch surface, architecture handling, signing, and release verification while duplicating a runtime Electron already contains.

Alternative: execute `node` from PATH. That fails on machines without Node and can run an unsupported or compromised executable.

### Treat the bundled resource as required package content

Electron-builder copies the generated directory with `extraResources` for all targets. The build script first creates the bundle and checks that it is syntactically loadable. The post-pack hook verifies the resource exists so platform artifacts cannot silently omit it.

The post-pack hook starts the bundle with the packaged executable and performs an MCP stdio initialize handshake on every native packaging host. macOS release verification repeats that check alongside native-module and architecture validation.

### Keep discovery credentials runtime-only

The bundle contains only code. Desktop continues to inject `JUGGLEWORK_UI_CONTROL_DISCOVERY` pointing at the current profile's discovery file. No discovery JSON is copied into the artifact, and no token enters build logs or generated code.

## Risks / Trade-offs

- [Bundled dependencies increase app size] → A minified single-file bundle is small relative to Electron and replaces no existing native resource.
- [Electron changes Node-mode behavior] → Keep a packaged-runtime initialize smoke test in the release pipeline; a future fuse change will fail before release.
- [Generated resource becomes stale] → Always rebuild it from source in `electron-build.mjs` and include source/package/lock changes in workflow path filters.
- [Development and production commands diverge] → Unit-test command resolution for both modes and exercise the production command against an unpacked app.
- [MCP protocol smoke process hangs] → Use bounded startup/response/termination timeouts and include captured stderr in the failure.

## Migration Plan

1. Land build, packaging, command-resolution, and verification changes together.
2. Produce an unpacked Desktop artifact and run the packaged MCP initialize smoke test.
3. Release a new Desktop version; existing workspace MCP configuration can remain named `jugglework-ui` because its command is reconciled by the built-in connector lifecycle.
4. Roll back the Desktop release if packaged verification fails. Do not restore the `npx` production fallback; a missing required built-in resource should remain an explicit failure.
