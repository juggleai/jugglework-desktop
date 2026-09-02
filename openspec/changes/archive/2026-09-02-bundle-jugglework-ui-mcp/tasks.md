## 1. Prepare the self-contained MCP resource

- [x] 1.1 Add a pinned Desktop build dependency and a preparation script that bundles `packages/jugglework-ui-mcp/index.mjs` with all runtime dependencies into a clean generated resource directory.
- [x] 1.2 Invoke preparation from every Desktop build and fail on missing output, unresolved non-builtin imports, or syntax errors.

## 2. Package and launch the embedded MCP

- [x] 2.1 Add the generated UI MCP directory to Electron `extraResources` for macOS, Windows, and Linux.
- [x] 2.2 Copy the verified resource to a stable versioned profile path and resolve production commands to the packaged Electron/AppImage executable with `ELECTRON_RUN_AS_NODE=1`; preserve source-checkout behavior in development.
- [x] 2.3 Keep bridge discovery runtime-only by continuing to inject the current profile discovery-file path without packaging tokens or machine-specific values.
- [x] 2.4 Conditionally repair only exact enabled legacy or prior app-managed `jugglework-ui` commands in local embedded workspaces while preserving custom, absent, disabled, unrelated, and concurrently changed state.

## 3. Verify package contents and protocol startup

- [x] 3.1 Add unit coverage for development and packaged command/environment resolution plus legacy-entry repair decisions.
- [x] 3.2 Extend post-pack checks to reject artifacts missing the embedded UI MCP resource.
- [x] 3.3 Add a bounded packaged-runtime smoke test that starts the MCP, completes stdio `initialize`, checks the `jugglework-ui` server identity, and terminates cleanly.
- [x] 3.4 Update build/release workflow path filters so UI MCP source changes trigger Desktop artifact validation.

## 4. Validation

- [x] 4.1 Run UI MCP syntax tests, Desktop Electron tests/typecheck, and strict OpenSpec validation.
- [x] 4.2 Build an unpacked macOS application, run packaged verification, and confirm the generated production command does not contain `npm`, `npx`, or a PATH-resolved `node`.
