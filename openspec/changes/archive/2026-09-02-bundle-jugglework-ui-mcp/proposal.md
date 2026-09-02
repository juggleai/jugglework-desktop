## Why

The packaged Desktop currently starts its built-in UI-control MCP with `npx -y jugglework-ui-mcp`, but that package is not available from npm. The child process exits immediately and OpenCode reduces the failure to `MCP error -32000: Connection closed`, even though the local JuggleWork UI bridge is healthy. A core built-in connector must remain available offline and must not depend on a package registry or a separately installed Node runtime.

## What Changes

- Build `packages/jugglework-ui-mcp` and all of its runtime dependencies into a self-contained JavaScript bundle during the Desktop build.
- Include that bundle as an explicit Electron `extraResource` on macOS, Windows, and Linux.
- Resolve the production MCP command to the bundled resource and run it with the packaged Electron executable in Node mode, while preserving the source checkout command in development.
- Repair existing enabled `jugglework-ui` workspace entries that still reference the legacy `npx` command, without re-enabling entries the user disabled.
- Fail Desktop builds and packaged-app verification when the embedded MCP is missing, still contains unresolved runtime imports, or cannot complete an MCP stdio initialization smoke test.
- Remove npm/network and system Node/npx from the production UI-control startup path; npm publication remains optional for third-party MCP clients.

## Capabilities

### New Capabilities

- `bundled-ui-control-mcp`: Offline packaging, production command resolution, and packaged-runtime verification for JuggleWork's built-in UI-control MCP.

### Modified Capabilities

None.

## Impact

- `packages/jugglework-ui-mcp`: gains a reproducible bundle entry point/output contract.
- `apps/desktop/scripts/electron-build.mjs`: prepares and verifies the embedded MCP resource before packaging.
- `apps/desktop/electron-builder.yml`: ships the generated resource on every supported platform.
- `apps/desktop/electron/main.mjs`: returns the packaged Electron-as-Node command instead of `npx` in production.
- `apps/desktop/scripts/verify-packaged-macos.mjs` and packaging tests: verify resource presence and MCP initialization.
- Build dependencies: add `esbuild` as a pinned Desktop development dependency; no new production runtime dependency or network requirement.
